// A process-crash memory model. No disk, SQLite, native flush, authentication or power-loss claim.
import { digestValue, immutable, validIds, validSpec, validateHistory } from './movement-journal.ts';
import type { JournalAck, JournalAttempt, JournalCode, JournalView, MoveIds, MovementJournal, MoveRecord, PhysicalMoveSpec, RecordInput } from './movement-journal.ts';
type Stored={spec:PhysicalMoveSpec;rows:MoveRecord[];head:{revision:number;digest:string|null};active:JournalAttempt|null};
type Session={stored:Stored;epoch:number;released:boolean};
export type JournalFault='reject-before'|'ack-lost'|'crash-before'|'crash-after';
export class JournalModelCrash extends Error { constructor(){super('modeled-journal-process-crash');this.name='JournalModelCrash';} }
const ok=<T>(value:T):JournalAck<T>=>({ok:true,value});
const bad=<T=never>(code:JournalCode,retained:'none'|'unknown'='none'):JournalAck<T>=>({ok:false,code,retained});
export class MemoryMoveJournal implements MovementJournal {
 readonly implementation='memory-model' as const;
 readonly #stores=new Map<string,Stored>();
 readonly #sessions=new WeakMap<object,Session>();
 #epoch=0;#fault:JournalFault|null=null;
 #key(ids:MoveIds){return ids.runId+'/'+ids.itemId;}
 #valid(s:Stored){return s.head.revision===s.rows.length && s.head.digest===(s.rows.at(-1)?.digest??null) && validateHistory(s.spec,s.rows)!==null;}
 #get(token:JournalAttempt):JournalAck<Stored>{if(!token||typeof token!=='object')return bad('invalid-session');const s=this.#sessions.get(token);if(!s||s.released||s.epoch!==this.#epoch||s.stored.active!==token)return bad('invalid-session');if(!this.#valid(s.stored))return bad('corrupt');return ok(s.stored);}
 #mint(s:Stored):JournalAck<{attempt:JournalAttempt;revision:number}>{if(s.active)return bad('busy');const token=Object.freeze({}) as JournalAttempt;s.active=token;this.#sessions.set(token,{stored:s,epoch:this.#epoch,released:false});return ok({attempt:token,revision:s.head.revision});}
 async reserve(spec:PhysicalMoveSpec):Promise<JournalAck<{attempt:JournalAttempt;revision:number}>>{
  if(!validSpec(spec))return bad('invalid-spec');const key=this.#key(spec),prior=this.#stores.get(key);
  if(prior){if(!this.#valid(prior))return bad('corrupt');if(digestValue(prior.spec)!==digestValue(spec))return bad('changed-binding');return this.#mint(prior);}
  if(this.#stores.size>=64)return bad('limit');const s:Stored={spec:immutable(spec),rows:[],head:{revision:0,digest:null},active:null};this.#stores.set(key,s);return this.#mint(s);
 }
 async openExisting(ids:MoveIds):Promise<JournalAck<{attempt:JournalAttempt;revision:number}>>{if(!validIds(ids))return bad('invalid-spec');const s=this.#stores.get(this.#key(ids));if(!s)return bad('not-found');if(!this.#valid(s))return bad('corrupt');if(s.spec.attemptId!==ids.attemptId)return bad('changed-binding');return this.#mint(s);}
 async read(token:JournalAttempt):Promise<JournalAck<JournalView>>{const s=this.#get(token);return s.ok?ok(immutable({spec:s.value.spec,revision:s.value.head.revision,records:s.value.rows})):s;}
 async appendAndSync(token:JournalAttempt,revision:number,input:RecordInput):Promise<JournalAck<{revision:number;digest:string}>>{
  const found=this.#get(token);if(!found.ok)return found;const s=found.value;
  if(!Number.isSafeInteger(revision)||revision!==s.head.revision)return bad('revision-conflict');if(s.rows.length>=128)return bad('limit');
  const body={...immutable(input),sequence:revision+1,bindingHash:digestValue(s.spec),priorDigest:s.head.digest};const row={...body,digest:digestValue(body)};
  if(!validateHistory(s.spec,[...s.rows,row]))return bad('invalid-transition');
  const fault=this.#fault;this.#fault=null;
  if(fault==='reject-before')return bad('io-error');if(fault==='crash-before')throw new JournalModelCrash();
  s.rows.push(immutable(row));s.head={revision:row.sequence,digest:row.digest};
  if(fault==='ack-lost')return bad('io-error','unknown');if(fault==='crash-after')throw new JournalModelCrash();
  return ok({revision:row.sequence,digest:row.digest});
 }
 async release(token:JournalAttempt):Promise<JournalAck<void>>{const session=this.#sessions.get(token);if(!session||session.released||session.epoch!==this.#epoch||session.stored.active!==token)return bad('invalid-session');session.released=true;session.stored.active=null;return ok(undefined);}
 // Synthetic fault controls; never a production durability interface.
 injectNext(fault:JournalFault){if(this.#fault)throw Error('model-journal-injection-pending');this.#fault=fault;}
 crashProcess(){for(const s of this.#stores.values())s.active=null;this.#epoch++;this.#fault=null;}
 crashPowerLoss():JournalAck<never>{return bad('unsupported');}
 retainedForTest(ids:MoveIds):JournalView|null{const s=this.#stores.get(this.#key(ids));return s?immutable({spec:s.spec,revision:s.head.revision,records:s.rows}):null;}
 corruptForTest(ids:MoveIds,edit:(rows:MoveRecord[])=>void){const s=this.#stores.get(this.#key(ids));if(!s)throw Error('model-journal-missing');const rows=structuredClone(s.rows);edit(rows);s.rows=rows;}
}
