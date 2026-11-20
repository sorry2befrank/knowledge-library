import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { scoreReferencePerishability } from "../packages/core/src/understudy/reference-scorer.ts";
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/reference/scorer.cases.json", import.meta.url), "utf8"));
function construct(v: any, depth = 0): string {
  if (depth > 8) throw Error("fixture.depth");
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || Object.keys(v).length !== 1) throw Error("fixture.shape");
  let text: string;
  if (Array.isArray(v.concat)) text = v.concat.map((x: any) => construct(x, depth + 1)).join("");
  else {
    const args = v.repeat ?? v.join;
    if (!Array.isArray(args) || args.length !== (v.repeat ? 2 : 3) || !Number.isInteger(args[1]) || args[1] < 0 || args[1] > 10000) throw Error("fixture.count");
    const part = construct(args[0], depth + 1);
    if (part.length * args[1] > 100000 || (!v.repeat && (typeof args[2] !== "string" || args[2].length > 100))) throw Error("fixture.bounds");
    text = v.repeat ? part.repeat(args[1]) : Array(args[1]).fill(part).join(args[2]);
  }
  if (text.length > 100000) throw Error("fixture.bytes"); return text;
}
it("keeps exactly the 15 published scorer cases", () => { expect(fixtures.cases).toHaveLength(15); expect(new Set(fixtures.cases.map((c: any) => c.id)).size).toBe(15); });
for (const c of fixtures.cases) it(`perishability reference: ${c.id}`, () => {
  expect(scoreReferencePerishability(construct(c.text))).toEqual(c.expected);
});
it("repeated scoring is stateless and produces only a density signal", () => {
  const one = scoreReferencePerishability("DONE $12 2/3 v1.2.3"), two = scoreReferencePerishability("DONE $12 2/3 v1.2.3");
  expect(one).toEqual(two); expect(Object.keys(one).sort()).toEqual(["classes", "hits", "per1k"]);
});
