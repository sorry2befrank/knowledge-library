// One proposed combined state for the eventual journal transaction. No I/O or execution permit.
import { count, dataCopy, digest, freeze, hash, id, insist, keys, time, uniqueIds } from './plan-data.ts';
import { calculateCaps, localIsoWeek, sameFolder, type CapInput } from './plan-caps.ts';
import { buildFocusPlan, type FrozenPlan, type PlanInput, type PlanReview, type PlanControls } from './plan.ts';
import { eligible, closeKernelProposal, type KernelInput } from './eligibility.ts';
import { admissionStateHash, proposeAdmissionTransition, validateAdmissionSnapshot,
  type AdmissionSnapshot, type AdmissionCommand, type RunBinding } from './global-admission.ts';
import { capLedgerStateHash, capReservationId, projectCapHistory, proposeCapLedgerTransition, validateCapLedgerSnapshot,
  type CapLedgerCommand, type CapLedgerSnapshot, type CapacityEvidence } from './cap-ledger.ts';

export interface StoredCapPlan { plan: FrozenPlan; week: string; capRevision: number; authorityHash: string; plannedAtMs: number; recordedAtMs: number }
export interface CoupledSnapshot {
  schema: 'coupled-admission/v1'; complete: true; revision: number; observedAtMs: number;
  admission: AdmissionSnapshot; caps: CapLedgerSnapshot; plans: readonly StoredCapPlan[]; runs: readonly RunBinding[];
}
export type FreshCapFacts = Omit<CapInput, 'history' | 'nowMs'>;
export interface FreshAdmissionFacts { caps: FreshCapFacts; kernel: KernelInput; controls: PlanControls }
export type CoupledCommand =
  | { type: 'cover-calendar'; evidence: Extract<CapLedgerCommand, { type: 'cover' }>['evidence'] }
  | { type: 'commit-plan'; input: PlanInput; authorityHash: string }
  | { type: 'record-review'; priorPlanHash: string; review: PlanReview }
  | { type: 'admit-plan'; planHash: string; runId: string; fresh: FreshAdmissionFacts }
  | { type: 'admission'; command: Exclude<AdmissionCommand, { type: 'admit' }>; capacityEvidence: CapacityEvidence | null }
  | { type: 'settle-unused'; reservationId: string; evidence: CapacityEvidence };
export type CoupledHeld = { status: 'held'; reason: string; effect: 'none'; authorizesEffects: false };
const held = (reason: string): CoupledHeld => freeze({ status: 'held', reason, effect: 'none', authorizesEffects: false });
export const COUPLED_RELEASE_HOLDS = Object.freeze(['durable-combined-state-CAS', 'trusted-history-and-capacity-receipt-authentication',
  'fresh-apply-kernel-and-preflight', 'native-movement-and-per-folder-lock', 'actual-quiet-evidence-and-recovery', 'external-rollback-anchor'] as const);
