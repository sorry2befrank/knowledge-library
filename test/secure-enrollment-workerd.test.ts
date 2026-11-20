import { it,expect } from 'vitest';
import { Miniflare,type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join,relative,isAbsolute } from 'node:path';
import { sha256Hex } from '@kl/core';
import { main } from '../cli/kl/src/kl.ts';
import { enrollmentFixture } from './helpers/enrollment.ts';

it('enrolls without setup bypass, restarts, uploads and retrieves the same citation through both CLI client classes',async()=>{
  const f=await enrollmentFixture(new Date().toISOString());
  const parent=resolve('.review/secure-enrollment-runtime');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'run-'));let runtime:Miniflare|undefined;
  try{
    const bundle=await build({entryPoints:['test/helpers/enrollment-worker.ts'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']});
    const options:MiniflareOptions={name:'enrollment-runtime',modules:true,script:bundle.outputFiles![0]!.text,compatibilityDate:'2026-07-30',
      durableObjects:{LIBRARY:{className:'EnrollmentHarness',useSQLite:true}},r2Buckets:['ARCHIVE','MIRROR'],
      durableObjectsPersist:join(root,'do'),r2Persist:join(root,'r2'),bindings:{SYNTHETIC_FIXTURE:'signed-enrollment-test-only',
        POLICY_BUNDLE:JSON.stringify(f.bundle),POLICY_ACCEPTANCE:JSON.stringify(f.acceptance),POLICY_PUBLIC_KEY:f.policyKey.publicKeyB64,
        POLICY_KEY_ID:f.policyKey.keyId,APPROVAL_PUBLIC_KEY:f.approvalKey.publicKeyB64,APPROVAL_KEY_ID:f.approvalKey.keyId}};
    runtime=new Miniflare(options);
    const device=f.tokens[0]!.token;
    const request=async(path:string,body:unknown,token?:string)=>{
      const res=await runtime!.dispatchFetch('https://enrollment.invalid'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      try { return {status:res.status,body:await res.json() as any}; }
      catch(cause) { throw new Error(`synthetic runtime response failed: ${path} (${res.status})`,{cause}); }
    };
    const before=await runtime.dispatchFetch('https://enrollment.invalid/v1/version/unknown/bytes',{headers:{authorization:`Bearer ${device}`}});
    expect(before.status).toBe(401);expect(await before.json()).toMatchObject({error:'unauthorized'});
    const enrolled=await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance});
    expect(enrolled).toMatchObject({status:200,body:{state:'active',receiptId:f.claims.receiptId}});
    const checkpoint=await (await runtime.getR2Bucket('MIRROR')).get(`authz/${String(enrolled.body.authzSeq).padStart(12,'0')}.json`);
    expect(checkpoint).not.toBeNull();const serialized=await checkpoint!.text();
    for(const t of f.tokens)expect(serialized).not.toContain(t.token);
    await runtime.dispose();runtime=new Miniflare(options);await runtime.ready;
    expect((await request('/v1/enroll',{approval:f.approval,acceptance:f.acceptance})).body).toEqual(enrolled.body);
    const altered=await f.resign({...f.claims,nonce:sha256Hex('different-approved-nonce')});
    expect((await request('/v1/enroll',{approval:altered,acceptance:f.acceptance})).status).toBe(409);
    const content='# Synthetic comet\nCobalt project notes remain discoverable.\n',digest=sha256Hex(content);
    const diff=await request('/v1/manifest/diff',{snapshotId:'signed-enrollment-upload',folderId:'folder:fixture',device:'fixture-device',collection:'col:fixture',
      identity:{volumeSerial:'node-dev:1',rootFileId:'node-ino:2'},scanComplete:true,heldLocal:{},entries:[{relPath:'overview.md',sha256:digest,size:Buffer.byteLength(content),mtime:f.trust.now(),gitTracked:false}]},device);
    expect(diff.status).toBe(200);
    expect((await request('/v1/batch',{pushId:diff.body.pushId,items:[{n:0,content}]},device)).status).toBe(200);
    const committed=await request('/v1/commit',{pushId:diff.body.pushId},device);
    expect(committed).toMatchObject({status:200,body:{partial:false,results:[{ok:true,custody:'verified'}]}});
    const cite=committed.body.results[0].cite;
    await runtime.dispose();runtime=new Miniflare(options);await runtime.ready;
    const fetcher:typeof fetch=async(input,init)=>{
      const response=await runtime!.dispatchFetch(String(input),init as Parameters<Miniflare['dispatchFetch']>[1]);
      return new Response(await response.arrayBuffer(),{status:response.status,headers:Object.fromEntries(response.headers)});
    };
    for(const [kind,index] of [['cc',1],['cx',2]] as const){
      let output='',errors='';
      const io={stdout:(s:string)=>{output+=s;},stderr:(s:string)=>{errors+=s;},env:{[kind==='cc'?'KL_TOKEN_CC':'KL_TOKEN_CX']:f.tokens[index]!.token},fetch:fetcher,platform:'linux'};
      await expect.poll(async()=>{output='';errors='';const code=await main(['search','cobalt','--as',kind,'--json','--url','https://enrollment.invalid'],io);return code===0&&output.includes(cite);},{timeout:15_000,interval:100}).toBe(true);
      output='';expect(await main(['read',cite,'--as',kind,'--json','--url','https://enrollment.invalid'],io)).toBe(0);
      expect(output).toContain(digest);expect(output).toContain('Cobalt project notes');expect(errors).toBe('');
      expect((await request('/v1/save',{content:'not allowed',collection:'col:fixture'},f.tokens[index]!.token)).status).toBe(403);
    }
  }finally{
    await runtime?.dispose();f.db.close();const child=relative(parent,resolve(root));
    if(!child||child.startsWith('..')||isAbsolute(child))throw Error('unsafe-fixture-cleanup');
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},90_000);
