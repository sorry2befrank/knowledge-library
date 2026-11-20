import { describe, it, expect } from 'vitest';
import { digest } from '../packages/core/src/focus/plan-data.ts';
import { calculateCaps, localIsoWeek } from '../packages/core/src/focus/plan-caps.ts';
import { buildFocusPlan } from '../packages/core/src/focus/plan.ts';
import { capLedgerStateHash, projectCapHistory, validateCapLedgerSnapshot } from '../packages/core/src/focus/cap-ledger.ts';
import { coupledStateHash, validateCoupledSnapshot, proposeCoupledTransition } from '../packages/core/src/focus/coupled-admission.ts';
import { capFixture, quiet } from './helpers/focus-plan-fixture.ts';
import { NOW, DAY, H, J, ledger, readCap, read, capTry, capNext, attempt, next, seed, commit, fresh, admit, begin, evidence, observe } from './helpers/cap-coupling-fixture.ts';

describe('complete cap state and projections (pure, non-authorizing)', () => {
  it('keeps persisted hashes stable across a fresh same-week read without a fake transition', async () => {
    const { s } = await seed(); const later = read(s, NOW + 1000);
    expect(capLedgerStateHash(later.caps)).toBe(capLedgerStateHash(s.caps)); expect(coupledStateHash(later)).toBe(coupledStateHash(s));
    expect(projectCapHistory(later.caps, NOW + 1000).status).toBe('projected');
  });
  for (const [name, change] of [
    ['missing history', (s: any) => { delete s.weeks; }], ['incomplete history', (s: any) => { s.complete = false; }],
    ['omitted calendar row', (s: any) => { s.weeks.splice(1, 1); }], ['duplicated calendar row', (s: any) => { s.weeks[1] = s.weeks[0]; }],
    ['wrong baseline identity', (s: any) => { s.weeks[0].baseline.id = H; }], ['unproven no-plan week', (s: any) => { s.weeks.at(-1).noPlanEvidenceHash = null; }],
    ['unknown timezone', (s: any) => { s.timezone = 'not/a/timezone'; }], ['extra field', (s: any) => { s.reset = true; }],
    ['stale read', (s: any) => { s.observedAtMs--; }], ['future coverage', (s: any) => { s.coverage.throughMs++; }],
  ] as const) it('holds ' + name, () => { const s = ledger(); change(s); expect(validateCapLedgerSnapshot(s, NOW).status).toBe('held'); });
  it('does not overwrite the first baseline on retries or smaller later scans', () => {
    const s = capNext(ledger(), { type: 'freeze-baseline', count: 6 });
    expect(s.weeks.at(-1)!.baseline!.count).toBe(6);
    expect(capTry(s, { type: 'freeze-baseline', count: 1 }).status).toBe('held');
  });
  it('charges old unknown capacity after 36 days and does not omit old membership', () => {
    let s = capNext(ledger(NOW, true), { type: 'reserve', runId: 'run', planHash: H, items: ['item'], admissionBindingHash: J });
    s = capNext(s, { type: 'bind-effect', reservationId: s.charges[0]!.id, effectId: 'effect' });
    s = capNext(s, { type: 'settle', reservationId: s.charges[0]!.id, evidence: evidence(s.charges[0]!, NOW, 'unknown') });
    const now = NOW + 36 * DAY; s = readCap(s, now);
    s = capNext(s, { type: 'cover', evidence: { state: 'verified', priorStateHash: capLedgerStateHash(s), throughMs: now, receiptHash: H } });
    const projected = projectCapHistory(s, now); expect(projected.status).toBe('projected'); if (projected.status !== 'projected') return;
    expect(projected.history.outstanding).toHaveLength(1); expect(projected.history.weeks.flatMap(w => w.removals)).toHaveLength(0);
    const cap = calculateCaps({ ...capFixture(now), history: projected.history }); expect(cap.status).toBe('calculated');
    if (cap.status === 'calculated') { expect(cap.value.removedThisWeek).toBe(1); expect(cap.value.removedTrailing).toBe(1); }
  });
  it('uses elapsed 28-day inclusive boundary through DST via the existing cap calculator', () => {
    const at = Date.parse('2030-03-10T07:00:00Z'), now = at + 28 * DAY;
    let s = capNext(ledger(at, true), { type: 'reserve', runId: 'run', planHash: H, items: ['item'], admissionBindingHash: J });
    s = capNext(s, { type: 'bind-effect', reservationId: s.charges[0]!.id, effectId: 'effect' });
    s = capNext(s, { type: 'settle', reservationId: s.charges[0]!.id, evidence: evidence(s.charges[0]!, at, 'removed') });
    s = readCap(s, now); s = capNext(s, { type: 'cover', evidence: { state: 'verified', priorStateHash: capLedgerStateHash(s), throughMs: now, receiptHash: H } });
    const p = projectCapHistory(s, now); if (p.status !== 'projected') throw Error('projection');
    const cap = calculateCaps({ ...capFixture(now), history: p.history }); if (cap.status !== 'calculated') throw Error('cap');
    expect(cap.value.removedTrailing).toBe(1); expect(p.history.outstanding).toHaveLength(0);
    const later = projectCapHistory(readCap(s, now + 1), now + 1); if (later.status !== 'projected') throw Error('projection');
    const expired = calculateCaps({ ...capFixture(now + 1), history: later.history }); if (expired.status !== 'calculated') throw Error('cap');
    expect(expired.value.removedTrailing).toBe(0);
  });
  it('requires bound coverage evidence before projecting a new calendar week', () => {
    const now = NOW + 7 * DAY, s = readCap(ledger(), now);
    expect(projectCapHistory(s, now).status).toBe('held');
    expect(capTry(s, { type: 'cover', evidence: { state: 'verified', priorStateHash: H, throughMs: now, receiptHash: J } }).status).toBe('held');
    const covered = capNext(s, { type: 'cover', evidence: { state: 'verified', priorStateHash: capLedgerStateHash(s), throughMs: now, receiptHash: J } });
    expect(covered.weeks.at(-1)!.baseline).toBeNull(); expect(projectCapHistory(covered, now).status).toBe('projected');
  });
});

