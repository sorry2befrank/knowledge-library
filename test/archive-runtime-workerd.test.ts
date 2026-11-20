import { it,expect } from 'vitest';
import { Miniflare,type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { sha256Hex } from '@kl/core';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { parseRuntimeConfig,runtimeConfigBindings } from '../apps/api/src/cloudflare/runtime-config.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';

async function release(runtime:Miniflare,f:Awaited<ReturnType<typeof enrollmentFixture>>,mode:'active'|'closed'='active'){
  const health=await (await runtime.dispatchFetch('https://enrollment.invalid/health')).json() as {versionId:string;release:{revision:number;releaseHash:string}|null};
  expect(health.versionId).toMatch(/^[a-f0-9-]{36}$/);
  const now=new Date().toISOString();
  const signed=await signRuntimeRelease({purpose:'kl-runtime-release/v1',audience:f.claims.audience,versionId:health.versionId,
    revision:(health.release?.revision??0)+1,previousReleaseHash:health.release?.releaseHash??null,mode,nonce:sha256Hex(crypto.randomUUID()),issuedAt:now,
    expiresAt:new Date(Date.parse(now)+900_000).toISOString()},f.approvalKey.keyId,f.approvalKey.privateKey);
  const response=await runtime.dispatchFetch('https://enrollment.invalid/v1/runtime/release',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signed)});
  return {status:response.status,body:await response.json()};
}

it('real active host enrolls, seals, restarts, and preserves scoped reads across compatible closed rollback',async()=>{
  const f=await enrollmentFixture(new Date().toISOString());
  const parent=resolve('.review/archive-runtime');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'run-'));let runtime:Miniflare|undefined;
  try{
    const bundle=await build({entryPoints:['apps/api/src/cloudflare/archive-worker.ts'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']});
    const config={schema:'kl-owner-runtime/v1',audience:f.claims.audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},
      policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
    const options:MiniflareOptions={name:'archive-runtime',modules:true,script:bundle.outputFiles![0]!.text,compatibilityDate:'2026-07-30',versionMetadata:'VERSION',
      durableObjects:{LIBRARY:{className:'LibraryDO',useSQLite:true}},r2Buckets:['ARCHIVE'],
      durableObjectsPersist:join(root,'do'),r2Persist:join(root,'r2'),bindings:{RUNTIME_MODE:'active',...runtimeConfigBindings(parseRuntimeConfig(JSON.stringify(config)))}};
    runtime=new Miniflare(options);
    const device=f.tokens[0]!.token;
    const request=async(path:string,body:unknown,token?:string)=>{
      const res=await runtime!.dispatchFetch('https://enrollment.invalid'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      return {status:res.status,body:await res.json() as any};
    };
    expect((await request('/v1/multipart/start',{},device)).status).toBe(503);
    const wrongOrigin=await runtime.dispatchFetch('https://wrong.invalid/v1/enroll',{method:'POST',body:JSON.stringify({approval:f.approval,acceptance:f.acceptance})});
    expect(wrongOrigin.status).toBe(503);
    expect((await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).status).toBe(503);
    expect((await request('/v1/runtime/release',{bad:'unsigned'})).status).toBe(400);
    expect((await release(runtime,f)).status).toBe(200);
    const enrolled=await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance});
    expect(enrolled).toMatchObject({status:200,body:{state:'active',receiptId:f.claims.receiptId}});
    const bucket=await runtime.getR2Bucket('ARCHIVE');
    expect((await bucket.list({prefix:'snap/'})).objects.length).toBeGreaterThan(0);
    expect((await bucket.list({prefix:'anchors/'})).objects.length).toBeGreaterThan(0);
    const content='# Synthetic comet\nCobalt project notes remain discoverable.\n',digest=sha256Hex(content);
    const diff=await request('/v1/manifest/diff',{snapshotId:'runtime-upload',folderId:'folder:fixture',device:'fixture-device',collection:'col:fixture',
      identity:{volumeSerial:'node-dev:1',rootFileId:'node-ino:2'},scanComplete:true,heldLocal:{},entries:[{relPath:'overview.md',sha256:digest,size:Buffer.byteLength(content),mtime:f.trust.now(),gitTracked:false}]},device);
    expect(diff.status).toBe(200);
    expect((await request('/v1/batch',{pushId:diff.body.pushId,items:[{n:0,content}]},device)).status).toBe(200);
    const committed=await request('/v1/commit',{pushId:diff.body.pushId},device);
    expect(committed).toMatchObject({status:200,body:{partial:false,results:[{ok:true,custody:'verified'}]}});
    const cite=committed.body.results[0].cite;
    const tool=async(token:string,name:string,args:Record<string,unknown>)=>request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},token);
    for(const token of [f.tokens[1]!.token,f.tokens[2]!.token]){
      await expect.poll(async()=>JSON.stringify((await tool(token,'library_search',{q:'cobalt'})).body),{timeout:20_000,interval:250}).toContain(cite);
      const read=await tool(token,'library_read',{ref:cite});expect(JSON.stringify(read.body)).toContain('Cobalt project notes');
      expect((await request('/v1/save',{content:'denied',collection:'col:fixture'},token)).status).toBe(403);
    }
    await runtime.dispose();runtime=new Miniflare({...options,bindings:{...options.bindings,RUNTIME_MODE:'closed'}});await runtime.ready;
    const closedBucket=await runtime.getR2Bucket('ARCHIVE');const before=(await closedBucket.list()).objects.map(o=>o.key);
    expect((await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},f.tokens[1]!.token)).status).toBe(503);
    expect((await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).status).toBe(503);
    expect((await release(runtime,f)).status).toBe(503);
    expect((await closedBucket.list()).objects.map(o=>o.key)).toEqual(before);
    await runtime.dispose();runtime=new Miniflare(options);await runtime.ready;
    expect((await tool(f.tokens[2]!.token,'library_read',{ref:cite})).status).toBe(503);
    expect((await release(runtime,f)).status).toBe(200);
    expect(JSON.stringify((await tool(f.tokens[2]!.token,'library_read',{ref:cite})).body)).toContain('Cobalt project notes');
    expect((await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).body).toEqual(enrolled.body);
    const stored=await (await runtime.getR2Bucket('ARCHIVE')).list();
    for(const o of stored.objects){if(o.key.startsWith('authz/')||o.key.startsWith('anchors/')){
      const text=await (await (await runtime.getR2Bucket('ARCHIVE')).get(o.key))!.text();
      for(const token of f.tokens)expect(text).not.toContain(token.token);
    }}
  }finally{
    await runtime?.dispose();f.db.close();const child=relative(parent,resolve(root));
    if(!child||child.startsWith('..')||isAbsolute(child))throw Error('unsafe-fixture-cleanup');
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},90_000);

