// DESIGN §6.8 / §6.13. Proposed journal transitions ONLY. No durable adapter or execution permit.
import { DAY, count, dataCopy, digest, errorCode, freeze, hash, id, insist, keys, time, uniqueIds } from './plan-data.ts';
import { sameFolder, validateFolder, type FolderBinding } from './plan-caps.ts';

export interface RunBinding {
  runId: string; planHash: string; pilotId: string; pilotReceiptHash: string; folder: FolderBinding;
  registered: boolean; capHistoryRevision: number; authorityHash: string;
  plannedItems: readonly string[];
}
export interface EffectObservation {
  id: string; kind: 'movement' | 'pointer' | 'veil' | 'restore' | 'recovery'; itemId: string | null;
  beganAtMs: number; state: 'intent' | 'unknown' | 'settled'; observedAtMs: number | null; observationHash: string | null;
}
export interface PendingQuiet {
  binding: RunBinding; admittedAtMs: number; phase: 'admitted' | 'running' | 'interrupted' | 'terminal';
  effectRevision: number; effects: readonly EffectObservation[]; effectsDigest: string; completedAtMs: number | null;
  movementClosed: boolean;
}
export interface AdmissionSnapshot {
  complete: true; revision: number; observedAtMs: number;
  activePilot: { id: string; receiptHash: string; folder: FolderBinding; authorityHash: string };
  pending: PendingQuiet | null;
  // Complete retained membership, including runs with zero effects. Bounded refusal, never truncation.
  closedRunIds: readonly string[];
}
export interface QuietEvidence {
  complete: true; observedAtMs: number; noLaterContradiction: boolean; bindingHash: string; effectRevision: number; effectsDigest: string;
  budget: { state: 'verified'; receiptHash: string; bindingHash: string; effectsDigest: string; acceptedEvents: number };
  immediate: {
    capturedAtMs: number; observedEvents: number; noNewProjects: boolean; noPortfolioRefusal: boolean;
    pinnedUntouched: boolean; zeroLibraryWritesInOrrery: boolean; folderScan: 'unchanged' | 'expected-needs-review';
  };
  nightly: {
    id: string; scheduleHash: string; firstFollowingAfterMs: number; firstFollowingConfirmed: boolean;
    startedAtMs: number; finishedAtMs: number; capturedAtMs: number;
    noHeldPathRipple: boolean; noPointerSourceRipple: boolean; noHeldPathCorrector: boolean;
  };
}
export type AdmissionCommand =
  | { type: 'admit'; binding: RunBinding }
  | { type: 'resume'; binding: RunBinding }
  | { type: 'interrupt'; binding: RunBinding }
  | { type: 'begin-effect'; binding: RunBinding; effectId: string; kind: EffectObservation['kind']; itemId: string | null }
  | { type: 'observe-effect'; binding: RunBinding; effectId: string; state: 'unknown' | 'settled'; observationHash: string }
  | { type: 'complete'; binding: RunBinding }
  | { type: 'release'; binding: RunBinding; quiet: QuietEvidence };
export interface TransitionInput { nowMs: number; expectedRevision: number; snapshot: AdmissionSnapshot; command: AdmissionCommand }
export type AdmissionTransition =
  | { status: 'proposed'; expectedRevision: number; expectedStateHash: string; next: AdmissionSnapshot; nextStateHash: string;
      effect: 'none'; authorizesEffects: false; requires: readonly string[] }
  | { status: 'held'; reasons: readonly string[]; effect: 'none'; authorizesEffects: false };
export type AdmissionValidation =
  | { status: 'valid'; snapshot: AdmissionSnapshot; stateHash: string; effect: 'none'; authorizesEffects: false }
  | { status: 'held'; reasons: readonly string[]; effect: 'none'; authorizesEffects: false };

