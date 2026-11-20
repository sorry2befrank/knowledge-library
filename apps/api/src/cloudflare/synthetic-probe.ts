// Temporary reviewed hosting probe. Never imported by the archive runtime.
import type { ObjectStore } from '../../../../packages/core/src/catalog/blobs.ts';
import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { acceptRuntimeRelease, runtimeIsReleased, runtimeReleaseState, type RuntimeReleasePort, type RuntimeReleaseTrust, type RuntimeReleaseState } from '../../../../packages/core/src/auth/runtime-release.ts';
import type { RuntimeSafety } from './runtime-safety.ts';

/** Preserve a single sanitized provider classification inside RuntimeSafety's
 * guarded effect; all other exceptions keep its fixed unavailable diagnostic. */
export function protectedProbeStore(safety:RuntimeSafety,store:ObjectStore):ObjectStore{
  return {get:k=>safety.run(()=>store.get(k)),list:p=>safety.run(()=>store.list(p)),
    async put(k,b,o){
      const outcome=await safety.run(async()=>{try{return {locked:false as const,value:await store.put(k,b,o)};}catch(error){lockDenial(error,'put');return {locked:true as const};}});
      if(outcome.locked)throw Error('put: Object locked by bucket policy (10069)');return outcome.value;
    },
    async delete(k){
      const locked=await safety.run(async()=>{try{await store.delete(k);return false;}catch(error){lockDenial(error,'delete');return true;}});
      if(locked)throw Error('delete: Object locked by bucket policy (10069)');
    },
  };
}

