import { expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeKernelProposal, type KernelInput, type Rule } from '../packages/core/src/focus/eligibility.ts';
import { recheck } from '../packages/core/src/focus/recheck.ts';
import { oracle, ORULES } from './kernel-oracle.ts';
import { deepFreeze, evaluate, INPUT_CLASSES, NOW, protectiveChange, tenInputs, worldArbitrary, type World } from './helpers/s2f-worlds.ts';
import { testLocalScorer } from './helpers/s2f-test-scorer.ts';

export const SEED = 0x5f2a2026;
const RUNS = 10_000;
type Counters = { cases: number; nonempty: number; blocked: number; soleRule: Record<number, number>; classes: Record<string, { appeared: number; decisive: number }>; freshDrops: number;
  expansionProposalChanges: number; correctionProposalChanges: number; expansionClosedChanges: number; correctionClosedChanges: number };
function counters(): Counters { return { cases: 0, nonempty: 0, blocked: 0, soleRule: Object.fromEntries(ORULES.map(rule => [rule, 0])), classes: Object.fromEntries(INPUT_CLASSES.map(name => [name, { appeared: 0, decisive: 0 }])), freshDrops: 0,
  expansionProposalChanges: 0, correctionProposalChanges: 0, expansionClosedChanges: 0, correctionClosedChanges: 0 }; }