export function coupledStateHash(s: CoupledSnapshot): string {
  return digest({ schema: s.schema, complete: s.complete, revision: s.revision, admission: admissionStateHash(s.admission),
    caps: capLedgerStateHash(s.caps), plans: s.plans, runs: s.runs });
}
function exactBinding(stored: StoredCapPlan, runId: string): RunBinding {
  const p = stored.plan, x = p.frozenInput;
  insist(typeof x.kernel.folder.registeredInOrrery === 'boolean');
  return { runId, planHash: p.planHash, pilotId: x.caps.pilot.id, pilotReceiptHash: x.caps.pilot.receiptHash,
    folder: x.caps.folder, registered: x.kernel.folder.registeredInOrrery, capHistoryRevision: stored.capRevision,
    authorityHash: stored.authorityHash, plannedItems: p.reviewed };
}
function capStep(s: CapLedgerSnapshot, command: CapLedgerCommand, nowMs: number): CapLedgerSnapshot {
  const step = proposeCapLedgerTransition({ snapshot: s, nowMs, expectedRevision: s.revision, expectedStateHash: capLedgerStateHash(s), command });
  insist(step.status === 'proposed', 'coupled-cap-held'); return step.next;
}
function validateFresh(f: FreshAdmissionFacts, stored: StoredCapPlan, now: number): void {
  keys(f, 'caps kernel controls'); keys(f.caps, 'folder calendar policy allowedTypeCount pilot ripple');
  keys(f.controls, 'state policyHash goalHash deviceId folderId observedAtMs policyEpoch goalEpoch approvalEpoch globalPaused folderPaused approvalFloor standingMode');
  const old = stored.plan.frozenInput, k = f.kernel;
  const { observedAtMs: _oldRead, ...oldControls } = old.controls, { observedAtMs: _freshRead, ...controls } = f.controls;
  insist(f.controls.observedAtMs === now && digest(controls) === digest(oldControls)
    && k.phase === 'apply' && k.nowMs === now && k.snapshot.capturedAtMs === now && k.references.readAtMs === now
    && digest(k.folder) === digest(old.kernel.folder) && digest(k.policy) === digest(old.kernel.policy)
    && digest(k.goal) === digest(old.kernel.goal), 'coupled-current-facts-invalid');
  // Historical proposal input remains untouched. Re-evaluate distinct current factual inputs.
  const current = eligible(k), closure = closeKernelProposal(k, stored.plan.reviewed);
  insist(current.evaluation === 'evaluated' && current.globalHolds.length === 0 && closure.evaluation === 'evaluated'
    && closure.globalHolds.length === 0 && stored.plan.reviewed.every(v => current.eligible.includes(v) && closure.eligible.includes(v)), 'coupled-current-kernel-held');
  for (const itemId of stored.plan.reviewed) insist(digest(k.snapshot.files.find(f => f.id === itemId))
    === digest(old.kernel.snapshot.files.find(f => f.id === itemId)), 'coupled-reviewed-item-changed');
  const r = old.review;
  if (r.rung < 2 || k.policy.nameMentions !== 'allow') insist(stored.plan.reviewed.every(v =>
    (closure.nameMentionCounts[v] ?? 0) === 0 || r.ticks.includes(v)), 'coupled-current-name-review-held');
  if (r.standing !== null) insist(r.standing.expiresAtMs > now
    && (r.standing.mode !== 'veto-24h' || r.standing.vetoClearThroughMs === now), 'coupled-review-stale');
  // Existing baseline arithmetic ignores this count; still require an honest complete current count.
  insist(k.snapshot.files.every(f => f.kind !== null && f.path?.normalized === true));
  const norm = (s: string) => s.normalize('NFC').toLowerCase();
  insist(k.snapshot.files.every(f => norm(f.path!.drive) === norm(k.folder.drive)
    && f.path!.segments.length > k.folder.segments.length
    && k.folder.segments.every((part, i) => norm(part) === norm(f.path!.segments[i]!))
    && f.location?.rootFileId === k.folder.rootFileId && f.identity?.volumeSerial === k.folder.volumeSerial), 'coupled-current-population-invalid');
  const allowed = k.snapshot.files.filter(f => f.kind === 'file' && k.policy.types.some(ext =>
    f.path!.segments.at(-1)!.toLowerCase().endsWith(ext.toLowerCase()))).length;
  insist(f.caps.allowedTypeCount === allowed, 'coupled-current-count-invalid');
}
function validate(s: CoupledSnapshot, now: number): void {
  keys(s, 'schema complete revision observedAtMs admission caps plans runs');
  insist(s.schema === 'coupled-admission/v1' && s.complete === true && time(now) && s.observedAtMs === now && count(s.revision));
  insist(validateAdmissionSnapshot(s.admission, now).status === 'valid' && validateCapLedgerSnapshot(s.caps, now).status === 'valid');
  insist(sameFolder(s.admission.activePilot.folder, s.caps.folder) && Array.isArray(s.plans) && s.plans.length <= 1000
    && Array.isArray(s.runs) && s.runs.length <= 10000);
  insist(s.plans.every(p => id(p.plan.planId))); uniqueIds(s.plans.map(p => p.plan.planHash), 1000); uniqueIds(s.runs.map(r => r.runId), 10000);
  for (const p of s.plans) {
    keys(p, 'plan week capRevision authorityHash plannedAtMs recordedAtMs'); insist(time(p.plannedAtMs) && p.plannedAtMs <= now && time(p.recordedAtMs) && p.recordedAtMs >= p.plannedAtMs && p.recordedAtMs <= now
      && count(p.capRevision) && p.capRevision <= s.caps.revision && hash(p.authorityHash)
      && p.authorityHash === s.admission.activePilot.authorityHash && p.week === localIsoWeek(p.plannedAtMs, s.caps.timezone).week);
    const built = buildFocusPlan(p.plan.frozenInput);
    insist(built.status === 'planned' && digest(built.plan) === digest(p.plan) && p.plan.frozenInput.kernel.nowMs === p.plannedAtMs
      && p.plan.caps.expectedHistoryRevision === p.capRevision && p.plan.caps.week === p.week
      && p.plan.frozenInput.review.atMs === p.recordedAtMs && p.plan.caps.proposedBaseline === null && sameFolder(p.plan.frozenInput.caps.folder, s.caps.folder)
      && p.plan.frozenInput.caps.pilot.id === s.admission.activePilot.id && p.plan.frozenInput.caps.pilot.receiptHash === s.admission.activePilot.receiptHash
      && p.plan.frozenInput.caps.calendar.bindingHash === s.caps.calendarBindingHash
      && p.plan.frozenInput.caps.calendar.timezone === s.caps.timezone);
    for (const w of p.plan.frozenInput.caps.history.weeks) insist(digest(w.baseline) === digest(s.caps.weeks.find(v => v.week === w.week)?.baseline ?? null));
  }
  const membership = [...s.admission.closedRunIds, ...(s.admission.pending ? [s.admission.pending.binding.runId] : [])].sort();
  insist(digest(membership) === digest(s.runs.map(r => r.runId).sort()), 'coupled-membership-invalid');
  for (const p of s.plans) {
    const first = s.plans.find(v => v.plan.planId === p.plan.planId)!;
    const { review: _a, ...a } = first.plan.frozenInput, { review: _b, ...b } = p.plan.frozenInput;
    insist(digest(a) === digest(b) && p.plan.draftHash === first.plan.draftHash && p.capRevision === first.capRevision
      && p.plannedAtMs === first.plannedAtMs && p.recordedAtMs >= first.recordedAtMs, 'coupled-review-invalid');
  }
  const usedPlans = new Set<string>();
  for (const run of s.runs) {
    const stored = s.plans.find(p => p.plan.planHash === run.planHash);
    insist(stored && digest(run) === digest(exactBinding(stored, run.runId)) && !usedPlans.has(stored.plan.planId), 'coupled-plan-invalid'); usedPlans.add(stored.plan.planId);
    const charges = s.caps.charges.filter(c => c.runId === run.runId);
    insist(run.plannedItems.length > 0 && digest(charges.map(c => c.itemId).sort()) === digest([...run.plannedItems].sort()), 'coupled-membership-invalid');
    for (const c of charges) {
      insist(c.planHash === run.planHash && c.admissionBindingHash === digest(run), 'coupled-membership-invalid');
      if (s.admission.closedRunIds.includes(run.runId) && c.effectId !== null) insist(['removed', 'not-removed'].includes(c.state), 'coupled-membership-invalid');
    }
  }
  insist(s.caps.charges.every(c => s.runs.some(r => r.runId === c.runId)), 'coupled-membership-invalid');
  const pending = s.admission.pending;
  if (pending) {
    insist(digest(s.runs.find(r => r.runId === pending.binding.runId)) === digest(pending.binding), 'coupled-membership-invalid');
    const movement = pending.effects.filter(e => e.kind === 'movement');
    for (const e of movement) {
      const c = s.caps.charges.find(c => c.runId === pending.binding.runId && c.itemId === e.itemId);
      insist(c && c.effectId === e.id && c.boundAtMs === e.beganAtMs, 'coupled-membership-invalid');
      insist(e.state === 'intent' ? c.state === 'reserved' : e.state === 'unknown' ? c.state === 'possibly-removed'
        : ['removed', 'not-removed'].includes(c.state), 'coupled-membership-invalid');
      if (e.state !== 'intent') insist(c.evidence?.receiptHash === e.observationHash && c.evidence?.observedAtMs === e.observedAtMs, 'coupled-membership-invalid');
    }
    insist(s.caps.charges.filter(c => c.runId === pending.binding.runId && c.effectId !== null)
      .every(c => movement.some(e => e.id === c.effectId)), 'coupled-membership-invalid');
  }
}
export function validateCoupledSnapshot(raw: unknown, nowMs: number):
  { status: 'valid'; snapshot: CoupledSnapshot; stateHash: string; effect: 'none'; authorizesEffects: false } | CoupledHeld {
  try { const snapshot = dataCopy(raw) as CoupledSnapshot; validate(snapshot, nowMs);
    return freeze({ status: 'valid', snapshot, stateHash: coupledStateHash(snapshot), effect: 'none', authorizesEffects: false });
  } catch { return held('coupled-state-invalid'); }
}
export function proposeCoupledTransition(raw: { snapshot: CoupledSnapshot; nowMs: number; expectedRevision: number;
  expectedStateHash: string; command: CoupledCommand }):
  { status: 'proposed'; expectedRevision: number; expectedStateHash: string; next: CoupledSnapshot; nextStateHash: string;
    effect: 'none'; authorizesEffects: false; releaseHolds: readonly string[] } | CoupledHeld {
  try {
    const x = dataCopy(raw); keys(x, 'snapshot nowMs expectedRevision expectedStateHash command'); validate(x.snapshot, x.nowMs);
    insist(x.expectedRevision === x.snapshot.revision && x.expectedStateHash === coupledStateHash(x.snapshot), 'coupled-conflict');
    const next = dataCopy(x.snapshot), c = x.command;
    if (c.type === 'cover-calendar') {
      keys(c, 'type evidence'); next.caps = capStep(next.caps, { type: 'cover', evidence: c.evidence }, x.nowMs);
    } else if (c.type === 'commit-plan') {
      keys(c, 'type input authorityHash'); insist(c.authorityHash === next.admission.activePilot.authorityHash
        && !next.plans.some(p => p.plan.planId === c.input.planId) && next.plans.length < 1000, 'coupled-plan-invalid');
      const input = dataCopy(c.input), projection = projectCapHistory(next.caps, x.nowMs);
      insist(projection.status === 'projected' && digest(projection.history) === digest(input.caps.history)
        && input.caps.pilot.id === next.admission.activePilot.id && input.caps.pilot.receiptHash === next.admission.activePilot.receiptHash
        && input.kernel.nowMs === x.nowMs && input.caps.nowMs === x.nowMs
        && input.caps.calendar.timezone === next.caps.timezone && input.caps.calendar.bindingHash === next.caps.calendarBindingHash
        && sameFolder(input.caps.folder, next.caps.folder), 'coupled-history-invalid');
      const cap = calculateCaps(input.caps); insist(cap.status === 'calculated', 'coupled-cap-held');
      if (cap.value.proposedBaseline) next.caps = capStep(next.caps, { type: 'freeze-baseline', count: cap.value.proposedBaseline.count }, x.nowMs);
      const finalProjection = projectCapHistory(next.caps, x.nowMs); insist(finalProjection.status === 'projected'); input.caps.history = finalProjection.history;
      const built = buildFocusPlan(input); insist(built.status === 'planned', 'coupled-plan-invalid');
      next.plans = [...next.plans, { plan: built.plan, week: built.plan.caps.week, capRevision: next.caps.revision,
        authorityHash: c.authorityHash, plannedAtMs: x.nowMs, recordedAtMs: x.nowMs }];
    } else if (c.type === 'record-review') {
      keys(c, 'type priorPlanHash review'); const prior = next.plans.find(p => p.plan.planHash === c.priorPlanHash);
      insist(prior && next.plans.length < 1000 && c.review.atMs === x.nowMs && prior.capRevision === next.caps.revision
        && next.plans.filter(p => p.plan.planId === prior.plan.planId).at(-1) === prior
        && !next.runs.some(r => next.plans.find(p => p.plan.planHash === r.planHash)?.plan.planId === prior.plan.planId), 'coupled-review-invalid');
      const input = dataCopy(prior.plan.frozenInput); input.review = c.review;
      const built = buildFocusPlan(input); insist(built.status === 'planned' && built.plan.draftHash === prior.plan.draftHash, 'coupled-review-invalid');
      next.plans = [...next.plans, { ...prior, plan: built.plan, recordedAtMs: x.nowMs }];
    } else if (c.type === 'admit-plan') {
      keys(c, 'type planHash runId fresh');
      insist(id(c.runId) && !next.runs.some(r => r.runId === c.runId || r.planHash === c.planHash), 'coupled-run-reused');
      const stored = next.plans.find(p => p.plan.planHash === c.planHash); insist(stored, 'coupled-plan-invalid');
      insist(next.plans.filter(p => p.plan.planId === stored.plan.planId).at(-1) === stored
        && !next.runs.some(r => next.plans.find(p => p.plan.planHash === r.planHash)?.plan.planId === stored.plan.planId), 'coupled-plan-superseded');
      const oldFacts = stored.plan.frozenInput.caps;
      validateFresh(c.fresh, stored, x.nowMs); const facts = c.fresh.caps;
      insist(stored.capRevision === next.caps.revision && stored.week === localIsoWeek(x.nowMs, next.caps.timezone).week
        && stored.plan.reviewed.length > 0 && digest(facts.calendar) === digest(oldFacts.calendar)
        && digest(facts.policy) === digest(oldFacts.policy) && digest(facts.pilot) === digest(oldFacts.pilot)
        && digest(facts.ripple) === digest(oldFacts.ripple) && sameFolder(facts.folder, next.caps.folder), 'coupled-plan-stale');
      const projection = projectCapHistory(next.caps, x.nowMs); insist(projection.status === 'projected' && projection.unresolvedPeriodDepartures.length === 0);
      const cap = calculateCaps({ ...facts, nowMs: x.nowMs, history: projection.history });
      insist(cap.status === 'calculated' && cap.value.proposedBaseline === null && cap.value.effectiveCap >= stored.plan.reviewed.length, 'coupled-cap-held');
      const binding = exactBinding(stored, c.runId);
      const admitted = proposeAdmissionTransition({ nowMs: x.nowMs, snapshot: next.admission, expectedRevision: next.admission.revision, command: { type: 'admit', binding } });
      insist(admitted.status === 'proposed', 'coupled-admission-held');
      next.caps = capStep(next.caps, { type: 'reserve', runId: c.runId, planHash: c.planHash, items: stored.plan.reviewed, admissionBindingHash: digest(binding) }, x.nowMs);
      next.admission = admitted.next; next.runs = [...next.runs, binding];
    } else if (c.type === 'settle-unused') {
      keys(c, 'type reservationId evidence'); const charge = next.caps.charges.find(v => v.id === c.reservationId);
      insist(charge && charge.effectId === null && c.evidence.outcome === 'not-removed' && c.evidence.basis === 'never-began', 'coupled-evidence-unproven');
      next.caps = capStep(next.caps, { type: 'settle', reservationId: charge.id, evidence: c.evidence }, x.nowMs);
    } else {
      insist(c.type === 'admission'); keys(c, 'type command capacityEvidence'); const a = c.command;
      insist(a.type !== ('admit' as string), 'coupled-admission-held');
      const pending = next.admission.pending; insist(pending, 'coupled-admission-held');
      if (a.type === 'begin-effect' && a.kind === 'movement') {
        const stored = next.plans.find(p => p.plan.planHash === a.binding.planHash);
        insist(stored && stored.week === localIsoWeek(x.nowMs, next.caps.timezone).week
          && stored.plan.frozenInput.kernel.goal.expiresAtMs > x.nowMs && stored.plan.frozenInput.caps.pilot.expiresAtMs > x.nowMs
          && (stored.plan.frozenInput.review.standing === null || stored.plan.frozenInput.review.standing.expiresAtMs > x.nowMs), 'coupled-plan-period-expired');
        next.caps = capStep(next.caps, { type: 'bind-effect', reservationId: capReservationId(a.binding.runId, a.binding.planHash, a.itemId!), effectId: a.effectId }, x.nowMs);
      }
      const effect = a.type === 'observe-effect' ? pending.effects.find(e => e.id === a.effectId) : null;
      if (a.type === 'observe-effect' && effect?.kind === 'movement') {
        const proof = c.capacityEvidence; insist(proof && proof.receiptHash === a.observationHash && proof.effectId === a.effectId
          && (a.state === 'unknown' ? proof.outcome === 'unknown' : ['removed', 'not-removed'].includes(proof.outcome)), 'coupled-evidence-unproven');
        next.caps = capStep(next.caps, { type: 'settle', reservationId: capReservationId(a.binding.runId, a.binding.planHash, effect.itemId!), evidence: proof }, x.nowMs);
      } else insist(c.capacityEvidence === null, 'coupled-evidence-unproven');
      const step = proposeAdmissionTransition({ nowMs: x.nowMs, snapshot: next.admission, expectedRevision: next.admission.revision, command: a });
      insist(step.status === 'proposed', 'coupled-admission-held'); next.admission = step.next;
    }
    insist(next.revision < Number.MAX_SAFE_INTEGER); next.revision++; next.observedAtMs = x.nowMs; validate(next, x.nowMs);
    return freeze({ status: 'proposed', expectedRevision: x.expectedRevision, expectedStateHash: x.expectedStateHash,
      next, nextStateHash: coupledStateHash(next), effect: 'none', authorizesEffects: false, releaseHolds: COUPLED_RELEASE_HOLDS });
  } catch { return held('coupled-transition-held'); }
}