export const DURABLE_ADMISSION_REQUIREMENTS = Object.freeze([
  'one-process-shared-global-lock', 'atomic-complete-journal-read-and-revision-CAS',
  'durable-sync-before-every-effect-intent', 'unknown-commit-holds-until-reread',
  'persistent-run-membership-and-pending-checkpoint', 'per-folder-lock-and-fresh-preflight',
  'receipt-verification-and-cap-baseline-transaction', 'native-crash-and-concurrency-conformance',
] as const);
/** Read freshness is metadata; refreshing a snapshot must not change the persisted-state CAS hash. */
export function admissionStateHash(snapshot: AdmissionSnapshot): string {
  const { observedAtMs: _readTime, ...persisted } = snapshot;
  return digest(persisted);
}
function validateBinding(b: RunBinding): void {
  keys(b, 'runId planHash pilotId pilotReceiptHash folder registered capHistoryRevision plannedItems authorityHash'); validateFolder(b.folder);
  insist(id(b.runId) && hash(b.planHash) && id(b.pilotId) && hash(b.pilotReceiptHash)
    && typeof b.registered === 'boolean' && count(b.capHistoryRevision) && hash(b.authorityHash)); uniqueIds(b.plannedItems, 30);
}
function validateSnapshot(s: AdmissionSnapshot, now: number): void {
  keys(s, 'complete revision observedAtMs activePilot pending closedRunIds');
  insist(s.complete === true && count(s.revision) && s.observedAtMs === now);
  keys(s.activePilot, 'id receiptHash folder authorityHash'); validateFolder(s.activePilot.folder);
  insist(id(s.activePilot.id) && hash(s.activePilot.receiptHash) && hash(s.activePilot.authorityHash)); uniqueIds(s.closedRunIds, 10000);
  if (s.pending === null) return;
  const p = s.pending; keys(p, 'binding admittedAtMs phase effectRevision effects effectsDigest completedAtMs movementClosed'); validateBinding(p.binding);
  insist(!s.closedRunIds.includes(p.binding.runId) && time(p.admittedAtMs) && p.admittedAtMs <= now
    && ['admitted', 'running', 'interrupted', 'terminal'].includes(p.phase) && count(p.effectRevision)
    && Array.isArray(p.effects) && p.effects.length <= 1000 && hash(p.effectsDigest) && p.effectsDigest === digest(p.effects) && typeof p.movementClosed === 'boolean');
  uniqueIds(p.effects.map(e => e.id), 1000);
  for (const e of p.effects) {
    keys(e, 'id kind itemId beganAtMs state observedAtMs observationHash');
    insist(['movement', 'pointer', 'veil', 'restore', 'recovery'].includes(e.kind) && time(e.beganAtMs) && e.beganAtMs >= p.admittedAtMs && e.beganAtMs <= now
      && ['intent', 'unknown', 'settled'].includes(e.state));
    insist(e.kind === 'movement' ? id(e.itemId) && p.binding.plannedItems.includes(e.itemId) : e.itemId === null);
    if (e.state === 'intent') insist(e.observedAtMs === null && e.observationHash === null);
    else insist(time(e.observedAtMs) && e.observedAtMs >= e.beganAtMs && e.observedAtMs <= now && hash(e.observationHash));
  }
  uniqueIds(p.effects.filter(e => e.kind === 'movement').map(e => e.itemId!));
  insist(p.effects.filter(e => e.state !== 'settled').length <= 1);
  insist(p.effectRevision >= p.effects.length + p.effects.filter(e => e.state !== 'intent').length + (p.movementClosed ? 1 : 0));
  if (p.phase === 'admitted') insist(p.effects.length === 0 && p.effectRevision === 0 && !p.movementClosed);
  if (p.phase === 'terminal') insist(p.movementClosed && time(p.completedAtMs) && p.completedAtMs >= p.admittedAtMs && p.completedAtMs <= now
    && p.effects.every(e => e.state === 'settled' && e.observedAtMs! <= p.completedAtMs!));
  else insist(p.completedAtMs === null);
}
/** Public persistence boundary: validate a complete read without inventing an empty fallback. */
export function validateAdmissionSnapshot(raw: unknown, nowMs: number): AdmissionValidation {
  try {
    insist(time(nowMs)); const snapshot = dataCopy(raw) as AdmissionSnapshot; validateSnapshot(snapshot, nowMs);
    return freeze({ status: 'valid', snapshot, stateHash: admissionStateHash(snapshot), effect: 'none', authorizesEffects: false });
  } catch (error) { return freeze({ status: 'held', reasons: [errorCode(error)], effect: 'none', authorizesEffects: false }); }
}
function validateQuiet(q: QuietEvidence, p: PendingQuiet, now: number): void {
  keys(q, 'complete observedAtMs noLaterContradiction bindingHash effectRevision effectsDigest budget immediate nightly');
  insist(p.phase === 'terminal' && p.completedAtMs !== null && q.complete === true && q.observedAtMs === now && q.noLaterContradiction === true && q.bindingHash === digest(p.binding)
    && q.effectRevision === p.effectRevision && q.effectsDigest === p.effectsDigest, 'quiet-unproven');
  const b = q.budget; keys(b, 'state receiptHash bindingHash effectsDigest acceptedEvents');
  insist(b.state === 'verified' && hash(b.receiptHash) && b.bindingHash === q.bindingHash && b.effectsDigest === q.effectsDigest
    && count(b.acceptedEvents, 1000000), 'quiet-unproven');
  const i = q.immediate; keys(i, 'capturedAtMs observedEvents noNewProjects noPortfolioRefusal pinnedUntouched zeroLibraryWritesInOrrery folderScan');
  insist(time(i.capturedAtMs) && i.capturedAtMs >= p.completedAtMs && i.capturedAtMs <= now && now - i.capturedAtMs < DAY
    && count(i.observedEvents, 1000000) && i.observedEvents <= b.acceptedEvents && i.noNewProjects === true
    && i.noPortfolioRefusal === true && i.pinnedUntouched === true && i.zeroLibraryWritesInOrrery === true
    && i.folderScan === (p.binding.registered ? 'expected-needs-review' : 'unchanged'), 'quiet-unproven');
  const n = q.nightly; keys(n, 'id scheduleHash firstFollowingAfterMs firstFollowingConfirmed startedAtMs finishedAtMs capturedAtMs noHeldPathRipple noPointerSourceRipple noHeldPathCorrector');
  insist(id(n.id) && hash(n.scheduleHash) && n.firstFollowingConfirmed === true && n.firstFollowingAfterMs === p.completedAtMs
    && time(n.startedAtMs) && n.startedAtMs > p.completedAtMs && time(n.finishedAtMs) && n.finishedAtMs >= n.startedAtMs
    && time(n.capturedAtMs) && n.capturedAtMs >= n.finishedAtMs && n.capturedAtMs <= now && now - n.capturedAtMs < DAY
    && n.noHeldPathRipple === true && n.noPointerSourceRipple === true && n.noHeldPathCorrector === true, 'quiet-unproven');
}

