// Complete durable-cap state proposals. No SQLite, receipt authentication, default history or effect authority.
import { DAY, count, dataCopy, digest, freeze, hash, id, insist, keys, time, uniqueIds } from './plan-data.ts';
import { localIsoWeek, overlappingWeeks, validateFolder, type CapHistory, type FolderBinding } from './plan-caps.ts';

export interface CapWeek {
  week: string;
  baseline: { id: string; count: number; frozenAtMs: number } | null;
  noPlanEvidenceHash: string | null;
}
/** Trusted verifier OUTPUT, not self-authenticating JSON or an implemented receipt verifier. */
export interface CapacityEvidence {
  state: 'verified'; receiptHash: string; reservationHash: string;
  runId: string; planHash: string; itemId: string; effectId: string | null;
  outcome: 'unknown' | 'removed' | 'not-removed';
  basis: 'uncertain' | 'confirmed-departure' | 'never-began' | 'reconciled-no-departure';
  departureAtMs: number | null; observedAtMs: number;
}
export interface CapCharge {
  id: string; runId: string; planHash: string; itemId: string; admissionBindingHash: string;
  reservedAtMs: number; effectId: string | null; boundAtMs: number | null;
  state: 'reserved' | 'possibly-removed' | 'removed' | 'not-removed'; evidence: CapacityEvidence | null;
}
export interface CapLedgerSnapshot {
  schema: 'cap-ledger/v1'; complete: true; revision: number; observedAtMs: number;
  folder: FolderBinding; timezone: string; calendarBindingHash: string;
  // throughMs identifies the last covered calendar week; read freshness is observedAtMs.
  coverage: { firstWeek: string; throughMs: number; evidenceHash: string };
  weeks: readonly CapWeek[]; charges: readonly CapCharge[];
}
export type CapLedgerCommand =
  | { type: 'cover'; evidence: { state: 'verified'; priorStateHash: string; throughMs: number; receiptHash: string } }
  | { type: 'freeze-baseline'; count: number }
  | { type: 'reserve'; runId: string; planHash: string; items: readonly string[]; admissionBindingHash: string }
  | { type: 'bind-effect'; reservationId: string; effectId: string }
  | { type: 'settle'; reservationId: string; evidence: CapacityEvidence };
export type CapLedgerHeld = { status: 'held'; reason: string; effect: 'none'; authorizesEffects: false };
const held = (reason: string): CapLedgerHeld => freeze({ status: 'held', reason, effect: 'none', authorizesEffects: false });
export const CAP_LEDGER_LIMITS = Object.freeze({ weeks: 520, charges: 20_000 });
export function capLedgerStateHash(s: CapLedgerSnapshot): string { const { observedAtMs: _readTime, ...persisted } = s; return digest(persisted); }
export const capReservationId = (runId: string, planHash: string, itemId: string): string => digest({ runId, planHash, itemId });
export const capReservationHash = (c: CapCharge): string => digest({ id: c.id, runId: c.runId, planHash: c.planHash,
  itemId: c.itemId, admissionBindingHash: c.admissionBindingHash, reservedAtMs: c.reservedAtMs });
export const capBaselineId = (s: Pick<CapLedgerSnapshot, 'folder' | 'calendarBindingHash'>, week: string): string =>
  digest({ folder: s.folder, calendarBindingHash: s.calendarBindingHash, week });
/** Actual departure is retained, but crossing a baseline period needs explicit future reconciliation. */
export const crossPeriodDeparture = (c: CapCharge, timezone: string): boolean => c.state === 'removed'
  && localIsoWeek(c.evidence!.departureAtMs!, timezone).week !== localIsoWeek(c.reservedAtMs, timezone).week;

