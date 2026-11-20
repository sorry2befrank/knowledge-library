import fc from 'fast-check';
import type { KernelFile, KernelInput } from '../../packages/core/src/focus/eligibility.ts';
import { eligible, type KernelInputs } from '../../packages/core/src/focus/kernel-adapter.ts';
import sweepCases from '../../fixtures/reference/sweep-protection.cases.json' with { type: 'json' };

export const DAY = 86_400_000, NOW = Date.parse('2030-01-29T00:00:00.000Z'), OLD = NOW - 200 * DAY;
const HASH = 'a'.repeat(64), GOAL = 'b'.repeat(64), CONTENT = 'c'.repeat(64);
export const INPUT_CLASSES = ['mutual-groups', 'kept-references', 'ambiguous-paths', 'nested-git', 'dot-instructions',
  'same-size-same-time-edits', 'incomplete-roots', 'unknown-adjudication', 'hard-pinned-name-mentions', 'null-metadata',
  'case-nfc-nfd-location', 'format-known-sweep'] as const;
export interface World {
  input: KernelInput;
  withoutFeature: KernelInput;
  classes: (typeof INPUT_CLASSES)[number][];
  decisiveId: string;
  scenario: number;
  scores: number[];
  perturb: number;
}
function baseFile(i: number): KernelFile {
  return { id: `f${i}`, kind: 'file', path: { drive: 'D:', segments: ['vault', 'project', `file-${i}.md`], normalized: true },
    pins: { complete: true, kinds: [], personaHome: false }, times: { mtimeMs: OLD, changeTimeMs: OLD, creationMs: OLD, firstSeenAtPathMs: OLD },
    restore: { historyComplete: true, latestAtMs: 'never' }, git: { walkComplete: true, innermostResolved: true, state: 'untracked' },
    custody: { classRemovable: true, verified: true, versionId: `v${i}`, currentSha256: CONTENT, archivedSha256: CONTENT },
    location: { rootFileId: 'root', deniedSegment: false },
    activity: { complete: true, reservations: 0, holds: 0, restores: 0, anotherProcessOpen: false, changedSinceGeneration: false },
    identity: { fileId: `fileid-${i}`, snapshotFileId: `fileid-${i}`, volumeSerial: 'volume', hardLinks: 1, parentsComplete: true, anyReparse: false, volumeKind: 'ntfs' } };
}
function base(count: number, stale: boolean, ask: boolean): KernelInput {
  return { nowMs: NOW, phase: 'plan', snapshot: { id: 'snapshot', capturedAtMs: NOW, complete: true, files: Array.from({ length: count }, (_, i) => baseFile(i)) },
    folder: { id: 'folder', deviceId: 'device', drive: 'D:', segments: ['vault', 'project'], rootFileId: 'root', volumeSerial: 'volume', mappingHash: 'd'.repeat(64), registryComplete: true, registeredInOrrery: false, obsidianSyncEnabled: false },
    policy: { state: 'accepted', hash: HASH, folderId: 'folder', deviceId: 'device', enabled: true, types: ['.md'], editGraceDays: 14,
      restoreProtectWeeks: 8, linkGuard: stale ? 'stale-sources' : 'strict', gitMode: 'never', nameMentions: ask ? 'ask' : 'allow', syncReplicated: 'unknown' },
    goal: { state: 'approved', hash: GOAL, policyHash: HASH, folderId: 'folder', deviceId: 'device', issuedAtMs: NOW - DAY, expiresAtMs: NOW + DAY, superseded: false, conflicting: false },
    references: { id: 'references', snapshotId: 'snapshot', policyHash: HASH, goalHash: GOAL, complete: true, rootsComplete: true, unresolvedReadErrors: 0, skippedUnexcluded: 0,
      exclusionsRecorded: true, exclusionsReceiptBound: true, readMode: 'full', readAtMs: NOW, lastFullReadAtMs: NOW, changeTimeConformance: false,
      notes: [...Array.from({ length: count }, (_, i) => `f${i}`), 'kept', 'dot-codex-instruction'].map(id => ({ id, hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: id === 'kept' ? NOW - DAY : OLD })), edges: [] },
    sweep: { folderId: 'folder', snapshotId: 'snapshot', format: 'known', history: 'complete', association: 'proven', adjudication: 'known', wholeFolderHeld: false, protectedIds: [] }, integration: null };
}
function edge(id: string, source: string, target: string, kind: KernelInput['references']['edges'][number]['kind']) { return { id, source, target, kind }; }
interface Parameters { scenario: number; count: number; stale: boolean; ask: boolean; variant: number; scores: number[]; perturb: number }
function makeWorld(p: Parameters): World {
  const input = base(p.count, p.stale, p.ask), clean = structuredClone(input), a = input.snapshot.files[0]!;
  const classes: World['classes'] = [], references = input.references;
  let decisiveId = 'f0';
  switch (p.scenario) {
    case 0: break;
    case 1: a.kind = 'directory'; break;
    case 2: a.pins!.kinds = ['goal']; break;
    case 3: a.times!.changeTimeMs = NOW - p.variant; classes.push('same-size-same-time-edits'); break;
    case 4: a.restore!.latestAtMs = NOW - p.variant; break;
    case 5: a.path!.segments = ['vault', 'project', 'nested-repo', 'file-0.md']; a.git!.state = 'tracked'; classes.push('nested-git'); break;
    case 6: a.custody!.archivedSha256 = 'e'.repeat(64); break;
    case 7: references.edges = [edge('kept-link', 'kept', 'f0', 'link')]; classes.push('kept-references'); break;
    case 8:
      if (p.variant % 2 === 0) a.path = { drive: 'd:', segments: ['OrReRy', 'project', 'file-0.md'], normalized: true };
      else { a.path!.segments = ['VAULT', 'project', p.variant % 3 ? 'de\u0301nie\u0301d' : 'DÉNIÉD', 'file-0.md']; a.location!.deniedSegment = true; }
      classes.push('case-nfc-nfd-location'); break;
    case 9: references.edges = [edge('fleet', 'kept', 'f0', 'ripple')]; break;
    case 10: a.activity!.reservations = 1 + p.variant; break;
    case 11: a.identity!.hardLinks = 2; break;
    case 12:
      references.edges = [edge('kept-link', 'kept', 'f0', 'path'), edge('ab', 'f0', 'f1', 'link'), edge('ba', 'f1', 'f0', 'link')];
      // Removing only the mutual-group edges frees f1; the original kept reference remains.
      clean.references.edges = [edge('kept-link', 'kept', 'f0', 'path')];
      classes.push('mutual-groups'); decisiveId = 'f1'; break;
    case 13: references.edges = [edge('ambiguous-a', 'kept', 'f0', 'ambiguous'), edge('ambiguous-b', 'kept', 'f1', 'ambiguous')]; classes.push('ambiguous-paths'); break;
    case 14: references.edges = [edge('instruction', 'dot-codex-instruction', 'f0', 'instruction')]; classes.push('dot-instructions'); break;
    case 15: references.rootsComplete = false; classes.push('incomplete-roots'); break;
    case 16: input.sweep.adjudication = 'unknown'; classes.push('unknown-adjudication'); break;
    case 17: references.notes.find(note => note.id === 'kept')!.hardPinned = true; references.edges = [edge('pinned-name', 'kept', 'f0', 'name')]; classes.push('hard-pinned-name-mentions'); break;
    case 18:
      if (p.variant % 3 === 0) a.times!.creationMs = null;
      else if (p.variant % 3 === 1) a.identity!.anyReparse = null;
      else a.identity!.volumeKind = 'unknown';
      classes.push('null-metadata'); break;
    case 19: {
      const knownCases = sweepCases.cases.filter(row => row.expected.status === 'known' && row.expected.protectedTargets.length === 1);
      const known = knownCases[p.variant % knownCases.length]!;
      if (known.expected.status !== 'known' || known.expected.protectedTargets.length !== 1) throw new Error('known-fixture-contract-drift');
      a.path!.segments = ['vault', 'project', ...known.expected.protectedTargets[0]!.split('/')];
      input.sweep.protectedIds = ['f0']; classes.push('format-known-sweep'); break;
    }
    case 20: a.activity!.holds = 1; references.edges = [edge('held-candidate', 'f0', 'f1', 'path')]; break;
    case 21: a.git!.walkComplete = false; a.git!.state = 'unknown'; break;
    case 22: references.edges = [edge('ordinary-name', 'kept', 'f0', 'name')]; break;
    case 23: references.edges = [edge('ab', 'f0', 'f1', 'link'), edge('ba', 'f1', 'f0', 'link')]; classes.push('mutual-groups'); break;
  }
  return { input, withoutFeature: clean, classes, decisiveId, scenario: p.scenario, scores: p.scores.slice(0, p.count), perturb: p.perturb };
}
export const worldArbitrary = fc.record({ scenario: fc.integer({ min: 0, max: 23 }), count: fc.integer({ min: 3, max: 8 }),
  stale: fc.boolean(), ask: fc.boolean(), variant: fc.integer({ min: 0, max: 9 }), scores: fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 8, maxLength: 8 }),
  perturb: fc.integer({ min: 0, max: 11 }) }).map(makeWorld);

