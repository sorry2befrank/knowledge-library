// DESIGN §6.2 / §6.5 / §6.7. Frozen, reproducible proposals; neither approval nor apply authority.
import { eligible, closeKernelProposal, type KernelInput } from './eligibility.ts';
import { calculateCaps, sameFolder, type CapInput, type CapValue } from './plan-caps.ts';
import { DAY, count, dataCopy, digest, errorCode, finite, freeze, hash, id, insist, keys, time, uniqueIds } from './plan-data.ts';

export interface FrozenFeatures {
  id: string; bm25: number; linkDistance: number | null; daysSinceEdit: number; daysSinceRead: number;
  veiledInWindow: boolean; frozenReadDaysAtVeil: number | null; pastRestores: number;
  status: string; kindPrior: number; perishability: number; nameMentions: number; score: number;
}
export interface PlanControls {
  state: 'verified'; policyHash: string; goalHash: string; deviceId: string; folderId: string; observedAtMs: number;
  policyEpoch: number; goalEpoch: number; approvalEpoch: number; globalPaused: boolean; folderPaused: boolean;
  approvalFloor: 'none' | 'item' | 'batch'; standingMode: 'apply' | 'veto-24h';
}
export interface StandingEvidence {
  state: 'verified'; receiptHash: string; folderId: string; deviceId: string; policyHash: string; goalHash: string;
  capPolicyHash: string; approvalEpoch: number; expiresAtMs: number; names: 'ask' | 'allow'; mode: 'apply' | 'veto-24h';
  publishedDraftHash: string | null; publishedAtMs: number | null; vetoClearThroughMs: number | null;
}
export interface PlanReview {
  atMs: number; rung: 0 | 1 | 2 | 3; ticks: readonly string[]; unticks: readonly string[]; batchReviewed: boolean;
  standing: StandingEvidence | null;
}
export interface PlanInput {
  planId: string; kernel: KernelInput; caps: CapInput; controls: PlanControls;
  learner: { state: 'verified'; version: string; hash: string; retrievalHash: string; supersedeHash: string; threshold: number };
  featureSnapshotId: string; features: readonly FrozenFeatures[];
  correctionExclusions: readonly string[]; review: PlanReview;
}
export interface FrozenPlan {
  schema: 'focus-plan-proposal/v1'; planId: string; planHash: string; draftHash: string; inputHash: string;
  refGeneration: string; effectiveCap: number; caps: CapValue; frozenInput: PlanInput;
  eligible: readonly string[]; proposed: readonly string[]; probes: readonly string[]; reviewed: readonly string[];
  itemReasons: Readonly<Record<string, readonly string[]>>;
}
export type PlanResult =
  | { status: 'planned'; plan: FrozenPlan; effect: 'none'; authorizesEffects: false; releaseHolds: readonly string[] }
  | { status: 'refused'; reasons: readonly string[]; effect: 'none'; authorizesEffects: false };

function validateReview(r: PlanReview, x: PlanInput, draftHash: string, offered: readonly string[]): void {
  keys(r, 'atMs rung ticks unticks batchReviewed standing'); uniqueIds(r.ticks, 32); uniqueIds(r.unticks, 32);
  insist(time(r.atMs) && r.atMs >= x.kernel.nowMs && count(r.rung, 3) && typeof r.batchReviewed === 'boolean' && r.ticks.every(v => offered.includes(v))
    && r.unticks.every(v => offered.includes(v)) && !r.ticks.some(v => r.unticks.includes(v)), 'review-invalid');
  if (r.rung < 2) { insist(r.standing === null && (r.rung !== 0 || r.batchReviewed === false), 'review-invalid'); return; }
  const s = r.standing; insist(s !== null && r.batchReviewed === false, 'review-invalid');
  keys(s, 'state receiptHash folderId deviceId policyHash goalHash capPolicyHash approvalEpoch expiresAtMs names mode publishedDraftHash publishedAtMs vetoClearThroughMs');
  insist(s.state === 'verified' && hash(s.receiptHash) && s.folderId === x.kernel.folder.id && s.deviceId === x.kernel.folder.deviceId
    && s.policyHash === x.kernel.policy.hash && s.goalHash === x.kernel.goal.hash && s.capPolicyHash === digest(x.caps.policy)
    && s.approvalEpoch === x.controls.approvalEpoch && time(s.expiresAtMs) && s.expiresAtMs > r.atMs
    && s.names === x.kernel.policy.nameMentions && s.mode === x.controls.standingMode, 'review-invalid');
  if (s.mode === 'veto-24h') insist(s.publishedDraftHash === draftHash && time(s.publishedAtMs)
    && s.publishedAtMs >= x.kernel.nowMs && s.publishedAtMs <= r.atMs - DAY && s.vetoClearThroughMs === r.atMs, 'review-invalid');
  else insist(s.publishedDraftHash === null && s.publishedAtMs === null && s.vetoClearThroughMs === null, 'review-invalid');
}

