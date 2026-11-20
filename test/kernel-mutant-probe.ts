// Executed by the isolated mutation runner, not a skipped test in the normal suite.
import fc from 'fast-check';
import { writeFileSync } from 'node:fs';
import { oracle } from './kernel-oracle.ts';
import { evaluate, worldArbitrary } from './helpers/s2f-worlds.ts';
const seeds = [0x5f2a2026, 0x10203040, 0x2468ace0, 0x31415926];
const rows = [];
for (const seed of seeds) {
  const d = fc.check(fc.property(worldArbitrary, world => {
    const expected = oracle(world.input), actual = evaluate(world.input);
    // Only a returned unsafe member fails P1. Throws and setup failures are separately rejected below.
    return actual.eligible.every(id => expected.eligible.includes(id));
  }), { numRuns: 10_000, seed });
  const counterexample = d.counterexample?.[0];
  let actualUnsafe: string[] = [];
  if (counterexample) {
    const expected = oracle(counterexample.input), actual = evaluate(counterexample.input);
    actualUnsafe = actual.eligible.filter(id => !expected.eligible.includes(id));
  }
  rows.push({ seed, failed: d.failed, numRuns: d.numRuns, numShrinks: d.numShrinks,
    counterexamplePath: d.counterexamplePath, counterexample: d.counterexample,
    actualUnsafe, error: d.failed ? String(d.errorInstance) : null,
    behavioralP1Failure: d.failed && actualUnsafe.length > 0 });
}
writeFileSync(process.env.S2F_MUTANT_REPORT!, JSON.stringify({ property: 'P1-sound', requestedRuns: 10_000, rows }, null, 2) + '\n');
if (rows.some(row => !row.behavioralP1Failure || row.numRuns > 10_000)) process.exitCode = 1;