export const PROBE_BYTES=new TextEncoder().encode('kl-retention-probe/v1\n');
const OTHER_BYTES=new TextEncoder().encode('kl-retention-probe/overwrite-attempt/v1\n');
const eq=(a:Uint8Array|undefined,b:Uint8Array)=>a!==undefined&&sha256Hex(a)===sha256Hex(b);
const hex=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
// Cloudflare's Workers binding documents a terminal numeric error code:
// https://developers.cloudflare.com/r2/api/error-codes/ — 10069 specifically
// means ObjectLockedByBucketPolicy. A network/permission/rate-limit failure is
// not retention evidence; unknown formats require manual reconciliation.
function lockDenial(error:unknown,operation:'put'|'delete'):void{
  if(!(error instanceof Error)||error.message.length>1024||
    !new RegExp('^'+operation+': [^\\r\\n]* \\(10069\\)$').test(error.message))throw Error('probe-lock-inconclusive');
}
export interface ProbeReceipt {
  schema:'kl-synthetic-probe/v1'; versionId:string; releaseHash:string;
  locks:{tested:3;overwriteDenied:number;deleteDenied:number;originalsIntact:number};
  lockEnforcementPassed:boolean;
  stagingControl:{readWriteAccessible:boolean;markerRemoved:boolean};
  sameAccountBinding:{readWriteAccessible:boolean;markerRemoved:boolean};
}
export interface ProbeContext {port:RuntimeReleasePort;trust:RuntimeReleaseTrust;versionId:string;archive:ObjectStore;decoy:ObjectStore;pause?:()=>Promise<void>;onUncertain?:()=>void}
// R2 permits one write/second/key. No retries or arbitrary duration input.
const mutationPause=()=>new Promise<void>(resolve=>setTimeout(resolve,1100));
function key(versionId:string):string {if(!uuid(versionId))throw Error('probe-refused');return 'archive-synthetic-probe/'+versionId;}
function runKey(versionId:string):string {if(!uuid(versionId))throw Error('probe-refused');return 'anchors/probe-run/'+versionId+'.json';}
function runBytes(versionId:string,releaseHash:string):Uint8Array{return new TextEncoder().encode(canonicalJson({schema:'kl-synthetic-probe-run/v1',versionId,releaseHash}));}
function uncertain(context:ProbeContext):never {context.onUncertain?.();throw Error('probe-run-uncertain');}
function validReceipt(value:unknown,versionId:string,releaseHash:string):value is ProbeReceipt {
  if(!value||typeof value!=='object')return false;
  const r=value as ProbeReceipt;
  if(r.schema!=='kl-synthetic-probe/v1'||r.versionId!==versionId||r.releaseHash!==releaseHash||!hex(releaseHash)||
    r.locks?.tested!==3||![r.locks.overwriteDenied,r.locks.deleteDenied,r.locks.originalsIntact].every(x=>Number.isInteger(x)&&x>=0&&x<=3)||
    r.lockEnforcementPassed!==(r.locks.overwriteDenied===3&&r.locks.deleteDenied===3&&r.locks.originalsIntact===3))return false;
  for(const control of [r.stagingControl,r.sameAccountBinding])if(!control||typeof control.readWriteAccessible!=='boolean'||typeof control.markerRemoved!=='boolean')return false;
  // Reconstruct the public aggregate, refusing extra stored fields or private data.
  return canonicalJson(r)===canonicalJson({schema:r.schema,versionId:r.versionId,releaseHash:r.releaseHash,locks:{tested:3,overwriteDenied:r.locks.overwriteDenied,deleteDenied:r.locks.deleteDenied,originalsIntact:r.locks.originalsIntact},lockEnforcementPassed:r.lockEnforcementPassed,
    stagingControl:{readWriteAccessible:r.stagingControl.readWriteAccessible,markerRemoved:r.stagingControl.markerRemoved},sameAccountBinding:{readWriteAccessible:r.sameAccountBinding.readWriteAccessible,markerRemoved:r.sameAccountBinding.markerRemoved}});
}
async function mutableControl(store:ObjectStore,nonce:string,pause:()=>Promise<void>):Promise<ProbeReceipt['stagingControl']>{
  const name='values/kl-synthetic-probe/'+nonce;
  // A collision may contain someone else's marker: never mutate that key.
  if(!(await store.put(name,PROBE_BYTES,{onlyIfAbsent:true})).written)throw Error('probe-collision');
  const readWriteAccessible=eq(await store.get(name),PROBE_BYTES);
  await pause();
  await store.delete(name);
  return {readWriteAccessible,markerRemoved:await store.get(name)===undefined};
}
/** All object names and both payloads are fixed here. No listing or caller content. */
export async function runSyntheticProbe(archive:ObjectStore,decoy:ObjectStore,nonce:string,versionId:string,releaseHash:string,pause=mutationPause):Promise<ProbeReceipt>{
  if(!hex(nonce)||!uuid(versionId)||!hex(releaseHash))throw Error('probe-refused');
  const locks:ProbeReceipt['locks']={tested:3,overwriteDenied:0,deleteDenied:0,originalsIntact:0};
  for(const prefix of ['ledger','anchors','authz']){
    const name=prefix+'/_lock-probe/'+nonce+'.json';
    if(!(await archive.put(name,PROBE_BYTES,{onlyIfAbsent:true})).written)throw Error('probe-collision');
    if(!eq(await archive.get(name),PROBE_BYTES))throw Error('probe-readback');
    await pause();
    try{await archive.put(name,OTHER_BYTES);}catch(error){lockDenial(error,'put');locks.overwriteDenied++;}
    await pause();
    try{await archive.delete(name);}catch(error){lockDenial(error,'delete');locks.deleteDenied++;}
    if(eq(await archive.get(name),PROBE_BYTES))locks.originalsIntact++;
  }
  return {schema:'kl-synthetic-probe/v1',versionId,releaseHash,locks,
    lockEnforcementPassed:locks.overwriteDenied===3&&locks.deleteDenied===3&&locks.originalsIntact===3,
    stagingControl:await mutableControl(archive,nonce,pause),sameAccountBinding:await mutableControl(decoy,nonce,pause)};
}
/** Caller holds RuntimeSafety's persisted single mutation gate across this operation. */
export async function acceptProbeRelease(input:unknown,context:ProbeContext):Promise<RuntimeReleaseState>{
  const {port,trust,versionId}=context;if(trust.audience.environment!=='staging')throw Error('probe-refused');
  const prior=await port.get(key(versionId));
  const packet=input as {claims?:{mode?:unknown;nonce?:unknown}}|null;
  const packetHash=sha256Hex(canonicalJson(input));
  // Only an identical retry or closure is allowed after this version has run.
  if(prior!==undefined&&packet?.claims?.mode!=='closed'&&!validReceipt(prior,versionId,packetHash))throw Error('probe-refused');
  const state=await acceptRuntimeRelease(input,port,trust,versionId);
  if(state.mode==='closed')return state;
  // Reserve the native version in independently retained storage before any
  // probe effect. A DO rollback cannot erase this once-only fact. A reservation
  // without its completed KV receipt needs reconciliation, never another run.
  const marker=runKey(versionId),expected=runBytes(versionId,state.releaseHash),existing=await port.proofs.get(marker);
  if(prior!==undefined){if(!eq(existing,expected))uncertain(context);return state;}
  if(existing!==undefined)uncertain(context);
  if(!(await port.proofs.put(marker,expected,{onlyIfAbsent:true})).written)uncertain(context);
  if(!eq(await port.proofs.get(marker),expected))uncertain(context);
  const nonce=packet?.claims?.nonce;if(!hex(nonce))throw Error('probe-refused');
  const receipt=await runSyntheticProbe(context.archive,context.decoy,nonce as string,versionId,state.releaseHash,context.pause);
  await port.put(key(versionId),receipt);await port.sync();
  if(canonicalJson(await port.get(key(versionId)))!==canonicalJson(receipt))throw Error('probe-readback');
  return state;
}
export async function readProbeReceipt(context:ProbeContext):Promise<ProbeReceipt>{
  const {port,trust,versionId}=context;if(trust.audience.environment!=='staging'||!await runtimeIsReleased(port,trust,versionId))throw Error('probe-refused');
  const value=await port.get(key(versionId));
  const hash=(await runtimeReleaseState(port,trust))?.releaseHash;
  if(!hex(hash)||!validReceipt(value,versionId,hash!))throw Error('probe-refused');
  if(!eq(await port.proofs.get(runKey(versionId)),runBytes(versionId,hash!)))throw Error('probe-refused');
  return value;
}
