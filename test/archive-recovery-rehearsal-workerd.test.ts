import { it,expect } from 'vitest';
import { Miniflare,type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { installBaseline,sha256Hex } from '@kl/core';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { sealArchive } from '../packages/core/src/catalog/durability.ts';
import { parseRuntimeConfig,runtimeConfigBindings } from '../apps/api/src/cloudflare/runtime-config.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';
import { REHEARSAL_CONTENT,type RehearsalInventory } from '../apps/api/src/cloudflare/recovery-rehearsal.ts';

it('actual staging rehearsal preserves namespace/R2, resets only pinned synthetic SQL, then ordinary runtime restores with cc revoked and cx exact bytes',async()=>{
  const f=await enrollmentFixture(new Date().toISOString()),origin='https://kl-api-staging.synthetic.workers.dev',audience={...f.claims.audience,origin};
  const parent=resolve('.review/recovery-rehearsal-workerd');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'run-'));let runtime:Miniflare|undefined;
  try{
    installBaseline(f.catalog,{scopeId:'global',privacy:'team'});f.catalog.enroll(f.grant);await f.catalog.drainOutbox();
    const note=await f.catalog.save({principal:f.claims.principal,clientClass:'kl-device'},{content:REHEARSAL_CONTENT,collection:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,path:'synthetic.md'});
    if(!note.ok)throw Error('fixture');await f.catalog.drainOutbox();const seal=(await sealArchive(f.catalog,{store:f.mirror,libraryId:audience.libraryId,minPolicyEpoch:1}))!;
    const inventory:RehearsalInventory={schema:'kl-rehearsal-inventory/v1',phase:'discard',libraryId:audience.libraryId,principal:f.claims.principal,collectionId:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,noteId:note.noteId,version:1,tokens:f.tokens.map(t=>({kind:t.kind,hash:t.hash})),pin:{snapshotHash:seal.snapshotHash,eventSeq:seal.eventSeq,eventHash:seal.eventHash,authzSeq:seal.authzSeq}};
    const bundle=async(entry:string)=> (await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers'],define:{__KL_REHEARSAL_INVENTORY__:JSON.stringify(JSON.stringify(inventory))}})).outputFiles![0]!.text;
    const [ordinary,rehearsal]=await Promise.all([bundle('apps/api/src/cloudflare/archive-worker.ts'),bundle('apps/api/src/cloudflare/recovery-rehearsal-worker.ts')]);
    const config={schema:'kl-owner-runtime/v1',audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
    const common:MiniflareOptions={name:'kl-api-staging',modules:true,script:ordinary,compatibilityDate:'2026-07-30',versionMetadata:'VERSION',durableObjects:{LIBRARY:{className:'LibraryDO',useSQLite:true}},r2Buckets:['ARCHIVE'],durableObjectsPersist:join(root,'do'),r2Persist:join(root,'r2'),bindings:{RUNTIME_MODE:'active',...runtimeConfigBindings(parseRuntimeConfig(JSON.stringify(config)))}};
    const start=async(script:string,mode:'active'|'closed')=>{await runtime?.dispose();runtime=new Miniflare({...common,script,bindings:{...common.bindings,RUNTIME_MODE:mode}});await runtime.ready;};
    const get=(path:string,token?:string)=>runtime!.dispatchFetch(origin+path,{headers:token?{authorization:'Bearer '+token}:{}});
    const release=async(mode:'active'|'closed'='active',invalid=false)=>{
      const h=await (await get('/health')).json() as {versionId:string;release:{revision:number;releaseHash:string}|null},now=new Date().toISOString();
      const packet=await signRuntimeRelease({purpose:'kl-runtime-release/v1',audience,versionId:h.versionId,revision:(h.release?.revision??0)+1,previousReleaseHash:h.release?.releaseHash??null,mode,nonce:sha256Hex(crypto.randomUUID()),issuedAt:now,expiresAt:new Date(Date.parse(now)+600_000).toISOString()},f.approvalKey.keyId,f.approvalKey.privateKey);
      if(invalid)packet.sig='A'.repeat(86);
      return {packet,response:await runtime!.dispatchFetch(origin+'/v1/runtime/release',{method:'POST',body:JSON.stringify(packet)})};
    };
    const read=async(token:string)=>{
      const r=await runtime!.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'library_read',arguments:{ref:note.cite}}})});
      const body=await r.json() as {result:{content:{text:string}[];structuredContent:Record<string,unknown>;isError:boolean}};
      expect(body.result.isError).toBe(false);const data=body.result.structuredContent;expect(JSON.parse(body.result.content[0]!.text)).toEqual(data);
      // Only the documented per-response wrapper nonce and its explicit field
      // are unstable; every custody, citation and content field still compares.
      const nonce=data.nonce as string;expect(nonce).toMatch(/^[a-f0-9]{8}$/);
      return {status:r.status,text:JSON.stringify({...data,nonce:'RESPONSE'}).replaceAll('untrusted-note-'+nonce,'untrusted-note-RESPONSE')};
    };
    const exactBytes=async(token:string)=>{const r=await get(`/v1/version/${note.noteId}@1/bytes`,token);expect(r.status).toBe(200);expect(r.headers.get('x-kl-sha256')).toBe(sha256Hex(REHEARSAL_CONTENT));expect(new Uint8Array(await r.arrayBuffer())).toEqual(new TextEncoder().encode(REHEARSAL_CONTENT));};
    await start(ordinary,'active');let bucket=await runtime!.getR2Bucket('ARCHIVE');
    for(const store of [f.mirror,f.blobStore])for(const [key,bytes] of store.objects)await bucket.put(key,bytes);
    expect((await release()).response.status).toBe(200);
    const before=await read(f.tokens[2]!.token);expect(before.status).toBe(200);expect(before.text).toContain('Synthetic acceptance fixture');await exactBytes(f.tokens[2]!.token);
    const retained=new Map<string,string>();for(const o of (await bucket.list()).objects)retained.set(o.key,sha256Hex(new Uint8Array(await (await bucket.get(o.key))!.arrayBuffer())));
    await start(rehearsal,'closed');expect((await get('/mcp')).status).toBe(503);expect((await get('/v1/status',f.tokens[0]!.token)).status).toBe(503);
    expect((await release('active',true)).response.status).toBe(400);
    const run=await release();expect(run.response.status).toBe(200);
    const result=await (await get('/rehearsal-result')).json();expect(result).toMatchObject({schema:'kl-recovery-rehearsal/v1',projectionEmpty:true,revoked:1,before:inventory.pin});
    bucket=await runtime!.getR2Bucket('ARCHIVE');for(const [key,digest] of retained)expect(sha256Hex(new Uint8Array(await (await bucket.get(key))!.arrayBuffer()))).toBe(digest);
    expect((await runtime!.dispatchFetch(origin+'/v1/runtime/release',{method:'POST',body:JSON.stringify(run.packet)})).status).toBe(200);
    await start(ordinary,'active');expect((await get('/v1/status',f.tokens[2]!.token)).status).toBe(503);
    expect((await release()).response.status).toBe(200);
    expect(await read(f.tokens[2]!.token)).toEqual(before);await exactBytes(f.tokens[2]!.token);expect((await get('/v1/status',f.tokens[1]!.token)).status).toBe(401);
    await start(ordinary,'closed');expect((await get('/v1/status',f.tokens[2]!.token)).status).toBe(503);
    await start(ordinary,'active');expect((await release()).response.status).toBe(200);
    expect(await read(f.tokens[2]!.token)).toEqual(before);await exactBytes(f.tokens[0]!.token);expect((await get('/v1/status',f.tokens[1]!.token)).status).toBe(401);
  }finally{
    await runtime?.dispose();f.db.close();const child=relative(parent,resolve(root));if(!child||child.startsWith('..')||isAbsolute(child))throw Error('unsafe-fixture-cleanup');
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},90_000);