it('retries only the original signed enrollment after a checkpoint-to-seal crash and keeps ordinary tokens closed meanwhile',async()=>{
  const f=await enrollmentFixture(new Date().toISOString());
  const parent=resolve('.review/archive-runtime');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'retry-'));let runtime:Miniflare|undefined;
  try{
    const config={schema:'kl-owner-runtime/v1',audience:f.claims.audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},
      policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
    const bundle=async(entry:string)=>(await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']})).outputFiles![0]!.text;
    const options:MiniflareOptions={name:'archive-runtime',modules:true,script:await bundle('test/helpers/runtime-unsealed-worker.ts'),compatibilityDate:'2026-07-30',
      durableObjects:{LIBRARY:{className:'LibraryDO',useSQLite:true}},r2Buckets:['ARCHIVE'],durableObjectsPersist:join(root,'do'),r2Persist:join(root,'r2'),
      bindings:{RUNTIME_MODE:'active',...runtimeConfigBindings(parseRuntimeConfig(JSON.stringify(config)))}};
    runtime=new Miniflare(options);
    const post=async(path:string,body:unknown,token?:string)=>{
      const res=await runtime!.dispatchFetch('https://enrollment.invalid'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      return {status:res.status,body:await res.json()};
    };
    expect((await post('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).status).toBe(200);
    const bucket=await runtime.getR2Bucket('ARCHIVE');expect((await bucket.list({prefix:'authz/'})).objects.length).toBe(1);
    expect((await bucket.list({prefix:'anchors/'})).objects.length).toBe(0);
    await runtime.dispose();runtime=new Miniflare({...options,script:await bundle('apps/api/src/cloudflare/archive-worker.ts'),versionMetadata:'VERSION'});await runtime.ready;
    expect((await release(runtime,f)).status).toBe(200);
    const statusRequest={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'library_status',arguments:{}}};
    expect((await post('/mcp',statusRequest,f.tokens[1]!.token)).status).toBe(503);
    const changed=await f.resign({...f.claims,nonce:sha256Hex('replacement-is-not-retry')});
    expect((await post('/v1/enroll',{approval:changed,acceptance:f.acceptance})).status).toBe(409);
    expect((await post('/mcp',statusRequest,f.tokens[1]!.token)).status).toBe(503);
    expect((await post('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).status).toBe(200);
    expect((await post('/mcp',statusRequest,f.tokens[1]!.token)).status).toBe(200);
    expect((await (await runtime.getR2Bucket('ARCHIVE')).list({prefix:'anchors/'})).objects.length).toBeGreaterThan(0);
  }finally{
    await runtime?.dispose();f.db.close();const child=relative(parent,resolve(root));
    if(!child||child.startsWith('..')||isAbsolute(child))throw Error('unsafe-fixture-cleanup');
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},60_000);
