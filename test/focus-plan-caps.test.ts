import { expect, it } from 'vitest';
import { calculateCaps, localIsoWeek, overlappingWeeks, type CapInput } from '../packages/core/src/focus/plan-caps.ts';
import { capFixture, DAY, NOW, H } from './helpers/focus-plan-fixture.ts';
function value(x: CapInput) { const r = calculateCaps(x); expect(r.status).toBe('calculated'); if (r.status !== 'calculated') throw Error(JSON.stringify(r)); return r.value; }
it('uses the minimum of run, frozen weekly, overlapping 28-day, ripple and measured pilot caps', () => {
  const x = capFixture(); expect(value(x)).toMatchObject({ baselineCount: 100, trailingBaseline: 100, weeklyRemaining: 30, trailingRemaining: 50, effectiveCap: 30 });
  x.history.weeks[0]!.baseline!.count = 8; expect(value(x).effectiveCap).toBe(4);
  x.ripple!.fixedEvents = 97; expect(value(x).effectiveCap).toBe(1);
  x.ripple!.fixedEvents = 101; expect(value(x).effectiveCap).toBe(0);
});
it('repeated runs use the existing baseline; folder shrink or growth does not refreeze it', () => {
  const x = capFixture(); x.history.weeks.at(-1)!.removals = [{ id: 'left', atMs: NOW, count: 29, state: 'removed' }];
  expect(value(x)).toMatchObject({ effectiveCap: 1, proposedBaseline: null });
  x.allowedTypeCount = 10000; expect(value(x).effectiveCap).toBe(1);
  x.allowedTypeCount = 0; expect(value(x)).toMatchObject({ baselineCount: 100, effectiveCap: 1 });
});
it('first-plan baseline is only a proposal bound to the exact history revision', () => {
  const x = capFixture(); x.history.weeks.at(-1)!.baseline = null; x.allowedTypeCount = 20;
  expect(value(x)).toMatchObject({ baselineCount: 20, effectiveCap: 6, expectedHistoryRevision: 5,
    proposedBaseline: { week: '2030-W05', count: 20, frozenAtMs: NOW } });
  expect(x.history.weeks.at(-1)!.baseline).toBeNull();
});
it('explicit no-plan weeks are allowed without manufacturing catch-up allowance', () => {
  const x = capFixture(); for (const row of x.history.weeks) row.baseline = null;
  expect(value(x)).toMatchObject({ baselineCount: 6, trailingBaseline: 6, effectiveCap: 1 });
});
it.each(['removed', 'possibly-removed', 'reserved'] as const)('counts %s capacity without a restore refund', state => {
  const x = capFixture(); x.history.weeks.at(-1)!.removals = [{ id: 'event', atMs: NOW, count: 30, state }];
  if (state !== 'removed') x.history.outstanding = [{ id: 'event', atMs: NOW, count: 30, state }];
  expect(value(x)).toMatchObject({ removedThisWeek: 30, weeklyRemaining: 0, effectiveCap: 0 });
});
it('unresolved reservations never age out, including all-time charges older than the displayed weeks', () => {
  const x = capFixture(); x.history.outstanding = [{ id: 'old', atMs: NOW - 90 * DAY, count: 30, state: 'possibly-removed' }];
  expect(value(x)).toMatchObject({ removedThisWeek: 30, removedTrailing: 30, effectiveCap: 0 });
  x.history.outstanding = []; expect(value(x).effectiveCap).toBe(30);
});
it('outstanding and week rows must agree exactly and are not double charged', () => {
  const x = capFixture(); x.history.outstanding = [{ id: 'active', atMs: NOW, count: 1, state: 'reserved' }];
  expect(calculateCaps(x).status).toBe('refused');
  x.history.weeks.at(-1)!.removals = [{ ...x.history.outstanding[0]! }];
  expect(value(x)).toMatchObject({ removedThisWeek: 1, removedTrailing: 1, effectiveCap: 29 });
  x.history.weeks.at(-1)!.removals[0]!.count = 2; expect(calculateCaps(x).status).toBe('refused');
});
it('includes exactly the oldest elapsed boundary and drops one millisecond older removals', () => {
  const x = capFixture(), row = x.history.weeks[0]!; row.baseline!.frozenAtMs -= 3600000;
  row.removals = [{ id: 'edge', atMs: NOW - 28 * DAY, count: 30, state: 'removed' }];
  expect(value(x).removedTrailing).toBe(30);
  row.removals[0]!.atMs--; expect(value(x).removedTrailing).toBe(0);
  expect(value(x).trailingBaseline).toBe(100);
});
it('retains an early baseline from a week partially overlapping the trailing window', () => {
  const x = capFixture(); x.history.weeks[0]!.baseline!.count = 2; x.history.weeks[0]!.baseline!.frozenAtMs -= 3600000;
  expect(value(x)).toMatchObject({ trailingBaseline: 2, effectiveCap: 1 });
});
it('ISO week uses explicit local date through year boundaries and DST', () => {
  expect(localIsoWeek(Date.parse('2021-01-04T04:59:59Z'), 'America/New_York').week).toBe('2020-W53');
  expect(localIsoWeek(Date.parse('2021-01-04T05:00:00Z'), 'America/New_York').week).toBe('2021-W01');
  expect(localIsoWeek(Date.parse('2026-03-09T03:59:59Z'), 'America/New_York').week).toBe('2026-W10');
  expect(localIsoWeek(Date.parse('2026-03-09T04:00:00Z'), 'America/New_York').week).toBe('2026-W11');
  expect(overlappingWeeks(Date.parse('2026-11-02T05:30:00Z'), 'America/New_York')).toEqual(['2026-W41', '2026-W42', '2026-W43', '2026-W44', '2026-W45']);
  expect(overlappingWeeks(Date.parse('2026-03-30T04:30:00Z'), 'America/New_York')).toEqual(['2026-W09', '2026-W10', '2026-W11', '2026-W12', '2026-W13', '2026-W14']);
});
it.each([
  ['missing week', (x: CapInput) => { x.history.weeks = x.history.weeks.slice(1); }],
  ['duplicate week', (x: CapInput) => { x.history.weeks = [...x.history.weeks.slice(1), x.history.weeks[1]!]; }],
  ['duplicate baseline', (x: CapInput) => { x.history.weeks[0]!.baseline!.id = x.history.weeks[1]!.baseline!.id; }],
  ['wrong baseline week', (x: CapInput) => { x.history.weeks[0]!.baseline!.frozenAtMs = NOW; }],
  ['unknown complete', (x: CapInput) => { (x.history as unknown as { complete: null }).complete = null; }],
  ['stale observation', (x: CapInput) => { x.history.observedAtMs--; }],
  ['changed timezone binding', (x: CapInput) => { x.calendar.bindingHash = H; }],
  ['invalid timezone', (x: CapInput) => { x.calendar.timezone = 'unknown/not-a-zone'; }],
  ['different root', (x: CapInput) => { x.history.folder.rootFileId = 'replacement'; }],
  ['negative count', (x: CapInput) => { x.history.weeks[0]!.baseline!.count = -1; }],
  ['fractional count', (x: CapInput) => { x.allowedTypeCount = 6.5; }],
  ['inflated policy', (x: CapInput) => { x.policy.weeklyBasisPoints = 3001; }],
] as const)('refuses %s history or binding', (_name, change) => {
  const x = capFixture(); change(x); expect(calculateCaps(x).status).toBe('refused');
});
it('refuses duplicate removal IDs, unknown outcomes and removals without a frozen baseline', () => {
  const x = capFixture(), row = x.history.weeks.at(-1)!;
  const e = { id: 'event', atMs: NOW, count: 1, state: 'removed' as const }; row.removals = [e, { ...e }];
  expect(calculateCaps(x).status).toBe('refused'); row.removals = [e]; row.baseline = null;
  expect(calculateCaps(x).status).toBe('refused');
});
it('calendar passage alone cannot increase an unmeasured canary or its F0 rung', () => {
  const x = capFixture(); x.pilot.firstRemoval = 'pending'; expect(value(x)).toMatchObject({ pilotCap: 1, maxRung: 0 });
  x.pilot.firstRemoval = 'complete'; x.pilot.measuredGrowth = false; expect(value(x)).toMatchObject({ pilotCap: 1, maxRung: 0 });
  x.pilot.measuredGrowth = true; x.pilot.startedAtMs = NOW - DAY; expect(value(x).pilotCap).toBe(10);
  x.pilot.maxBatch = 3; expect(value(x).pilotCap).toBe(3);
});
it.each([null, 0] as const)('unknown or zero ripple denominator %s remains cap one', denominator => {
  const x = capFixture(); x.ripple!.eventsPerItem = denominator; expect(value(x).rippleCap).toBe(1);
  x.ripple!.fixedEvents = 101; expect(value(x).rippleCap).toBe(0);
});
it('missing measurement or null policy budget gives one; zero budget gives zero', () => {
  const x = capFixture(); x.ripple = null; expect(value(x).rippleCap).toBe(1);
  x.policy.rippleEventBudget = null; expect(value(x).rippleCap).toBe(1);
  x.policy.rippleEventBudget = 0; expect(value(x).rippleCap).toBe(0);
});
it('malformed measurement and pilot scope fail closed instead of becoming canary fallback', () => {
  const x = capFixture(); x.ripple!.eventsPerItem = Number.NaN; expect(calculateCaps(x).status).toBe('refused');
  const y = capFixture(); y.pilot.folder.folderId = 'other'; expect(calculateCaps(y).status).toBe('refused');
});
