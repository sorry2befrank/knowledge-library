// DESIGN §6.2 / §6.13. Pure calculation; a proposed baseline is NOT a durable freeze.
import { DAY, count, dataCopy, digest, errorCode, freeze, hash, id, insist, keys, time } from './plan-data.ts';

export interface FolderBinding { folderId: string; deviceId: string; rootFileId: string; volumeSerial: string }
export interface CalendarBinding {
  state: 'verified'; timezone: string; bindingHash: string; policyHash: string; deviceId: string;
}
export interface CapPolicy {
  hash: string; maxPerRun: number; weeklyBasisPoints: number; trailingBasisPoints: number; rippleEventBudget: number | null;
}
export interface WeekHistory {
  week: string;
  // null is explicit complete evidence that no plan froze a baseline that week, not missing data.
  baseline: { id: string; count: number; frozenAtMs: number } | null;
  // Possibly completed removals and reserved in-flight capacity count in full. Restores never refund.
  removals: readonly { id: string; atMs: number; count: number; state: 'removed' | 'possibly-removed' | 'reserved' }[];
}
export interface CapHistory {
  complete: true; folder: FolderBinding; calendarBindingHash: string; revision: number; observedAtMs: number;
  weeks: readonly WeekHistory[];
  // Complete all-time unresolved capacity, including rows older than the displayed weeks.
  outstanding: readonly { id: string; atMs: number; count: number; state: 'possibly-removed' | 'reserved' }[];
}
export interface PilotEvidence {
  state: 'verified'; id: string; folder: FolderBinding; receiptHash: string; startedAtMs: number;
  expiresAtMs: number; firstRemoval: 'pending' | 'complete'; measuredGrowth: boolean;
  maxBatch: number; maxRung: 0 | 1 | 2 | 3;
}
export interface RippleMeasurement {
  state: 'verified'; receiptHash: string; policyHash: string; pilotId: string;
  sourceHash: string; fixedEvents: number; eventsPerItem: number | null;
}
export interface CapInput {
  nowMs: number; folder: FolderBinding; calendar: CalendarBinding; policy: CapPolicy; history: CapHistory;
  allowedTypeCount: number; pilot: PilotEvidence; ripple: RippleMeasurement | null;
}
export interface CapValue {
  week: string; overlappingWeeks: readonly string[]; baselineCount: number; trailingBaseline: number;
  removedThisWeek: number; removedTrailing: number; weeklyRemaining: number; trailingRemaining: number;
  rippleCap: number; pilotCap: number; effectiveCap: number; maxRung: number;
  proposedBaseline: { week: string; count: number; frozenAtMs: number } | null;
  expectedHistoryRevision: number; inputHash: string;
}
export type CapResult = { status: 'calculated'; value: CapValue; effect: 'none'; authorizesEffects: false }
  | { status: 'refused'; reasons: readonly string[]; effect: 'none'; authorizesEffects: false };

export function validateFolder(x: FolderBinding): void {
  keys(x, 'folderId deviceId rootFileId volumeSerial'); insist(Object.values(x).every(id));
}
export const sameFolder = (a: FolderBinding, b: FolderBinding): boolean => digest(a) === digest(b);
/** ISO week of an instant in the explicitly bound policy/device timezone; never host-local. */
export function localIsoWeek(atMs: number, timezone: string): { week: string; monday: number } {
  insist(time(atMs) && typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 100, 'timezone-unproven');
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(atMs);
  const part = (name: string) => Number(parts.find(p => p.type === name)?.value);
  const d = new Date(0); d.setUTCFullYear(part('year'), part('month') - 1, part('day')); d.setUTCHours(0, 0, 0, 0);
  const monday = d.getTime() / DAY - (d.getUTCDay() + 6) % 7;
  const thursday = new Date((monday + 3) * DAY), year = thursday.getUTCFullYear();
  const jan4 = new Date(0); jan4.setUTCFullYear(year, 0, 4); jan4.setUTCHours(0, 0, 0, 0);
  const firstMonday = jan4.getTime() / DAY - (jan4.getUTCDay() + 6) % 7;
  return { week: `${year}-W${String(1 + (monday - firstMonday) / 7).padStart(2, '0')}`, monday };
}
export function overlappingWeeks(nowMs: number, timezone: string): string[] {
  insist(time(nowMs) && nowMs >= 28 * DAY);
  const first = localIsoWeek(nowMs - 28 * DAY, timezone), last = localIsoWeek(nowMs, timezone), result: string[] = [];
  for (let day = first.monday; day <= last.monday; day += 7) result.push(localIsoWeek((day + 3) * DAY + 12 * 3600000, 'UTC').week);
  insist(result.length >= 5 && result.length <= 6); return result;
}

