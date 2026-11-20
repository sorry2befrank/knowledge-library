// Small-corpus copy-only runtime: export every committed ledger change before its
// response. Locked, content-free anchors authenticate purgeable projection dumps.
// Recovery is an explicit scratch-store operation, never an HTTP setup bypass.
import type { Catalog } from './catalog.ts';
import type { ObjectStore } from './blobs.ts';
import type { SqlDriver, SqlParam } from './driver.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { eventHash, GENESIS, type EventRow } from './ledger.ts';
import { canonicalJson } from '../primitives/canonical.ts';
import { sha256Hex } from '../primitives/sha256.ts';
import { ensureFtsTable, migrateCollectionIndexes } from './search-index.ts';

export interface ArchiveDurabilityContext { store:ObjectStore; libraryId:string; minPolicyEpoch:number; maxSnapshotBytes?:number }
export interface ArchiveSeal { schema:'kl-archive-seal/v1'; libraryHash:string; revision:number; schemaVersion:number; eventSeq:number; eventHash:string; authzSeq:number; minPolicyEpoch:number; snapshotHash:string; ledgerHash:string }
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true});
const HASH=/^[a-f0-9]{64}$/;
const MAX_SEALS=5000, MAX_ROWS=100000;
// Exact schema-version allowlist. Unknown schema tables cannot silently disappear
// from a recovery dump; derived FTS and ephemeral usage records are rebuilt/reset.
const TABLES=['meta','events','values_','undo','outbox','authz_events','approvals','policy_acceptances','collections','idempotency','multipart_pushes','text_pushes','text_push_items','folders','notes','versions','version_classes','blob_refs','aliases','designations','principals','tokens','tags','edges','overrides','corrections','correction_states','signals','cases','playbooks','candidates','champions','evolution','replays','holdout_looks','ladder_state','evidence_snapshots','chunks'] as const;
const EPHEMERAL=new Set(['query_log','audit','reads']);
type Snapshot={schema:'kl-archive-projection/v1';schemaVersion:number;libraryHash:string;tables:Record<string,Record<string,SqlParam>[]>};
function refuse():never {throw new Error('archive-durability-unproven');}
function ctx(c:ArchiveDurabilityContext) {
  if(!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(c.libraryId)||!Number.isSafeInteger(c.minPolicyEpoch)||c.minPolicyEpoch<1)refuse();
  const max=c.maxSnapshotBytes??32*1024*1024;
  if(!Number.isSafeInteger(max)||max<1||max>64*1024*1024)refuse();
  return {libraryHash:sha256Hex(c.libraryId),max};
}
function bytes(value:unknown){return enc.encode(canonicalJson(value));}
function authzHead(db:SqlDriver){return db.get<{seq:number}>('SELECT max(seq) AS seq FROM authz_events')?.seq??0;}
function epoch(db:SqlDriver){const n=Number(db.get<{value:string}>("SELECT value FROM meta WHERE key='min_policy_epoch'")?.value??0);if(!Number.isSafeInteger(n)||n<0)refuse();return n;}
async function verifiedPut(store:ObjectStore,key:string,data:Uint8Array){
  await store.put(key,data,{onlyIfAbsent:true});
  const read=await store.get(key);if(!read||sha256Hex(read)!==sha256Hex(data))refuse();
}
function anchorPrefix(c:ArchiveDurabilityContext){return `anchors/${ctx(c).libraryHash}/`;}
async function latest(c:ArchiveDurabilityContext):Promise<ArchiveSeal|undefined>{
  const prefix=anchorPrefix(c), keys=await c.store.list(prefix);
  if(keys.length>MAX_SEALS||new Set(keys).size!==keys.length)refuse();
  if(!keys.length)return undefined;
  const parsed=keys.map(key=>{const m=/^(\d{12})-([a-f0-9]{64})\.json$/.exec(key.slice(prefix.length));if(!key.startsWith(prefix)||!m)refuse();return {key,rev:Number(m[1]),hash:m[2]!};});
  parsed.sort((a,b)=>a.rev-b.rev);
  // One immutable anchor per revision. Forks or missing revisions close recovery.
  if(parsed.some((p,i)=>p.rev!==i+1))refuse();
  const p=parsed[parsed.length-1]!, raw=await c.store.get(p.key);
  if(!raw||raw.length>4096||sha256Hex(raw)!==p.hash)refuse();
  let s:ArchiveSeal;try{s=JSON.parse(dec.decode(raw));}catch{refuse();}
  if(s.schema!=='kl-archive-seal/v1'||s.libraryHash!==ctx(c).libraryHash||s.revision!==p.rev||s.schemaVersion!==SCHEMA_VERSION||
     ![s.eventSeq,s.authzSeq,s.minPolicyEpoch].every(n=>Number.isSafeInteger(n)&&n>=0)||
     ![s.eventHash,s.snapshotHash,s.ledgerHash].every(h=>typeof h==='string'&&HASH.test(h))||s.minPolicyEpoch<c.minPolicyEpoch)refuse();
  return s;
}
function virgin(catalog:Catalog){
  return !catalog.db.get("SELECT 1 FROM events WHERE kind<>'champion.baseline' LIMIT 1") &&
    ['principals','tokens','collections','folders','notes','authz_events','approvals','policy_acceptances'].every(t=>!catalog.db.get(`SELECT 1 FROM ${t} LIMIT 1`)) &&
    !catalog.db.get("SELECT 1 FROM meta WHERE key IN ('setup_consumed','enrollment_hash','setup_secret_h')");
}
async function checkpointKeys(c:ArchiveDurabilityContext):Promise<string[]>{
  const keys=await c.store.list('authz/');if(keys.length>MAX_ROWS||new Set(keys).size!==keys.length)refuse();
  const checkpoints:string[]=[];
  for(const key of keys){
    if(/^authz\/\d{12}\.json$/.test(key)){checkpoints.push(key);continue;}
    // Retention enforcement probes are fixed synthetic markers, never authz
    // claims. Admit only this reserved exact path and exact immutable bytes.
    if(!/^authz\/_lock-probe\/[a-f0-9]{64}\.json$/.test(key))refuse();
    const marker=await c.store.get(key);if(!marker||sha256Hex(marker)!==sha256Hex('kl-retention-probe/v1\n'))refuse();
  }
  return checkpoints;
}
async function checkAuthz(catalog:Catalog,c:ArchiveDurabilityContext,requirePending=false){
  const keys=await checkpointKeys(c);
  for(const key of keys){
    const match=/^authz\/(\d{12})\.json$/.exec(key);if(!match)refuse();
    const seq=Number(match[1]),ev=catalog.db.get<Record<string,SqlParam>>('SELECT * FROM authz_events WHERE seq=?',[seq]);
    if(!ev)refuse();
    const actual=await c.store.get(key);if(!actual||sha256Hex(actual)!==sha256Hex(bytes({...ev,minPolicyEpoch:ev.epoch})))refuse();
    if(Number(ev.epoch)>epoch(catalog.db))refuse();
  }
  // Every locally committed narrowing intent must be matched, including after
  // a crash between its checkpoint write and the next projection seal.
  const rows=catalog.db.all<{target:string}>(`SELECT target FROM outbox WHERE step IN ('authz.checkpoint','enrollment.checkpoint') ${requirePending?'':"AND state='done'"}`);
  for(const row of rows){const key=`authz/${row.target.padStart(12,'0')}.json`;if(!keys.includes(key))refuse();}
}
/** Fresh locked storage is authority for rollback detection, never local state alone. */
export async function verifyArchiveFreshness(catalog:Catalog,c:ArchiveDurabilityContext):Promise<void>{
  ctx(c);if(!catalog.verifyChain().ok)refuse();
  const seal=await latest(c);await checkAuthz(catalog,c);
  if(!seal){
    // An enrolled but unsealed crash may only be reconciled by sealArchive;
    // normal request startup never mistakes it for an empty installation.
    if(!virgin(catalog))refuse();
    return;
  }
  const event=catalog.db.get<{hash:string}>('SELECT hash FROM events WHERE seq=?',[seal.eventSeq]);
  if(event?.hash!==seal.eventHash||authzHead(catalog.db)<seal.authzSeq||epoch(catalog.db)<Math.max(c.minPolicyEpoch,seal.minPolicyEpoch))refuse();
  const ledger=await c.store.get(`ledger/${seal.libraryHash}/${seal.ledgerHash}.jsonl`);
  if(!ledger||sha256Hex(ledger)!==seal.ledgerHash)refuse();
  const projection=await c.store.get(`snap/${seal.libraryHash}/${seal.snapshotHash}.json`);
  if(!projection||projection.length>ctx(c).max||sha256Hex(projection)!==seal.snapshotHash)refuse();
}
/** This is only permission to retry POST /v1/enroll's original, still-valid
 * signature. It never grants normal traffic, alarm work or replacement setup. */
