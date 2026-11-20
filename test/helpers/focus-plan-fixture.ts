import type { CapInput } from '../../packages/core/src/focus/plan-caps.ts';
import { overlappingWeeks } from '../../packages/core/src/focus/plan-caps.ts';
import type { PlanInput } from '../../packages/core/src/focus/plan.ts';
import type { AdmissionSnapshot, RunBinding, QuietEvidence } from '../../packages/core/src/focus/global-admission.ts';
import { digest, DAY } from '../../packages/core/src/focus/plan-data.ts';
import { fixture, NOW } from './s2f-adapter-fixture.ts';
import { collectKernelInputs } from '../../packages/core/src/focus/collect-kernel-inputs.ts';
import { eligible } from '../../packages/core/src/focus/kernel-adapter.ts';
export { NOW, DAY };
export const H = 'a'.repeat(64), G = 'b'.repeat(64), J = 'c'.repeat(64);
export const folder = { folderId: 'folder', deviceId: 'device', rootFileId: 'root', volumeSerial: 'SYNTH-VOL' };
export function capFixture(now = NOW, timezone = 'America/New_York'): CapInput {
  const weeks = overlappingWeeks(now, timezone);
  return { nowMs: now, folder: { ...folder }, allowedTypeCount: 6,
    calendar: { state: 'verified', timezone, bindingHash: J, policyHash: H, deviceId: folder.deviceId },
    policy: { hash: H, maxPerRun: 30, weeklyBasisPoints: 3000, trailingBasisPoints: 5000, rippleEventBudget: 100 },
    history: { complete: true, folder: { ...folder }, calendarBindingHash: J, revision: 5, observedAtMs: now, outstanding: [],
      weeks: weeks.map((week, i) => ({ week, baseline: { id: `baseline-${i}`, count: 100,
        frozenAtMs: now - (weeks.length - i - 1) * 7 * DAY }, removals: [] })) },
    pilot: { state: 'verified', id: 'pilot', folder: { ...folder }, receiptHash: G, startedAtMs: now - 30 * DAY,
      expiresAtMs: now + 30 * DAY, firstRemoval: 'complete', measuredGrowth: true, maxBatch: 30, maxRung: 3 },
    ripple: { state: 'verified', receiptHash: J, policyHash: H, pilotId: 'pilot', sourceHash: G, fixedEvents: 2, eventsPerItem: 2 } };
}
export async function planFixture(): Promise<PlanInput> {
  const { c, ports } = await fixture();
  const input = eligible(...await collectKernelInputs(c, ports)).input;
  const original = input.snapshot.files[0]!;
  input.snapshot.files = Array.from({ length: 6 }, (_, n) => {
    const f = structuredClone(original); f.id = `f${n}`; f.path!.segments = ['vault', 'project', `candidate-${n}.md`];
    f.identity!.fileId = f.identity!.snapshotFileId = `physical-${n}`; return f;
  });
  input.references.notes = [...input.snapshot.files.map(f => ({ id: f.id, hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: NOW - 200 * DAY })),
    { id: 'outside', hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: NOW - 200 * DAY }];
  input.references.edges = [];
  return { planId: 'plan', kernel: input, caps: capFixture(),
    controls: { state: 'verified', policyHash: H, goalHash: G, deviceId: 'device', folderId: 'folder', observedAtMs: NOW,
      policyEpoch: 1, goalEpoch: 2, approvalEpoch: 3, globalPaused: false, folderPaused: false, approvalFloor: 'none', standingMode: 'apply' },
    learner: { state: 'verified', version: 'v0', hash: H, retrievalHash: G, supersedeHash: J, threshold: 0.5 },
    featureSnapshotId: input.snapshot.id,
    features: input.snapshot.files.map((f, n) => ({ id: f.id, bm25: 1, linkDistance: null, daysSinceEdit: 200, daysSinceRead: 100,
      veiledInWindow: false, frozenReadDaysAtVeil: null, pastRestores: 0, status: 'ordinary', kindPrior: 1, perishability: 1,
      nameMentions: 0, score: [0.1, 0.2, 0.3, 0.6, 0.7, 0.8][n]! })), correctionExclusions: [],
    review: { atMs: NOW, rung: 0, ticks: ['f0'], unticks: [], batchReviewed: false, standing: null } };
}
export function binding(): RunBinding {
  return { runId: 'run', planHash: H, pilotId: 'pilot', pilotReceiptHash: G, folder: { ...folder }, registered: false,
    capHistoryRevision: 5, authorityHash: J, plannedItems: ['f0', 'f1'] };
}
export function snapshot(): AdmissionSnapshot {
  return { complete: true, revision: 0, observedAtMs: NOW, activePilot: { id: 'pilot', receiptHash: G, folder: { ...folder }, authorityHash: J }, pending: null, closedRunIds: [] };
}
export function quiet(s: AdmissionSnapshot, now = NOW + 3000): QuietEvidence {
  const p = s.pending!, completed = p.completedAtMs!;
  return { complete: true, observedAtMs: now, noLaterContradiction: true, bindingHash: digest(p.binding), effectRevision: p.effectRevision, effectsDigest: p.effectsDigest,
    budget: { state: 'verified', receiptHash: H, bindingHash: digest(p.binding), effectsDigest: p.effectsDigest, acceptedEvents: 5 },
    immediate: { capturedAtMs: completed, observedEvents: 4, noNewProjects: true, noPortfolioRefusal: true, pinnedUntouched: true,
      zeroLibraryWritesInOrrery: true, folderScan: p.binding.registered ? 'expected-needs-review' : 'unchanged' },
    nightly: { id: 'nightly', scheduleHash: J, firstFollowingAfterMs: completed, firstFollowingConfirmed: true,
      startedAtMs: completed + 1, finishedAtMs: completed + 2, capturedAtMs: completed + 2,
      noHeldPathRipple: true, noPointerSourceRipple: true, noHeldPathCorrector: true } };
}
