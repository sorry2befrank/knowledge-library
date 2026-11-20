// Synthetic runtime host only. It uses the actual signed enrollment route;
// no constructor principal creation, magic tokens, setup mode or drain route.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, Request as WorkerRequest, Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { Catalog, importPublicKey, loadReferenceAdmissionRules } from '@kl/core/worker';
import { createApiHandler } from '../../apps/api/src/handler.ts';
import { openDurableSql } from '../../apps/api/src/cloudflare/sql-driver.ts';
import { R2ObjectStore, type ArchiveBucket } from '../../apps/api/src/cloudflare/r2-store.ts';
import { OutboxScheduler } from '../../apps/api/src/cloudflare/outbox-scheduler.ts';
interface Env {
  SYNTHETIC_FIXTURE:string; POLICY_BUNDLE:string; POLICY_ACCEPTANCE:string;
  POLICY_PUBLIC_KEY:string; POLICY_KEY_ID:string; APPROVAL_PUBLIC_KEY:string; APPROVAL_KEY_ID:string;
  ARCHIVE:ArchiveBucket; MIRROR:ArchiveBucket;
  LIBRARY:{idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
}
export class EnrollmentHarness extends DurableObject<Env> {
  private api!: (req:Request)=>Promise<Response>;
  private scheduler!: OutboxScheduler;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    if(env.SYNTHETIC_FIXTURE!=='signed-enrollment-test-only')throw Error('fixture-required');
    ctx.blockConcurrencyWhile(async()=>{
      const bundle=JSON.parse(env.POLICY_BUNDLE),acceptance=JSON.parse(env.POLICY_ACCEPTANCE);
      const policy={publicKey:await importPublicKey(env.POLICY_PUBLIC_KEY),keyId:env.POLICY_KEY_ID,minEpoch:1,policyHash:acceptance.policyHash};
      const catalog=new Catalog({db:openDurableSql(ctx.storage),blobStore:new R2ObjectStore(env.ARCHIVE),mirror:new R2ObjectStore(env.MIRROR),
        denyRules:await loadReferenceAdmissionRules(bundle,acceptance,policy)});
      this.scheduler=new OutboxScheduler({catalog,alarms:ctx.storage,minDelayMs:25});
      await this.scheduler.recover();
      this.api=createApiHandler({catalog,enrollmentTrust:{approval:{publicKeyB64:env.APPROVAL_PUBLIC_KEY,keyId:env.APPROVAL_KEY_ID},policy,
        audience:{origin:'https://enrollment.invalid',environment:'staging',libraryId:'library-fixture'},now:()=>catalog.clock.now()}});
    });
  }
  override async fetch(request:WorkerRequest):Promise<WorkerResponse>{
    const init:RequestInit&{duplex?:'half'}={method:request.method,headers:Object.fromEntries(request.headers),body:request.body as ReadableStream<Uint8Array>|null};
    if(request.body)init.duplex='half';
    return await this.scheduler.run(()=>this.api(new Request(request.url,init))) as WorkerResponse;
  }
  override async alarm():Promise<void>{await this.scheduler.alarm();}
}
export default {fetch(req:Request,env:Env){return env.LIBRARY.get(env.LIBRARY.idFromName('library-fixture')).fetch(req);}};
