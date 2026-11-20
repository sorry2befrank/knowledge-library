import type { ObjectStore } from '../../../../packages/core/src/catalog/blobs.ts';
import type { SqlDriver } from '../../../../packages/core/src/catalog/driver.ts';

export const SAFETY_HOLD_KEY='archive-runtime-safety-hold';
export const PENDING_EFFECT_KEY='archive-runtime-pending-effect';
interface HoldPort {
  get(key:string):Promise<unknown>;
  put(key:string,value:unknown):Promise<void>;
  delete(key:string):Promise<boolean>;
  sync():Promise<void>;
  abort(reason:string):void;
  waitUntil(promise:Promise<unknown>):void;
}
/** An R2 timeout is not cancellation. Never release the serialized producer while
 * its effects may still finish. Persist a hold, then reset the DO. If either step
 * fails, poison this instance and retain the pending queue until it is evicted. */
export class RuntimeSafety {
  private poisoned=false;
  private readonly port:HoldPort;
  private readonly deadline:number;
  constructor(port:HoldPort,deadline=10_000){this.port=port;this.deadline=deadline;}
  get held():boolean{return this.poisoned;}
  async load():Promise<void>{
    try{
      // Bound storage reads before poisoning. Call load() directly: run() never
      // settles effects that poison the instance, including this state transition.
      const held=await this.run(async()=>await this.port.get(SAFETY_HOLD_KEY)!==undefined||
        await this.port.get(PENDING_EFFECT_KEY)!==undefined);
      if(held)this.poisoned=true;
    }catch{
      this.poisoned=true;throw Error('archive-unavailable');
    }
  }
  check():void{if(this.poisoned)throw Error('archive-unavailable');}
  run<T>(effect:()=>Promise<T>,milliseconds=this.deadline):Promise<T>{
    this.check();
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.poison();},milliseconds);
      Promise.resolve().then(()=>{this.check();return effect();}).then(value=>{
        clearTimeout(timer);if(!this.poisoned)resolve(value);
      },()=>{
        clearTimeout(timer);if(!this.poisoned)reject(Error('archive-unavailable'));
      });
    });
  }
  /** Persist intent BEFORE mutations; even a failed timeout-hold write cannot
   * reopen the next instance. The callback includes complete seal/readback. */
  async mutation<T>(effect:()=>Promise<T>):Promise<T>{
    this.check();
    await this.run(()=>this.port.put(PENDING_EFFECT_KEY,{schema:'kl-runtime-effect/v1'}));
    await this.run(()=>this.port.sync());
    try{
      const result=await this.run(effect,45_000);
      await this.run(()=>this.port.delete(PENDING_EFFECT_KEY));await this.run(()=>this.port.sync());
      return result;
    }catch{
      // The effect settled before rejecting. Keep persisted pending intent for
      // explicit operator reconciliation, rather than widening automatic retry.
      this.poisoned=true;throw Error('archive-unavailable');
    }
  }
  private poison():void{
    if(this.poisoned)return;
    this.poisoned=true;
    // No note names, object keys, exception text, tokens, or request IDs in holds/logs.
    const persist=this.port.put(SAFETY_HOLD_KEY,{schema:'kl-runtime-hold/v1',reason:'deadline'}).then(()=>this.port.sync()).then(()=>{
      this.port.abort('archive-runtime-held');
    }).catch(()=>{/* Failed persistence/reset cannot reopen this instance. */});
    this.port.waitUntil(persist);
  }
  store(store:ObjectStore):ObjectStore{
    return {put:(k,b,o)=>this.run(()=>store.put(k,b,o)),get:k=>this.run(()=>store.get(k)),
      delete:k=>this.run(()=>store.delete(k)),list:p=>this.run(()=>store.list(p))};
  }
  sql(db:SqlDriver):SqlDriver {
    // Late async continuations after an I/O timeout cannot mutate the projection.
    return {exec:q=>{this.check();db.exec(q);},run:(q,p)=>{this.check();return db.run(q,p);},
      all:<T>(q:string,p?:Parameters<SqlDriver['all']>[1])=>{this.check();return db.all<T>(q,p);},
      get:<T>(q:string,p?:Parameters<SqlDriver['get']>[1])=>{this.check();return db.get<T>(q,p);},
      transaction:<T>(fn:()=>T)=>{this.check();return db.transaction(fn);},inTransaction:()=>db.inTransaction(),close:()=>db.close()};
  }
}

/** Body deadlines run before any serialized catalog operation. Cancellation can
 * itself hang for an adversarial stream, so it is deliberately not awaited. */
export async function boundedRequest(request:Request,limit:number,milliseconds=10_000):Promise<Request>{
  if(!request.body)return request;
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let length=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('request-timeout'));void reader.cancel().catch(()=>{});},milliseconds);});
  try{
    while(true){
      const {done,value}=await Promise.race([reader.read(),expired]);if(done)break;
      if(value.byteLength>limit-length){void reader.cancel().catch(()=>{});throw Error('request-too-large');}
      length+=value.byteLength;chunks.push(value);
    }
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const headers=new Headers(request.headers);headers.delete('content-length');
    return new Request(request.url,{method:request.method,headers,body:bytes});
  }finally{clearTimeout(timer);reader.releaseLock();}
}

/** Bound the client's wait without releasing/abandoning the internal producer. */
export async function responseDeadline(work:Promise<Response>,milliseconds=55_000):Promise<Response>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<Response>(resolve=>{timer=setTimeout(()=>resolve(unavailable()),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
export function unavailable():Response{return Response.json({error:'archive-unavailable'},{status:503,headers:{'cache-control':'no-store','retry-after':'30'}});}