function observe(world: World, actual: ReturnType<typeof evaluate>, c: Counters) {
  c.cases++;
  if (actual.eligible.length > 0) c.nonempty++;
  if (actual.eligible.length < world.input.snapshot.files.length) c.blocked++;
  for (const proof of Object.values(actual.items)) {
    const blocked = ORULES.filter(rule => proof[rule].state !== 'pass');
    if (blocked.length === 1 && actual.globalHolds.length === 0) c.soleRule[blocked[0]!]!++;
  }
  if (world.classes.length) {
    const removed = evaluate(world.withoutFeature);
    for (const name of world.classes) {
      c.classes[name]!.appeared++;
      if (!actual.eligible.includes(world.decisiveId) && removed.eligible.includes(world.decisiveId)) c.classes[name]!.decisive++;
    }
  }
}
function nonvacuity(c: Counters, fresh: boolean) {
  expect(c.cases).toBe(RUNS);
  expect(c.nonempty).toBeGreaterThanOrEqual(RUNS * 0.2);
  expect(c.blocked).toBeGreaterThanOrEqual(RUNS * 0.2);
  for (const rule of ORULES) expect(c.soleRule[rule], `sole rule ${rule}`).toBeGreaterThanOrEqual(100);
  for (const name of INPUT_CLASSES) {
    expect(c.classes[name]!.appeared, `${name} appearances`).toBeGreaterThanOrEqual(300);
    expect(c.classes[name]!.decisive, `${name} decisive`).toBeGreaterThanOrEqual(1);
  }
  if (fresh) expect(c.freshDrops).toBeGreaterThanOrEqual(RUNS * 0.2);
}
function run(name: string, check: (world: World, actual: ReturnType<typeof evaluate>, c: Counters) => void, fresh = false) {
  const c = counters();
  const prop = fc.property(worldArbitrary, world => { const actual = evaluate(world.input); observe(world, actual, c); check(world, actual, c); });
  const d = fc.check(prop, { numRuns: 10_000, seed: SEED });
  if (process.env.S2F_PROOF_DIR) {
    mkdirSync(process.env.S2F_PROOF_DIR, { recursive: true });
    writeFileSync(join(process.env.S2F_PROOF_DIR, `${name}.json`), JSON.stringify({ name, seed: SEED, failed: d.failed, numRuns: d.numRuns,
      numSkips: d.numSkips, numShrinks: d.numShrinks, counterexample: d.counterexample, counterexamplePath: d.counterexamplePath,
      error: d.failed ? String(d.errorInstance) : null, counters: c }, null, 2) + '\n');
  }
  expect(d.failed, d.failed ? String(d.errorInstance) : undefined).toBe(false);
  expect(d.numRuns).toBe(10_000);
  nonvacuity(c, fresh);
  if (name === 'P5-learned-invariant') for (const value of [c.expansionProposalChanges, c.correctionProposalChanges, c.expansionClosedChanges, c.correctionClosedChanges]) expect(value).toBeGreaterThanOrEqual(100);
}
it('P1 sound: every eligible file passes all eleven independently derived rules', () => run('P1-sound', (world, actual) => {
  const expected = oracle(world.input);
  for (const id of actual.eligible) {
    expect(expected.eligible).toContain(id);
    for (const rule of ORULES) expect(expected.reasons[id]![rule]).toEqual([]);
  }
}), 120_000);
it('P2 justified: every kept candidate has a truthful reason and each reported reason is supported', () => run('P2-justified', (world, actual) => {
  const expected = oracle(world.input);
  for (const file of world.input.snapshot.files) {
    const proof = actual.items[file.id]!, codes = [...actual.globalHolds, ...ORULES.flatMap(rule => proof[rule].codes)];
    if (!actual.eligible.includes(file.id)) { expect(codes.length).toBeGreaterThan(0); expect(expected.eligible).not.toContain(file.id); }
    for (const rule of ORULES) for (const code of proof[rule].codes) expect(expected.reasons[file.id]![rule]).toContain(code);
  }
  for (const code of actual.globalHolds) expect(expected.global).toContain(code);
}), 120_000);
it('P3 conservation: eligible/kept partition the candidates and every rule/reason count agrees', () => run('P3-conservation', (world, actual) => {
  const ids = world.input.snapshot.files.map(file => file.id).sort(), held = ids.filter(id => !actual.eligible.includes(id));
  expect(new Set(actual.eligible).size).toBe(actual.eligible.length);
  expect([...actual.eligible, ...held].sort()).toEqual(ids);
  expect(actual.counts.eligible + actual.counts.held).toBe(ids.length);
  const reasonCounts: Record<string, number> = {};
  for (const rule of ORULES) {
    for (const state of ['pass', 'blocked', 'unknown'] as const) expect(actual.counts.byRule[rule][state]).toBe(ids.filter(id => actual.items[id]![rule].state === state).length);
  }
  for (const id of ids) for (const code of new Set(ORULES.flatMap(rule => actual.items[id]![rule].codes))) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  for (const code of actual.globalHolds) reasonCounts[code] = ids.length;
  expect(actual.counts.byReason).toEqual(reasonCounts);
}), 120_000);
it('P4 monotone: one additional protective fact never enlarges eligibility', () => run('P4-monotone', (world, actual) => {
  const protectedInput = protectiveChange(world.input, world.perturb), after = evaluate(protectedInput);
  for (const id of after.eligible) expect(actual.eligible).toContain(id);
}), 120_000);
it('P5 learned-invariant: frozen evidence resists writes and learned proposals only narrow closure', () => run('P5-learned-invariant', (world, actual, c) => {
  const frozen = deepFreeze(structuredClone(world.input));
  const before = evaluate(frozen);
  // All three learned values are generated from the arbitrary's random score vector/selector.
  // Cards include ineligible candidates. The scorer has no access to factual kernel inputs.
  const cards = frozen.snapshot.files.map((file, i) => ({ id: file.id, terms: [`topic-${i % 3}`] }));
  const playbook = { scores: frozen.snapshot.files.map((file, i) => ({ id: file.id, value: world.scores[i]! })), threshold: world.perturb - 6, expansionBoost: 4 };
  const corrections = frozen.snapshot.files.map((file, i) => ({ id: file.id, keep: world.scores[i]! % 2 === 0 }));
  const expansions = world.scores.slice(0, 1 + world.perturb % 2).map(score => ({ term: `topic-${Math.abs(score) % 3}`, weight: 1 + Math.abs(score) % 11 }));
  const proposed = testLocalScorer(cards, playbook, corrections, expansions);
  const noExpansions = testLocalScorer(cards, playbook, corrections, []), noCorrections = testLocalScorer(cards, playbook, [], expansions);
  const closed = closeKernelProposal(frozen, proposed);
  const closedNoExpansions = closeKernelProposal(frozen, noExpansions), closedNoCorrections = closeKernelProposal(frozen, noCorrections);
  const differs = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort());
  if (differs(proposed, noExpansions)) c.expansionProposalChanges++;
  if (differs(proposed, noCorrections)) c.correctionProposalChanges++;
  if (differs(closed.eligible, closedNoExpansions.eligible)) c.expansionClosedChanges++;
  if (differs(closed.eligible, closedNoCorrections.eligible)) c.correctionClosedChanges++;
  for (const id of closed.eligible) { expect(actual.eligible).toContain(id); expect(proposed).toContain(id); }
  expect(closed.eligible).toEqual(oracle(frozen, proposed).eligible);
  expect(() => { frozen.snapshot.files[0]!.kind = 'directory'; }).toThrow();
  expect(() => { frozen.snapshot.files[0]!.times!.mtimeMs = NOW; }).toThrow();
  expect(evaluate(frozen)).toEqual(before);
}), 120_000);
it('P6 fresh-subset: real recheck intersects fresh eligibility, closes and explains every drop', () => run('P6-fresh-subset', (world, actual, c) => {
  const control = world.input.snapshot.files.at(-1)!.id;
  const proposed = actual.eligible.filter(id => id === control || world.scores[Number(id.slice(1))]! <= 0);
  const fresh = protectiveChange(world.input, world.perturb, control);
  if (world.perturb === 2) { fresh.snapshot.files.at(-1)!.activity!.holds = 0; fresh.snapshot.files.at(-1)!.times!.changeTimeMs = NOW; }
  const result = recheck(proposed, tenInputs(fresh)), freshEligible = evaluate(fresh);
  for (const id of result.retained) { expect(proposed).toContain(id); expect(freshEligible.eligible).toContain(id); }
  expect(result.retained).toEqual(oracle(fresh, proposed).eligible);
  expect([...result.retained, ...result.dropped.map(item => item.id)].sort()).toEqual([...proposed].sort());
  if (result.dropped.length) c.freshDrops++;
  for (const drop of result.dropped) {
    expect(drop.reasons.length).toBeGreaterThan(0);
    for (const code of drop.reasons) {
      expect(code).toMatch(/^ineligible-now:(?:[1-9]|10|11)$/);
      const rule = Number(code.split(':')[1]) as Rule;
      expect(result.proof[drop.id]![rule].state).not.toBe('pass');
    }
  }
}, true), 120_000);
it('P7 order-invariant: file/reference permutations preserve E and every reason', () => run('P7-order-invariant', (world, actual) => {
  const input: KernelInput = structuredClone(world.input), rotate = world.perturb % input.snapshot.files.length;
  input.snapshot.files = [...input.snapshot.files.slice(rotate), ...input.snapshot.files.slice(0, rotate)].reverse();
  input.references.edges = [...input.references.edges].reverse(); input.references.notes = [...input.references.notes].reverse();
  const result = evaluate(input);
  const normal = (proof: typeof actual.items) => Object.fromEntries(Object.entries(proof).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, checks]) => [id, Object.fromEntries(ORULES.map(rule => [rule, { state: checks[rule].state, codes: [...checks[rule].codes].sort(), references: [...checks[rule].references].sort() }]))]));
  expect(result.eligible).toEqual(actual.eligible); expect(normal(result.items)).toEqual(normal(actual.items)); expect(result.counts).toEqual(actual.counts);
}), 120_000);
