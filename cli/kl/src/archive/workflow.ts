import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { versionCitation } from '../../../../packages/core/src/primitives/citation.ts';
import { PushJournal, type JournalRun } from './journal.ts';
import type { ArchiveRegistration } from './registration.ts';
import type { ArchiveScan } from './source.ts';

const SMALL = 1 << 20;
const MAX_RESPONSE = 25 * 1024 * 1024;
const NOTE_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-server-response');
  return value as Json;
}
function index(value: unknown, length: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) throw Error('invalid-server-response');
  return value as number;
}
export class ArchiveHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`archive-http-${status}`); this.status=status; }
}
/** Rate-limited readback must respect the service window. A response cannot request an unbounded sleep. */
export function archiveRetryDelay(status:number, retryAfter:string|null, attempt:number, now=Date.now()):number {
  const seconds=retryAfter!==null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  const suggested=Number.isFinite(seconds) ? seconds*1000 : retryAfter===null ? NaN : Date.parse(retryAfter)-now;
  if (Number.isFinite(suggested) && suggested>=0) return Math.min(60_000,suggested);
  return status===429 ? Math.min(60_000,1000*2**attempt) : 100*(attempt+1);
}
export type ArchiveReceiptStatus = 'current' | 'sibling' | 'proposed-edit' | 'held' | 'refused' | 'rerouted' | 'pending' | 'unproven';
export interface ArchiveReceiptItem {
  n: number; relPath: string; sha256: string; noteId?: string; ver?: number; cite?: string;
  stage: 'READBACK_OK' | 'CUSTODY_OK' | 'COMMITTED' | 'UNPROVEN';
  status: ArchiveReceiptStatus; deduped: boolean; reused: boolean; reason?: string; ruleCodes?: string[]; readbackAt?: string;
  accountingMismatch?: 'reuse-plan-mismatch';
}
export interface ArchiveReceipt {
  schemaVersion: 'kl-upload-receipt/v1'; mode: 'push' | 'sync'; snapshotId: string; pushId: string;
  folderId: string; completedAt: string; partial: boolean; removalAuthorized: false;
  counts: { scanned: number; pushed: number; deduplicated: number; reused: number; reusedBytes: number; heldLocal: number; readErrors: number; skipped: number; custodyVerified: number; readbackVerified: number; unresolved: number };
  items: ArchiveReceiptItem[];
}
export interface ArchiveWorkflowOptions {
  registration: ArchiveRegistration; scan: ArchiveScan | (() => Promise<ArchiveScan>); journal: PushJournal;
  token: string; fetch: typeof fetch; mode: 'push' | 'sync'; now?: () => string;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (value.byteLength > limit - count) { await reader.cancel(); throw Error('server-response-too-large'); }
      chunks.push(value); count += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Each attempt is journaled before dispatch. No redirects, token fallback, remote error text,
 * or source removal. Recovery reruns manifest/diff for the same durable snapshot identity. */
async function request(o: ArchiveWorkflowOptions, run: JournalRun, phase: string, item: number | null,
  path: string, init: RequestInit, limit = MAX_RESPONSE,
  verify?: (bytes:Uint8Array,headers:Headers)=>Record<string,unknown>): Promise<{ bytes: Uint8Array; headers: Headers }> {
  const now = o.now ?? (() => new Date().toISOString());
  for (let attempt = 0; attempt < 3; attempt++) {
    const step = o.journal.intent(run, phase, item, now());
    let retryDelay=100*(attempt+1);
    try {
      const response = await o.fetch(o.registration.apiOrigin + path, { ...init, redirect: 'error',
        signal: AbortSignal.timeout(30_000), headers: { ...init.headers, authorization: `Bearer ${o.token}` } });
      if (!response.ok) { retryDelay=archiveRetryDelay(response.status,response.headers.get('retry-after'),attempt); await response.body?.cancel(); throw new ArchiveHttpError(response.status); }
      const bytes = await readBounded(response, limit);
      const proof = verify?.(bytes,response.headers);
      o.journal.outcome(step, 'ok', { status: response.status, bytes: bytes.byteLength, ...proof }, now());
      return { bytes, headers: response.headers };
    } catch (error) {
      // Intentionally omit error.message: network exceptions can contain credentials or request data.
      o.journal.outcome(step, 'failed', { code: error instanceof ArchiveHttpError ? error.message : 'transport-or-response-failed' }, now());
      if ((error instanceof ArchiveHttpError && error.status !== 429 && error.status < 500) || attempt === 2) throw error instanceof ArchiveHttpError ? error : Error('archive-transport-or-response-failed');
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  throw Error('archive-retry-exhausted');
}

async function post(o: ArchiveWorkflowOptions, run: JournalRun, phase: string, body: unknown): Promise<Json> {
  const path = phase === 'manifest' ? '/v1/manifest/diff' : phase === 'batch' ? '/v1/batch' : '/v1/commit';
  const { bytes } = await request(o,run,phase,null,path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try { return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))); }
  catch { throw Error('invalid-server-response'); }
}

export async function runArchiveWorkflow(o: ArchiveWorkflowOptions): Promise<ArchiveReceipt> {
  const release = o.journal.lockFolder(sha256Hex(canonicalJson({ origin: o.registration.apiOrigin, folderId: o.registration.folderId })));
  try { return await runLockedWorkflow({ ...o, scan: typeof o.scan === 'function' ? await o.scan() : o.scan }); }
  finally { release(); }
}

async function runLockedWorkflow(o: ArchiveWorkflowOptions & { scan: ArchiveScan }): Promise<ArchiveReceipt> {
  const now = o.now ?? (() => new Date().toISOString()); const { registration: reg, scan, journal } = o;
  // Local hashes bind a resume to the exact client grant, policy, source and endpoint. No bearer is persisted.
  const binding = sha256Hex(canonicalJson({ folderId:reg.folderId, device:reg.device, root:reg.root,
    origin:reg.apiOrigin, collection:reg.collectionId, policy:reg.policyHash, grant:sha256Hex(o.token) }));
  // Credential/policy rotation does not change which source last observed the archived head.
  const checkpointBinding = sha256Hex(canonicalJson({ folderId:reg.folderId, device:reg.device, root:reg.root,
    origin:reg.apiOrigin, collection:reg.collectionId }));
  const prior = journal.versions(checkpointBinding,binding);
  const entries = scan.files.map(file => ({relPath:file.relPath,sha256:file.sha256,size:file.size,mtime:file.mtime,
    gitTracked:file.gitTracked,lastKnownVer:prior.get(file.relPath)?.ver}));
  const heldLocal: Record<string,number> = {};
  for (const item of scan.heldLocal) for (const rule of item.ruleCodes) heldLocal[rule] = (heldLocal[rule] ?? 0) + 1;
  const manifest = { folderId:reg.folderId, device:reg.device, collection:reg.collectionId,
    identity:{volumeSerial:reg.identity.volumeSerial,rootFileId:reg.identity.fileId}, entries,
    scanComplete:scan.complete,heldLocal };
  const serialized = canonicalJson(manifest);
  let run = journal.begin(binding,sha256Hex(serialized),serialized,now());
  let diff: Json;
  try { diff = await post(o,run,'manifest',{...manifest,snapshotId:run.snapshotId,...(run.pushId ? {pushId:run.pushId} : {})}); }
  catch (error) {
    if (!(error instanceof ArchiveHttpError) || error.status !== 410) throw error;
    journal.abandonExpired(run,now());
    run = journal.begin(binding,sha256Hex(serialized),serialized,now());
    diff = await post(o,run,'manifest',{...manifest,snapshotId:run.snapshotId});
  }
  if (typeof diff.pushId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(diff.pushId) || !Array.isArray(diff.missing)
    || (diff.reusable !== undefined && !Array.isArray(diff.reusable))) throw Error('invalid-server-response');
  journal.bindPush(run,diff.pushId);
  const requested = new Set<number>(); const small: {n:number;contentBase64:string}[] = [];
  // Validate the complete transfer plan before sending bytes. Reuse metadata identifies only
  // this manifest entry; it never supplies an unrelated source note as a destination receipt.
  const offered = new Set<number>();
  for (const [values, seen] of [[diff.missing,requested],[diff.reusable ?? [],offered]] as [unknown[],Set<number>][]) {
    for (const value of values) {
      const item = object(value); const n = index(item.n,entries.length); const entry = entries[n]!;
      if (seen.has(n) || (seen===offered && requested.has(n)) || item.relPath !== entry.relPath || item.sha256 !== entry.sha256 || item.size !== entry.size) throw Error('invalid-server-response');
      seen.add(n);
    }
  }
  journal.planUploads(run,[...requested],now());
  const possibleUploads=journal.possibleUploads(run,entries.flatMap((entry,n)=>entry.size<=SMALL?[n]:[]));
  for (const n of requested) {
    const file = scan.files[n]!;
    if (file.size <= SMALL) small.push({n,contentBase64:Buffer.from(file.bytes).toString('base64')});
    else await request(o,run,'upload',n,`/v1/upload/${run.pushId}/${n}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:file.bytes as unknown as BodyInit});
  }
  // Batch wire size includes base64/JSON overhead, with headroom below the pilot's 4 MiB request limit.
  let batch: typeof small = []; let size = 0;
  for (const item of small) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (size + itemBytes > 3 * 1024 * 1024 && batch.length) { await post(o,run,'batch',{pushId:run.pushId,items:batch}); batch=[]; size=0; }
    batch.push(item); size += itemBytes;
  }
  if (batch.length) await post(o,run,'batch',{pushId:run.pushId,items:batch});
  const committed = await post(o,run,'commit',{pushId:run.pushId});
  if (committed.pushId !== run.pushId || !Array.isArray(committed.results) || typeof committed.partial !== 'boolean') throw Error('invalid-server-response');
  const seen = new Set<number>(); const items: ArchiveReceiptItem[] = [];
  for (const value of committed.results) {
    const row = object(value); const n = index(row.n,entries.length); const entry = entries[n]!;
    if (seen.has(n) || row.relPath !== entry.relPath) throw Error('invalid-server-response');
    seen.add(n);
    if (row.reused !== undefined && typeof row.reused !== 'boolean') throw Error('invalid-server-response');
    const item: ArchiveReceiptItem = {n,relPath:entry.relPath,sha256:entry.sha256,stage:'UNPROVEN',status:'unproven',deduped:false,reused:false};
    items.push(item);
    if (row.ok === false) {
      if (!['held','refused','rerouted','pending'].includes(String(row.status)) || typeof row.reason !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(row.reason) ||
          (row.status === 'pending' && !['custody-pending','reuse-failed'].includes(row.reason)) ||
          (row.ruleCodes !== undefined && (!Array.isArray(row.ruleCodes) || row.ruleCodes.length > 100 || row.ruleCodes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(code))))) throw Error('invalid-server-response');
      item.status = row.status as ArchiveReceiptStatus; item.reason = row.reason;
      if (row.ruleCodes !== undefined) item.ruleCodes = row.ruleCodes as string[];
      continue;
    }
    if (row.ok !== true || !['current','sibling','proposed-edit','held'].includes(String(row.status))) throw Error('invalid-server-response');
    if (row.sha256 !== entry.sha256 || typeof row.noteId !== 'string' || !NOTE_ID.test(row.noteId) || !Number.isSafeInteger(row.ver) || (row.ver as number) < 1 || row.cite !== versionCitation(row.noteId,row.ver as number,entry.sha256)) throw Error('invalid-server-response');
    item.noteId = row.noteId; item.ver = row.ver as number; item.cite = row.cite as string;
    item.status = row.status as ArchiveReceiptStatus; item.deduped = row.deduped === true; item.stage = 'COMMITTED';
    // The durable local transfer history is authoritative for byte savings. A server can
    // discover a reuse source after refusing a requested upload; that is valid
    // progress, but bytes already sent cannot count as saved. Destination dedup
    // and historical reuse are mutually exclusive accounting categories.
    item.reused = row.reused === true && !possibleUploads.has(n) && !item.deduped;
    if (offered.has(n) && row.reused !== true) item.accountingMismatch = 'reuse-plan-mismatch';
    if (row.custody !== 'verified' && row.custody !== 'indexed') { item.reason='custody-not-verified'; continue; }
    item.stage='CUSTODY_OK';
    try {
      await request(o,run,'readback',n,`/v1/version/${row.noteId}@${row.ver}/bytes`,{method:'GET'},entry.size,(bytes,headers)=>{
        if (headers.get('x-kl-sha256') !== entry.sha256 || bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256 || !Buffer.from(bytes).equals(Buffer.from(scan.files[n]!.bytes))) throw Error('readback-mismatch');
        return {stage:'READBACK_OK',sha256:entry.sha256,noteId:row.noteId,ver:row.ver};
      });
      item.stage='READBACK_OK'; item.readbackAt=now();
    } catch { item.reason='readback-failed'; }
  }
  for (let n=0;n<entries.length;n++) if (!seen.has(n)) items.push({n,relPath:entries[n]!.relPath,sha256:entries[n]!.sha256,stage:'UNPROVEN',status:'unproven',deduped:false,reused:false,reason:'not-committed'});
  items.sort((a,b)=>a.n-b.n);
  const verified = items.filter(item=>item.stage==='READBACK_OK');
  const unresolved = items.filter(item=>item.stage!=='READBACK_OK'||item.status!=='current').length;
  const receipt: ArchiveReceipt = {schemaVersion:'kl-upload-receipt/v1',mode:o.mode,snapshotId:run.snapshotId,pushId:run.pushId!,folderId:reg.folderId,completedAt:now(),
    partial:!scan.complete || scan.heldLocal.length>0 || unresolved>0 || committed.partial===true,removalAuthorized:false,
    counts:{scanned:scan.files.length+scan.heldLocal.length+scan.skipped.length+scan.readErrors.length,pushed:items.filter(i=>i.stage!=='UNPROVEN'&&!i.deduped).length,
      deduplicated:items.filter(i=>i.stage!=='UNPROVEN'&&i.deduped).length,
      // Pushed/deduplicated describe destination versions; reuse describes their byte transfer.
      reused:items.filter(i=>i.stage!=='UNPROVEN'&&i.reused).length,reusedBytes:items.reduce((bytes,i)=>bytes+(i.stage!=='UNPROVEN'&&i.reused?entries[i.n]!.size:0),0),
      heldLocal:scan.heldLocal.length,readErrors:scan.readErrors.length,skipped:scan.skipped.length,
      custodyVerified:items.filter(i=>i.stage==='CUSTODY_OK'||i.stage==='READBACK_OK').length,readbackVerified:verified.length,unresolved},items};
  // Terminal dispositions do not freeze admitted neighbors. Unresolved custody/readback keeps
  // the exact grant-bound resume manifest; current checkpoints and completion stay atomic.
  if (items.every(item=>item.stage==='READBACK_OK' || (item.stage==='UNPROVEN' && ['held','refused','rerouted'].includes(item.status))))
    journal.complete(run,receipt,now(),items.filter(item=>item.stage==='READBACK_OK' && item.status==='current').map(item=>({
      relPath:item.relPath,noteId:item.noteId!,ver:item.ver!,sha256:item.sha256})),checkpointBinding);
  return receipt;
}
