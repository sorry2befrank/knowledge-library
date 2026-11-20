import { it,expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { parseRuntimeConfig,runtimeConfigBindings } from '../apps/api/src/cloudflare/runtime-config.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';
it('real probe Worker stays data-closed, requires signed native release, measures unlocked emulator honestly, retries without effects and closes',async()=>{
  const f=await enrollmentFixture(new Date().toISOString());let runtime:Miniflare|undefined;
  try{
    const bundle=await build({entryPoints:['apps/api/src/cloudflare/synthetic-probe-worker.ts'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']});
    const config={schema:'kl-owner-runtime/v1',audience:f.claims.audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
    runtime=new Miniflare({name:'synthetic-probe',modules:true,script:bundle.outputFiles![0]!.text,compatibilityDate:'2026-07-30',versionMetadata:'VERSION',durableObjects:{LIBRARY:{className:'LibraryDO',useSQLite:true}},r2Buckets:['ARCHIVE','DECOY'],bindings:{RUNTIME_MODE:'closed',...runtimeConfigBindings(parseRuntimeConfig(JSON.stringify(config)))}});
    const get=(path:string)=>runtime!.dispatchFetch('https://enrollment.invalid'+path);
    const post=(input:unknown)=>runtime!.dispatchFetch('https://enrollment.invalid/v1/runtime/release',{method:'POST',body:JSON.stringify(input)});
    expect((await get('/probe-result')).status).toBe(503);expect((await get('/mcp')).status).toBe(503);
    expect((await post({unsigned:true})).status).toBe(400);
    const health=await (await get('/health')).json() as {versionId:string};const now=new Date().toISOString();
    const packet=await signRuntimeRelease({purpose:'kl-runtime-release/v1',audience:f.claims.audience,versionId:health.versionId,revision:1,previousReleaseHash:null,mode:'active',nonce:'4'.repeat(64),issuedAt:now,expiresAt:new Date(Date.parse(now)+600_000).toISOString()},f.approvalKey.keyId,f.approvalKey.privateKey);
    expect((await runtime.dispatchFetch('https://wrong.invalid/v1/runtime/release',{method:'POST',body:JSON.stringify(packet)})).status).toBe(503);
    const response=await post(packet);expect(response.status).toBe(200);const state=await response.json() as {releaseHash:string};
    const receipt=await (await get('/probe-result')).json();expect(receipt).toMatchObject({schema:'kl-synthetic-probe/v1',versionId:health.versionId,lockEnforcementPassed:false,locks:{tested:3,overwriteDenied:0,deleteDenied:0,originalsIntact:0},sameAccountBinding:{readWriteAccessible:true,markerRemoved:true}});
    const archive=await runtime.getR2Bucket('ARCHIVE'),before=(await archive.list()).objects.map(o=>o.key);
    expect(before).toHaveLength(2);expect(before.some(k=>k.startsWith('anchors/runtime-release/'))).toBe(true);
    expect(before).toContain('anchors/probe-run/'+health.versionId+'.json');expect((await (await runtime.getR2Bucket('DECOY')).list()).objects).toEqual([]);
    expect((await post(packet)).status).toBe(200);expect((await archive.list()).objects.map(o=>o.key)).toEqual(before);
    const closed=await signRuntimeRelease({...packet.claims,revision:2,previousReleaseHash:state.releaseHash,mode:'closed'},f.approvalKey.keyId,f.approvalKey.privateKey);
    expect((await post(closed)).status).toBe(200);expect((await get('/probe-result')).status).toBe(503);
  }finally{await runtime?.dispose();f.db.close();}
},60_000);
