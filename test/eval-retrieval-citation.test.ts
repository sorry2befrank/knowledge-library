// The "is this change safe to ship" gate. It runs the retrieval-and-citation eval (eval/run-eval.ts) over the
// synthetic golden set and fails when any metric drops below the floors in eval/thresholds.json or when a
// case that passed before now fails. A separate check proves the committed results table is current; that
// check alone does not catch a regression, because `npm run eval` clears it.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runEval, renderMarkdown, renderJson, loadGolden, RESULTS_MD, RESULTS_JSON, type EvalResults } from "../eval/run-eval.ts";

interface Thresholds { minimum: Record<string, number>; maximum: Record<string, number>; allNegativeControlsRefused: boolean; categoryMinimumPassed: Record<string, number> }
const thresholds = JSON.parse(readFileSync(join(dirname(RESULTS_JSON), "thresholds.json"), "utf8")) as Thresholds;
const lf = (s: string) => s.replace(/\r\n/g, "\n");

let r: EvalResults;
beforeAll(async () => { r = await runEval(); });

describe("retrieval-and-citation eval: the ship gate", () => {
  it("no metric drops below its floor", () => {
    const m = r.metrics as unknown as Record<string, number>;
    for (const [k, floor] of Object.entries(thresholds.minimum)) expect(m[k], `${k} fell below ${floor}`).toBeGreaterThanOrEqual(floor);
    for (const [k, ceil] of Object.entries(thresholds.maximum)) expect(m[k], `${k} rose above ${ceil}`).toBeLessThanOrEqual(ceil);
    if (thresholds.allNegativeControlsRefused) expect(r.metrics.negativeControlsRefused, "a bad citation was accepted").toBe(r.metrics.negativeControls);
  });

  it("no category passes fewer cases than its floor", () => {
    for (const c of r.categories) expect(c.passed, `${c.category}: ${c.passed}/${c.cases}`).toBeGreaterThanOrEqual(thresholds.categoryMinimumPassed[c.category] ?? c.cases);
  });

  it("every case without a known-gap label passes", () => {
    const failing = r.cases.filter((c) => !c.pass && !c.knownGap).map((c) => `${c.id}: ${c.reason}`);
    expect(failing).toEqual([]);
  });

  it("every known gap still fails; one that now passes must lose its label (and the floors should be raised by hand)", () => {
    const fixed = r.cases.filter((c) => c.pass && c.knownGap).map((c) => c.id);
    expect(fixed, "these known gaps now pass: remove knownGap in eval/golden-set.json, raise eval/thresholds.json, run npm run eval").toEqual([]);
  });

  it("the committed results table is current (freshness only: it proves the table matches the code, not that nothing regressed)", () => {
    expect(lf(readFileSync(RESULTS_JSON, "utf8")), "eval/results.json is stale: run npm run eval").toBe(renderJson(r));
    expect(lf(readFileSync(RESULTS_MD, "utf8")), "eval/RESULTS.md is stale: run npm run eval").toBe(renderMarkdown(r));
  });

  it("is deterministic: a second run gives byte-identical results", async () => {
    expect(renderJson(await runEval())).toBe(renderJson(r));
  });

  it("the golden set is well formed: unique ids, a reason for every case, known corpus keys", () => {
    const { golden } = loadGolden();
    const keys = new Set(golden.corpus.map((n) => n.key));
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(golden.cases.length);
    for (const c of golden.cases) {
      expect(c.why.length, c.id).toBeGreaterThan(10);
      for (const k of [...(c.accept ?? []), ...(c.requireAll ?? []), ...(c.mustOutrank ?? []), ...(c.forbid ?? []), ...(c.target ? [c.target] : [])]) expect(keys.has(k), `${c.id}: ${k}`).toBe(true);
    }
  });
});