export function calculateCaps(raw: CapInput): CapResult {
  try {
    const x = dataCopy(raw); keys(x, 'nowMs folder calendar policy history allowedTypeCount pilot ripple');
    const { nowMs: now, folder, calendar: cal, policy: p, history: h, pilot, ripple } = x;
    insist(time(now) && now >= 28 * DAY && count(x.allowedTypeCount, 10000)); validateFolder(folder);
    keys(cal, 'state timezone bindingHash policyHash deviceId');
    insist(cal.state === 'verified' && hash(cal.bindingHash) && cal.policyHash === p.hash && cal.deviceId === folder.deviceId, 'timezone-unproven');
    keys(p, 'hash maxPerRun weeklyBasisPoints trailingBasisPoints rippleEventBudget');
    insist(hash(p.hash) && count(p.maxPerRun, 30) && count(p.weeklyBasisPoints, 3000) && count(p.trailingBasisPoints, 5000)
      && (p.rippleEventBudget === null || count(p.rippleEventBudget, 1000000)));
    const weeks = overlappingWeeks(now, cal.timezone), week = weeks.at(-1)!;
    keys(h, 'complete folder calendarBindingHash revision observedAtMs weeks outstanding'); validateFolder(h.folder);
    insist(h.complete === true && sameFolder(h.folder, folder) && h.calendarBindingHash === cal.bindingHash
      && count(h.revision) && h.observedAtMs === now && Array.isArray(h.weeks) && h.weeks.length === weeks.length, 'history-invalid');
    insist(Array.isArray(h.outstanding) && h.outstanding.length <= 10000, 'history-invalid');
    const outstanding = new Map<string, CapHistory['outstanding'][number]>();
    let weeklyRemoved = 0, trailingRemoved = 0;
    for (const charge of h.outstanding) {
      keys(charge, 'id atMs count state');
      insist(id(charge.id) && !outstanding.has(charge.id) && time(charge.atMs) && charge.atMs <= now
        && count(charge.count, 30) && charge.count > 0 && ['possibly-removed', 'reserved'].includes(charge.state), 'history-invalid');
      outstanding.set(charge.id, charge); weeklyRemoved += charge.count; trailingRemoved += charge.count;
    }
    const byWeek = new Map<string, WeekHistory>(), baselineIds = new Set<string>(), removalIds = new Set<string>();
    for (const row of h.weeks) {
      keys(row, 'week baseline removals'); insist(weeks.includes(row.week) && !byWeek.has(row.week), 'history-invalid');
      byWeek.set(row.week, row); insist(Array.isArray(row.removals) && row.removals.length <= 10000, 'history-invalid');
      if (row.baseline !== null) {
        keys(row.baseline, 'id count frozenAtMs'); const b = row.baseline;
        insist(id(b.id) && !baselineIds.has(b.id) && count(b.count, 10000) && time(b.frozenAtMs) && b.frozenAtMs <= now
          && localIsoWeek(b.frozenAtMs, cal.timezone).week === row.week, 'history-invalid'); baselineIds.add(b.id);
      } else insist(row.removals.length === 0, 'history-invalid');
      for (const removal of row.removals) {
        keys(removal, 'id atMs count state');
        insist(id(removal.id) && !removalIds.has(removal.id) && time(removal.atMs) && removal.atMs <= now
          && removal.atMs >= row.baseline!.frozenAtMs && count(removal.count, 30) && removal.count > 0
          && ['removed', 'possibly-removed', 'reserved'].includes(removal.state)
          && localIsoWeek(removal.atMs, cal.timezone).week === row.week, 'history-invalid');
        removalIds.add(removal.id);
        if (removal.state === 'removed') {
          insist(!outstanding.has(removal.id), 'history-invalid');
          if (row.week === week) weeklyRemoved += removal.count;
          // Exact oldest boundary is retained conservatively; restores never subtract removal history.
          if (removal.atMs >= now - 28 * DAY) trailingRemoved += removal.count;
        } else insist(digest(outstanding.get(removal.id) ?? null) === digest(removal), 'history-invalid');
      }
    }
    for (const charge of outstanding.values()) if (weeks.includes(localIsoWeek(charge.atMs, cal.timezone).week))
      insist(removalIds.has(charge.id), 'history-invalid');
    const current = byWeek.get(week)!;
    const proposedBaseline = current.baseline === null ? { week, count: x.allowedTypeCount, frozenAtMs: now } : null;
    const baselineCount = current.baseline?.count ?? x.allowedTypeCount;
    const trailingBaseline = Math.min(baselineCount, ...h.weeks.flatMap(row => row.baseline ? [row.baseline.count] : []));
    const weeklyRemaining = Math.max(0, Math.floor(p.weeklyBasisPoints * baselineCount / 10000) - weeklyRemoved);
    const trailingRemaining = Math.max(0, Math.floor(p.trailingBasisPoints * trailingBaseline / 10000) - trailingRemoved);
    keys(pilot, 'state id folder receiptHash startedAtMs expiresAtMs firstRemoval measuredGrowth maxBatch maxRung'); validateFolder(pilot.folder);
    insist(pilot.state === 'verified' && id(pilot.id) && sameFolder(pilot.folder, folder) && hash(pilot.receiptHash)
      && time(pilot.startedAtMs) && pilot.startedAtMs <= now && time(pilot.expiresAtMs) && pilot.expiresAtMs > now
      && ['pending', 'complete'].includes(pilot.firstRemoval) && typeof pilot.measuredGrowth === 'boolean'
      && count(pilot.maxBatch, 30) && pilot.maxBatch >= 1 && count(pilot.maxRung, 3), 'pilot-unproven');
    const canary = pilot.firstRemoval === 'pending' || !pilot.measuredGrowth;
    const pilotCap = canary ? 1 : Math.min(pilot.maxBatch, now - pilot.startedAtMs < 14 * DAY ? 10 : 30);
    const maxRung = canary ? 0 : pilot.maxRung;
    let rippleCap = 1;
    if (ripple !== null) {
      keys(ripple, 'state receiptHash policyHash pilotId sourceHash fixedEvents eventsPerItem');
      insist(ripple.state === 'verified' && hash(ripple.receiptHash) && ripple.policyHash === p.hash && ripple.pilotId === pilot.id
        && hash(ripple.sourceHash) && count(ripple.fixedEvents, 1000000)
        && (ripple.eventsPerItem === null || count(ripple.eventsPerItem, 1000000)), 'ripple-unproven');
      if (p.rippleEventBudget !== null && ripple.eventsPerItem !== null && ripple.eventsPerItem > 0)
        rippleCap = Math.max(0, Math.min(p.maxPerRun, Math.floor((p.rippleEventBudget - ripple.fixedEvents) / ripple.eventsPerItem)));
    }
    // A known zero budget cannot fund even an unmeasured canary.
    if (p.rippleEventBudget === 0) rippleCap = 0;
    if (p.rippleEventBudget !== null && ripple !== null && ripple.fixedEvents >= p.rippleEventBudget) rippleCap = 0;
    return freeze({ status: 'calculated', effect: 'none', authorizesEffects: false, value: { week, overlappingWeeks: weeks,
      baselineCount, trailingBaseline, removedThisWeek: weeklyRemoved, removedTrailing: trailingRemoved, weeklyRemaining, trailingRemaining,
      rippleCap, pilotCap, effectiveCap: Math.min(p.maxPerRun, weeklyRemaining, trailingRemaining, rippleCap, pilotCap), maxRung,
      proposedBaseline, expectedHistoryRevision: h.revision, inputHash: digest(x) } });
  } catch (error) { return freeze({ status: 'refused', reasons: [errorCode(error)], effect: 'none', authorizesEffects: false }); }
}