export function tenInputs(input: KernelInput): KernelInputs {
  const files = input.snapshot.files.map(({ pins, custody, restore, git, activity, ...file }) => file);
  return [{ nowMs: input.nowMs, phase: input.phase, ...input.snapshot, folder: input.folder, files }, input.goal,
    { ...input.policy, timezone: 'UTC', registryComplete: true, personaHomes: [], deniedSegments: [], understudyProjectLabels: ['synthetic'] },
    { files: input.snapshot.files.map(file => ({ id: file.id, value: file.pins })), sweep: input.sweep, parserReasonCodes: [] },
    input.snapshot.files.map(file => ({ id: file.id, value: file.custody })), input.snapshot.files.map(file => ({ id: file.id, value: file.restore })),
    input.snapshot.files.map(file => ({ id: file.id, value: file.git })), { ...input.references, localSources: [], unreadableSources: [] },
    input.snapshot.files.map(file => ({ id: file.id, value: file.activity })), input.integration];
}
export const evaluate = (input: KernelInput) => eligible(...tenInputs(input)).kernel;
export function protectiveChange(original: KernelInput, variant: number, targetId?: string): KernelInput {
  const input = structuredClone(original), target = targetId ?? input.snapshot.files.at(-1)!.id, file = input.snapshot.files.find(file => file.id === target)!;
  switch (variant % 12) {
    case 0: input.references.edges = [...input.references.edges, edge('fresh-kept-reference', 'kept', target, 'path')]; break;
    case 1: file.pins!.kinds = [...file.pins!.kinds, 'owner']; break;
    case 2: file.activity!.holds = 1; break;
    case 3: input.references.unresolvedReadErrors = 1; break;
    case 4: file.times!.changeTimeMs = null; break;
    case 5: file.identity!.anyReparse = null; break;
    case 6: input.sweep.adjudication = 'unknown'; break;
    case 7: file.git!.walkComplete = false; file.git!.state = 'unknown'; break;
    case 8: input.references.rootsComplete = false; break;
    case 9: file.identity!.hardLinks = null; break;
    case 10: file.identity!.volumeSerial = null; break;
    case 11: file.times!.changeTimeMs = NOW; break;
  }
  return input;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
