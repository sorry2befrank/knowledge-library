import { expect, it } from 'vitest';
import { eligible, type KernelInputs, type Snapshot, type SnapshotFile, type Policy } from '../packages/core/src/focus/kernel-adapter.ts';
import { collectKernelInputs, filetimeMilliseconds, sweepCutoff, validateSweepResult } from '../packages/core/src/focus/collect-kernel-inputs.ts';
import { eligible as originalKernel } from '../packages/core/src/focus/eligibility.ts';
import { fixture, NOW, OLD, ticks } from './helpers/s2f-adapter-fixture.ts';
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type TenArguments = Assert<Equals<Parameters<typeof eligible>, KernelInputs>>;
type SnapshotKeys = Assert<Equals<keyof Snapshot, 'nowMs' | 'phase' | 'id' | 'capturedAtMs' | 'complete' | 'folder' | 'files'>>;
type SnapshotFileKeys = Assert<Equals<keyof SnapshotFile, 'id' | 'kind' | 'path' | 'times' | 'location' | 'identity'>>;
type PolicyKeys = Assert<Equals<keyof Policy, 'state' | 'hash' | 'folderId' | 'deviceId' | 'enabled' | 'types' | 'editGraceDays' | 'restoreProtectWeeks' | 'linkGuard' | 'gitMode' | 'nameMentions' | 'syncReplicated' | 'timezone' | 'registryComplete' | 'personaHomes' | 'deniedSegments' | 'understudyProjectLabels'>>;