function weekMonday(week: string): number {
  insist(/^\d{4}-W\d{2}$/.test(week), 'cap-coverage-invalid');
  const year = Number(week.slice(0, 4)), n = Number(week.slice(6));
  const jan4 = new Date(0); jan4.setUTCFullYear(year, 0, 4); jan4.setUTCHours(0, 0, 0, 0);
  const day = jan4.getTime() / DAY - (jan4.getUTCDay() + 6) % 7 + (n - 1) * 7;
  insist(localIsoWeek((day + 3) * DAY + 12 * 3600000, 'UTC').week === week, 'cap-coverage-invalid'); return day;
}
function coveredWeeks(firstWeek: string, throughMs: number, timezone: string): string[] {
  const first = weekMonday(firstWeek), last = localIsoWeek(throughMs, timezone).monday;
  insist(first <= last && (last - first) / 7 < CAP_LEDGER_LIMITS.weeks, 'cap-workload-limit');
  const result: string[] = [];
  // UTC here encodes an ISO calendar label, not a default policy timezone.
  for (let day = first; day <= last; day += 7) result.push(localIsoWeek((day + 3) * DAY + 12 * 3600000, 'UTC').week);
  return result;
}
function validateEvidence(e: CapacityEvidence, c: CapCharge, now: number): void {
  keys(e, 'state receiptHash reservationHash runId planHash itemId effectId outcome basis departureAtMs observedAtMs');
  insist(e.state === 'verified' && hash(e.receiptHash) && e.reservationHash === capReservationHash(c)
    && e.runId === c.runId && e.planHash === c.planHash && e.itemId === c.itemId && e.effectId === c.effectId
    && time(e.observedAtMs) && e.observedAtMs >= (c.boundAtMs ?? c.reservedAtMs) && e.observedAtMs <= now, 'cap-evidence-unproven');
  if (e.outcome === 'unknown') insist(c.effectId !== null && e.basis === 'uncertain' && e.departureAtMs === null, 'cap-evidence-unproven');
  else if (e.outcome === 'removed') insist(c.effectId !== null && c.boundAtMs !== null && e.basis === 'confirmed-departure'
    && time(e.departureAtMs) && e.departureAtMs >= c.boundAtMs && e.departureAtMs <= e.observedAtMs, 'cap-period-unproven');
  else insist(e.outcome === 'not-removed' && e.departureAtMs === null
    && (c.effectId === null ? e.basis === 'never-began' : e.basis === 'reconciled-no-departure'), 'cap-evidence-unproven');
}
function validate(s: CapLedgerSnapshot, now: number): void {
  keys(s, 'schema complete revision observedAtMs folder timezone calendarBindingHash coverage weeks charges');
  insist(s.schema === 'cap-ledger/v1' && s.complete === true && count(s.revision) && time(now) && s.observedAtMs === now
    && typeof s.timezone === 'string' && s.timezone.length > 0 && s.timezone.length <= 100 && hash(s.calendarBindingHash), 'cap-ledger-invalid');
  validateFolder(s.folder); keys(s.coverage, 'firstWeek throughMs evidenceHash');
  insist(time(s.coverage.throughMs) && s.coverage.throughMs <= now && hash(s.coverage.evidenceHash), 'cap-coverage-invalid');
  const expected = coveredWeeks(s.coverage.firstWeek, s.coverage.throughMs, s.timezone);
  insist(Array.isArray(s.weeks) && s.weeks.length === expected.length && Array.isArray(s.charges)
    && s.charges.length <= CAP_LEDGER_LIMITS.charges, 'cap-ledger-invalid');
  for (let i = 0; i < expected.length; i++) {
    const w = s.weeks[i]!; keys(w, 'week baseline noPlanEvidenceHash'); insist(w.week === expected[i], 'cap-coverage-invalid');
    if (w.baseline === null) insist(hash(w.noPlanEvidenceHash), 'cap-coverage-invalid');
    else {
      keys(w.baseline, 'id count frozenAtMs'); const b = w.baseline;
      insist(w.noPlanEvidenceHash === null && b.id === capBaselineId(s, w.week) && count(b.count, 10000)
        && time(b.frozenAtMs) && b.frozenAtMs <= now && localIsoWeek(b.frozenAtMs, s.timezone).week === w.week, 'cap-baseline-invalid');
    }
  }
  uniqueIds(s.charges.map(c => c.id), CAP_LEDGER_LIMITS.charges);
  const runItems = new Set<string>(), effects = new Set<string>();
  for (const c of s.charges) {
    keys(c, 'id runId planHash itemId admissionBindingHash reservedAtMs effectId boundAtMs state evidence');
    insist(id(c.runId) && hash(c.planHash) && id(c.itemId) && hash(c.admissionBindingHash)
      && c.id === capReservationId(c.runId, c.planHash, c.itemId) && time(c.reservedAtMs) && c.reservedAtMs <= now
      && ['reserved', 'possibly-removed', 'removed', 'not-removed'].includes(c.state), 'cap-ledger-invalid');
    const membership = digest([c.runId, c.itemId]); insist(!runItems.has(membership), 'cap-ledger-invalid'); runItems.add(membership);
    const w = s.weeks.find(w => w.week === localIsoWeek(c.reservedAtMs, s.timezone).week);
    insist(w?.baseline && c.reservedAtMs >= w.baseline.frozenAtMs, 'cap-baseline-invalid');
    if (c.effectId === null) insist(c.boundAtMs === null, 'cap-ledger-invalid');
    else {
      insist(id(c.effectId) && time(c.boundAtMs) && c.boundAtMs >= c.reservedAtMs && c.boundAtMs <= now, 'cap-ledger-invalid');
      const pair = digest([c.runId, c.effectId]); insist(!effects.has(pair), 'cap-ledger-invalid'); effects.add(pair);
    }
    if (c.state === 'reserved') insist(c.evidence === null, 'cap-ledger-invalid');
    else {
      insist(c.evidence !== null, 'cap-evidence-unproven'); validateEvidence(c.evidence, c, now);
      insist(c.state === (c.evidence.outcome === 'unknown' ? 'possibly-removed' : c.evidence.outcome), 'cap-ledger-invalid');
    }
  }
}
export function validateCapLedgerSnapshot(raw: unknown, nowMs: number):
  { status: 'valid'; snapshot: CapLedgerSnapshot; stateHash: string; effect: 'none'; authorizesEffects: false } | CapLedgerHeld {
  try { const snapshot = dataCopy(raw) as CapLedgerSnapshot; validate(snapshot, nowMs);
    return freeze({ status: 'valid', snapshot, stateHash: capLedgerStateHash(snapshot), effect: 'none', authorizesEffects: false });
  } catch { return held('cap-ledger-invalid'); }
}
export function projectCapHistory(raw: unknown, nowMs: number):
  { status: 'projected'; history: CapHistory; ledgerHash: string; unresolvedPeriodDepartures: readonly string[]; effect: 'none'; authorizesEffects: false } | CapLedgerHeld {
  try {
    const result = validateCapLedgerSnapshot(raw, nowMs); insist(result.status === 'valid', 'cap-ledger-invalid'); const s = result.snapshot;
    insist(localIsoWeek(s.coverage.throughMs, s.timezone).week === localIsoWeek(nowMs, s.timezone).week, 'cap-coverage-stale');
    const current = overlappingWeeks(nowMs, s.timezone);
    const weeks = current.map(week => {
      const w = s.weeks.find(row => row.week === week); insist(w, 'cap-coverage-invalid');
      return { week, baseline: w.baseline, removals: s.charges.flatMap(c => {
        const cross = crossPeriodDeparture(c, s.timezone);
        const atMs = c.state === 'removed' && !cross ? c.evidence!.departureAtMs! : c.reservedAtMs;
        return c.state !== 'not-removed' && localIsoWeek(atMs, s.timezone).week === week ? [{ id: c.id, atMs, count: 1,
          state: c.state === 'removed' && !cross ? 'removed' as const : c.state === 'possibly-removed' || cross ? 'possibly-removed' as const : 'reserved' as const }] : [];
      }) };
    });
    const outstanding = s.charges.filter(c => c.state === 'reserved' || c.state === 'possibly-removed' || crossPeriodDeparture(c, s.timezone))
      .map(c => ({ id: c.id, atMs: c.reservedAtMs, count: 1, state: c.state === 'reserved' ? 'reserved' as const : 'possibly-removed' as const }));
    return freeze({ status: 'projected', history: { complete: true, folder: s.folder, calendarBindingHash: s.calendarBindingHash,
      revision: s.revision, observedAtMs: nowMs, weeks, outstanding }, ledgerHash: result.stateHash,
      unresolvedPeriodDepartures: s.charges.filter(c => crossPeriodDeparture(c, s.timezone)).map(c => c.id), effect: 'none', authorizesEffects: false });
  } catch { return held('cap-projection-unproven'); }
}
export function proposeCapLedgerTransition(raw: { snapshot: CapLedgerSnapshot; nowMs: number; expectedRevision: number;
  expectedStateHash: string; command: CapLedgerCommand }):
  { status: 'proposed'; expectedRevision: number; expectedStateHash: string; next: CapLedgerSnapshot; nextStateHash: string; effect: 'none'; authorizesEffects: false } | CapLedgerHeld {
  try {
    const x = dataCopy(raw); keys(x, 'snapshot nowMs expectedRevision expectedStateHash command'); validate(x.snapshot, x.nowMs);
    insist(x.expectedRevision === x.snapshot.revision && x.expectedStateHash === capLedgerStateHash(x.snapshot), 'cap-conflict');
    const next = dataCopy(x.snapshot), c = x.command;
    if (c.type === 'cover') {
      keys(c, 'type evidence'); keys(c.evidence, 'state priorStateHash throughMs receiptHash');
      insist(c.evidence.state === 'verified' && c.evidence.priorStateHash === x.expectedStateHash && c.evidence.throughMs === x.nowMs
        && c.evidence.throughMs >= next.coverage.throughMs && hash(c.evidence.receiptHash), 'cap-coverage-unproven');
      const all = coveredWeeks(next.coverage.firstWeek, x.nowMs, next.timezone);
      next.weeks = [...next.weeks, ...all.slice(next.weeks.length).map(week => ({ week, baseline: null, noPlanEvidenceHash: c.evidence.receiptHash }))];
      next.coverage = { ...next.coverage, throughMs: x.nowMs, evidenceHash: c.evidence.receiptHash };
    } else if (c.type === 'freeze-baseline') {
      keys(c, 'type count'); insist(localIsoWeek(next.coverage.throughMs, next.timezone).week === localIsoWeek(x.nowMs, next.timezone).week && count(c.count, 10000), 'cap-coverage-stale');
      const week = localIsoWeek(x.nowMs, next.timezone).week, row = next.weeks.find(w => w.week === week);
      insist(row?.baseline === null, 'cap-baseline-exists'); row.baseline = { id: capBaselineId(next, week), count: c.count, frozenAtMs: x.nowMs }; row.noPlanEvidenceHash = null;
    } else if (c.type === 'reserve') {
      keys(c, 'type runId planHash items admissionBindingHash'); uniqueIds(c.items, 30);
      insist(id(c.runId) && hash(c.planHash) && hash(c.admissionBindingHash) && c.items.length > 0
        && localIsoWeek(next.coverage.throughMs, next.timezone).week === localIsoWeek(x.nowMs, next.timezone).week && !next.charges.some(v => v.runId === c.runId), 'cap-reservation-invalid');
      next.charges = [...next.charges, ...c.items.map(itemId => ({ id: capReservationId(c.runId, c.planHash, itemId), runId: c.runId,
        planHash: c.planHash, itemId, admissionBindingHash: c.admissionBindingHash, reservedAtMs: x.nowMs,
        effectId: null, boundAtMs: null, state: 'reserved' as const, evidence: null }))];
    } else if (c.type === 'bind-effect') {
      keys(c, 'type reservationId effectId'); const charge = next.charges.find(v => v.id === c.reservationId);
      insist(charge && charge.state === 'reserved' && charge.effectId === null && id(c.effectId), 'cap-reservation-invalid'); charge.effectId = c.effectId; charge.boundAtMs = x.nowMs;
    } else {
      insist(c.type === 'settle'); keys(c, 'type reservationId evidence'); const charge = next.charges.find(v => v.id === c.reservationId);
      insist(charge && ['reserved', 'possibly-removed'].includes(charge.state) && c.evidence.observedAtMs === x.nowMs, 'cap-reservation-invalid');
      validateEvidence(c.evidence, charge, x.nowMs); charge.evidence = c.evidence;
      charge.state = c.evidence.outcome === 'unknown' ? 'possibly-removed' : c.evidence.outcome;
    }
    insist(next.revision < Number.MAX_SAFE_INTEGER); next.revision++; next.observedAtMs = x.nowMs; validate(next, x.nowMs);
    return freeze({ status: 'proposed', expectedRevision: x.expectedRevision, expectedStateHash: x.expectedStateHash,
      next, nextStateHash: capLedgerStateHash(next), effect: 'none', authorizesEffects: false });
  } catch { return held('cap-transition-held'); }
}
