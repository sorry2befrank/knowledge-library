// Temporary staging-only artifact; never a dependency of archive-worker.ts.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import type { ObjectStore } from '../../../../packages/core/src/catalog/blobs.ts';
import { runtimeReleaseState, type RuntimeReleasePort } from '../../../../packages/core/src/auth/runtime-release.ts';
import { readRuntimeConfig, type RuntimeConfig } from './runtime-config.ts';
import { RuntimeSafety, boundedRequest, responseDeadline, unavailable } from './runtime-safety.ts';
import { boundedArchiveBucket } from './runtime-bucket.ts';
import { R2ObjectStore } from './r2-store.ts';
import { acceptProbeRelease, readProbeReceipt, protectedProbeStore, type ProbeContext } from './synthetic-probe.ts';
type Bindings='RUNTIME_MODE'|'RUNTIME_CONFIG_COUNT'|`RUNTIME_CONFIG_${1|2|3|4|5|6|7|8}`;
type Env=Omit<CloudArchiveEnv,Bindings>&Record<Bindings,string>&{DECOY:CloudArchiveEnv['ARCHIVE']};
function config(env:Env):RuntimeConfig|undefined {
  try{const c=readRuntimeConfig(env);if(c.audience.environment==='staging'&&env.RUNTIME_MODE==='closed')return c;}catch{}
}
function route(req:{url:string;method:string},c:RuntimeConfig):string|undefined{
  const u=new URL(req.url);if(u.origin!==c.audience.origin||u.search)return;
  if(req.method==='GET'&&['/health','/v1/runtime/release','/probe-result'].includes(u.pathname))return u.pathname;
  if(req.method==='POST'&&u.pathname==='/v1/runtime/release')return u.pathname;
}
function tracking(store:ObjectStore,wrote:()=>void):ObjectStore{return {
  get:key=>store.get(key),list:prefix=>store.list(prefix),
  put:(key,bytes,options)=>{wrote();return store.put(key,bytes,options);},
  delete:key=>{wrote();return store.delete(key);},
};}
export class LibraryDO extends DurableObject<Env>{
  private readonly safety:RuntimeSafety;private readonly cfg:RuntimeConfig|undefined;
  private pending=0;private statusPending=0;private ready:Promise<void>|undefined;
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.cfg=config(env);
    this.safety=new RuntimeSafety({get:key=>ctx.storage.get(key),put:(key,value)=>ctx.storage.put(key,value),delete:key=>ctx.storage.delete(key),sync:()=>ctx.storage.sync(),abort:reason=>ctx.abort(reason),waitUntil:p=>ctx.waitUntil(p)});
  }
  private trust(){return {approval:this.cfg!.approval,audience:this.cfg!.audience,now:()=>new Date().toISOString()};}
  private readPort():RuntimeReleasePort{return {proofs:new R2ObjectStore(boundedArchiveBucket(this.env.ARCHIVE,8192),1),get:key=>this.ctx.storage.get(key),put:async()=>{throw Error('read-only');},sync:async()=>{}};}
  private context(wrote:()=>void):ProbeContext {
    const archive=tracking(protectedProbeStore(this.safety,new R2ObjectStore(boundedArchiveBucket(this.env.ARCHIVE,8192),1)),wrote);
    return {archive,decoy:tracking(protectedProbeStore(this.safety,new R2ObjectStore(boundedArchiveBucket(this.env.DECOY,8192),1)),wrote),trust:this.trust(),versionId:this.env.VERSION?.id,onUncertain:wrote,
      port:{proofs:archive,get:key=>this.safety.run(()=>this.ctx.storage.get(key)),put:(key,value)=>{wrote();return this.safety.run(()=>this.ctx.storage.put(key,value));},sync:()=>this.safety.run(()=>this.ctx.storage.sync())}};
  }
  override async fetch(request:WorkerRequest):Promise<WorkerResponse>{
    const path=this.cfg&&route(request,this.cfg);if(!path)return unavailable() as WorkerResponse;
    if(request.method==='GET'&&path!=='/probe-result'){
      if(this.statusPending)return unavailable() as WorkerResponse;this.statusPending++;
      const work=(async()=>{const release=await runtimeReleaseState(this.readPort(),this.trust());
        return Response.json(path==='/health'?{phase:'synthetic-storage-probe',versionId:this.env.VERSION?.id??null,mode:this.env.RUNTIME_MODE,release}:release,{headers:{'cache-control':'no-store'}});
      })().catch(()=>unavailable()).finally(()=>{this.statusPending--;});
      this.ctx.waitUntil(work);return await responseDeadline(work,10_000) as WorkerResponse;
    }
    if(this.pending||this.safety.held)return unavailable() as WorkerResponse;this.pending++;
    const work=(async()=>{try{
      await (this.ready??=this.safety.load());this.safety.check();
      if(request.method==='GET'){
        return Response.json(await readProbeReceipt(this.context(()=>{throw Error('read-only');})),{headers:{'cache-control':'no-store'}});
      }
      const req=new Request(request.url,{method:request.method,body:request.body as ReadableStream<Uint8Array>,duplex:'half'} as RequestInit);
      const buffered=await boundedRequest(req,8192);let input:unknown;
      try{input=await buffered.json();}catch{return Response.json({error:'probe-refused'},{status:400});}
      // This separate probe binary has no archive API. Its closed packaging
      // mode never grants access: only an exact-version signed release runs it.
      return await this.safety.mutation(async()=>{let wrote=false;
        // 8.8 seconds fixed pacing + bounded storage within 15 seconds total.
        // An unknown outcome keeps the durable hold; the 18-second response
        // deadline leaves margin under the owner's 20-second fetch deadline.
        try{return Response.json(await this.safety.run(()=>acceptProbeRelease(input,this.context(()=>{wrote=true;})),15_000),{headers:{'cache-control':'no-store'}});}
        catch{if(wrote)throw Error('archive-unavailable');return Response.json({error:'probe-refused'},{status:400,headers:{'cache-control':'no-store'}});}
      });
    }catch{return unavailable();}finally{this.pending--;}})();
    this.ctx.waitUntil(work);return await responseDeadline(work,18_000) as WorkerResponse;
  }
  override async alarm():Promise<void>{ /* No catalogue, scheduler or source data in this artifact. */ }
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
  const c=config(env);if(!c||!route(request,c))return unavailable();
  try{return await responseDeadline(env.LIBRARY.get(env.LIBRARY.idFromName(c.audience.libraryId)).fetch(request) as Promise<Response>);}catch{return unavailable();}
}};
