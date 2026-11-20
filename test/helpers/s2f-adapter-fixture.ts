import { MemoryInventorySource } from '../../packages/core/src/inventory/memory-source.ts';
import { runInventory } from '../../packages/core/src/inventory/inventory.ts';
import type { CollectorContext, CollectorPorts } from '../../packages/core/src/focus/collect-kernel-inputs.ts';
import type { PathSnapshot, ScopeId } from '../../packages/core/src/fs/fs.ts';
import sweepCases from '../../fixtures/reference/sweep-protection.cases.json' with { type: 'json' };
type Mutable<T> = T extends string | number | bigint | boolean | null ? T : { -readonly [K in keyof T]: Mutable<T[K]> };

export const NOW = Date.parse('2030-01-29T00:00:00Z'), OLD = Date.parse('2029-01-01T00:00:00Z');
export const ticks = (ms: number) => BigInt(ms) * 10000n + 116444736000000000n;
export async function fixture(withReport = false, nestedName = 'example.md') {
  const source = new MemoryInventorySource();
  const oldIso = new Date(OLD).toISOString(), time = { modified: oldIso, changed: oldIso, created: oldIso };
  source.seedFile('vault/project/zqcanary7.md', 'Synthetic ordinary note.', { times: time });
  source.seedFile(`vault/project/notes/${nestedName}`, 'Synthetic candidate.', { times: time });
  source.seedFile('vault/kept.md', 'Synthetic kept source.', { times: time });
  const report = sweepCases.cases.find(row => row.id === 'older-adjudicated-report-not-protective')!.input;
  if (withReport) source.seedFile('vault/project/UNDERSTUDY.md', report.understudyText!, { times: time });
  const inventory = await runInventory(source, { roots: [{ id: 'vault', path: 'vault', sets: ['vault', 'fleet'] }],
    policy: { codeTypes: ['.ts'], commonStems: [], fleet: { textExt: ['.md'], ignoreDirs: [], maxBytes: 65536 }, targetFolder: 'vault/project' },
    mode: 'full', now: new Date(NOW).toISOString() });
  const hash = 'a'.repeat(64), goalHash = 'b'.repeat(64), scope = 'synthetic-scope' as ScopeId;
  const c: CollectorContext = { snapshot: { id: 'snapshot', capturedAtMs: NOW, complete: true, phase: 'plan' }, scope,
    folder: { id: 'folder', deviceId: 'device', drive: 'D:', segments: ['vault', 'project'], rootFileId: 'root', volumeSerial: 'SYNTH-VOL',
      mappingHash: 'd'.repeat(64), registryComplete: true, registeredInOrrery: false, obsidianSyncEnabled: false }, virtualFolder: 'vault/project',
    goalRev: { state: 'approved', hash: goalHash, policyHash: hash, folderId: 'folder', deviceId: 'device', issuedAtMs: NOW - 86400000,
      expiresAtMs: NOW + 86400000, superseded: false, conflicting: false },
    policy: { state: 'accepted', hash, folderId: 'folder', deviceId: 'device', enabled: true, types: ['.md'], editGraceDays: 14,
      restoreProtectWeeks: 8, linkGuard: 'strict', gitMode: 'never', nameMentions: 'ask', syncReplicated: 'unknown', timezone: 'UTC',
      registryComplete: true, personaHomes: [], deniedSegments: ['denied'], understudyProjectLabels: ['sample-project'] },
    inventory, pins: inventory.files.map(file => ({ path: file.path, value: { complete: true, kinds: [] } })),
    history: inventory.files.map(file => ({ path: file.path, value: { ...file.identity!, firstSeenAtPathMs: OLD, restore: { historyComplete: true, latestAtMs: 'never' } } })),
    currentContent: inventory.files.map(file => ({ path: file.path, value: { snapshotId: 'snapshot', ...file.identity!, sha256: 'c'.repeat(64),
      bytes: file.size!, mtimeMs: OLD, changeTimeMs: OLD, creationMs: OLD } })),
    reservations: inventory.files.map(file => ({ path: file.path, value: { complete: true, reservations: 0, holds: 0, restores: 0,
      anotherProcessOpen: false, changedSinceGeneration: false } })),
    sourceFacts: inventory.files.map(file => ({ path: file.path, value: { hardPinned: file.path.endsWith('/UNDERSTUDY.md'), designated: false, approvedGoalMatched: false } })),
    referenceBinding: { snapshotId: 'snapshot', policyHash: hash, goalHash, exclusionsReceiptBound: true, changeTimeConformance: false },
    sweep: withReport ? { ...report, reportAbsentConfirmed: false, historyComplete: true, associationProven: true } : {
      sweepLogText: '', trustLedgerText: '{"adjudications":{}}', understudyText: null,
      reportAbsentConfirmed: true, historyComplete: true, associationProven: true }, integrationState: null };
  const inspections = new Map<string, Mutable<PathSnapshot>>();
  for (const file of inventory.files.filter(file => file.path.startsWith('vault/project/'))) {
    const relative = file.path.slice('vault/project/'.length).split('/');
    inspections.set(relative.join('/'), { path: { scope, segments: relative }, kind: 'file', identity: file.identity,
      parents: relative.map((_, i) => ({ segments: relative.slice(0, i), identity: { volumeSerial: 'SYNTH-VOL', fileId: i === 0 ? 'root' : `parent-${i}` } })),
      volumeKind: 'ntfs', supportedLocalVolume: true, hardLinks: 1, bytes: file.size, readOnly: false,
      times: { modified: ticks(OLD), changed: ticks(OLD), created: ticks(OLD) }, anyReparseComponent: false });
  }
  const ports: CollectorPorts = { fs: { inspect: async path => {
    const value = inspections.get(path.segments.join('/'));
    return value ? { ok: true, value } : { ok: false, code: 'not-found', effect: 'none' };
  } }, git: { tracking: () => 'untracked' }, clock: { nowMs: () => NOW }, timeEncoding: 'windows-filetime-100ns',
    catalog: { custodySnapshot: async () => inventory.files.map(file => ({ path: file.path,
      value: { classRemovable: true, verified: true, versionId: 'synthetic-v1', currentSha256: 'c'.repeat(64), archivedSha256: 'c'.repeat(64) } })) } };
  return { c, ports, inspections, source };
}