describe('atomic proposed plan, review and admission transitions', () => {
  it('stages the first baseline and final history revision before producing a reproducible plan hash', async () => {
    const { s, input } = await seed(); const prior = coupledStateHash(s), planned = commit(s, input), p = planned.plans[0]!;
    expect(s.caps.weeks.at(-1)!.baseline).toBeNull(); expect(coupledStateHash(s)).toBe(prior);
    expect(planned.caps.weeks.at(-1)!.baseline!.count).toBe(6); expect(p.capRevision).toBe(1); expect(p.plan.caps.proposedBaseline).toBeNull();
    const rebuilt = buildFocusPlan(p.plan.frozenInput); expect(rebuilt.status).toBe('planned');
    if (rebuilt.status === 'planned') expect(rebuilt.plan.planHash).toBe(p.plan.planHash);
  });
  it('withholds both staged baseline and plan if the plan fails review', async () => {
    const { s, input } = await seed(); input.review.ticks = ['not-offered']; const before = digest(s);
    expect(attempt(s, { type: 'commit-plan', input, authorityHash: J }).status).toBe('held'); expect(digest(s)).toBe(before);
  });
  it('does not freeze a baseline for a different pilot or pilot receipt', async () => {
    const { s, input } = await seed(); const other = structuredClone(input); other.caps.pilot.id = 'other'; other.caps.ripple!.pilotId = 'other';
    expect(attempt(s, { type: 'commit-plan', input: other, authorityHash: J }).status).toBe('held');
    input.caps.pilot.receiptHash = H; expect(attempt(s, { type: 'commit-plan', input, authorityHash: J }).status).toBe('held');
    expect(s.caps.weeks.at(-1)!.baseline).toBeNull();
  });
  it('proposes the entire reserved reviewed set and global pending checkpoint together', async () => {
    const { s, input } = await seed(NOW, true); input.review.ticks = ['f0', 'f1'];
    const planned = commit(s, input), admitted = admit(planned);
    expect(admitted.admission.pending!.binding.plannedItems).toEqual(['f0', 'f1']);
    expect(admitted.caps.charges.map(c => c.itemId)).toEqual(['f0', 'f1']); expect(admitted.runs).toHaveLength(1);
    expect(planned.caps.charges).toHaveLength(0); expect(planned.admission.pending).toBeNull();
  });
  it('uses one combined CAS and rejects stale revision or hash', async () => {
    const { s, input } = await seed(); const command = { type: 'commit-plan' as const, input, authorityHash: J };
    const one = attempt(s, command), two = attempt(s, command); expect(one.status).toBe('proposed'); expect(two.status).toBe('proposed');
    // Pure competitors are proposals; only a later transaction owner may commit one expected state.
    if (one.status !== 'proposed') return;
    expect(proposeCoupledTransition({ snapshot: one.next, nowMs: NOW, expectedRevision: s.revision, expectedStateHash: coupledStateHash(s), command }).status).toBe('held');
    expect(proposeCoupledTransition({ snapshot: s, nowMs: NOW, expectedRevision: s.revision, expectedStateHash: H, command }).status).toBe('held');
  });
  it('preserves the exact draft for 24-hour veto review and admits using distinct current facts', async () => {
    const { s, input } = await seed(); input.controls.standingMode = 'veto-24h'; input.review.ticks = [];
    const planned = commit(s, input), draft = planned.plans[0]!.plan; const now = NOW + DAY;
    const review = { atMs: now, rung: 2 as const, ticks: [], unticks: [], batchReviewed: false, standing: {
      state: 'verified' as const, receiptHash: H, folderId: 'folder', deviceId: 'device', policyHash: H, goalHash: 'b'.repeat(64),
      capPolicyHash: digest(input.caps.policy), approvalEpoch: 3, expiresAtMs: now + DAY, names: 'ask' as const, mode: 'veto-24h' as const,
      publishedDraftHash: draft.draftHash, publishedAtMs: NOW, vetoClearThroughMs: now } };
    expect(attempt(read(planned, now - 1), { type: 'record-review', priorPlanHash: draft.planHash, review: { ...review, atMs: now - 1 } }).status).toBe('held');
    const reviewed = next(read(planned, now), { type: 'record-review', priorPlanHash: draft.planHash, review });
    const revised = reviewed.plans.at(-1)!.plan; expect(revised.draftHash).toBe(draft.draftHash); expect(revised.planHash).not.toBe(draft.planHash);
    expect(revised.frozenInput.kernel.nowMs).toBe(NOW); expect(revised.frozenInput.kernel.snapshot.capturedAtMs).toBe(NOW);
    expect(admit(reviewed).admission.pending!.binding.planHash).toBe(revised.planHash);
    expect(attempt(read(reviewed, now + 1), { type: 'admit-plan', planHash: revised.planHash, runId: 'run', fresh: fresh(reviewed, now + 1) }).status).toBe('held');
    expect(attempt(reviewed, { type: 'admit-plan', planHash: draft.planHash, runId: 'old-version', fresh: fresh(reviewed) }).status).toBe('held');
  });
  for (const [name, mutate] of [
    ['kernel time', (x: any) => { x.kernel.nowMs++; }], ['feature score', (x: any) => { x.features[0].score += 0.01; }],
    ['controls epoch', (x: any) => { x.controls.approvalEpoch++; }], ['cap allowed count', (x: any) => { x.caps.allowedTypeCount--; }],
  ] as const) it('refuses non-review input mutation under the same plan ID: ' + name, async () => {
    const { s, input } = await seed(), planned = commit(s, input), changed = structuredClone(planned.plans[0]!.plan.frozenInput);
    mutate(changed); expect(attempt(planned, { type: 'commit-plan', input: changed, authorityHash: J }).status).toBe('held');
    expect(attempt(planned, { type: 'record-review', priorPlanHash: planned.plans[0]!.plan.planHash, review: changed.review, input: changed } as any).status).toBe('held');
  });
  for (const [name, mutate] of [
    ['paused controls', (f: any) => { f.controls.globalPaused = true; }], ['new approval epoch', (f: any) => { f.controls.approvalEpoch++; }],
    ['stale kernel', (f: any) => { f.kernel.snapshot.capturedAtMs--; }], ['new hard pin', (f: any) => { f.kernel.snapshot.files[0].pins.kinds = ['goal']; }],
    ['different file identity', (f: any) => { f.kernel.snapshot.files[0].identity.fileId = f.kernel.snapshot.files[0].identity.snapshotFileId = 'replacement'; }],
    ['revoked goal', (f: any) => { f.kernel.goal.state = 'missing'; }], ['changed calendar binding', (f: any) => { f.caps.calendar.bindingHash = H; }],
    ['different root', (f: any) => { f.kernel.folder.rootFileId = 'other'; }],
    ['new kept-source link', (f: any) => { f.kernel.references.edges.push({ id: 'new-reference', source: 'outside', target: 'f0', kind: 'link' }); }],
  ] as const) it('holds admission on separate current facts: ' + name, async () => {
    const { s, input } = await seed(), planned = commit(s, input), f = fresh(planned); mutate(f);
    expect(attempt(planned, { type: 'admit-plan', planHash: planned.plans[0]!.plan.planHash, runId: 'run', fresh: f }).status).toBe('held');
  });
  it('refuses review after admission and does not admit a superseded or consumed plan', async () => {
    const { s, input } = await seed(), planned = commit(s, input), a = admit(planned), p = planned.plans[0]!.plan;
    expect(attempt(a, { type: 'record-review', priorPlanHash: p.planHash, review: p.frozenInput.review }).status).toBe('held');
    expect(attempt(a, { type: 'admit-plan', planHash: p.planHash, runId: 'another', fresh: fresh(a) }).status).toBe('held');
  });
  it('refuses a self-consistent rebuilt second version that changes non-review features', async () => {
    const { s, input } = await seed(), planned = commit(s, input), first = planned.plans[0]!;
    const changed = structuredClone(first.plan.frozenInput); changed.features = changed.features.map((f, i) => i ? f : { ...f, score: 0.11 });
    const built = buildFocusPlan(changed); expect(built.status).toBe('planned'); if (built.status !== 'planned') return;
    const forged = structuredClone(planned); forged.plans = [...forged.plans, { ...first, plan: built.plan }];
    expect(validateCoupledSnapshot(forged, NOW).status).toBe('held');
  });
  it('rejects changed cap revision even when the caller offers an otherwise valid frozen plan', async () => {
    const { s, input } = await seed(), planned = commit(s, input);
    const revised = next(planned, { type: 'cover-calendar', evidence: { state: 'verified', priorStateHash: capLedgerStateHash(planned.caps), throughMs: NOW, receiptHash: H } });
    expect(attempt(revised, { type: 'admit-plan', planHash: planned.plans[0]!.plan.planHash, runId: 'run', fresh: fresh(revised) }).status).toBe('held');
  });
  it('accepts a separately refreshed reference generation without rewriting the historical draft', async () => {
    const { s, input } = await seed(), planned = read(commit(s, input), NOW + 1000), f = fresh(planned), prior = digest(planned.plans);
    f.kernel.snapshot.id = f.kernel.references.snapshotId = f.kernel.sweep.snapshotId = 'fresh-snapshot'; f.kernel.references.id = 'fresh-reference';
    expect(attempt(planned, { type: 'admit-plan', planHash: planned.plans[0]!.plan.planHash, runId: 'run', fresh: f }).status).toBe('proposed');
    expect(digest(planned.plans)).toBe(prior); expect(f.kernel.snapshot.capturedAtMs).toBe(NOW + 1000);
  });
  it('refuses outside-folder files in the claimed current population', async () => {
    const { s, input } = await seed(), planned = commit(s, input), f = fresh(planned);
    const outside = structuredClone(f.kernel.snapshot.files.at(-1)!); outside.id = 'outside-file'; outside.path!.segments = ['another', 'folder', 'ordinary.md'];
    f.kernel.snapshot.files = [...f.kernel.snapshot.files, outside]; f.caps.allowedTypeCount++;
    expect(attempt(planned, { type: 'admit-plan', planHash: planned.plans[0]!.plan.planHash, runId: 'run', fresh: f }).status).toBe('held');
  });
});