export async function canRetryUnsealedEnrollment(catalog:Catalog,c:ArchiveDurabilityContext):Promise<boolean>{
  try {
    if(await latest(c)||!catalog.verifyChain().ok||catalog.db.get("SELECT 1 FROM meta WHERE key='recovery_state'"))return false;
    if(catalog.db.get("SELECT 1 FROM events WHERE kind NOT IN ('champion.baseline','enrollment.initialize','enrollment.activate') LIMIT 1")||
      catalog.db.get("SELECT 1 FROM authz_events WHERE kind<>'enrollment.initialize' LIMIT 1")||
      ['notes','versions','text_pushes','multipart_pushes','reads','query_log'].some(t=>catalog.db.get(`SELECT 1 FROM ${t} LIMIT 1`)))return false;
    if(catalog.db.get<{n:number}>('SELECT count(*) AS n FROM authz_events')?.n!==1||
      catalog.db.get<{n:number}>('SELECT count(*) AS n FROM principals')?.n!==1||
      !catalog.db.get("SELECT 1 FROM meta WHERE key='enrollment_hash'"))return false;
    await checkAuthz(catalog,c);return true;
  } catch{return false;}
}
function snapshot(catalog:Catalog,c:ArchiveDurabilityContext):Snapshot{
  const expected=new Set<string>(TABLES);
  const existing=catalog.db.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'");
  if(existing.some(r=>!expected.has(r.name)&&!EPHEMERAL.has(r.name)&&!r.name.startsWith('fts_')&&!r.name.startsWith('sqlite_')&&!r.name.startsWith('_cf_')))refuse();
  const tables:Snapshot['tables']={};let total=0;
  for(const table of TABLES){
    const cols=catalog.db.all<{name:string;pk:number}>(`PRAGMA table_info(${table})`);
    const order=cols.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>`"${x.name}"`).join(',')||'rowid';
    const rows=catalog.db.all<Record<string,SqlParam>>(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ${MAX_ROWS+1}`);
    total+=rows.length;if(total>MAX_ROWS)refuse();tables[table]=rows;
  }
  // Usage/cached result rows are intentionally not part of a recovery grant.
  return {schema:'kl-archive-projection/v1',schemaVersion:SCHEMA_VERSION,libraryHash:ctx(c).libraryHash,tables};
}
/** Caller must serialize all catalog changes until this complete write/readback finishes. */
export async function sealArchive(catalog:Catalog,c:ArchiveDurabilityContext):Promise<ArchiveSeal|undefined>{
  const limits=ctx(c), head=catalog.head();if(!catalog.verifyChain().ok)refuse();
  const previous=await latest(c);await checkAuthz(catalog,c,true);
  if(!previous&&virgin(catalog))return undefined;
  if(!head.seq)refuse();
  if(epoch(catalog.db)<c.minPolicyEpoch)refuse();
  if(previous){
    const old=catalog.db.get<{hash:string}>('SELECT hash FROM events WHERE seq=?',[previous.eventSeq]);
    if(old?.hash!==previous.eventHash||authzHead(catalog.db)<previous.authzSeq||epoch(catalog.db)<previous.minPolicyEpoch)refuse();
  }
  const data=bytes(snapshot(catalog,c));if(data.length>limits.max)refuse();
  const snapshotHash=sha256Hex(data), rows=catalog.db.all<EventRow>('SELECT * FROM events ORDER BY seq');
  if(previous?.eventSeq===head.seq&&previous.authzSeq===authzHead(catalog.db)&&previous.snapshotHash===snapshotHash){
    await verifyArchiveFreshness(catalog,c);return previous;
  }
  const ledger=enc.encode(rows.map(r=>canonicalJson(r)).join('\n')+'\n');
  if(ledger.length>limits.max)refuse();
  const seal:ArchiveSeal={schema:'kl-archive-seal/v1',libraryHash:limits.libraryHash,revision:(previous?.revision??0)+1,
    schemaVersion:SCHEMA_VERSION,eventSeq:head.seq,eventHash:head.hash,authzSeq:authzHead(catalog.db),minPolicyEpoch:epoch(catalog.db),snapshotHash,ledgerHash:sha256Hex(ledger)};
  if(seal.revision>MAX_SEALS)refuse();
  await verifiedPut(c.store,`snap/${limits.libraryHash}/${snapshotHash}.json`,data);
  await verifiedPut(c.store,`ledger/${limits.libraryHash}/${seal.ledgerHash}.jsonl`,ledger);
  await verifiedPut(c.store,`${anchorPrefix(c)}${String(seal.revision).padStart(12,'0')}-${sha256Hex(bytes(seal))}.json`,bytes(seal));
  return seal;
}

/** Restore a verified latest dump into a virgin scratch catalog only. A newer
 * narrowing checkpoint that the snapshot cannot replay keeps recovery closed. */
export async function restoreArchive(catalog:Catalog,c:ArchiveDurabilityContext):Promise<ArchiveSeal>{
  const seal=await latest(c);if(!seal||TABLES.some(t=>t!=='meta'&&catalog.db.get(`SELECT 1 FROM ${t} LIMIT 1`))||
    [...EPHEMERAL].some(t=>catalog.db.get(`SELECT 1 FROM ${t} LIMIT 1`))||
    catalog.db.all<{key:string;value:string}>('SELECT key,value FROM meta').some(r=>!(['schema_version','min_policy_epoch','setup_mode'].includes(r.key))||
      r.value!==({schema_version:String(SCHEMA_VERSION),min_policy_epoch:'0',setup_mode:'0'} as Record<string,string>)[r.key]))refuse();
  const raw=await c.store.get(`snap/${seal.libraryHash}/${seal.snapshotHash}.json`);
  if(!raw||raw.length>ctx(c).max||sha256Hex(raw)!==seal.snapshotHash)refuse();
  let dump:Snapshot;try{dump=JSON.parse(dec.decode(raw));}catch{refuse();}
  if(dump.schema!=='kl-archive-projection/v1'||dump.schemaVersion!==SCHEMA_VERSION||dump.libraryHash!==seal.libraryHash||!dump.tables||
    canonicalJson(Object.keys(dump.tables).sort())!==canonicalJson([...TABLES].sort()))refuse();
  let total=0;
  for(const table of TABLES){
    const rows=dump.tables[table];if(!Array.isArray(rows))refuse();total+=rows.length;if(total>MAX_ROWS)refuse();
    const columns=catalog.db.all<{name:string}>(`PRAGMA table_info(${table})`).map(x=>x.name).sort();
    for(const row of rows){if(!row||Array.isArray(row)||canonicalJson(Object.keys(row).sort())!==canonicalJson(columns)||
      Object.values(row).some(v=>v!==null&&typeof v!=='string'&&(typeof v!=='number'||!Number.isFinite(v))))refuse();}
  }
  let previous=GENESIS,seq=0;
  for(const row of dump.tables.events!){const e=row as unknown as EventRow;if(e.seq!==++seq||e.prev_hash!==previous||eventHash(e)!==e.hash)refuse();previous=e.hash;}
  if(seq!==seal.eventSeq||previous!==seal.eventHash)refuse();
  // Authenticate all locked checkpoints before any SQL mutation. No stale ACL
  // can be imported after a revocation that is newer than this projection.
  const authzKeys=await checkpointKeys(c);
  for(const row of dump.tables.outbox!)if(['authz.checkpoint','enrollment.checkpoint'].includes(String(row.step))&&
    !authzKeys.includes(`authz/${String(row.target).padStart(12,'0')}.json`))refuse();
  for(const key of authzKeys){const m=/^authz\/(\d{12})\.json$/.exec(key);if(!m)refuse();
    const row=dump.tables.authz_events!.find(r=>r.seq===Number(m[1]));if(!row)refuse();
    const actual=await c.store.get(key);if(!actual||sha256Hex(actual)!==sha256Hex(bytes({...row,minPolicyEpoch:row.epoch})))refuse();}
  const ledger=await c.store.get(`ledger/${seal.libraryHash}/${seal.ledgerHash}.jsonl`);
  if(!ledger||sha256Hex(ledger)!==seal.ledgerHash||sha256Hex(enc.encode(dump.tables.events!.map(r=>canonicalJson(r)).join('\n')+'\n'))!==seal.ledgerHash)refuse();
  catalog.db.transaction(()=>{
    catalog.db.exec('PRAGMA defer_foreign_keys=ON');
    for(const table of TABLES){
      if(table==='meta')catalog.db.run('DELETE FROM meta');
      const rows=dump.tables[table]!;for(const row of rows){const cols=Object.keys(row);
        catalog.db.run(`INSERT INTO ${table} (${cols.map(k=>`"${k}"`).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,cols.map(k=>row[k]!));}
    }
    // Reconstruct both FTS partitions from the authenticated chunk projection.
    for(const r of catalog.db.all<{privacy_class:string}>('SELECT DISTINCT privacy_class FROM chunks')){
      const table=ensureFtsTable(catalog.db,r.privacy_class);
      catalog.db.run(`INSERT INTO ${table}(title,headings,tags,body,path,chunk_rowid) SELECT title,headings,tags,body,path,rowid FROM chunks WHERE privacy_class=?`,[r.privacy_class]);
    }
    migrateCollectionIndexes(catalog.db);
    if(!catalog.verifyChain().ok||authzHead(catalog.db)!==seal.authzSeq||epoch(catalog.db)!==seal.minPolicyEpoch)refuse();
    catalog.db.run("INSERT INTO meta(key,value) VALUES('recovery_state','pending')");
  });
  await verifyArchiveFreshness(catalog,c);
  catalog.db.run("DELETE FROM meta WHERE key='recovery_state'");
  return seal;
}
