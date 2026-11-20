// Model-only physical movement vocabulary. No native journal or upstream authorization.
import type { FileGuard, FileIdentity, FsCode, FsPath, ParentGuard } from '../fs/fs.ts';
import { canonicalJson } from '../primitives/canonical.ts';
import { sha256Hex } from '../primitives/sha256.ts';

declare const attemptBrand: unique symbol;
export interface JournalAttempt { readonly [attemptBrand]: 'memory-journal-session'; }
export interface MoveIds { readonly runId: string; readonly itemId: string; readonly attemptId: string; }
export interface PhysicalMoveSpec extends MoveIds {
  readonly source: { readonly path: FsPath; readonly guard: FileGuard; readonly sha256: string; readonly bytes: number };
  readonly held: { readonly path: FsPath; readonly parents: ParentGuard };
}
export type PhysicalStep = 'bind-source' | 'create-held' | 'copy' | 'flush-held' | 'verify-held' | 'remove-source' | 'observe-held' | 'clean-unverified-partial' | 'reconcile';
export interface PhysicalObservation {
  readonly source: 'verified-plan-identity' | 'absent' | 'changed' | 'unknown';
  readonly held: 'verified-readonly' | 'known-unverified-partial' | 'absent' | 'changed' | 'unknown';
  readonly heldIdentity: FileIdentity | null;
  readonly heldSha256: string | null;
  readonly bytes: number | null;
}
export interface RecordInput {
  readonly eventId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly stage: PhysicalStep;
  readonly kind: 'intent' | 'confirmation';
  readonly observation: PhysicalObservation | null;
}
export interface MoveRecord extends RecordInput {
  readonly sequence: number;
  readonly bindingHash: string;
  readonly priorDigest: string | null;
  readonly digest: string;
}
export type JournalCode = 'busy' | 'changed-binding' | 'revision-conflict' | 'corrupt' | 'limit' | 'io-error' | 'unsupported' | 'not-found' | 'invalid-session' | 'invalid-spec' | 'invalid-transition';
export type JournalAck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: JournalCode; readonly retained: 'none' | 'unknown' };
export interface JournalView { readonly spec: PhysicalMoveSpec; readonly revision: number; readonly records: readonly MoveRecord[]; }
export interface MovementJournal {
  readonly implementation: 'memory-model';
  reserve(spec: PhysicalMoveSpec): Promise<JournalAck<{ readonly attempt: JournalAttempt; readonly revision: number }>>;
  openExisting(ids: MoveIds): Promise<JournalAck<{ readonly attempt: JournalAttempt; readonly revision: number }>>;
  read(attempt: JournalAttempt): Promise<JournalAck<JournalView>>;
  appendAndSync(attempt: JournalAttempt, expectedRevision: number, record: RecordInput): Promise<JournalAck<{ readonly revision: number; readonly digest: string }>>;
  release(attempt: JournalAttempt): Promise<JournalAck<void>>;
}
export type OutcomeReason = 'complete' | 'invalid-spec' | 'journal-refused' | 'journal-unknown' | 'fs-refused' | 'source-mismatch' | 'destination-conflict' | 'held-changed' | 'source-absent-without-intent' | 'missing-verified-copy' | 'model-crash' | 'copy-limit' | 'close-unknown';
export interface ModelMoveOutcome {
  readonly modelOnly: true;
  readonly status: 'physical-held' | 'skipped' | 'pending' | 'conflict' | 'hard-alarm';
  readonly reason: OutcomeReason;
  readonly source: 'retained' | 'absent' | 'unknown';
  readonly held: 'verified-readonly' | 'partial' | 'absent' | 'changed' | 'unknown';
  readonly journalRevision: number | null;
  readonly failedFsCode?: FsCode;
  readonly removalMayHaveCommitted: boolean;
}
export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
export const digestValue = (value: unknown): string => sha256Hex(canonicalJson(value));
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (x: unknown): void => { if (x && typeof x === 'object') { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } };
  freeze(copy); return copy;
}
const keys = (x: unknown, expected: string[]): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...expected].sort().join(',');
const bounded = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const identity = (x: unknown): x is FileIdentity => keys(x, ['volumeSerial','fileId']) && [x.volumeSerial,x.fileId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128);
const segments = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 32 && x.every(v => typeof v === 'string' && v.length > 0 && v.length <= 120 && /^[\x20-\x7e]+$/.test(v) && !/[\\/:]/.test(v) && !/[. ]$/.test(v) && v !== '.' && v !== '..');
function validPath(x: unknown): x is FsPath { return keys(x,['scope','segments']) && typeof x.scope === 'string' && x.scope.length > 0 && x.scope.length <= 128 && segments(x.segments) && x.segments.length > 0; }
function validParents(x: unknown, p: FsPath): x is ParentGuard {
  if (!keys(x,['scope','parents']) || x.scope !== p.scope || !Array.isArray(x.parents) || x.parents.length !== p.segments.length) return false;
  return x.parents.every((v,i) => keys(v,['segments','identity']) && Array.isArray(v.segments) && v.segments.length === i && v.segments.every((s,j) => s === p.segments[j]) && identity(v.identity));
}
export function validIds(x: MoveIds): boolean { return !!x && bounded(x.runId) && bounded(x.itemId) && bounded(x.attemptId); }
export function validSpec(x: unknown): x is PhysicalMoveSpec {
  if (!keys(x,['runId','itemId','attemptId','source','held']) || !validIds(x as unknown as MoveIds)) return false;
  const s=x.source,h=x.held;
  if (!keys(s,['path','guard','sha256','bytes']) || !validPath(s.path) || !keys(s.guard,['parents','identity']) || !identity(s.guard.identity) || !validParents(s.guard.parents,s.path) || typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.bytes) || (s.bytes as number) < 0 || (s.bytes as number) > 1_048_576) return false;
  if (!keys(h,['path','parents']) || !validPath(h.path) || !validParents(h.parents,h.path)) return false;
  return !(s.path.scope === h.path.scope && s.path.segments.map(v=>v.toLowerCase()).join('/') === h.path.segments.map(v=>v.toLowerCase()).join('/'));
}
export interface HistoryFacts { readonly heldIdentity: FileIdentity | null; readonly everVerified: boolean; readonly removalIntent: boolean; readonly cleanupIntent: boolean; readonly physicalHeld: boolean; }
/** Validate the complete retained history; no partial prefix is silently treated as an empty journal. */
export function validateHistory(spec: PhysicalMoveSpec, rows: readonly MoveRecord[]): HistoryFacts | null {
  if (!validSpec(spec) || rows.length > 128) return null;
  const bindingHash=digestValue(spec), events=new Set<string>(), intents=new Set<string>();
  let prior: MoveRecord | undefined, heldIdentity: FileIdentity | null=null, everVerified=false, removalIntent=false, cleanupIntent=false, physicalHeld=false;
  const stages: PhysicalStep[]=['bind-source','create-held','copy','flush-held','verify-held','remove-source','observe-held','clean-unverified-partial','reconcile'];
  for (let index=0;index<rows.length;index++) {
    const r=rows[index]!;
    if (!keys(r,['eventId','intentId','attemptId','stage','kind','observation','sequence','bindingHash','priorDigest','digest']) || !bounded(r.eventId) || !bounded(r.intentId) || r.attemptId !== spec.attemptId || events.has(r.eventId) || r.sequence !== index+1 || r.bindingHash !== bindingHash || r.priorDigest !== (prior?.digest ?? null) || !stages.includes(r.stage) || !['intent','confirmation'].includes(r.kind)) return null;
    const {digest,...body}=r; if (digestValue(body)!==digest) return null; events.add(r.eventId);
    const o=r.observation;
    if (o !== null) {
      if (!keys(o,['source','held','heldIdentity','heldSha256','bytes']) || !['verified-plan-identity','absent','changed','unknown'].includes(o.source) || !['verified-readonly','known-unverified-partial','absent','changed','unknown'].includes(o.held) || o.heldIdentity !== null && !identity(o.heldIdentity) || o.heldSha256 !== null && !/^[0-9a-f]{64}$/.test(o.heldSha256) || o.bytes !== null && (!Number.isSafeInteger(o.bytes)||o.bytes<0||o.bytes>1_048_576)) return null;
      if (o.heldIdentity && sameIdentity(o.heldIdentity,spec.source.guard.identity)) return null;
      if (o.held === 'verified-readonly' && (!heldIdentity || !o.heldIdentity || !sameIdentity(o.heldIdentity,heldIdentity) || o.heldSha256 !== spec.source.sha256 || o.bytes !== spec.source.bytes)) return null;
    }
    if (r.kind==='intent') {
      if (intents.has(r.intentId)) return null; intents.add(r.intentId);
      if (index===0) { if (r.stage!=='bind-source' || o!==null) return null; }
      else if (r.stage==='reconcile') { /* Explicitly supersedes an uncertain pending intent; no physical authority. */ }
      else if (r.stage==='clean-unverified-partial') { if (!heldIdentity || everVerified || removalIntent || o?.source!=='verified-plan-identity' || o.held!=='known-unverified-partial' || !o.heldIdentity || !sameIdentity(o.heldIdentity,heldIdentity)) return null; }
      else {
        if (!prior || prior.kind!=='confirmation') return null;
        const previous=prior.stage, observed=prior.observation;
        if (r.stage==='create-held' && !(['bind-source','clean-unverified-partial','reconcile'].includes(previous) && observed?.source==='verified-plan-identity' && observed.held==='absent' && !heldIdentity)) return null;
        if (r.stage==='copy' && previous!=='create-held') return null;
        if (r.stage==='flush-held' && previous!=='copy') return null;
        if (r.stage==='verify-held' && previous!=='flush-held') return null;
        if (r.stage==='remove-source' && (!['verify-held','reconcile'].includes(previous) || observed?.source!=='verified-plan-identity' || observed.held!=='verified-readonly' || !everVerified)) return null;
        if (r.stage==='observe-held' && (!['remove-source','reconcile'].includes(previous) || observed?.source!=='absent' || observed.held!=='verified-readonly' || !removalIntent)) return null;
        if (r.stage==='bind-source') return null;
      }
      if (r.stage==='remove-source') removalIntent=true;
      if (r.stage==='clean-unverified-partial') cleanupIntent=true;
    } else {
      if (!prior || prior.kind!=='intent' || prior.stage!==r.stage || prior.intentId!==r.intentId || !o) return null;
      if (r.stage==='create-held') { if (heldIdentity || !o.heldIdentity || o.held!=='known-unverified-partial' || o.source!=='verified-plan-identity') return null; heldIdentity=o.heldIdentity; }
      else if (o.heldIdentity && (!heldIdentity || !sameIdentity(o.heldIdentity,heldIdentity))) return null;
      if (r.stage==='bind-source' && (o.source!=='verified-plan-identity'||o.held!=='absent')) return null;
      if (['copy','flush-held'].includes(r.stage) && (o.source!=='verified-plan-identity'||o.held!=='known-unverified-partial'||o.bytes!==spec.source.bytes)) return null;
      if (r.stage==='verify-held') { if (o.source!=='verified-plan-identity'||o.held!=='verified-readonly') return null; everVerified=true; }
      if (r.stage==='remove-source' && (o.source!=='absent'||o.held!=='verified-readonly')) return null;
      if (r.stage==='observe-held') { if (o.source!=='absent'||o.held!=='verified-readonly') return null; physicalHeld=true; }
      if (r.stage==='clean-unverified-partial') { if (o.source!=='verified-plan-identity'||o.held!=='absent') return null; heldIdentity=null;cleanupIntent=false; }
      if (r.stage==='reconcile'&&o.held==='absent'&&heldIdentity) { if(!cleanupIntent||everVerified||removalIntent||o.source!=='verified-plan-identity'||o.heldIdentity!==null)return null;heldIdentity=null;cleanupIntent=false; }
    }
    prior=r;
  }
  return {heldIdentity,everVerified,removalIntent,cleanupIntent,physicalHeld};
}
