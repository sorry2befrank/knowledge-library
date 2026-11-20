import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdmissionSnapshot, RunBinding, QuietEvidence } from '../../packages/core/src/focus/global-admission.ts';
import { digest } from '../../packages/core/src/focus/plan-data.ts';
export const NOW = 1_800_000_000_000, H = 'a'.repeat(64), G = 'b'.repeat(64);
export const folder = { folderId: 'synthetic-folder', deviceId: 'synthetic-device', rootFileId: 'synthetic-root', volumeSerial: 'synthetic-volume' };
export function initial(): AdmissionSnapshot { return { complete: true, revision: 0, observedAtMs: NOW,
  activePilot: { id: 'pilot', receiptHash: H, folder, authorityHash: G }, pending: null, closedRunIds: [] }; }
export function binding(runId = 'run'): RunBinding { return { runId, planHash: H, pilotId: 'pilot', pilotReceiptHash: H,
  folder, registered: false, capHistoryRevision: 5, authorityHash: G, plannedItems: ['item'] }; }
export function quiet(s: AdmissionSnapshot, nowMs: number): QuietEvidence {
  const p = s.pending!, at = p.completedAtMs!;
  return { complete: true, observedAtMs: nowMs, noLaterContradiction: true, bindingHash: digest(p.binding), effectRevision: p.effectRevision,
    effectsDigest: p.effectsDigest, budget: { state: 'verified', receiptHash: H, bindingHash: digest(p.binding), effectsDigest: p.effectsDigest, acceptedEvents: 5 },
    immediate: { capturedAtMs: at, observedEvents: 1, noNewProjects: true, noPortfolioRefusal: true, pinnedUntouched: true,
      zeroLibraryWritesInOrrery: true, folderScan: 'unchanged' },
    nightly: { id: 'nightly', scheduleHash: G, firstFollowingAfterMs: at, firstFollowingConfirmed: true, startedAtMs: at + 1,
      finishedAtMs: at + 2, capturedAtMs: at + 2, noHeldPathRipple: true, noPointerSourceRipple: true, noHeldPathCorrector: true } };
}
export function fixture(): string { return join(mkdtempSync(join(process.env.ADMISSION_TEST_ROOT ?? tmpdir(), 'admission-')), 'journal.sqlite'); }
