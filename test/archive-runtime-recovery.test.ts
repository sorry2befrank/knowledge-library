import { it,expect } from 'vitest';
import { Miniflare,type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { Catalog,installBaseline,sha256Hex,type Op } from '@kl/core';
import { opHash } from '../packages/core/src/catalog/apply.ts';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { parseRuntimeConfig,runtimeConfigBindings } from '../apps/api/src/cloudflare/runtime-config.ts';
import { sealArchive } from '../packages/core/src/catalog/durability.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';

async function fixture(revoked=true,adapter=false,at=new Date().toISOString()){
  const f=await enrollmentFixture(at);
  installBaseline(f.catalog,{scopeId:'global',privacy:'team'});
  f.catalog.enroll(f.grant);await f.catalog.drainOutbox();
  const content='# Synthetic recovery\nApricot telescopes preserve exact context.\n';
  const note=await f.catalog.save({principal:f.claims.principal,clientClass:'kl-device'},
    {content,collection:'col:fixture',folderId:'folder:fixture',path:'recovery.md'});
  expect(note.ok).toBe(true);if(!note.ok)throw Error('fixture-save-failed');await f.catalog.drainOutbox();
  const revoke=async()=>{
    const result=f.catalog.apply({principal:'system',clientClass:'kl-device'},{kind:'system'},
      {kind:'token.revoke',tokenHash:f.tokens[1]!.hash,reason:'owner'});
    await f.catalog.acknowledge((result.result as {authzSeq:number}).authzSeq);
  };
  // Prepare an already-authorized synthetic ledger, not a live approval route.
  // Production uses its unchanged noApprovalChannel verifier after recovery.
  const narrow=async(op:Extract<Op,{kind:'note.withdraw'|'policy.accept'}>)=>{
    const receipt={receiptId:'synthetic-'+op.kind,actionKind:op.kind,actionHash:opHash(op),evidenceHash:sha256Hex('synthetic-evidence'),
      principal:f.claims.principal,credentialId:'synthetic-only',issuedAt:at,expiresAt:new Date(Date.parse(at)+900_000).toISOString(),serverSig:'synthetic-only'};
    const producer=new Catalog({db:f.db,blobStore:f.blobStore,mirror:f.mirror,denyRules:f.denyRules,clock:f.catalog.clock,
      receipts:{verify:(r,e)=>r===receipt&&e.actionKind===receipt.actionKind&&e.actionHash===receipt.actionHash?{ok:true}:{ok:false,reason:'action-mismatch'}}});
    const applied=producer.apply({principal:f.claims.principal,clientClass:'kl-device'},{kind:'receipt',receipt},op);
    await producer.acknowledge((applied.result as {authzSeq:number}).authzSeq);
  };
  if(revoked)await revoke();
  const durability={store:f.mirror,libraryId:f.claims.audience.libraryId,minPolicyEpoch:1};
  await sealArchive(f.catalog,durability);
  const parent=resolve('.review/archive-runtime-recovery');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'run-'));
  const bundle=await build({entryPoints:[adapter?'test/helpers/runtime-recovery-worker.ts':'apps/api/src/cloudflare/archive-worker.ts'],
    bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']});
  const config={schema:'kl-owner-runtime/v1',audience:f.claims.audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},
    policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
  const options:MiniflareOptions={name:'archive-runtime',modules:true,script:bundle.outputFiles![0]!.text,compatibilityDate:'2026-07-30',versionMetadata:'VERSION',
    durableObjects:{LIBRARY:{className:'LibraryDO',useSQLite:true}},r2Buckets:['ARCHIVE'],
    durableObjectsPersist:join(root,'do'),r2Persist:join(root,'r2'),bindings:{RUNTIME_MODE:'active',...runtimeConfigBindings(parseRuntimeConfig(JSON.stringify(config)))}};
  let runtime=new Miniflare(options);
  const copyObjects=async()=>{const bucket=await runtime.getR2Bucket('ARCHIVE');
    for(const store of [f.mirror,f.blobStore])for(const [key,bytes] of store.objects)await bucket.put(key,bytes);
  };
  await copyObjects();
  return {...f,content,cite:note.cite,noteId:note.noteId,durability,revoke,narrow,copyObjects,get runtime(){return runtime;},
    async restart(fresh=false,fault=false){await runtime.dispose();runtime=new Miniflare({...options,
      durableObjectsPersist:join(root,fresh?'fresh-do':'do'),bindings:{...options.bindings,...(fault?{FAIL_SNAPSHOT_READ:'2'}:{})}});await runtime.ready;},
    async release(){
      const h=await (await runtime.dispatchFetch('https://enrollment.invalid/health')).json() as {versionId:string;release:{revision:number;releaseHash:string}|null};
      const now=new Date().toISOString();
      const signed=await signRuntimeRelease({purpose:'kl-runtime-release/v1',audience:f.claims.audience,versionId:h.versionId,
        revision:(h.release?.revision??0)+1,previousReleaseHash:h.release?.releaseHash??null,mode:'active',nonce:sha256Hex(crypto.randomUUID()),issuedAt:now,
        expiresAt:new Date(Date.parse(now)+900_000).toISOString()},f.approvalKey.keyId,f.approvalKey.privateKey);
      return runtime.dispatchFetch('https://enrollment.invalid/v1/runtime/release',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signed)});
    },
    async tool(token:string,name='library_read',args:Record<string,unknown>={ref:note.cite}){
      const response=await runtime.dispatchFetch('https://enrollment.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      return {status:response.status,body:await response.json()};
    },
    async projection(){return (await runtime.dispatchFetch('https://enrollment.invalid/test/projection')).json() as Promise<Record<string,unknown>>;},
    async close(){await runtime.dispose();f.db.close();const child=relative(parent,resolve(root));
      if(!child||child.startsWith('..')||isAbsolute(child))throw Error('unsafe-fixture-cleanup');
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  };
}

it('production host restores a lost projection only after a fresh release, preserving exact citation and revoked-token denial',async()=>{
  const f=await fixture();try{
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    expect((await f.release()).status).toBe(200);
    const first=await f.tool(f.tokens[2]!.token);expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toContain(f.content.trim().split('\n')[1]);
    expect(JSON.stringify(first.body)).toContain(f.cite);
    expect((await f.tool(f.tokens[1]!.token)).status).toBe(401);
    await f.restart(true);
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    expect((await f.release()).status).toBe(200);
    const restored=await f.tool(f.tokens[2]!.token);
    expect(restored).toMatchObject({status:200,body:{result:{structuredContent:{cite:f.cite,sha256:sha256Hex(f.content),truncated:false}}}});
    const bytes=await f.runtime.dispatchFetch(`https://enrollment.invalid/v1/version/${f.cite.slice(3).split('~')[0]}/bytes`,
      {headers:{authorization:`Bearer ${f.tokens[2]!.token}`}});
    expect(bytes.status).toBe(200);expect(bytes.headers.get('x-kl-sha256')).toBe(sha256Hex(f.content));expect(await bytes.text()).toBe(f.content);
    expect((await f.tool(f.tokens[1]!.token)).status).toBe(401);
    const search=await f.tool(f.tokens[2]!.token,'library_search',{q:'apricot'});
    expect(search.status).toBe(200);expect(JSON.stringify(search.body)).toContain(f.cite);
  }finally{await f.close();}
},60_000);

it('never replaces a nonempty stale projection after a newer narrowing checkpoint and retains the durable hold',async()=>{
  const f=await fixture(false,true);try{
    expect((await f.release()).status).toBe(200);expect((await f.tool(f.tokens[2]!.token)).status).toBe(200);
    const before=await f.projection();expect(before).toMatchObject({notes:1,revoked:0,recovery:null,pending:false});
    await f.revoke();const bucket=await f.runtime.getR2Bucket('ARCHIVE');
    for(const [key,bytes] of f.mirror.objects)if(key.startsWith('authz/'))await bucket.put(key,bytes);
    await f.restart();expect((await f.release()).status).toBe(200);
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    const after=await f.projection();expect(after).toMatchObject({head:before.head,notes:1,revoked:0,recovery:null,pending:true});
    await f.restart();const started=Date.now();expect((await f.release()).status).toBe(503);
    expect(Date.now()-started).toBeLessThan(10_000);
    expect((await f.tool(f.tokens[1]!.token)).status).toBe(503);
    expect(await f.projection()).toMatchObject({head:before.head,notes:1,revoked:0,pending:true});
  }finally{await f.close();}
},60_000);

it('keeps imported authorization closed if post-import archive readback fails, including after restart',async()=>{
  const f=await fixture(true,true);try{
    await f.restart(false,true);expect((await f.release()).status).toBe(200);
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    expect(await f.projection()).toMatchObject({notes:1,revoked:1,recovery:'pending',pending:true,snapshotReads:2});
    await f.restart();const started=Date.now();expect((await f.release()).status).toBe(503);
    expect(Date.now()-started).toBeLessThan(10_000);
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    expect(await f.projection()).toMatchObject({notes:1,revoked:1,recovery:'pending',pending:true,snapshotReads:0});
  }finally{await f.close();}
},60_000);

it('refuses a corrupt latest snapshot without falling back to an older valid grant',async()=>{
  const f=await fixture(false,true);try{
    await f.revoke();const latest=await sealArchive(f.catalog,f.durability);await f.copyObjects();
    await (await f.runtime.getR2Bucket('ARCHIVE')).put(`snap/${latest!.libraryHash}/${latest!.snapshotHash}.json`,'{}');
    expect((await f.release()).status).toBe(200);expect((await f.tool(f.tokens[1]!.token)).status).toBe(503);
    expect(await f.projection()).toMatchObject({head:0,notes:0,revoked:0,recovery:null,pending:true});
  }finally{await f.close();}
},60_000);

it('released production runtime rejects correctly formed expired device and client bearers after pristine recovery',async()=>{
  const f=await fixture(false,false,new Date(Date.now()-2*86_400_000).toISOString());try{
    expect((await f.release()).status).toBe(200);
    for(const token of f.tokens){
      const result=await f.tool(token.token);
      expect(result).toMatchObject({status:401,body:{error:'unauthorized',reason:'expired'}});
    }
  }finally{await f.close();}
},60_000);

it('released production recovery preserves note withdrawal for MCP search, citation reads and full-byte routes',async()=>{
  const f=await fixture(false);try{
    await f.narrow({kind:'note.withdraw',noteId:f.noteId});
    await sealArchive(f.catalog,f.durability);await f.copyObjects();
    expect((await f.release()).status).toBe(200);
    for(const token of f.tokens){
      expect(await f.tool(token.token,'library_status',{})).toMatchObject({status:200,body:{result:{isError:false}}});
      expect(await f.tool(token.token)).toMatchObject({status:200,body:{result:{isError:true,structuredContent:{error:'withdrawn'}}}});
      const search=await f.tool(token.token,'library_search',{q:'apricot'});
      expect(search).toMatchObject({status:200,body:{result:{isError:false,structuredContent:{hits:[]}}}});
      const bytes=await f.runtime.dispatchFetch(`https://enrollment.invalid/v1/version/${f.noteId}@1/bytes`,
        {headers:{authorization:`Bearer ${token.token}`}});
      expect(bytes.status).toBe(409);expect(await bytes.json()).toMatchObject({error:'withdrawn'});
    }
  }finally{await f.close();}
},60_000);

it('released production recovery refuses an older projection after a newer policy epoch checkpoint without importing it',async()=>{
  const f=await fixture(false,true);try{
    await f.narrow({kind:'policy.accept',epoch:2,policyHash:sha256Hex('synthetic-new-policy'),receiptId:'synthetic-policy-2',sig:'synthetic-only'});
    const bucket=await f.runtime.getR2Bucket('ARCHIVE');
    for(const [key,bytes] of f.mirror.objects)if(key.startsWith('authz/'))await bucket.put(key,bytes);
    expect((await f.release()).status).toBe(200);
    expect((await f.tool(f.tokens[2]!.token)).status).toBe(503);
    expect(await f.projection()).toMatchObject({head:0,notes:0,recovery:null,pending:true});
  }finally{await f.close();}
},60_000);
