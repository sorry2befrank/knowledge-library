import { expect, it } from 'vitest';
import { buildFocusPlan, type PlanInput, type StandingEvidence } from '../packages/core/src/focus/plan.ts';
import { planFixture, NOW, DAY, H, G, J } from './helpers/focus-plan-fixture.ts';
import { digest } from '../packages/core/src/focus/plan-data.ts';
function plan(x: PlanInput) { const r = buildFocusPlan(x); expect(r.status).toBe('planned'); if (r.status !== 'planned') throw Error(JSON.stringify(r)); return r.plan; }
function standing(x: PlanInput): StandingEvidence {
  return { state: 'verified', receiptHash: H, folderId: 'folder', deviceId: 'device', policyHash: H, goalHash: G, capPolicyHash: digest(x.caps.policy),
    approvalEpoch: 3, expiresAtMs: NOW + 7 * DAY, names: x.kernel.policy.nameMentions, mode: 'apply', publishedDraftHash: null, publishedAtMs: null, vetoClearThroughMs: null };
}
it('freezes all allowed-type features and pins, ranks only E and never authorizes an effect', async () => {
  const x = await planFixture(), r = buildFocusPlan(x); expect(r.status).toBe('planned');
  if (r.status !== 'planned') throw Error(JSON.stringify(r));
  expect(r).toMatchObject({ effect: 'none', authorizesEffects: false }); expect(r.releaseHolds).toContain('durable-cap-baseline-and-global-admission');
  expect(r.plan.proposed).toEqual(['f0', 'f1', 'f2']); expect(r.plan.reviewed).toEqual(['f0']); expect(r.plan.probes).toEqual(['f3', 'f4']);
  expect(r.plan.frozenInput.features).toHaveLength(6); expect(Object.isFrozen(r.plan.frozenInput.kernel.snapshot.files)).toBe(true);
  x.features[0]!.score = -10; expect(r.plan.frozenInput.features[0]!.score).toBe(0.1);
});
it('learner changes alter ranking and hash but cannot widen factual eligibility', async () => {
  const x = await planFixture(); x.kernel.snapshot.files[0]!.pins!.kinds = ['goal']; x.review.ticks = [];
  const a = plan(x); x.features[0]!.score = -1e6; x.features[2]!.score = -1; x.learner.hash = J;
  const b = plan(x); expect(b.eligible).toEqual(a.eligible); expect(b.eligible).not.toContain('f0');
  expect(b.proposed[0]).toBe('f2'); expect(b.planHash).not.toBe(a.planHash);
});
it('factual blockers remain effective when the learner ranks them first', async () => {
  const x = await planFixture(); x.kernel.snapshot.files[0]!.activity!.holds = 1; x.review.ticks = [];
  expect(plan(x).proposed).toEqual(['f1', 'f2']);
});
it('cap truncation and exclusions each re-close references without refilling candidates', async () => {
  const x = await planFixture(); x.review.ticks = [];
  x.kernel.references.edges = [{ id: 'depends-on-kept', source: 'f1', target: 'f0', kind: 'path' }];
  x.caps.policy.maxPerRun = 1; expect(plan(x).proposed).toEqual([]);
  x.caps.policy.maxPerRun = 30; x.correctionExclusions = ['f1']; expect(plan(x).proposed).toEqual(['f2']);
});
it('review unticking a source closes its referenced target as well', async () => {
  const x = await planFixture(); x.kernel.references.edges = [{ id: 'link', source: 'f0', target: 'f1', kind: 'link' }];
  x.review.ticks = ['f1']; x.review.unticks = ['f0']; expect(plan(x).reviewed).toEqual([]);
  x.review.ticks = ['f0', 'f1']; x.review.unticks = []; expect(plan(x).reviewed).toEqual(['f0', 'f1']);
});
it('F1 names need an explicit same-plan tick even when policy says allow', async () => {
  const x = await planFixture(); x.review.rung = 1; x.review.batchReviewed = true; x.review.ticks = []; x.kernel.policy.nameMentions = 'allow';
  x.kernel.references.edges = [{ id: 'name', source: 'outside', target: 'f0', kind: 'name' }]; x.features[0]!.nameMentions = 1;
  expect(plan(x).reviewed).toEqual(['f1', 'f2']);
  x.review.ticks = ['f0']; expect(plan(x).reviewed).toEqual(['f0', 'f1', 'f2']);
});
it('new name obligations after an exclusion propagate to a fixed point', async () => {
  const x = await planFixture(); x.review.rung = 1; x.review.batchReviewed = true; x.review.ticks = []; x.review.unticks = ['f0'];
  x.kernel.references.edges = [{ id: 'first', source: 'f0', target: 'f1', kind: 'name' }, { id: 'second', source: 'f1', target: 'f2', kind: 'name' }];
  x.features[1]!.nameMentions = 1; x.features[2]!.nameMentions = 1;
  expect(plan(x).reviewed).toEqual([]);
  x.review.ticks = ['f1']; expect(plan(x).reviewed).toEqual(['f1', 'f2']);
});
it('probes are eligible keep-side nearest threshold items and require explicit ticks inside the cap', async () => {
  const x = await planFixture(); x.review.rung = 1; x.review.batchReviewed = true; x.review.ticks = [];
  expect(plan(x).reviewed).toEqual(['f0', 'f1', 'f2']);
  x.review.ticks = ['f3']; expect(plan(x).reviewed).toEqual(['f0', 'f1', 'f2', 'f3']);
  x.caps.policy.maxPerRun = 3; expect(buildFocusPlan(x).status).toBe('refused');
});
it('first pilot item stays F0 and one item despite an old start date', async () => {
  const x = await planFixture(); x.caps.pilot.firstRemoval = 'pending';
  expect(plan(x)).toMatchObject({ effectiveCap: 1, reviewed: ['f0'] });
  x.review.rung = 1; x.review.batchReviewed = true; expect(buildFocusPlan(x).status).toBe('refused');
});
it('approval floor caps the rung despite a grown pilot', async () => {
  const x = await planFixture(); x.controls.approvalFloor = 'item'; x.review.rung = 1; x.review.batchReviewed = true;
  expect(buildFocusPlan(x).status).toBe('refused');
});
it('F2/F3 standing rule binds current scope, caps, goal, names and epoch', async () => {
  const x = await planFixture(); x.review.rung = 2; x.review.ticks = []; x.review.standing = standing(x);
  expect(plan(x).reviewed).toEqual(['f0', 'f1', 'f2']); x.review.rung = 3; expect(plan(x).reviewed).toHaveLength(3);
  x.review.standing.approvalEpoch--; expect(buildFocusPlan(x).status).toBe('refused');
});
it('veto24h binds the previously published draft; waiting changes review time, not frozen planning evidence', async () => {
  const x = await planFixture(); x.controls.standingMode = 'veto-24h'; const draft = plan(x).draftHash;
  x.review.rung = 2; x.review.ticks = []; x.review.atMs = NOW + DAY;
  x.review.standing = { ...standing(x), mode: 'veto-24h', publishedDraftHash: draft, publishedAtMs: NOW, vetoClearThroughMs: NOW + DAY };
  expect(plan(x).reviewed).toHaveLength(3);
  x.review.atMs--; x.review.standing.vetoClearThroughMs = x.review.atMs; expect(buildFocusPlan(x).status).toBe('refused');
  x.review.atMs++; x.review.standing.vetoClearThroughMs = x.review.atMs; x.learner.hash = J; expect(buildFocusPlan(x).status).toBe('refused');
});
it('review ticks and unticks alter final hash but leave the draft hash unchanged', async () => {
  const x = await planFixture(), a = plan(x); x.review.ticks = ['f1']; x.review.unticks = ['f0']; const b = plan(x);
  expect(b.draftHash).toBe(a.draftHash); expect(b.planHash).not.toBe(a.planHash);
  expect(b.reviewed).toEqual(['f1']);
});
it('veiled recency uses the value frozen at veil begin', async () => {
  const x = await planFixture(); x.features[0]!.veiledInWindow = true; x.features[0]!.frozenReadDaysAtVeil = 100;
  expect(plan(x).frozenInput.features[0]!.daysSinceRead).toBe(100);
  x.features[0]!.daysSinceRead = 200; expect(buildFocusPlan(x).status).toBe('refused');
});
it.each([
  ['missing features', (x: PlanInput) => { x.features = x.features.slice(1); }],
  ['duplicate features', (x: PlanInput) => { x.features = [...x.features.slice(1), x.features[1]!]; }],
  ['unknown score', (x: PlanInput) => { x.features[0]!.score = NaN; }],
  ['wrong count', (x: PlanInput) => { x.caps.allowedTypeCount++; }],
  ['stale snapshot', (x: PlanInput) => { x.kernel.snapshot.capturedAtMs -= DAY; }],
  ['unknown kind', (x: PlanInput) => { x.kernel.snapshot.files[0]!.kind = null; }],
  ['outside folder inflates baseline', (x: PlanInput) => { x.kernel.snapshot.files[0]!.path!.segments = ['outside', 'candidate.md']; }],
  ['pause', (x: PlanInput) => { x.controls.globalPaused = true; }],
  ['scope mismatch', (x: PlanInput) => { x.controls.deviceId = 'other'; }],
  ['stale controls', (x: PlanInput) => { x.controls.observedAtMs--; }],
  ['tick outside offer', (x: PlanInput) => { x.review.ticks = ['f5']; }],
  ['tick and untick', (x: PlanInput) => { x.review.unticks = ['f0']; }],
] as const)('refuses %s without a permissive fallback', async (_name, change) => {
  const x = await planFixture(); change(x); expect(buildFocusPlan(x).status).toBe('refused');
});
it('hash covers feature, learner, policy, epoch and history evidence, with deterministic ties', async () => {
  const x = await planFixture(); for (const f of x.features) f.score = 0.1; x.features = [...x.features].reverse();
  expect(plan(x).proposed).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  const first = plan(x).planHash; x.controls.policyEpoch++; expect(plan(x).planHash).not.toBe(first);
  const second = plan(x).planHash; x.caps.history.revision++; expect(plan(x).planHash).not.toBe(second);
});
