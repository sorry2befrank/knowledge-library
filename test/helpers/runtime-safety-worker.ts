// Synthetic deadline fault only; never bundled by the production entrypoint.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState,Request as WorkerRequest,Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { RuntimeSafety,SAFETY_HOLD_KEY } from '../../apps/api/src/cloudflare/runtime-safety.ts';
type Env={PROBE:DurableObjectNamespace<SafetyProbe>};
export class SafetyProbe extends DurableObject<Env>{
  private readonly safety:RuntimeSafety;
  private readonly loaded:Promise<void>;
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);
    this.safety=new RuntimeSafety({get:k=>ctx.storage.get(k),put:(k,v)=>ctx.storage.put(k,v),delete:k=>ctx.storage.delete(k),sync:()=>ctx.storage.sync(),abort:r=>ctx.abort(r),waitUntil:p=>ctx.waitUntil(p)},20);
    this.loaded=this.safety.load();
  }
  override async fetch(req:WorkerRequest):Promise<WorkerResponse>{
    await this.loaded;
    if(new URL(req.url).pathname==='/hang')await this.safety.run(()=>new Promise(()=>{}));
    if(new URL(req.url).pathname==='/write'){
      if(this.safety.held)return Response.json({held:true},{status:503}) as WorkerResponse;
      await this.ctx.storage.put('unexpected-write',true);
    }
    return Response.json({held:this.safety.held,hold:await this.ctx.storage.get(SAFETY_HOLD_KEY),wrote:!!await this.ctx.storage.get('unexpected-write')}) as WorkerResponse;
  }
}
export default {fetch(req:WorkerRequest,env:Env){return env.PROBE.get(env.PROBE.idFromName('deadline-probe')).fetch(req);}};
