import { capFixture, planFixture, snapshot, NOW, DAY, H, J } from './focus-plan-fixture.ts';
import { capBaselineId, capLedgerStateHash, capReservationHash, projectCapHistory, proposeCapLedgerTransition,
  type CapLedgerSnapshot, type CapLedgerCommand, type CapacityEvidence, type CapCharge } from '../../packages/core/src/focus/cap-ledger.ts';
import { coupledStateHash, proposeCoupledTransition, type CoupledSnapshot, type CoupledCommand, type FreshAdmissionFacts } from '../../packages/core/src/focus/coupled-admission.ts';
import type { PlanInput } from '../../packages/core/src/focus/plan.ts';
export { NOW, DAY, H, J };
export function ledger(now = NOW, currentBaseline = false): CapLedgerSnapshot {
  const x = capFixture(now), s: CapLedgerSnapshot = { schema: 'cap-ledger/v1', complete: true, revision: 0, observedAtMs: now,
    folder: x.folder, timezone: x.calendar.timezone, calendarBindingHash: x.calendar.bindingHash,
    coverage: { firstWeek: x.history.weeks[0]!.week, throughMs: now, evidenceHash: H }, weeks: [], charges: [] };
  s.weeks = x.history.weeks.map((w, i) => ({ week: w.week,
    baseline: !currentBaseline && i === x.history.weeks.length - 1 ? null : { ...w.baseline!, id: capBaselineId(s, w.week) },
    noPlanEvidenceHash: !currentBaseline && i === x.history.weeks.length - 1 ? H : null }));
  return s;
}
export const readCap = (s: CapLedgerSnapshot, now: number): CapLedgerSnapshot => ({ ...structuredClone(s), observedAtMs: now });
export const read = (s: CoupledSnapshot, now: number): CoupledSnapshot => ({ ...structuredClone(s), observedAtMs: now,
  caps: readCap(s.caps, now), admission: { ...structuredClone(s.admission), observedAtMs: now } });
export function capTry(s: CapLedgerSnapshot, command: CapLedgerCommand, now = s.observedAtMs) {
  return proposeCapLedgerTransition({ snapshot: s, nowMs: now, expectedRevision: s.revision, expectedStateHash: capLedgerStateHash(s), command });
}
export function capNext(s: CapLedgerSnapshot, command: CapLedgerCommand, now = s.observedAtMs): CapLedgerSnapshot {
  const r = capTry(s, command, now); if (r.status !== 'proposed') throw Error('fixture cap held: ' + command.type); return r.next;
}
export function attempt(s: CoupledSnapshot, command: CoupledCommand, now = s.observedAtMs) {
  return proposeCoupledTransition({ snapshot: s, nowMs: now, expectedRevision: s.revision, expectedStateHash: coupledStateHash(s), command });
}
export function next(s: CoupledSnapshot, command: CoupledCommand, now = s.observedAtMs): CoupledSnapshot {
  const r = attempt(s, command, now); if (r.status !== 'proposed') throw Error('fixture coupled held: ' + command.type); return r.next;
}
export async function seed(now = NOW, currentBaseline = false) {
  const input = await planFixture();
  input.kernel.nowMs = input.kernel.snapshot.capturedAtMs = input.kernel.references.readAtMs = input.kernel.references.lastFullReadAtMs = now;
  input.kernel.goal.issuedAtMs = now - DAY; input.kernel.goal.expiresAtMs = now + 14 * DAY;
  input.controls.observedAtMs = input.review.atMs = now;
  input.caps = capFixture(now);
  const admission = snapshot(); admission.observedAtMs = now;
  const s: CoupledSnapshot = { schema: 'coupled-admission/v1', complete: true, revision: 0, observedAtMs: now,
    admission, caps: ledger(now, currentBaseline), plans: [], runs: [] };
  const p = projectCapHistory(s.caps, now); if (p.status !== 'projected') throw Error('fixture projection held');
  input.caps.history = p.history;
  return { s, input };
}
export function commit(s: CoupledSnapshot, input: PlanInput): CoupledSnapshot {
  return next(s, { type: 'commit-plan', input, authorityHash: J });
}
export function fresh(s: CoupledSnapshot, now = s.observedAtMs): FreshAdmissionFacts {
  const p = structuredClone(s.plans.at(-1)!.plan.frozenInput), { nowMs: _now, history: _history, ...caps } = p.caps;
  p.kernel.phase = 'apply'; p.kernel.nowMs = p.kernel.snapshot.capturedAtMs = p.kernel.references.readAtMs = p.kernel.references.lastFullReadAtMs = now;
  p.controls.observedAtMs = now;
  return { caps, kernel: p.kernel, controls: p.controls };
}
export function admit(s: CoupledSnapshot, runId = 'run'): CoupledSnapshot {
  return next(s, { type: 'admit-plan', planHash: s.plans.at(-1)!.plan.planHash, runId, fresh: fresh(s) });
}
export function begin(s: CoupledSnapshot, effectId = 'move', itemId = 'f0'): CoupledSnapshot {
  return next(s, { type: 'admission', capacityEvidence: null,
    command: { type: 'begin-effect', binding: s.admission.pending!.binding, effectId, kind: 'movement', itemId } });
}
export function evidence(c: CapCharge, now: number, outcome: CapacityEvidence['outcome'], departureAtMs: number | null = outcome === 'removed' ? now : null): CapacityEvidence {
  return { state: 'verified', receiptHash: H, reservationHash: capReservationHash(c), runId: c.runId, planHash: c.planHash,
    itemId: c.itemId, effectId: c.effectId, outcome, basis: outcome === 'removed' ? 'confirmed-departure' : outcome === 'unknown' ? 'uncertain' : c.effectId === null ? 'never-began' : 'reconciled-no-departure',
    departureAtMs, observedAtMs: now };
}
export function observe(s: CoupledSnapshot, outcome: CapacityEvidence['outcome'], departureAtMs?: number): CoupledSnapshot {
  const c = s.caps.charges.find(c => c.effectId === 'move')!;
  return next(s, { type: 'admission', command: { type: 'observe-effect', binding: s.admission.pending!.binding,
    effectId: 'move', state: outcome === 'unknown' ? 'unknown' : 'settled', observationHash: H },
    capacityEvidence: evidence(c, s.observedAtMs, outcome, departureAtMs ?? (outcome === 'removed' ? s.observedAtMs : null)) });
}
