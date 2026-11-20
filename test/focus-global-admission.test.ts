import { expect, it } from 'vitest';
import { admissionStateHash, proposeAdmissionTransition, validateAdmissionSnapshot, type AdmissionCommand, type AdmissionSnapshot, type QuietEvidence } from '../packages/core/src/focus/global-admission.ts';
import { binding, snapshot, quiet, NOW, DAY, H, G, J } from './helpers/focus-plan-fixture.ts';
import { digest } from '../packages/core/src/focus/plan-data.ts';
function call(s: AdmissionSnapshot, c: AdmissionCommand, now = NOW) {
  return proposeAdmissionTransition({ nowMs: now, expectedRevision: s.revision, snapshot: { ...s, observedAtMs: now }, command: c });
}
function next(s: AdmissionSnapshot, c: AdmissionCommand, now = NOW): AdmissionSnapshot {
  const r = call(s, c, now); expect(r.status).toBe('proposed'); if (r.status !== 'proposed') throw Error(JSON.stringify(r)); return r.next;
}
function admitted() { return next(snapshot(), { type: 'admit', binding: binding() }); }
function started() { return next(admitted(), { type: 'begin-effect', binding: binding(), effectId: 'move', kind: 'movement', itemId: 'f0' }); }
function settled() { return next(started(), { type: 'observe-effect', binding: binding(), effectId: 'move', state: 'settled', observationHash: H }); }
function complete() { return next(settled(), { type: 'complete', binding: binding() }); }
it('public persistence validator returns an immutable checked snapshot without authority', () => {
  const input = started(), r = validateAdmissionSnapshot(input, NOW); expect(r.status).toBe('valid');
  if (r.status !== 'valid') throw Error('held');
  expect(r).toMatchObject({ stateHash: admissionStateHash(input), effect: 'none', authorizesEffects: false });
  expect(r.snapshot).toEqual(input); expect(r.snapshot).not.toBe(input); expect(Object.isFrozen(r.snapshot.pending)).toBe(true);
});
it('public persistence validator refuses absent, corrupt, stale and unknown input without empty fallback', () => {
  for (const bad of [null, {}, false, [], { ...snapshot(), complete: null }, { ...snapshot(), observedAtMs: NOW - 1 }, { ...started(), pending: {} }])
    expect(validateAdmissionSnapshot(bad, NOW).status).toBe('held');
});
it('admission proposes the global checkpoint before effects and carries explicit durability requirements', () => {
  const s = snapshot(), r = call(s, { type: 'admit', binding: binding() }); expect(r.status).toBe('proposed');
  if (r.status !== 'proposed') throw Error('held');
  expect(r).toMatchObject({ effect: 'none', authorizesEffects: false, expectedRevision: 0, expectedStateHash: admissionStateHash(s) });
  expect(r.next.pending).toMatchObject({ phase: 'admitted', effectRevision: 0, effects: [] });
  expect(r.requires).toContain('durable-sync-before-every-effect-intent'); expect(s.pending).toBeNull();
  expect(Object.isFrozen(r.next.pending!.binding.plannedItems)).toBe(true);
});
it('read freshness changes no persisted CAS hash but a revision change does', () => {
  const s = snapshot(); expect(admissionStateHash({ ...s, observedAtMs: NOW + 1 })).toBe(admissionStateHash(s));
  expect(admissionStateHash({ ...s, revision: 1 })).not.toBe(admissionStateHash(s));
});
it('a modeled competing proposal loses CAS and cannot clear or replace the committed pending run', () => {
  const initial = snapshot(), first = next(initial, { type: 'admit', binding: binding() });
  const second = proposeAdmissionTransition({ nowMs: NOW, expectedRevision: initial.revision, snapshot: first,
    command: { type: 'admit', binding: { ...binding(), runId: 'other' } } });
  expect(second.status).toBe('held'); expect(first.pending!.binding.runId).toBe('run');
});
it.each(['same-folder', 'other-folder', 'other-pilot'] as const)('pending quiet blocks %s new admission', mode => {
  const s = admitted(), b = binding(); b.runId = 'other';
  if (mode === 'other-folder') b.folder.folderId = 'other'; if (mode === 'other-pilot') b.pilotId = 'other';
  expect(call(s, { type: 'admit', binding: b }).status).toBe('held');
});
it('only the exact admitted run can resume after interrupted serialization/restart', () => {
  const s = next(started(), { type: 'interrupt', binding: binding() });
  const recovered = JSON.parse(JSON.stringify(s)) as AdmissionSnapshot;
  expect(next(recovered, { type: 'resume', binding: binding() }).pending!.effects[0]!.state).toBe('intent');
  expect(call(recovered, { type: 'resume', binding: { ...binding(), planHash: G } }).status).toBe('held');
});
it.each(['pilot', 'authority'] as const)('changed current %s prevents resumption without resetting the pending hold', field => {
  const s = structuredClone(started()); if (field === 'pilot') s.activePilot.id = 'new'; else s.activePilot.authorityHash = H;
  expect(call(s, { type: 'resume', binding: binding() }).status).toBe('held');
  expect(s.pending!.binding.planHash).toBe(H);
});
it.each(['intent', 'unknown'] as const)('unsettled %s blocks every later effect kind; settling permits the next item', state => {
  let s = started();
  if (state === 'unknown') s = next(s, { type: 'observe-effect', binding: binding(), effectId: 'move', state, observationHash: J });
  for (const kind of ['movement', 'pointer', 'veil', 'restore', 'recovery'] as const) {
    expect(call(s, { type: 'begin-effect', binding: binding(), effectId: `next-${kind}`, kind, itemId: kind === 'movement' ? 'f1' : null }).status).toBe('held');
  }
  const done = next(s, { type: 'observe-effect', binding: binding(), effectId: 'move', state: 'settled', observationHash: H });
  expect(next(done, { type: 'begin-effect', binding: binding(), effectId: 'second', kind: 'movement', itemId: 'f1' }).pending!.effects).toHaveLength(2);
});
it('unknown effect cannot complete or clear quiet even with otherwise green observations', () => {
  const s = next(started(), { type: 'observe-effect', binding: binding(), effectId: 'move', state: 'unknown', observationHash: H });
  expect(call(s, { type: 'complete', binding: binding() }).status).toBe('held');
  expect(call(s, { type: 'release', binding: binding(), quiet: quiet(complete()) }, NOW + 3000).status).toBe('held');
});
it('movement cannot add an unplanned item or repeat an already attempted item', () => {
  const s = settled();
  for (const itemId of ['f0', 'unplanned']) expect(call(s, { type: 'begin-effect', binding: binding(), effectId: 'new', kind: 'movement', itemId }).status).toBe('held');
  expect(next(s, { type: 'begin-effect', binding: binding(), effectId: 'new', kind: 'movement', itemId: 'f1' }).pending!.effects).toHaveLength(2);
});
it('completion permanently closes movement even after interruption and recovery', () => {
  let s = next(complete(), { type: 'interrupt', binding: binding() }); s = next(s, { type: 'resume', binding: binding() });
  expect(call(s, { type: 'begin-effect', binding: binding(), effectId: 'late', kind: 'movement', itemId: 'f1' }).status).toBe('held');
  expect(next(s, { type: 'begin-effect', binding: binding(), effectId: 'recover', kind: 'recovery', itemId: null }).pending!.movementClosed).toBe(true);
});
it('matching complete immediate and first-following-nightly evidence proposes release and retains used run membership', () => {
  const s = complete(), released = next(s, { type: 'release', binding: binding(), quiet: quiet(s) }, NOW + 3000);
  expect(released.pending).toBeNull(); expect(released.closedRunIds).toEqual(['run']);
  expect(call(released, { type: 'admit', binding: binding() }, NOW + 3000).status).toBe('held');
  expect(next(released, { type: 'admit', binding: { ...binding(), runId: 'next' } }, NOW + 3000).pending!.binding.runId).toBe('next');
});
it.each(['pointer', 'veil', 'restore', 'recovery'] as const)('later %s invalidates older quiet proof even when same run identity remains', kind => {
  const original = complete(), old = quiet(original); let s = next(original, { type: 'begin-effect', binding: binding(), effectId: 'later', kind, itemId: null }, NOW + 1000);
  s = next(s, { type: 'observe-effect', binding: binding(), effectId: 'later', state: 'settled', observationHash: G }, NOW + 1001);
  s = next(s, { type: 'complete', binding: binding() }, NOW + 1002);
  expect(call(s, { type: 'release', binding: binding(), quiet: old }, NOW + 3000).status).toBe('held');
  expect(next(s, { type: 'release', binding: binding(), quiet: quiet(s) }, NOW + 3000).pending).toBeNull();
});
it.each([
  ['different binding', (q: QuietEvidence) => { q.bindingHash = J; }],
  ['older effect revision', (q: QuietEvidence) => { q.effectRevision--; }],
  ['wrong effects digest', (q: QuietEvidence) => { q.effectsDigest = J; }],
  ['stale source observation', (q: QuietEvidence) => { q.observedAtMs--; }],
  ['later contradiction', (q: QuietEvidence) => { q.noLaterContradiction = false; }],
  ['failed event budget', (q: QuietEvidence) => { q.immediate.observedEvents = 6; }],
  ['new project', (q: QuietEvidence) => { q.immediate.noNewProjects = false; }],
  ['portfolio refusal', (q: QuietEvidence) => { q.immediate.noPortfolioRefusal = false; }],
  ['pinned touched', (q: QuietEvidence) => { q.immediate.pinnedUntouched = false; }],
  ['Orrery write', (q: QuietEvidence) => { q.immediate.zeroLibraryWritesInOrrery = false; }],
  ['wrong folder-scan expectation', (q: QuietEvidence) => { q.immediate.folderScan = 'expected-needs-review'; }],
  ['later convenient nightly', (q: QuietEvidence) => { q.nightly.firstFollowingConfirmed = false; }],
  ['wrong nightly origin', (q: QuietEvidence) => { q.nightly.firstFollowingAfterMs--; }],
  ['held ripple', (q: QuietEvidence) => { q.nightly.noHeldPathRipple = false; }],
  ['pointer ripple', (q: QuietEvidence) => { q.nightly.noPointerSourceRipple = false; }],
  ['held correction', (q: QuietEvidence) => { q.nightly.noHeldPathCorrector = false; }],
] as const)('keeps pending on %s evidence', (_name, change) => {
  const s = complete(), q = quiet(s); change(q); expect(call(s, { type: 'release', binding: binding(), quiet: q }, NOW + 3000).status).toBe('held');
});
it('exact 24-hour-old quiet evidence is stale', () => {
  const s = complete(), q = quiet(s, NOW + DAY); expect(call(s, { type: 'release', binding: binding(), quiet: q }, NOW + DAY).status).toBe('held');
});
it('registered folder needs-review is accepted only for its matching binding', () => {
  const b = binding(); b.registered = true;
  let s = next(snapshot(), { type: 'admit', binding: b }); s = next(s, { type: 'complete', binding: b });
  expect(next(s, { type: 'release', binding: b, quiet: quiet(s) }, NOW + 3000).pending).toBeNull();
});
it('malformed, stale and unbounded journal snapshots cannot mint an empty fallback', () => {
  const s = started(); const bad = structuredClone(s); bad.pending!.effectsDigest = H;
  expect(call(bad, { type: 'resume', binding: binding() }).status).toBe('held');
  const huge = snapshot(); huge.closedRunIds = Array.from({ length: 10001 }, (_, i) => `run-${i}`);
  expect(call(huge, { type: 'admit', binding: binding() }).status).toBe('held');
  expect(proposeAdmissionTransition({ nowMs: NOW, expectedRevision: 0, snapshot: { ...snapshot(), observedAtMs: NOW - 1 }, command: { type: 'admit', binding: binding() } }).status).toBe('held');
});
it('corrupt snapshots with multiple simultaneous unknown effects are refused', () => {
  const s = structuredClone(started()), p = s.pending!;
  p.effects = [...p.effects, { ...p.effects[0]!, id: 'second', itemId: 'f1' }]; p.effectsDigest = digest(p.effects); p.effectRevision = 2;
  expect(call(s, { type: 'resume', binding: binding() }).status).toBe('held');
});
