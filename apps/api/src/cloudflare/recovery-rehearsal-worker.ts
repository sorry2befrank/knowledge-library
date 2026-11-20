// Temporary staging-only signed synthetic rehearsal. No archive HTTP surface.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState,Request as WorkerRequest,Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { Catalog,importPublicKey,loadReferenceAdmissionRules,verifyAcceptance,bundleHash } from '@kl/core/worker';
import { runtimeReleaseState,type RuntimeReleasePort } from '../../../../packages/core/src/auth/runtime-release.ts';
import { readRuntimeConfig,type RuntimeConfig } from './runtime-config.ts';
import { RuntimeSafety,boundedRequest,responseDeadline,unavailable } from './runtime-safety.ts';
import { openDurableSql } from './sql-driver.ts';
import { R2ObjectStore } from './r2-store.ts';
import { boundedArchiveBucket } from './runtime-bucket.ts';
import { acceptRehearsalRelease,readRehearsalReceipt,parseRehearsalInventory,type RehearsalContext } from './recovery-rehearsal.ts';
declare const __KL_REHEARSAL_INVENTORY__:string;
type Bindings='RUNTIME_MODE'|'RUNTIME_CONFIG_COUNT'|`RUNTIME_CONFIG_${1|2|3|4|5|6|7|8}`;
type Env=Omit<CloudArchiveEnv,Bindings>&Record<Bindings,string>;
function config(env:Env):RuntimeConfig|undefined{try{const c=readRuntimeConfig(env);const i=parseRehearsalInventory(__KL_REHEARSAL_INVENTORY__);if(c.audience.environment==='staging'&&/^kl-api-staging\.[a-z0-9-]+\.workers\.dev$/.test(new URL(c.audience.origin).hostname)&&env.RUNTIME_MODE==='closed'&&c.audience.libraryId===i.libraryId)return c;}catch{}}
function route(req:{url:string;method:string},c:RuntimeConfig):string|undefined{
  const u=new URL(req.url);if(u.origin!==c.audience.origin||u.search)return;
  if(req.method==='GET'&&['/health','/v1/runtime/release','/rehearsal-result'].includes(u.pathname))return u.pathname;
  if(req.method==='POST'&&u.pathname==='/v1/runtime/release')return u.pathname;
}
export class LibraryDO extends DurableObject<Env>{
  private readonly safety:RuntimeSafety;private readonly cfg:RuntimeConfig|undefined;private pending=0;private statusPending=0;private ready:Promise<void>|undefined;private catalog:Catalog|undefined;
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.cfg=config(env);this.safety=new RuntimeSafety({get:k=>ctx.storage.get(k),put:(k,v)=>ctx.storage.put(k,v),delete:k=>ctx.storage.delete(k),sync:()=>ctx.storage.sync(),abort:r=>ctx.abort(r),waitUntil:p=>ctx.waitUntil(p)});}
  private trust(){return {approval:this.cfg!.approval,audience:this.cfg!.audience,now:()=>new Date().toISOString()};}
  private readPort():RuntimeReleasePort{return {proofs:new R2ObjectStore(boundedArchiveBucket(this.env.ARCHIVE,8192),1),get:k=>this.ctx.storage.get(k),put:async()=>{throw Error('read-only');},sync:async()=>{}};}
  private async context(wrote:()=>void):Promise<RehearsalContext>{
    const c=this.cfg!,store=this.safety.store(new R2ObjectStore(boundedArchiveBucket(this.env.ARCHIVE),100));
    if(!this.catalog){const policy={...c.policy,publicKey:await importPublicKey(c.policy.publicKeyB64)};
      if(!(await verifyAcceptance(c.policyAcceptance,bundleHash(c.policyBundle),policy)).ok)throw Error('rehearsal-refused');
      const rules=await loadReferenceAdmissionRules(c.policyBundle,c.policyAcceptance,policy);
      await this.ctx.blockConcurrencyWhile(async()=>{this.catalog=new Catalog({db:this.safety.sql(openDurableSql(this.ctx.storage)),blobStore:store,mirror:store,denyRules:rules});});
    }
    const proof=this.safety.store(new R2ObjectStore(boundedArchiveBucket(this.env.ARCHIVE,8192),1));
    return {catalog:this.catalog!,inventory:parseRehearsalInventory(__KL_REHEARSAL_INVENTORY__),durability:{store,libraryId:c.audience.libraryId,minPolicyEpoch:c.policy.minEpoch,maxSnapshotBytes:1024*1024},trust:this.trust(),versionId:this.env.VERSION?.id,onUncertain:wrote,
      port:{proofs:{...proof,put:(k,b,o)=>{wrote();return proof.put(k,b,o);}},get:k=>this.safety.run(()=>this.ctx.storage.get(k)),put:(k,v)=>{wrote();return this.safety.run(()=>this.ctx.storage.put(k,v));},sync:()=>this.safety.run(()=>this.ctx.storage.sync())}};
  }
  override async fetch(request:WorkerRequest):Promise<WorkerResponse>{
    const path=this.cfg&&route(request,this.cfg);if(!path)return unavailable() as WorkerResponse;
    if(request.method==='GET'&&path!=='/rehearsal-result'){
      if(this.statusPending)return unavailable() as WorkerResponse;this.statusPending++;
      const work=(async()=>{const release=await runtimeReleaseState(this.readPort(),this.trust());return Response.json(path==='/health'?{phase:'synthetic-recovery-rehearsal',versionId:this.env.VERSION?.id??null,mode:this.env.RUNTIME_MODE,release}:release,{headers:{'cache-control':'no-store'}});})().catch(()=>unavailable()).finally(()=>{this.statusPending--;});
      this.ctx.waitUntil(work);return await responseDeadline(work,10_000) as WorkerResponse;
    }
    if(this.pending||this.safety.held)return unavailable() as WorkerResponse;this.pending++;
    const work=(async()=>{try{
      await (this.ready??=this.safety.load());this.safety.check();
      if(request.method==='GET')return Response.json(await readRehearsalReceipt(await this.context(()=>{throw Error('read-only');})),{headers:{'cache-control':'no-store'}});
      const req=new Request(request.url,{method:request.method,body:request.body as ReadableStream<Uint8Array>,duplex:'half'} as RequestInit);const buffered=await boundedRequest(req,8192);let input:unknown;
      try{input=await buffered.json();}catch{return Response.json({error:'rehearsal-refused'},{status:400});}
      return await this.safety.mutation(async()=>{let wrote=false;
        try{return Response.json(await this.safety.run(async()=>acceptRehearsalRelease(input,await this.context(()=>{wrote=true;})),45_000),{headers:{'cache-control':'no-store'}});}
        catch{if(wrote)throw Error('archive-unavailable');return Response.json({error:'rehearsal-refused'},{status:400,headers:{'cache-control':'no-store'}});}
      });
    }catch{return unavailable();}finally{this.pending--;}})();this.ctx.waitUntil(work);return await responseDeadline(work,48_000) as WorkerResponse;
  }
  override async alarm():Promise<void>{ /* No scheduler or ordinary archive requests. */ }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{const c=config(env);if(!c||!route(request,c))return unavailable();try{return await responseDeadline(env.LIBRARY.get(env.LIBRARY.idFromName(c.audience.libraryId)).fetch(request) as Promise<Response>,49_000);}catch{return unavailable();}}};
