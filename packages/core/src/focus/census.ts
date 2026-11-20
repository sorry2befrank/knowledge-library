// Counts-only public projection. The local blocker function is intentionally separate.
import { eligible as evaluateKernel, type KernelInput, type KernelResult, type Rule } from './eligibility.ts';
import type { KernelOutput } from './kernel-adapter.ts';

export interface CensusAssumptions {
  // Admission is not computed here: a trusted caller must identify the admitted synthetic files.
  rule6?: { admittedIds: readonly string[] };
  liveIntegration?: true;
}
type Figure<T> = { value: T; hypothetical?: true };
function figure<T>(value: T, hypothetical: boolean): Figure<T> { return hypothetical ? { value, hypothetical: true } : { value }; }
const RULES: readonly Rule[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function forCensus(output: KernelOutput, assumptions: CensusAssumptions): KernelInput {
  // Ephemeral assumed facts are neither returned nor accepted by an apply API.
  const input = structuredClone(output.input);
  if (assumptions.rule6) for (const file of input.snapshot.files) if (assumptions.rule6.admittedIds.includes(file.id))
    file.custody = { classRemovable: true, verified: true, versionId: 'census-assumption',
      currentSha256: '0'.repeat(64), archivedSha256: '0'.repeat(64) };
  if (assumptions.liveIntegration && input.folder.registeredInOrrery === true) input.integration = {
    state: 'live-tested', folderId: input.folder.id, deviceId: input.folder.deviceId,
    rootFileId: input.folder.rootFileId, volumeSerial: input.folder.volumeSerial, policyHash: input.policy.hash,
    receiptId: 'census-assumption', expiresAtMs: input.nowMs + 1, mappingHash: input.folder.mappingHash,
    expectedSequence: 1, acceptedSequence: 1, snapshotAtMs: input.nowMs, acceptedAtMs: input.nowMs, observedAtMs: input.nowMs,
  };
  return input;
}
function counts(result: KernelResult, hypothetical: boolean) {
  return {
    candidates: figure(result.counts.evaluatedFiles, hypothetical), eligible: figure(result.counts.eligible, hypothetical),
    held: figure(result.counts.held, hypothetical),
    complete: figure(Object.values(result.items).filter(proof => !RULES.some(rule => proof[rule].codes.includes('coverage-incomplete'))).length, hypothetical),
    incomplete: figure(Object.values(result.items).filter(proof => RULES.some(rule => proof[rule].codes.includes('coverage-incomplete'))).length, hypothetical),
    byRule: Object.fromEntries(RULES.map(rule => [rule, figure({ ...result.counts.byRule[rule], blocking: result.counts.byRule[rule].blocked + result.counts.byRule[rule].unknown }, hypothetical)])),
    byReason: Object.fromEntries(Object.entries(result.counts.byReason).map(([reason, count]) => [reason, figure(count, hypothetical)])),
    nameMentionOnly: figure(result.eligible.filter(id => (result.nameMentionCounts[id] ?? 0) > 0).length, hypothetical),
  };
}
export function censusReport(kernelOutput: KernelOutput, assumptions: CensusAssumptions = {}) {
  const assumedRules: { rule: 6 | 8; reason: string }[] = [];
  if (assumptions.rule6) assumedRules.push({ rule: 6, reason: 'not yet pushed; caller-supplied admission set' });
  if (assumptions.liveIntegration) assumedRules.push({ rule: 8, reason: 'live integration and folder opt-in assumed' });
  const hypothetical = assumedRules.length > 0;
  const input = forCensus(kernelOutput, assumptions), current = evaluateKernel(input);
  const variants = [];
  for (const link_guard of ['strict', 'stale-sources'] as const)
    for (const git_mode of ['never', 'sparse'] as const)
      for (const name_mentions of ['ask', 'allow'] as const) {
        const result = evaluateKernel({ ...input, policy: { ...input.policy, linkGuard: link_guard, gitMode: git_mode, nameMentions: name_mentions } });
        variants.push({ link_guard, git_mode, name_mentions, ...counts(result, hypothetical) });
      }
  const shapeCounts = new Map<string, number>();
  for (const file of input.snapshot.files) {
    const name = file.path?.segments.at(-1) ?? '', match = /\.([A-Za-z0-9]{1,16})$/.exec(name);
    // Restrict the extension alphabet. No user segment text, stem, lengths, IDs or hashes are exported.
    const extension = match ? `.${match[1]!.toLowerCase()}` : 'unknown';
    const shape = `${file.path?.segments.length ?? 0} segments, ${extension}`;
    shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
  }
  const json = { schema: 'kernel-census/v1', effect: 'none', assumptions: assumedRules,
    status: kernelOutput.status, zeroYield: current.counts.zeroYield, ...counts(current, hypothetical), variants,
    shapes: [...shapeCounts.entries()].sort().map(([shape, count]) => ({ shape, count: figure(count, hypothetical) })),
    admissionGuard: 'not-computed', veil: 'not-computed', obsidianSyncEnabled: input.folder.obsidianSyncEnabled };
  const label = hypothetical ? 'Hypothetical' : 'Real';
  const lines = ['Kernel census; read-only counts.', ...assumedRules.map(item => `Assumed rule ${item.rule}: ${item.reason}.`),
    `${label} |E|: ${current.eligible.length}; candidates: ${current.counts.evaluatedFiles}; held: ${current.counts.held}.`,
    ...RULES.map(rule => `${label} rule ${rule} blocking: ${current.counts.byRule[rule].blocked + current.counts.byRule[rule].unknown}.`),
    ...variants.map(row => `${label} ${row.link_guard}/${row.git_mode}/${row.name_mentions}: |E|=${row.eligible.value}.`),
    ...json.shapes.map(row => `${label} shape ${row.shape}: ${row.count.value}.`),
    'Admission guard: not-computed. Veil: not-computed.'];
  return { json, text: lines.join('\n') };
}

/** Local-only paths. Never embed this in censusReport or a shared turnover. */
export function censusLocalBlockers(output: KernelOutput) {
  const rows = new Map<string, Set<string>>(), sources = new Map(output.localSources.map(row => [row.id, row.path]));
  const add = (path: string, candidate: string) => { const ids = rows.get(path) ?? new Set(); ids.add(candidate); rows.set(path, ids); };
  for (const path of output.unreadableSources) for (const id of Object.keys(output.kernel.items)) add(path, id);
  const edges = new Map(output.input.references.edges.map(edge => [edge.id, edge]));
  for (const [id, proof] of Object.entries(output.kernel.items)) for (const rule of [9, 10] as const)
    for (const referenceId of proof[rule].references) {
      const edge = edges.get(referenceId), path = edge ? sources.get(edge.source) : undefined;
      if (path) add(path, id);
    }
  return { localOnly: true, sources: [...rows.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, ids]) => ({ path, blockedCandidates: ids.size })), admissionGuard: 'not-computed', veil: 'not-computed' };
}
