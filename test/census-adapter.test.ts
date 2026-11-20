import { expect, it } from 'vitest';
import { eligible } from '../packages/core/src/focus/kernel-adapter.ts';
import { collectKernelInputs } from '../packages/core/src/focus/collect-kernel-inputs.ts';
import { censusReport, censusLocalBlockers } from '../packages/core/src/focus/census.ts';
import { fixture } from './helpers/s2f-adapter-fixture.ts';

it('real zero-custody census reports all rule-six holds with no hypothetical label', async () => {
  const { c, ports } = await fixture(); ports.catalog.custodySnapshot = async () => [];
  const out = eligible(...await collectKernelInputs(c, ports)), report = censusReport(out);
  expect(report.json.eligible.value).toBe(0); expect(report.json.byRule[6]!.value.blocking).toBe(2);
  expect(report.json.variants).toHaveLength(8); expect(JSON.stringify(report).toLowerCase()).not.toContain('hypothetical');
});
it('shared reports omit local canary names, raw report text and paths while preserving only extension/depth', async () => {
  const { c, ports } = await fixture(), out = eligible(...await collectKernelInputs(c, ports));
  expect(JSON.stringify(out).toLowerCase()).toContain('zqcanary7');
  const report = censusReport(out); expect(JSON.stringify(report.json).toLowerCase()).not.toContain('zqcanary7'); expect(report.text.toLowerCase()).not.toContain('zqcanary7');
  expect(report.json.shapes.map(row => row.shape)).toEqual(['3 segments, .md', '4 segments, .md']);
  expect(report.json.admissionGuard).toBe('not-computed'); expect(report.json.veil).toBe('not-computed');
});
it('assumptions label each computed figure and never alter real kernel evidence', async () => {
  const { c, ports } = await fixture(); ports.catalog.custodySnapshot = async () => []; c.folder.registeredInOrrery = true;
  const out = eligible(...await collectKernelInputs(c, ports)), before = structuredClone(out);
  const report = censusReport(out, { rule6: { admittedIds: out.input.snapshot.files.map(file => file.id) }, liveIntegration: true });
  expect(report.json.assumptions.map(row => row.rule)).toEqual([6, 8]); expect(report.json.eligible.value).toBe(2);
  expect(report.json.eligible.hypothetical).toBe(true); expect(report.json.variants.every(row => row.eligible.hypothetical)).toBe(true);
  for (const row of Object.values(report.json.byRule)) expect(row.hypothetical).toBe(true);
  expect(report.json.shapes.every(row => row.count.hypothetical)).toBe(true); expect(out).toEqual(before); expect(out.kernel.eligible).toEqual([]);
});
it('a missing goal or registry stays blocked even under census custody/integration assumptions', async () => {
  const { c, ports } = await fixture(); c.goalRev.state = 'missing'; c.folder.registryComplete = null;
  const out = eligible(...await collectKernelInputs(c, ports));
  expect(censusReport(out, { rule6: { admittedIds: out.input.snapshot.files.map(file => file.id) }, liveIntegration: true }).json.eligible.value).toBe(0);
});
it('local blocker lists identify distinct affected candidates without entering shared output', async () => {
  const { c, ports } = await fixture();
  for (const kind of ['ripple', 'instruction'] as const) c.inventory.references.push({ id: kind, source: 'vault/kept.md', target: 'vault/project/zqcanary7.md', kind, token: '' });
  let out = eligible(...await collectKernelInputs(c, ports));
  expect(censusLocalBlockers(out).sources).toEqual([{ path: 'vault/kept.md', blockedCandidates: 1 }]);
  c.inventory.generation.readErrors.push({ root: 'vault', path: 'vault/zqcanary7-unreadable.md', code: 'unreadable' });
  out = eligible(...await collectKernelInputs(c, ports));
  expect(censusLocalBlockers(out).sources).toContainEqual({ path: 'vault/zqcanary7-unreadable.md', blockedCandidates: 2 });
  expect(JSON.stringify(censusReport(out)).toLowerCase()).not.toContain('zqcanary7');
  expect(censusReport(out).json.incomplete.value).toBe(2);
});
