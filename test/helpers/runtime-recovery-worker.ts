// Test-only fault/observation adapter around the actual production DO. It has no
// recovery implementation, enrollment shortcut, or authority-changing endpoint.
import type { DurableObjectState,Request as WorkerRequest,Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';
import { LibraryDO as ProductionLibraryDO } from '../../apps/api/src/cloudflare/archive-worker.ts';
import { readRuntimeConfig } from '../../apps/api/src/cloudflare/runtime-config.ts';
import { PENDING_EFFECT_KEY,SAFETY_HOLD_KEY } from '../../apps/api/src/cloudflare/runtime-safety.ts';
type Env=ConstructorParameters<typeof ProductionLibraryDO>[1]&{FAIL_SNAPSHOT_READ?:string};
export class LibraryDO extends ProductionLibraryDO {
  private readonly observation:DurableObjectState;
  private readonly counts:{snapshots:number};
  constructor(ctx:DurableObjectState,env:Env){
    const counts={snapshots:0};
    const bucket=new Proxy(env.ARCHIVE,{get(target,prop){
      if(prop==='get')return async(key:string)=>{
        if(key.startsWith('snap/')&&++counts.snapshots===Number(env.FAIL_SNAPSHOT_READ))throw Error('synthetic-readback-failure');
        return target.get(key);
      };
      const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
    }});
    super(ctx,{...env,ARCHIVE:bucket});this.observation=ctx;this.counts=counts;
  }
  override async fetch(request:WorkerRequest):Promise<WorkerResponse>{
    if(new URL(request.url).pathname==='/test/projection'&&request.method==='GET'){
      const sql=this.observation.storage.sql;
      const row=(query:string)=>sql.exec(query).toArray()[0];
      return Response.json({head:row('SELECT COUNT(*) AS n FROM events')?.n,
        notes:row('SELECT COUNT(*) AS n FROM notes')?.n,
        revoked:row('SELECT COUNT(*) AS n FROM tokens WHERE revokedAt IS NOT NULL')?.n,
        recovery:row("SELECT value FROM meta WHERE key='recovery_state'")?.value??null,
        pending:await this.observation.storage.get(PENDING_EFFECT_KEY)!==undefined,
        held:await this.observation.storage.get(SAFETY_HOLD_KEY)!==undefined,
        snapshotReads:this.counts.snapshots}) as WorkerResponse;
    }
    return super.fetch(request);
  }
}
export default {fetch(request:WorkerRequest,env:Env){
  const config=readRuntimeConfig(env);return env.LIBRARY.get(env.LIBRARY.idFromName(config.audience.libraryId)).fetch(request);
}};