export function buildFocusPlan(raw: PlanInput): PlanResult {
  try {
    const x = dataCopy(raw); keys(x, 'planId kernel caps controls learner featureSnapshotId features correctionExclusions review');
    insist(id(x.planId) && x.kernel.phase === 'plan');
    const k = eligible(x.kernel); insist(k.evaluation === 'evaluated' && k.globalHolds.length === 0, 'plan-held');
    const folder = { folderId: x.kernel.folder.id, deviceId: x.kernel.folder.deviceId, rootFileId: x.kernel.folder.rootFileId, volumeSerial: x.kernel.folder.volumeSerial };
    insist(sameFolder(folder, x.caps.folder) && x.caps.nowMs === x.kernel.nowMs && x.caps.policy.hash === x.kernel.policy.hash);
    const c = x.controls; keys(c, 'state policyHash goalHash deviceId folderId observedAtMs policyEpoch goalEpoch approvalEpoch globalPaused folderPaused approvalFloor standingMode');
    insist(c.state === 'verified' && c.policyHash === x.kernel.policy.hash && c.goalHash === x.kernel.goal.hash
      && c.deviceId === folder.deviceId && c.folderId === folder.folderId && c.observedAtMs === x.kernel.nowMs
      && count(c.policyEpoch) && count(c.goalEpoch) && count(c.approvalEpoch) && c.globalPaused === false && c.folderPaused === false
      && ['none', 'item', 'batch'].includes(c.approvalFloor) && ['apply', 'veto-24h'].includes(c.standingMode), 'plan-held');
    // A count cannot silently omit unknown kinds/paths, even when they would be ineligible for removal.
    insist(x.kernel.snapshot.files.every(f => f.kind !== null && f.path?.normalized === true));
    const norm = (s: string) => s.normalize('NFC').toLowerCase();
    insist(x.kernel.snapshot.files.every(f => norm(f.path!.drive) === norm(x.kernel.folder.drive)
      && f.path!.segments.length > x.kernel.folder.segments.length
      && x.kernel.folder.segments.every((part, i) => norm(part) === norm(f.path!.segments[i]!))
      && f.location?.rootFileId === folder.rootFileId && f.identity?.volumeSerial === folder.volumeSerial));
    const allowed = x.kernel.snapshot.files.filter(f => f.kind === 'file' && x.kernel.policy.types.some(ext =>
      f.path!.segments.at(-1)!.toLowerCase().endsWith(ext.toLowerCase()))).map(f => f.id);
    const allowedIds = new Set(allowed);
    insist(allowed.length === x.caps.allowedTypeCount && x.featureSnapshotId === x.kernel.snapshot.id);
    const caps = calculateCaps(x.caps); insist(caps.status === 'calculated', caps.status === 'refused' ? caps.reasons[0] : 'input-invalid');
    const learner = x.learner; keys(learner, 'state version hash retrievalHash supersedeHash threshold');
    insist(learner.state === 'verified' && id(learner.version) && hash(learner.hash) && hash(learner.retrievalHash)
      && hash(learner.supersedeHash) && finite(learner.threshold));
    insist(Array.isArray(x.features) && x.features.length === allowed.length); uniqueIds(x.features.map(f => f.id));
    const namedSources = new Map<string, Set<string>>();
    for (const edge of x.kernel.references.edges) if (edge.kind === 'name' && edge.source !== edge.target) {
      const sources = namedSources.get(edge.target) ?? new Set<string>(); sources.add(edge.source); namedSources.set(edge.target, sources);
    }
    for (const f of x.features) {
      keys(f, 'id bm25 linkDistance daysSinceEdit daysSinceRead veiledInWindow frozenReadDaysAtVeil pastRestores status kindPrior perishability nameMentions score');
      insist(allowedIds.has(f.id) && [f.bm25, f.daysSinceEdit, f.daysSinceRead, f.kindPrior, f.perishability].every(v => finite(v) && v >= 0)
        && (f.linkDistance === null || count(f.linkDistance, 10000)) && count(f.pastRestores, 1000000) && id(f.status)
        && count(f.nameMentions, 100000) && f.nameMentions === (namedSources.get(f.id)?.size ?? 0) && finite(f.score)
        && typeof f.veiledInWindow === 'boolean');
      if (f.veiledInWindow) insist(finite(f.frozenReadDaysAtVeil) && f.frozenReadDaysAtVeil >= 0 && f.daysSinceRead === f.frozenReadDaysAtVeil);
      else insist(f.frozenReadDaysAtVeil === null);
    }
    uniqueIds(x.correctionExclusions); insist(x.correctionExclusions.every(v => allowedIds.has(v)));
    const excluded = new Set(x.correctionExclusions);
    const scores = new Map(x.features.map(f => [f.id, f.score]));
    const ranked = [...k.eligible].sort((a, b) => scores.get(a)! - scores.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    const close = (ids: readonly string[]) => {
      const result = closeKernelProposal(x.kernel, ids); insist(result.evaluation === 'evaluated' && result.globalHolds.length === 0, 'plan-held');
      const kept = new Set(result.eligible); return ids.filter(v => kept.has(v));
    };
    const capped = ranked.filter(v => scores.get(v)! < learner.threshold).slice(0, caps.value.effectiveCap);
    const proposed = close(close(capped).filter(v => !excluded.has(v)));
    const probes = ranked.filter(v => scores.get(v)! >= learner.threshold && !excluded.has(v)).slice(0, 2);
    // Publication/review receipts bind this immutable draft; review fields cannot create a hash cycle.
    const { review: _review, ...draftInput } = x;
    const draftHash = digest({ schema: 'focus-plan-draft/v1', input: draftInput, caps: caps.value, proposed, probes });
    validateReview(x.review, x, draftHash, [...proposed, ...probes]);
    const floor = c.approvalFloor === 'item' ? 0 : c.approvalFloor === 'batch' ? 1 : 3;
    insist(x.review.rung <= Math.min(floor, caps.value.maxRung), 'review-invalid');
    const ticks = new Set(x.review.ticks), unticks = new Set(x.review.unticks);
    const reviewedCandidates = [...proposed, ...probes].filter(v => {
      if (unticks.has(v)) return false;
      if (probes.includes(v) || x.review.rung === 0) return ticks.has(v);
      if (x.review.rung === 1 && !x.review.batchReviewed) return false;
      return true;
    });
    insist(reviewedCandidates.length <= caps.value.effectiveCap, 'review-invalid');
    let reviewed = close(reviewedCandidates);
    if (x.review.rung < 2 || x.kernel.policy.nameMentions !== 'allow') {
      // A kept source may create a new name-review obligation after exclusions or closure.
      // Iterate both narrowing rules; never reuse the larger E's mention counts.
      for (;;) {
        const proof = closeKernelProposal(x.kernel, reviewed);
        insist(proof.evaluation === 'evaluated' && proof.globalHolds.length === 0, 'plan-held');
        const next = close(reviewed.filter(v => (proof.nameMentionCounts[v] ?? 0) === 0 || ticks.has(v)));
        if (next.length === reviewed.length) break;
        reviewed = next;
      }
    }
    const itemReasons = Object.fromEntries(allowed.map(v => [v, reviewed.includes(v) ? [probes.includes(v) ? 'explicit-probe' : 'reviewed-proposal']
      : proposed.includes(v) ? ['awaiting-review-or-closure'] : ['kept']]));
    const body = { schema: 'focus-plan-proposal/v1' as const, planId: x.planId, draftHash, inputHash: digest(x),
      refGeneration: x.kernel.references.id, effectiveCap: caps.value.effectiveCap, caps: caps.value,
      frozenInput: x, eligible: k.eligible, proposed, probes, reviewed, itemReasons };
    return freeze({ status: 'planned', plan: { ...body, planHash: digest(body) }, effect: 'none', authorizesEffects: false,
      releaseHolds: ['scoped-review-receipt-verification', 'durable-cap-baseline-and-global-admission', 'fresh-apply-kernel-caps-and-preflight', 'native-movement-and-recovery-conformance'] });
  } catch (error) { return freeze({ status: 'refused', reasons: [errorCode(error)], effect: 'none', authorizesEffects: false }); }
}