export function proposeAdmissionTransition(raw: TransitionInput): AdmissionTransition {
  try {
    const x = dataCopy(raw); keys(x, 'nowMs expectedRevision snapshot command');
    insist(time(x.nowMs) && count(x.expectedRevision)); validateSnapshot(x.snapshot, x.nowMs);
    insist(x.expectedRevision === x.snapshot.revision, 'revision-conflict');
    const c = x.command; validateBinding(c.binding);
    const base = 'type binding';
    if (c.type === 'begin-effect') keys(c, base + ' effectId kind itemId');
    else if (c.type === 'observe-effect') keys(c, base + ' effectId state observationHash');
    else if (c.type === 'release') keys(c, base + ' quiet');
    else { keys(c, base); insist(['admit', 'resume', 'interrupt', 'complete'].includes(c.type)); }
    const next = dataCopy(x.snapshot); insist(next.revision < Number.MAX_SAFE_INTEGER);
    const samePilot = c.binding.pilotId === next.activePilot.id && c.binding.pilotReceiptHash === next.activePilot.receiptHash && c.binding.authorityHash === next.activePilot.authorityHash
      && sameFolder(c.binding.folder, next.activePilot.folder);
    if (c.type === 'admit') {
      insist(next.pending === null, 'pending-quiet'); insist(!next.closedRunIds.includes(c.binding.runId), 'run-reused');
      insist(next.closedRunIds.length < 10000, 'workload-limit'); insist(samePilot, 'pilot-unproven');
      next.pending = { binding: c.binding, admittedAtMs: x.nowMs, phase: 'admitted', effectRevision: 0,
        effects: [], effectsDigest: digest([]), completedAtMs: null, movementClosed: false };
    } else {
      const p = next.pending;
      insist(p !== null && digest(c.binding) === digest(p.binding), 'pending-quiet');
      if (c.type !== 'release') insist(samePilot, 'pilot-unproven');
      if (c.type === 'resume') { insist(p.phase !== 'terminal', 'pending-quiet'); p.phase = 'running'; }
      if (c.type === 'interrupt') { p.phase = 'interrupted'; p.completedAtMs = null; }
      if (c.type === 'begin-effect') {
        // Sequential effects include recovery/pointer/veil writes; ambiguity is reconciled first.
        insist(p.effects.every(e => e.state === 'settled'), 'pending-quiet');
        insist(id(c.effectId) && !p.effects.some(e => e.id === c.effectId) && p.effects.length < 1000
          && ['movement', 'pointer', 'veil', 'restore', 'recovery'].includes(c.kind));
        if (c.kind === 'movement') insist(!p.movementClosed && id(c.itemId) && p.binding.plannedItems.includes(c.itemId)
          && !p.effects.some(e => e.kind === 'movement' && e.itemId === c.itemId));
        else insist(c.itemId === null);
        p.effects = [...p.effects, { id: c.effectId, kind: c.kind, itemId: c.itemId, beganAtMs: x.nowMs, state: 'intent', observedAtMs: null, observationHash: null }];
        p.phase = 'running'; p.completedAtMs = null; p.effectRevision++;
      }
      if (c.type === 'observe-effect') {
        insist(id(c.effectId) && ['unknown', 'settled'].includes(c.state) && hash(c.observationHash));
        const e = p.effects.find(e => e.id === c.effectId); insist(e && e.state !== 'settled');
        e.state = c.state; e.observedAtMs = x.nowMs; e.observationHash = c.observationHash;
        p.phase = 'running'; p.completedAtMs = null; p.effectRevision++;
      }
      if (c.type === 'complete') {
        insist(p.phase !== 'terminal' && p.effects.every(e => e.state === 'settled'), 'pending-quiet');
        p.phase = 'terminal'; p.completedAtMs = x.nowMs; p.effectRevision++; p.movementClosed = true;
      }
      p.effectsDigest = digest(p.effects); insist(count(p.effectRevision));
      if (c.type === 'release') {
        validateQuiet(c.quiet, p, x.nowMs); next.closedRunIds = [...next.closedRunIds, p.binding.runId]; next.pending = null;
      }
    }
    next.revision++; next.observedAtMs = x.nowMs; validateSnapshot(next, x.nowMs);
    return freeze({ status: 'proposed', expectedRevision: x.expectedRevision, expectedStateHash: admissionStateHash(x.snapshot), next,
      nextStateHash: admissionStateHash(next), effect: 'none', authorizesEffects: false, requires: DURABLE_ADMISSION_REQUIREMENTS });
  } catch (error) { return freeze({ status: 'held', reasons: [errorCode(error)], effect: 'none', authorizesEffects: false }); }
}