it('collects two eligible synthetic files and delegates unchanged to the existing eleven-rule kernel', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports), out = eligible(...inputs);
  expect(out.kernel.eligible).toHaveLength(2);
  expect(out.kernel).toEqual(originalKernel(out.input));
  expect(out.eligibilityProof).toEqual(out.kernel.items);
  expect(out.input.snapshot.files[0]!.times!.mtimeMs).toBe(OLD);
  expect(out.kernel.counts.byRule[6]).toEqual({ pass: 2, blocked: 0, unknown: 0 });
});
it.each(['missing', 'proposal', 'unknown'] as const)('reports goal-unapproved for %s while preserving real E=0', async state => {
  const { c, ports } = await fixture(); c.goalRev.state = state;
  const out = eligible(...await collectKernelInputs(c, ports));
  expect(out.status).toBe('goal-unapproved'); expect(out.kernel.eligible).toEqual([]);
});
it('expired and conflicting goals do not gain census approval', async () => {
  const { c, ports } = await fixture(); c.goalRev.expiresAtMs = NOW; c.goalRev.conflicting = true;
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.status).toBe('goal-unapproved'); expect(out.kernel.eligible).toEqual([]);
});
it('missing and duplicate per-file custody evidence stay unknown', async () => {
  const { c, ports } = await fixture(), input = await collectKernelInputs(c, ports);
  input[4] = []; expect(eligible(...input).kernel.counts.byRule[6].unknown).toBe(2);
  const original = await collectKernelInputs(c, ports); original[4] = [...original[4], ...original[4]];
  expect(eligible(...original).kernel.counts.byRule[6].unknown).toBe(2);
});
it('unknown registry and persona-home classification protect', async () => {
  const { c, ports } = await fixture(); c.policy.registryComplete = null;
  const out = eligible(...await collectKernelInputs(c, ports));
  expect(out.kernel.eligible).toEqual([]); expect(out.kernel.counts.byRule[2].unknown).toBe(2); expect(out.kernel.counts.byRule[8].unknown).toBe(2);
});
it('persona home covers nested special files with drive/NFC/case matching but not siblings or ordinary notes', async () => {
  const { c, ports } = await fixture(false, 'CORRECTIONS.md');
  c.folder.segments = ['Vaúlt', 'project'];
  c.policy.personaHomes = [{ drive: 'd:', segments: ['VAU\u0301LT', 'PROJECT'] }];
  let out = eligible(...await collectKernelInputs(c, ports));
  const nested = out.input.snapshot.files.find(file => file.path?.segments.at(-1) === 'CORRECTIONS.md')!;
  const ordinary = out.input.snapshot.files.find(file => file.path?.segments.at(-1) === 'zqcanary7.md')!;
  expect(out.eligibilityProof[nested.id]![2].codes).toContain('hard-pinned');
  expect(out.kernel.eligible).not.toContain(nested.id); expect(out.kernel.eligible).toContain(ordinary.id);
  for (const home of [{ drive: 'E:', segments: ['Vaúlt', 'project'] }, { drive: 'D:', segments: ['Vaúlt', 'project-other'] }]) {
    c.policy.personaHomes = [home]; out = eligible(...await collectKernelInputs(c, ports));
    expect(out.kernel.eligible).toContain(nested.id); expect(out.kernel.eligible).toContain(ordinary.id);
  }
});
it.each(['unknown', 'failed', 'wrong-path', 'missing-parents'] as const)('inspect %s remains protective', async scenario => {
  const { c, ports, inspections } = await fixture();
  if (scenario === 'unknown') for (const observed of inspections.values()) observed.times.changed = null;
  if (scenario === 'failed') ports.fs.inspect = async () => ({ ok: false, code: 'io-error', effect: 'none' });
  if (scenario === 'wrong-path') for (const observed of inspections.values()) observed.path = { ...observed.path, segments: ['wrong.md'] };
  if (scenario === 'missing-parents') for (const observed of inspections.values()) observed.parents = [];
  expect(eligible(...await collectKernelInputs(c, ports)).kernel.eligible).toEqual([]);
});
it('converts known FILETIME upward and protects unknown, pre-epoch and overflow counters', () => {
  expect(filetimeMilliseconds(ticks(OLD) + 1n, 'windows-filetime-100ns')).toBe(OLD + 1);
  for (const value of [null, 0n, ticks(Number.MAX_SAFE_INTEGER) + 1n]) expect(filetimeMilliseconds(value, 'windows-filetime-100ns')).toBeNull();
  expect(filetimeMilliseconds(ticks(OLD), 'unknown')).toBeNull();
});
it('an unknown time encoding cannot age the files into eligibility', async () => {
  const { c, ports } = await fixture(); ports.timeEncoding = 'unknown';
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.counts.byRule[3].unknown).toBe(2); expect(out.kernel.eligible).toEqual([]);
});
it('same-size/mtime preserved changes and volume/identity drift are active work', async () => {
  for (const mutate of [(o: Awaited<ReturnType<typeof fixture>>['inspections'] extends Map<string, infer T> ? T : never) => { o.times.changed = ticks(OLD + 1); },
    (o: Awaited<ReturnType<typeof fixture>>['inspections'] extends Map<string, infer T> ? T : never) => { o.identity = { volumeSerial: 'changed', fileId: o.identity!.fileId }; }]) {
    const { c, ports, inspections } = await fixture(); for (const observed of inspections.values()) mutate(observed);
    const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.eligible).toEqual([]); expect(out.kernel.counts.byReason['active-work']).toBe(2);
  }
});
it('open holds/reservations/restores and git-unknown cannot be dropped by composition', async () => {
  const { c, ports } = await fixture(); c.reservations = c.reservations.map(row => ({ ...row, value: { ...row.value!, holds: 1, restores: 1, reservations: 1 } }));
  ports.git.tracking = () => 'git-unknown';
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.counts.byRule[10].blocked).toBe(2); expect(out.kernel.counts.byRule[5].unknown).toBe(2);
});
it('missing custody snapshot and unreadable git port remain unknown', async () => {
  const { c, ports } = await fixture(); ports.catalog.custodySnapshot = async () => { throw new Error('synthetic unavailable'); }; ports.git.tracking = () => { throw new Error('synthetic unreadable'); };
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.counts.byRule[6].unknown).toBe(2); expect(out.kernel.counts.byRule[5].unknown).toBe(2);
});
it('archive claims cannot substitute for independently bound current-byte snapshot evidence', async () => {
  for (const kind of ['missing', 'wrong-snapshot', 'wrong-id', 'wrong-size', 'wrong-time', 'wrong-hash']) {
    const { c, ports } = await fixture();
    if (kind === 'missing') c.currentContent = [];
    else c.currentContent = c.currentContent.map(row => ({ ...row, value: { ...row.value,
      ...(kind === 'wrong-snapshot' ? { snapshotId: 'stale' } : kind === 'wrong-id' ? { fileId: 'changed' } : kind === 'wrong-size' ? { bytes: 99 } : kind === 'wrong-time' ? { changeTimeMs: NOW } : { sha256: 'e'.repeat(64) }) } }));
    const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.eligible).toEqual([]);
    expect(out.kernel.counts.byRule[6].blocked + out.kernel.counts.byRule[6].unknown).toBe(2);
  }
});
it('first-seen and restore history belongs to the inspected identity', async () => {
  const { c, ports } = await fixture(); c.history = c.history.map(row => ({ ...row, value: { ...row.value, fileId: 'previous-file-at-path' } }));
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.eligible).toEqual([]); expect(out.kernel.counts.byRule[3].unknown).toBe(2); expect(out.kernel.counts.byRule[4].unknown).toBe(2);
});
it('unpinned fleet extraction settings cannot establish full coverage', async () => {
  const { c, ports } = await fixture(); c.inventory.generation.flags.push('fleet-exclusions-unpinned');
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.eligible).toEqual([]); expect(out.kernel.globalHolds).toContain('coverage-incomplete');
});
it('known older adjudicated report receives B inventory pins beyond parser protectedTargets', async () => {
  const { c, ports } = await fixture(true), inputs = await collectKernelInputs(c, ports);
  expect(inputs[3].sweep.format).toBe('known'); expect(inputs[3].sweep.protectedIds.length).toBeGreaterThan(0);
  expect(eligible(...inputs).kernel.counts.byReason['sweep-protected']).toBeGreaterThan(0);
});
it('A remains held: raw prose preamble blocks all candidates and B cannot clear it', async () => {
  const { c, ports } = await fixture(true); c.sweep.understudyText = 'Producer prose preamble.\n' + c.sweep.understudyText;
  const inputs = await collectKernelInputs(c, ports), out = eligible(...inputs);
  expect(inputs[3].parserReasonCodes).toContain('report-preamble-unrecognized');
  expect(inputs[3].sweep.protectedIds.length).toBeGreaterThan(0);
  expect(out.kernel.eligible).toEqual([]);
  for (const proof of Object.values(out.kernel.items)) expect(proof[2].codes).toContain('adjudication-unknown');
});
it.each([{ labels: [] }, { labels: ['sample-project', 'sample-project'] }])('missing/non-unique project labels hold the whole folder', async ({ labels }) => {
  const { c, ports } = await fixture(); c.policy.understudyProjectLabels = labels;
  expect(eligible(...await collectKernelInputs(c, ports)).kernel.counts.byReason['adjudication-unknown']).toBe(2);
});
it('unknown parser results and invalid local timezone never become known', () => {
  for (const value of [null, {}, { status: 'known', blockEveryCandidate: true, reasonCodes: [], protectedTargets: [], protectedReports: [] }]) expect(validateSweepResult(value)).toBeNull();
  expect(sweepCutoff(NOW + 59_999, 'America/New_York')).toBe('2030-01-14 19:00'); expect(sweepCutoff(NOW, 'invalid/timezone')).toBeNull();
});
it('missing source facts, incomplete roots and unmapped references each stop completeness', async () => {
  for (const kind of ['source', 'root', 'reference']) {
    const { c, ports } = await fixture();
    if (kind === 'source') c.sourceFacts = [];
    if (kind === 'root') c.inventory.generation.roots[0]!.complete = false;
    if (kind === 'reference') c.inventory.references.push({ id: 'missing', source: 'vault/kept.md', target: null, kind: 'unresolved', token: 'missing' });
    const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.eligible).toEqual([]); expect(out.kernel.globalHolds).toContain('coverage-incomplete');
  }
});
it('Obsidian open, last-open and bookmark references become hard pins', async () => {
  for (const detail of ['open-leaf', 'last-open', 'bookmark'] as const) {
    const { c, ports } = await fixture(); c.inventory.references.push({ id: 'obsidian', source: 'vault/kept.md', target: 'vault/project/zqcanary7.md', kind: 'obsidian', detail, token: '' });
    const out = eligible(...await collectKernelInputs(c, ports)); expect(out.kernel.counts.byReason['hard-pinned']).toBe(1); expect(out.kernel.eligible).toHaveLength(1);
  }
});
it('ambiguous references expand every target before fixed-point closure', async () => {
  const { c, ports } = await fixture(); c.inventory.references.push({ id: 'ambiguous', source: 'vault/kept.md', target: null,
    kind: 'ambiguous', candidates: ['vault/project/zqcanary7.md', 'vault/project/notes/example.md'], token: 'ambiguous' });
  const out = eligible(...await collectKernelInputs(c, ports)); expect(out.input.references.edges).toHaveLength(2); expect(out.kernel.counts.byRule[7].blocked).toBe(2); expect(out.kernel.eligible).toEqual([]);
});
