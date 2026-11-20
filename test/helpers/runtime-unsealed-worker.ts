// Simulate a crash after signed enrollment checkpoint and before its first seal.
// Fixture-only host uses the real verifier and never accepts token/identity shortcuts.
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState,Request as WorkerRequest,Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { Catalog,importPublicKey,loadReferenceAdmissionRules } from '@kl/core/worker';
import { readRuntimeConfig } from '../../apps/api/src/cloudflare/runtime-config.ts';
import { createApiHandler } from '../../apps/api/src/handler.ts';
import { openDurableSql } from '../../apps/api/src/cloudflare/sql-driver.ts';
import { R2ObjectStore } from '../../apps/api/src/cloudflare/r2-store.ts';
type Env={ARCHIVE:R2Bucket;LIBRARY:DurableObjectNamespace<LibraryDO>} & Record<`RUNTIME_CONFIG_${number}`|'RUNTIME_CONFIG_COUNT',string>;
export class LibraryDO extends DurableObject<Env>{
  private readonly ready:Promise<void>;private api!:ReturnType<typeof createApiHandler>;
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);this.ready=(async()=>{
    const c=readRuntimeConfig(env),policy={...c.policy,publicKey:await importPublicKey(c.policy.publicKeyB64)};
    const store=new R2ObjectStore(env.ARCHIVE),catalog=new Catalog({db:openDurableSql(ctx.storage),blobStore:store,mirror:store,
      denyRules:await loadReferenceAdmissionRules(c.policyBundle,c.policyAcceptance,policy)});
    this.api=createApiHandler({catalog,enrollmentTrust:{approval:c.approval,policy,audience:c.audience,now:()=>catalog.clock.now()}});
  })();}
  override async fetch(req:WorkerRequest):Promise<WorkerResponse>{await this.ready;
    if(new URL(req.url).pathname!=='/v1/enroll')return new Response(null,{status:404}) as WorkerResponse;
    return await this.api(new Request(req.url,{method:req.method,headers:Object.fromEntries(req.headers),body:await req.arrayBuffer()})) as WorkerResponse;
  }
}
export default {fetch(req:WorkerRequest,env:Env){const c=readRuntimeConfig(env);return env.LIBRARY.get(env.LIBRARY.idFromName(c.audience.libraryId)).fetch(req);}};
