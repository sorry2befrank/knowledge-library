// Synthetic physical controller only. No native adapter, credentials, custody or approval gates.
import { MemoryFs, ModelCrash } from '../fs/memory.ts';
import type { CreatedHandle, FileHandle, FileIdentity, Fs, FsResult, Handle, HandleSnapshot } from '../fs/fs.ts';
import { MemoryMoveJournal, JournalModelCrash } from './memory-move-journal.ts';
import { immutable, sameIdentity, validSpec, validateHistory } from './movement-journal.ts';
import type { JournalAck, JournalAttempt, ModelMoveOutcome, MoveIds, OutcomeReason, PhysicalMoveSpec, PhysicalObservation, PhysicalStep, RecordInput } from './movement-journal.ts';

class Stop extends Error {
 readonly result:ModelMoveOutcome;
 constructor(result:ModelMoveOutcome){super(result.reason);this.result=result;}
}
export interface ModelSafeMove {
 move(spec:PhysicalMoveSpec):Promise<ModelMoveOutcome>;
 resume(ids:MoveIds):Promise<ModelMoveOutcome>;
}
/** A real MemoryFs and MemoryMoveJournal are required; no Boolean enables production execution. */
export function createModelSafeMove(memory:MemoryFs,journal:MemoryMoveJournal):ModelSafeMove {
 if(!(memory instanceof MemoryFs)||!(journal instanceof MemoryMoveJournal)||memory.implementation!=='memory-model'||journal.implementation!=='memory-model')throw Error('memory-model-required');
 const fs:Fs=memory;
 const refusal=(reason:OutcomeReason):ModelMoveOutcome=>({modelOnly:true,status:'pending',reason,source:'unknown',held:'unknown',journalRevision:null,removalMayHaveCommitted:false});
 async function execute(admission:JournalAck<{attempt:JournalAttempt;revision:number}>):Promise<ModelMoveOutcome>{
  if(!admission.ok)return refusal(admission.retained==='unknown'?'journal-unknown':'journal-refused');
  const token=admission.value.attempt;let revision=admission.value.revision,sourceHandle:FileHandle|null=null,createdHandle:CreatedHandle|null=null,heldHandle:FileHandle|null=null;
  let source:'retained'|'absent'|'unknown'='unknown',held:ModelMoveOutcome['held']='unknown',removalMayHaveCommitted=false,crashed=false;
  let result:ModelMoveOutcome=refusal('journal-refused'),spec:PhysicalMoveSpec,heldIdentity:FileIdentity|null=null;
  const outcome=(status:ModelMoveOutcome['status'],reason:OutcomeReason):ModelMoveOutcome=>({modelOnly:true,status,reason,source,held,journalRevision:revision,removalMayHaveCommitted});
  function stop(status:ModelMoveOutcome['status'],reason:OutcomeReason):never{throw new Stop(outcome(status,reason));}
  function use<T>(r:FsResult<T>):T {if(r.ok)return r.value;throw new Stop({...outcome(r.effect==='unknown'||removalMayHaveCommitted||held==='partial'||held==='verified-readonly'?'pending':r.code==='already-exists'?'conflict':'skipped','fs-refused'),failedFsCode:r.code,source:removalMayHaveCommitted?'unknown':source});}
  function juse<T>(r:JournalAck<T>):T {if(r.ok)return r.value;throw new Stop(outcome('pending',r.retained==='unknown'?'journal-unknown':'journal-refused'));}
  const observation=(sourceState:PhysicalObservation['source'],heldState:PhysicalObservation['held'],bytes:number|null=null,sha:string|null=null):PhysicalObservation=>({source:sourceState,held:heldState,heldIdentity,heldSha256:sha,bytes});
  async function append(stage:PhysicalStep,kind:'intent'|'confirmation',intentId:string,o:PhysicalObservation|null):Promise<void>{
   const input:RecordInput={eventId:'event-'+(revision+1),intentId,attemptId:spec.attemptId,stage,kind,observation:o};
   const ack=juse(await journal.appendAndSync(token,revision,input));revision=ack.revision;
  }
  async function intent(stage:PhysicalStep,o:PhysicalObservation|null=null):Promise<string>{const id='intent-'+(revision+1);await append(stage,'intent',id,o);return id;}
  async function confirm(stage:PhysicalStep,id:string,o:PhysicalObservation):Promise<void>{await append(stage,'confirmation',id,o);}
  async function verifySource():Promise<HandleSnapshot>{
   if(!sourceHandle)throw Error('source-handle-required');const stat=use(await fs.statHandle(sourceHandle));
   if(!sameIdentity(stat.identity,spec.source.guard.identity)||stat.bytes!==spec.source.bytes||stat.readOnly)stop('conflict','source-mismatch');
   const hash=use(await fs.hash(sourceHandle));if(hash.bytes!==spec.source.bytes||hash.sha256!==spec.source.sha256)stop('conflict','source-mismatch');source='retained';return stat;
  }
  async function verifyHeld(requireReadOnly:boolean):Promise<void>{
   if(!heldHandle||!heldIdentity)throw Error('held-handle-required');const stat=use(await fs.statHandle(heldHandle));
   if(!sameIdentity(stat.identity,heldIdentity)||sameIdentity(stat.identity,spec.source.guard.identity)||stat.bytes!==spec.source.bytes||requireReadOnly&&!stat.readOnly){held='changed';stop('hard-alarm','held-changed');}
   const hash=use(await fs.hash(heldHandle));if(hash.bytes!==spec.source.bytes||hash.sha256!==spec.source.sha256){held='changed';stop('hard-alarm','held-changed');}
   if(requireReadOnly)held='verified-readonly';
  }
  async function sourceAbsent():Promise<boolean>{const r=await fs.openExclusive(spec.source.path,spec.source.guard,'read-delete');if(!r.ok&&r.code==='not-found'&&r.effect==='none'){source='absent';return true;}if(!r.ok)use(r);else use(await fs.close(r.value));source='unknown';return false;}
  async function closeKnown(which:'source'|'created'|'held'):Promise<void>{const h=which==='source'?sourceHandle:which==='created'?createdHandle:heldHandle;if(!h)return;use(await fs.close(h));if(which==='source')sourceHandle=null;else if(which==='created')createdHandle=null;else heldHandle=null;}
  async function finishHeld():Promise<void>{
   if(!await sourceAbsent())stop('conflict','source-mismatch');await verifyHeld(true);
   const id=await intent('observe-held');await confirm('observe-held',id,observation('absent','verified-readonly',spec.source.bytes,spec.source.sha256));
   await closeKnown('held');result=outcome('physical-held','complete');
  }
  async function removeSource():Promise<void>{
   const id=await intent('remove-source');
   // Both exclusive handles remain live. Final checks and disposition use the original source handle.
   await verifySource();await verifyHeld(true);
   removalMayHaveCommitted=true;
   use(await fs.setDeleteDisposition(sourceHandle!));
   await closeKnown('source');source='unknown';
   if(!await sourceAbsent())stop('pending','source-mismatch');await verifyHeld(true);
   await confirm('remove-source',id,observation('absent','verified-readonly',spec.source.bytes,spec.source.sha256));
   await finishHeld();
  }
  async function createAndCopy():Promise<void>{
   let id=await intent('create-held');createdHandle=use(await fs.createNew(spec.held.path,spec.held.parents));held='partial';
   const created=use(await fs.statHandle(createdHandle));
   if(sameIdentity(created.identity,spec.source.guard.identity)||created.bytes!==0||created.readOnly)stop('conflict','destination-conflict');heldIdentity=created.identity;
   await confirm('create-held',id,observation('verified-plan-identity','known-unverified-partial',0));
   id=await intent('copy');let offset=0;
   do {
    const chunk=use(await fs.read(sourceHandle!,offset,Math.min(65_536,Math.max(1,spec.source.bytes-offset))));
    if(chunk.bytes.length>65_536||offset+chunk.bytes.length>spec.source.bytes||chunk.bytes.length===0&&!chunk.eof)stop('pending','copy-limit');
    if(chunk.bytes.length)use(await fs.appendCreated(createdHandle,chunk.bytes));offset+=chunk.bytes.length;
    if(chunk.eof){if(offset!==spec.source.bytes)stop('conflict','source-mismatch');break;}
    if(offset>=spec.source.bytes)stop('conflict','source-mismatch');
   }while(offset<=spec.source.bytes);
   await verifySource();await confirm('copy',id,observation('verified-plan-identity','known-unverified-partial',offset));
   id=await intent('flush-held');use(await fs.flushCreated(createdHandle));await confirm('flush-held',id,observation('verified-plan-identity','known-unverified-partial',offset));
   id=await intent('verify-held');await closeKnown('created');
   heldHandle=use(await fs.openExclusive(spec.held.path,{identity:heldIdentity,parents:spec.held.parents},'read-attributes'));
   await verifyHeld(false);use(await fs.setReadOnly(heldHandle,true));await verifyHeld(true);
   await confirm('verify-held',id,observation('verified-plan-identity','verified-readonly',spec.source.bytes,spec.source.sha256));
   await removeSource();
  }
  try {
   const view=juse(await journal.read(token));spec=view.spec;revision=view.revision;
   const facts=validateHistory(spec,view.records);if(!facts)stop('pending','journal-refused');heldIdentity=facts.heldIdentity;removalMayHaveCommitted=facts.removalIntent;
   if(view.records.length===0){
    const id=await intent('bind-source');sourceHandle=use(await fs.openExclusive(spec.source.path,spec.source.guard,'read-delete'));await verifySource();
    const destination=await fs.inspect(spec.held.path);if(destination.ok)stop('conflict','destination-conflict');if(destination.code!=='not-found'||destination.effect!=='none')use(destination);held='absent';
    await confirm('bind-source',id,observation('verified-plan-identity','absent'));await createAndCopy();
   } else {
    const reconcileId=await intent('reconcile');
    const sourceOpen=await fs.openExclusive(spec.source.path,spec.source.guard,'read-delete');
    if(sourceOpen.ok){sourceHandle=sourceOpen.value;await verifySource();}
    else if(sourceOpen.code==='not-found'&&sourceOpen.effect==='none'){source='absent';}
    else {source='unknown';use(sourceOpen);}
    const heldPath=await fs.inspect(spec.held.path);
    if(!heldPath.ok&&heldPath.code!=='not-found')use(heldPath);
    if(!heldIdentity){
     if(heldPath.ok){held='unknown';stop('conflict','destination-conflict');}
     held='absent';if(source==='absent')stop(facts.removalIntent||facts.everVerified?'hard-alarm':'pending',facts.removalIntent||facts.everVerified?'missing-verified-copy':'source-absent-without-intent');
     await confirm('reconcile',reconcileId,observation('verified-plan-identity','absent'));await createAndCopy();
    } else if(!heldPath.ok){
     held='absent';
     if(facts.cleanupIntent&&!facts.everVerified&&!facts.removalIntent&&sourceHandle){heldIdentity=null;await confirm('reconcile',reconcileId,observation('verified-plan-identity','absent'));await createAndCopy();}
     else stop(facts.everVerified||facts.removalIntent?'hard-alarm':'conflict',facts.everVerified||facts.removalIntent?'missing-verified-copy':'destination-conflict');
    } else if(!heldPath.value.identity||!sameIdentity(heldPath.value.identity,heldIdentity)){
     held='changed';stop(facts.everVerified?'hard-alarm':'conflict','held-changed');
    } else if(facts.everVerified){
     heldHandle=use(await fs.openExclusive(spec.held.path,{identity:heldIdentity,parents:spec.held.parents},'read-attributes'));await verifyHeld(true);
     if(source==='absent'&&!facts.removalIntent)stop('pending','source-absent-without-intent');
     await confirm('reconcile',reconcileId,observation(source==='absent'?'absent':'verified-plan-identity','verified-readonly',spec.source.bytes,spec.source.sha256));
     if(source==='absent')await finishHeld();else await removeSource();
    } else {
     held='partial';if(!sourceHandle)stop('pending','source-absent-without-intent');
     // Never adopt unverified bytes. Delete only journal-bound partial identity with fresh source proof.
     heldHandle=use(await fs.openExclusive(spec.held.path,{identity:heldIdentity,parents:spec.held.parents},'read-delete-attributes'));
     await verifySource();const clean=await intent('clean-unverified-partial',observation('verified-plan-identity','known-unverified-partial'));
     const partial=use(await fs.statHandle(heldHandle));if(!sameIdentity(partial.identity,heldIdentity))stop('conflict','held-changed');
     if(partial.readOnly)use(await fs.setReadOnly(heldHandle,false));await verifySource();
     use(await fs.setDeleteDisposition(heldHandle));await closeKnown('held');
     const absent=await fs.inspect(spec.held.path);if(absent.ok||absent.code!=='not-found'||absent.effect!=='none')stop('pending','destination-conflict');
     heldIdentity=null;held='absent';await confirm('clean-unverified-partial',clean,observation('verified-plan-identity','absent'));await createAndCopy();
    }
   }
  } catch(error) {
   if(error instanceof ModelCrash||error instanceof JournalModelCrash){crashed=true;memory.crashProcess();journal.crashProcess();source='unknown';held='unknown';result=outcome('pending','model-crash');}
   else if(error instanceof Stop)result=error.result;
   else {source='unknown';held='unknown';result=outcome('pending','fs-refused');}
  } finally {
   if(!crashed){
    // A disposition may already be set. Closing can finish deletion and is never rollback evidence.
    for(const h of [sourceHandle,createdHandle,heldHandle])if(h){try{const closed=await fs.close(h);if(!closed.ok)result={...result,status:'pending',reason:'close-unknown',source:removalMayHaveCommitted?'unknown':result.source,held:'unknown'};}catch{memory.crashProcess();journal.crashProcess();crashed=true;result={...result,status:'pending',reason:'model-crash',source:'unknown',held:'unknown'};break;}}
    if(removalMayHaveCommitted&&result.status!=='physical-held')result={...result,source:'unknown'};
    if(!crashed)await journal.release(token);
   }
  }
  return immutable(result);
 }
 return Object.freeze({
  async move(spec:PhysicalMoveSpec){if(!validSpec(spec))return refusal('invalid-spec');return execute(await journal.reserve(immutable(spec)));},
  async resume(ids:MoveIds){return execute(await journal.openExisting(ids));},
 });
}