describe('effect observations and conservative capacity', () => {
  it('settles unused capacity only with bound evidence and then permanently refuses begin', async () => {
    const { s, input } = await seed(); const a = admit(commit(s, input)), c = a.caps.charges[0]!;
    const bad = evidence(c, NOW, 'not-removed'); bad.reservationHash = H;
    expect(attempt(a, { type: 'settle-unused', reservationId: c.id, evidence: bad }).status).toBe('held');
    const settled = next(a, { type: 'settle-unused', reservationId: c.id, evidence: evidence(c, NOW, 'not-removed') });
    expect(settled.caps.charges[0]!.state).toBe('not-removed');
    expect(attempt(settled, { type: 'admission', capacityEvidence: null, command: { type: 'begin-effect', binding: settled.admission.pending!.binding, kind: 'movement', effectId: 'move', itemId: 'f0' } }).status).toBe('held');
  });
  it('retains unknown effect and full charge, blocking every following effect until reconciliation', async () => {
    const { s, input } = await seed(), a = observe(begin(admit(commit(s, input))), 'unknown');
    const p = projectCapHistory(a.caps, NOW); if (p.status !== 'projected') throw Error('projection'); expect(p.history.outstanding).toHaveLength(1);
    for (const kind of ['recovery', 'restore', 'pointer'] as const) expect(attempt(a, { type: 'admission', capacityEvidence: null,
      command: { type: 'begin-effect', binding: a.admission.pending!.binding, effectId: kind, kind, itemId: null } }).status).toBe('held');
    expect(observe(a, 'not-removed').caps.charges[0]!.state).toBe('not-removed');
  });
  it('requires movement observation and cap evidence to agree exactly', async () => {
    const { s, input } = await seed(), a = begin(admit(commit(s, input))), c = a.caps.charges[0]!;
    const command = { type: 'observe-effect' as const, binding: a.admission.pending!.binding, effectId: 'move', state: 'settled' as const, observationHash: H };
    expect(attempt(a, { type: 'admission', command, capacityEvidence: null }).status).toBe('held');
    const proof = evidence(c, NOW, 'removed'); proof.effectId = 'other';
    expect(attempt(a, { type: 'admission', command, capacityEvidence: proof }).status).toBe('held');
    expect(attempt(a, { type: 'admission', command, capacityEvidence: evidence(c, NOW, 'unknown') }).status).toBe('held');
  });
  it('retains same-week removed history through restore, completion and quiet release without refund', async () => {
    const { s, input } = await seed(); let a = observe(begin(admit(commit(s, input))), 'removed');
    const before = capLedgerStateHash(a.caps), binding = a.admission.pending!.binding;
    a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'begin-effect', binding, effectId: 'restore', kind: 'restore', itemId: null } });
    a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'observe-effect', binding, effectId: 'restore', state: 'settled', observationHash: J } });
    a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'complete', binding } });
    a = read(a, NOW + 3000); a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'release', binding, quiet: quiet(a.admission) } });
    expect(capLedgerStateHash(a.caps)).toBe(before); expect(a.admission.closedRunIds).toEqual(['run']); expect(a.caps.charges[0]!.state).toBe('removed');
  });
  it('records truthful departure across a week boundary, keeps an explicit conservative charge and permits recovery', async () => {
    const before = Date.parse('2030-02-04T04:59:59Z'), after = before + 2000;
    const { s, input } = await seed(before); let a = begin(admit(commit(s, input))); const baselineBefore = digest(a.caps.weeks);
    expect(localIsoWeek(before, a.caps.timezone).week).not.toBe(localIsoWeek(after, a.caps.timezone).week);
    a = observe(read(a, after), 'removed'); expect(a.caps.charges[0]!.evidence!.departureAtMs).toBe(after); expect(digest(a.caps.weeks)).toBe(baselineBefore);
    const binding = a.admission.pending!.binding;
    a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'begin-effect', binding, effectId: 'recovery', kind: 'recovery', itemId: null } });
    a = next(a, { type: 'admission', capacityEvidence: null, command: { type: 'observe-effect', binding, effectId: 'recovery', state: 'settled', observationHash: J } });
    a = next(a, { type: 'cover-calendar', evidence: { state: 'verified', priorStateHash: capLedgerStateHash(a.caps), throughMs: after, receiptHash: H } });
    const p = projectCapHistory(a.caps, after); if (p.status !== 'projected') throw Error('projection');
    expect(p.unresolvedPeriodDepartures).toEqual([a.caps.charges[0]!.id]); expect(p.history.outstanding[0]!.state).toBe('possibly-removed');
    expect(p.history.weeks.at(-1)!.baseline).toBeNull(); expect(p.history.weeks.at(-1)!.removals).toHaveLength(0);
    expect(capTry(a.caps, { type: 'settle', reservationId: a.caps.charges[0]!.id, evidence: evidence(a.caps.charges[0]!, after, 'not-removed') }).status).toBe('held');
  });
  it('holds not-yet-begun movement after the local week boundary while allowing unused reconciliation', async () => {
    const before = Date.parse('2030-02-04T04:59:59Z'), { s, input } = await seed(before), a = read(admit(commit(s, input)), before + 2000);
    expect(attempt(a, { type: 'admission', capacityEvidence: null, command: { type: 'begin-effect', binding: a.admission.pending!.binding,
      effectId: 'move', kind: 'movement', itemId: 'f0' } }).status).toBe('held');
    const c = a.caps.charges[0]!; expect(attempt(a, { type: 'settle-unused', reservationId: c.id, evidence: evidence(c, a.observedAtMs, 'not-removed') }).status).toBe('proposed');
  });
  it('holds a new movement after goal expiry while keeping truthful no-departure observation possible', async () => {
    const { s, input } = await seed(); input.kernel.goal.expiresAtMs = NOW + 1000;
    const admitted = admit(commit(s, input)), begun = begin(admitted), later = read(admitted, NOW + 1000);
    expect(attempt(later, { type: 'admission', capacityEvidence: null, command: { type: 'begin-effect', binding: later.admission.pending!.binding,
      effectId: 'move', kind: 'movement', itemId: 'f0' } }).status).toBe('held');
    expect(observe(read(begun, NOW + 1000), 'not-removed').caps.charges[0]!.state).toBe('not-removed');
  });
  it('rejects missing charge or run membership and never treats a pure proposal as an effect permit', async () => {
    const { s, input } = await seed(), a = admit(commit(s, input));
    const missing = structuredClone(a); missing.caps.charges = []; expect(validateCoupledSnapshot(missing, NOW).status).toBe('held');
    const omitted = structuredClone(a); omitted.runs = []; expect(validateCoupledSnapshot(omitted, NOW).status).toBe('held');
    for (const result of [validateCoupledSnapshot(a, NOW), attempt(s, { type: 'commit-plan', input, authorityHash: J }), validateCoupledSnapshot({}, NOW)]) {
      expect(result.authorizesEffects).toBe(false); expect(result.effect).toBe('none');
    }
  });
});
