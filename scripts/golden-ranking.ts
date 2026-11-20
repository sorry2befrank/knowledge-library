// Writes test/fixtures/golden-ranking.json: fixed queries over the synthetic vault with their ordered results under
// baseline v0 (S1c C3). The post-S1c ranking IS baseline v0; any later ranking change fails test/s1c-understudy.test.ts
// and needs a new baseline version. Run: node scripts/golden-ranking.ts
import { writeFileSync } from "node:fs";
import { BASELINE_V0_HASH } from "@kl/core";
import { generateFixtures, fixtureDigest } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK_CONNECTOR, PARTNER, idMap } from "../test/helpers/load.ts";

const fx = generateFixtures();
const { catalog } = newCatalog(fx);
const report = await loadFixtures(catalog, fx);
const back = new Map([...idMap(report)].map(([synth, real]) => [real, synth]));
const extra = ["invoice", "rate card tiers", "restore drill snapshot", "candidate scorecard", "milestone scope cut", "p95 latency error budget", "net 30 deposit", "kickoff intake form"];
const queries = [...fx.goldenQueries.map((g) => ({ q: g.q, principal: g.principal })), ...extra.flatMap((q) => [{ q, principal: "frank" }, { q, principal: "partner" }])];
const out = queries.map(({ q, principal }) => {
  const r = catalog.search(principal === "frank" ? FRANK_CONNECTOR : PARTNER, q, { k: 10 });
  return { q, principal, k: 10, expected: r.hits.map((h) => ({ noteId: back.get(h.noteId)!, score: Number(h.score.toFixed(3)) })) };
});
writeFileSync("test/fixtures/golden-ranking.json", JSON.stringify({ baseline: BASELINE_V0_HASH, fixtureDigest: fixtureDigest(fx), note: "ordered top-10 per query under baseline v0 over the synthetic vault; synthetic note ids; scores to 3 decimals", queries: out }, null, 2) + "\n");
console.log(`golden-ranking: ${out.length} queries`);
