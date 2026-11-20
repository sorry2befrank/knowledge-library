// Temporary owner-approved staging artifact. Never imported by the archive host.
import type { Catalog } from '../../../../packages/core/src/catalog/catalog.ts';
import type { SqlParam } from '../../../../packages/core/src/catalog/driver.ts';
import { SCHEMA_VERSION } from '../../../../packages/core/src/catalog/schema.ts';
import { ftsTableFor,collectionFtsTableFor } from '../../../../packages/core/src/catalog/search-index.ts';
import { sealArchive,verifyArchiveFreshness,type ArchiveDurabilityContext } from '../../../../packages/core/src/catalog/durability.ts';
import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { acceptRuntimeRelease,runtimeIsReleased,runtimeReleaseState,type RuntimeReleasePort,type RuntimeReleaseTrust,type RuntimeReleaseState } from '../../../../packages/core/src/auth/runtime-release.ts';

export const REHEARSAL_CONTENT='# Archive hosted rehearsal\nSynthetic acceptance fixture. No personal or client data.\n';
const enc=new TextEncoder(),HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
// Version-specific snapshot schema: changing the catalog requires another review.
const TABLES=['meta','events','values_','undo','outbox','authz_events','approvals','policy_acceptances','collections','idempotency','multipart_pushes','text_pushes','text_push_items','folders','notes','versions','version_classes','blob_refs','aliases','designations','principals','tokens','tags','edges','overrides','corrections','correction_states','signals','cases','playbooks','candidates','champions','evolution','replays','holdout_looks','ladder_state','evidence_snapshots','chunks'] as const;
const EPHEMERAL=['query_log','audit','reads'];
const UNUSED=['multipart_pushes','designations','overrides','corrections','correction_states','signals','cases','candidates','evolution','replays','holdout_looks','ladder_state','evidence_snapshots'];
function refuse():never{throw Error('rehearsal-refused');}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export interface RehearsalInventory {
  schema:'kl-rehearsal-inventory/v1';phase:'discard';libraryId:string;principal:string;collectionId:string;folderId:string;
  noteId:string;version:number;tokens:{kind:'kl-device'|'cc-bearer'|'cx-bearer';hash:string}[];
  pin:{snapshotHash:string;eventSeq:number;eventHash:string;authzSeq:number};
}
export function parseRehearsalInventory(text:string):RehearsalInventory{
  if(enc.encode(text).length>8192)refuse();const x=JSON.parse(text) as RehearsalInventory;
  if(!exact(x,['schema','phase','libraryId','principal','collectionId','folderId','noteId','version','tokens','pin'])||x.schema!=='kl-rehearsal-inventory/v1'||x.phase!=='discard'||
    ![x.libraryId,x.principal,x.collectionId,x.folderId,x.noteId].every(v=>typeof v==='string'&&ID.test(v))||x.version!==1||!Array.isArray(x.tokens)||x.tokens.length!==3)refuse();
  if([...x.tokens.map(t=>t.kind)].sort().join('|')!=='cc-bearer|cx-bearer|kl-device'||new Set(x.tokens.map(t=>t.hash)).size!==3||
    x.tokens.some(t=>!exact(t,['kind','hash'])||!HASH.test(t.hash)))refuse();
  if(!exact(x.pin,['snapshotHash','eventSeq','eventHash','authzSeq'])||![x.pin.snapshotHash,x.pin.eventHash].every(v=>HASH.test(v))||
    ![x.pin.eventSeq,x.pin.authzSeq].every(v=>Number.isSafeInteger(v)&&v>0))refuse();
  return structuredClone(x);
}
type Pin=NonNullable<RehearsalInventory['pin']>;
export interface RehearsalReceipt {schema:'kl-recovery-rehearsal/v1';phase:'discard';versionId:string;releaseHash:string;inventoryHash:string;before:Pin;after:Pin;counts:{notes:1;versions:1;tokens:3};revoked:number;projectionEmpty:boolean}
export interface RehearsalContext {catalog:Catalog;durability:ArchiveDurabilityContext;inventory:RehearsalInventory;port:RuntimeReleasePort;trust:RuntimeReleaseTrust;versionId:string;onUncertain?:()=>void}
function versionKey(version:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(version))refuse();return 'anchors/recovery-rehearsal/'+version+'.json';}
function kvKey(version:string){versionKey(version);return 'archive-recovery-rehearsal/'+version;}
function resultKey(version:string){versionKey(version);return 'anchors/recovery-rehearsal-result/'+version+'.json';}
function bytes(v:unknown){return enc.encode(canonicalJson(v));}
const same=(a:Uint8Array|undefined,b:Uint8Array)=>!!a&&sha256Hex(a)===sha256Hex(b);
function uncertain(c:RehearsalContext):never{c.onUncertain?.();throw Error('rehearsal-uncertain');}
function virtualTables(c:Catalog):string[]{
  const known=new Set<string>([...TABLES,...EPHEMERAL]);
  const tables=c.db.all<{name:string;sql:string}>('SELECT name,sql FROM sqlite_master WHERE type=\'table\'');
  const expected=new Set<string>();
  for(const row of c.db.all<{collectionId:string;privacy_class:string}>('SELECT DISTINCT n.collectionId,c.privacy_class FROM chunks c JOIN notes n ON n.noteId=c.noteId')){
    expected.add(ftsTableFor(row.privacy_class));expected.add(collectionFtsTableFor(row.collectionId,row.privacy_class));
  }
  const derived=new Set([...expected].flatMap(t=>[t,...['_data','_idx','_content','_docsize','_config'].map(s=>t+s)]));
  if(tables.some(t=>!known.has(t.name)&&!derived.has(t.name)&&!t.name.startsWith('sqlite_')&&!t.name.startsWith('_cf_')))refuse();
  const virtual=tables.filter(t=>expected.has(t.name)&&/^CREATE VIRTUAL TABLE/i.test(t.sql)).map(t=>t.name);
  if(virtual.length!==expected.size)refuse();return virtual;
}
function projection(c:Catalog,libraryId:string):Pin{
  virtualTables(c);if(SCHEMA_VERSION!==4)refuse();let count=0;const tables:Record<string,Record<string,SqlParam>[]>={};
  for(const table of TABLES){
    const cols=c.db.all<{name:string;pk:number}>(`PRAGMA table_info(${table})`),order=cols.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>`"${x.name}"`).join(',')||'rowid';
    const rows=c.db.all<Record<string,SqlParam>>(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 1001`);count+=rows.length;if(count>1000)refuse();tables[table]=rows;
  }
  const data=bytes({schema:'kl-archive-projection/v1',schemaVersion:SCHEMA_VERSION,libraryHash:sha256Hex(libraryId),tables});if(data.length>1024*1024)refuse();
  return {snapshotHash:sha256Hex(data),eventSeq:c.head().seq,eventHash:c.head().hash,authzSeq:c.db.get<{n:number}>('SELECT max(seq) AS n FROM authz_events')?.n??0};
}
async function inspect(c:RehearsalContext):Promise<Pin>{
  const {catalog,inventory:i,durability:d}=c,db=catalog.db;
  if(c.trust.audience.environment!=='staging'||i.libraryId!==c.trust.audience.libraryId||d.libraryId!==i.libraryId)refuse();
  await verifyArchiveFreshness(catalog,d);
  for(const [table,n] of [['principals',1],['collections',1],['folders',1],['notes',1],['versions',1],['tokens',3]] as const)if(db.get<{n:number}>(`SELECT count(*) AS n FROM ${table}`)?.n!==n)refuse();
  if(UNUSED.some(t=>db.get(`SELECT 1 FROM ${t} LIMIT 1`))||db.get("SELECT 1 FROM outbox WHERE state<>'done'")||db.get("SELECT 1 FROM text_pushes WHERE state<>'committed'"))refuse();
  if(!db.get("SELECT 1 FROM principals WHERE id=? AND status='active'",[i.principal])||!db.get('SELECT 1 FROM collections WHERE collectionId=?',[i.collectionId])||
    !db.get('SELECT 1 FROM folders WHERE folderId=? AND owner_principal=? AND collectionId=?',[i.folderId,i.principal,i.collectionId])||
    !db.get("SELECT 1 FROM notes WHERE noteId=? AND collectionId=? AND folderId=? AND currentVer=1 AND status='current'",[i.noteId,i.collectionId,i.folderId]))refuse();
  const digest=sha256Hex(REHEARSAL_CONTENT);
  if(!db.get("SELECT 1 FROM versions WHERE noteId=? AND ver=1 AND sha256=? AND bytes=? AND custody='indexed'",[i.noteId,digest,enc.encode(REHEARSAL_CONTENT).length]))refuse();
  for(const t of i.tokens)if(!db.get('SELECT 1 FROM tokens WHERE hash=? AND kind=? AND principal=? AND revokedAt IS NULL AND collection_ids=?',[t.hash,t.kind,i.principal,canonicalJson([i.collectionId])]))refuse();
  if(!same(await catalog.blobs.get(digest),enc.encode(REHEARSAL_CONTENT)))refuse();
  const pin=projection(catalog,i.libraryId);
  const retained=await d.store.get(`snap/${sha256Hex(i.libraryId)}/${pin.snapshotHash}.json`);
  if(!retained||sha256Hex(retained)!==pin.snapshotHash)refuse();
  if(canonicalJson(i.pin)!==canonicalJson(pin))refuse();return pin;
}
function clearProjection(catalog:Catalog):void{
  const virtual=virtualTables(catalog),db=catalog.db;
  db.transaction(()=>{
    db.exec('PRAGMA defer_foreign_keys=ON');
    // Drop derived virtual tables before their content table (restore rebuilds them). Never touch DO KV,
    // SQLite internals, provider tables, alarms, R2, or unrelated SQL tables.
    for(const t of virtual)db.exec(`DROP TABLE "${t}"`);
    for(const t of [...TABLES,...EPHEMERAL].reverse())db.run(`DELETE FROM ${t}`);
    for(const [key,value] of [['schema_version',String(SCHEMA_VERSION)],['min_policy_epoch','0'],['setup_mode','0']])db.run('INSERT INTO meta(key,value) VALUES(?,?)',[key!,value!]);
    if([...TABLES.filter(t=>t!=='meta'),...EPHEMERAL].some(t=>db.get(`SELECT 1 FROM ${t} LIMIT 1`)))refuse();
    if(canonicalJson(db.all('SELECT key,value FROM meta ORDER BY key'))!==canonicalJson([{key:'min_policy_epoch',value:'0'},{key:'schema_version',value:String(SCHEMA_VERSION)},{key:'setup_mode',value:'0'}]))refuse();
  });
}
function receipt(value:unknown,c:RehearsalContext,releaseHash:string):value is RehearsalReceipt{
  if(!exact(value,['schema','phase','versionId','releaseHash','inventoryHash','before','after','counts','revoked','projectionEmpty']))return false;
  const r=value as unknown as RehearsalReceipt;
  return r.schema==='kl-recovery-rehearsal/v1'&&r.phase===c.inventory.phase&&r.versionId===c.versionId&&r.releaseHash===releaseHash&&r.inventoryHash===sha256Hex(canonicalJson(c.inventory))&&
    canonicalJson(r.counts)===canonicalJson({notes:1,versions:1,tokens:3})&&r.revoked===1&&r.projectionEmpty===true&&
    [r.before,r.after].every(p=>exact(p,['snapshotHash','eventSeq','eventHash','authzSeq'])&&HASH.test(p.snapshotHash)&&HASH.test(p.eventHash)&&Number.isSafeInteger(p.eventSeq)&&p.eventSeq>0&&Number.isSafeInteger(p.authzSeq)&&p.authzSeq>0)&&
    canonicalJson(r.before)===canonicalJson(c.inventory.pin)&&r.after.eventSeq===r.before.eventSeq+1&&r.after.authzSeq===r.before.authzSeq+1;
}
/** Caller serializes through RuntimeSafety.mutation across the complete effect. */
export async function acceptRehearsalRelease(input:unknown,c:RehearsalContext):Promise<RuntimeReleaseState>{
  c.inventory=parseRehearsalInventory(canonicalJson(c.inventory));if(c.trust.audience.environment!=='staging')refuse();
  const prior=await c.port.get(kvKey(c.versionId)),hash=sha256Hex(canonicalJson(input)),packet=input as {claims?:{mode?:unknown}};
  if(prior!==undefined&&packet?.claims?.mode!=='closed'&&!receipt(prior,c,hash))refuse();
  const state=await acceptRuntimeRelease(input,c.port,c.trust,c.versionId);if(state.mode==='closed')return state;
  const marker=bytes({schema:'kl-recovery-rehearsal-run/v1',versionId:c.versionId,releaseHash:state.releaseHash,inventoryHash:sha256Hex(canonicalJson(c.inventory))});
  const existing=await c.port.proofs.get(versionKey(c.versionId));
  if(prior!==undefined){if(!same(existing,marker)||!same(await c.port.proofs.get(resultKey(c.versionId)),bytes(prior)))uncertain(c);return state;}
  if(existing!==undefined)uncertain(c);
  // Complete read-only inventory validation precedes any destructive action.
  const before=await inspect(c);
  if(!(await c.port.proofs.put(versionKey(c.versionId),marker,{onlyIfAbsent:true})).written||!same(await c.port.proofs.get(versionKey(c.versionId)),marker))uncertain(c);
  let after=before;
  {
    const revoked=c.catalog.apply({principal:'system',clientClass:'kl-device'},{kind:'system'},{kind:'token.revoke',tokenHash:c.inventory.tokens.find(t=>t.kind==='cc-bearer')!.hash,reason:'owner'});
    await c.catalog.acknowledge((revoked.result as {authzSeq:number}).authzSeq);
    const sealed=await sealArchive(c.catalog,c.durability);if(!sealed)uncertain(c);await verifyArchiveFreshness(c.catalog,c.durability);
    after=projection(c.catalog,c.inventory.libraryId);if(after.snapshotHash!==sealed.snapshotHash)uncertain(c);
    clearProjection(c.catalog);
  }
  const result:RehearsalReceipt={schema:'kl-recovery-rehearsal/v1',phase:c.inventory.phase,versionId:c.versionId,releaseHash:state.releaseHash,inventoryHash:sha256Hex(canonicalJson(c.inventory)),before,after,counts:{notes:1,versions:1,tokens:3},revoked:1,projectionEmpty:true};
  if(!receipt(result,c,state.releaseHash))uncertain(c);
  if(!(await c.port.proofs.put(resultKey(c.versionId),bytes(result),{onlyIfAbsent:true})).written||!same(await c.port.proofs.get(resultKey(c.versionId)),bytes(result)))uncertain(c);
  await c.port.put(kvKey(c.versionId),result);await c.port.sync();if(canonicalJson(await c.port.get(kvKey(c.versionId)))!==canonicalJson(result))uncertain(c);
  return state;
}
export async function readRehearsalReceipt(c:RehearsalContext):Promise<RehearsalReceipt>{
  if(!await runtimeIsReleased(c.port,c.trust,c.versionId))refuse();const hash=(await runtimeReleaseState(c.port,c.trust))?.releaseHash;
  const value=await c.port.get(kvKey(c.versionId));if(!hash||!receipt(value,c,hash))refuse();
  const expected=bytes({schema:'kl-recovery-rehearsal-run/v1',versionId:c.versionId,releaseHash:hash,inventoryHash:sha256Hex(canonicalJson(c.inventory))});
  if(!same(await c.port.proofs.get(versionKey(c.versionId)),expected)||!same(await c.port.proofs.get(resultKey(c.versionId)),bytes(value)))refuse();return value;
}
