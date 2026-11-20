// S1c section C (understudy). Each test was written to FAIL against the S1b code and pass against the fix.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { replay, gradeCandidate, saveCandidate, installBaseline, resolveChampion, promote, computeLineageKey, splitFor, ingestSignals, callTool, sha256Hex, canonicalJson, playbookHash, BASELINE_V0, BASELINE_V0_HASH, type Catalog, type ReceiptVerifier, type ReplayReport } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, idMap, type LoadReport } from "./helpers/load.ts";

const fx = generateFixtures();
const KEY = { scopeId: "global", privacy: "team" };
const SYS = { principal: "system", clientClass: "kl-device" as const };
const approveAll: ReceiptVerifier = { verify: (r) => (r ? { ok: true } : { ok: false, reason: "no-approval-channel" }) };
const RECEIPT = { receiptId: "test-receipt", actionKind: "x", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "test" };

/** Synthetic labels: held-out team notes whose title is the oracle; a nonsense query term the candidate maps to the title. */
function heldoutGoldens(catalog: Catalog, report: LoadReport, count: number) {
  const ids = idMap(report);
  const picked = fx.notes.filter((n) => report.admitted.has(n.noteId) && n.privacyClass === "team" && n.folder === "synth-desk" && /^[A-Za-z0-9 -]+$/.test(n.title) && splitFor(computeLineageKey(catalog.db, ids.get(n.noteId)!)) === "heldout").slice(0, count);
  const goldens = picked.map((n, i) => ({ q: `zq-term-${i}`, principal: "frank", expectedNoteId: ids.get(n.noteId)! }));
  const synonyms = Object.fromEntries(picked.map((n, i) => [`zq-term-${i}`, [n.title.toLowerCase().replace(/[-_]+/g, " ")]]));
  return { goldens, synonyms, picked };
}

describe("C1: grade only real replays", () => {
  it("a hand-written report on a candidate that was never replayed is refused even with look budget available", async () => {
    const { catalog } = newCatalog(fx);
    installBaseline(catalog, KEY);
    const c = saveCandidate(catalog, KEY, { ...BASELINE_V0, synonyms: { a: ["b"] } }, BASELINE_V0_HASH, "test", []);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks")!.c).toBe(0);
    const forged = { verdict: "tested" as const, generation: catalog.head().seq, heldoutLook: true as const };
    expect(() => gradeCandidate(catalog, c.candidateId, forged)).toThrow(/report-not-replayed/);
    expect(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [c.candidateId])!.state).toBe("saved");
  });
  it("a real replay stores a record (report hash, playbook hash, generation) and spends the look itself; grading binds to it", async () => {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" && n.kind === "decision");
    installBaseline(catalog, KEY);
    const pb = { ...BASELINE_V0, synonyms: { a: ["b"] } };
    const c = saveCandidate(catalog, KEY, pb, BASELINE_V0_HASH, "test", []);
    const rep = replay(catalog, BASELINE_V0, pb, { targetGroups: [], privacy: "team" });
    const rec = catalog.db.get<{ reportHash: string; playbookHash: string; generation: number }>("SELECT reportHash, playbookHash, generation FROM replays ORDER BY id DESC LIMIT 1")!;
    expect(rec.playbookHash).toBe(playbookHash(pb)); expect(rec.reportHash).toBe(sha256Hex(canonicalJson(rep))); expect(rec.generation).toBe(rep.generation);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks")!.c).toBe(1); // the replay spent the look, not the grade
    // a report for a different playbook, an edited report, or a report from another generation does not grade this candidate
    const other = saveCandidate(catalog, KEY, { ...BASELINE_V0, synonyms: { c: ["d"] } }, BASELINE_V0_HASH, "test", []);
    expect(() => gradeCandidate(catalog, other.candidateId, rep)).toThrow(/report-not-replayed/);
    expect(() => gradeCandidate(catalog, c.candidateId, { ...rep, verdict: "tested" })).toThrow(/report-not-replayed/);
    expect(() => gradeCandidate(catalog, c.candidateId, rep)).toThrow(/report-not-replayed|generation/); // the other candidate's creation moved the head
    const rep2 = replay(catalog, BASELINE_V0, pb, { targetGroups: [], privacy: "team" });
    gradeCandidate(catalog, c.candidateId, rep2);
    expect(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [c.candidateId])!.state).toBe("graded");
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks")!.c).toBe(2);
  });
  it("a vetoed candidate cannot be re-graded, in this week or the next", async () => {
    const { catalog, clock } = newCatalog(fx);
    installBaseline(catalog, KEY);
    const bad = { ...BASELINE_V0, consumes: { focus: "abc" } };
    const c = saveCandidate(catalog, KEY, bad, BASELINE_V0_HASH, "test", []);
    const rep = replay(catalog, BASELINE_V0, bad, { targetGroups: [], privacy: "team" });
    expect(rep.verdict).toBe("vetoed");
    gradeCandidate(catalog, c.candidateId, rep);
    expect(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [c.candidateId])!.state).toBe("vetoed");
    clock.set("2026-10-19T12:00:00.000Z"); // next ISO week: fresh look budget
    const rep2 = replay(catalog, BASELINE_V0, bad, { targetGroups: [], privacy: "team" });
    expect(() => gradeCandidate(catalog, c.candidateId, rep2)).toThrow(/already-vetoed/);
    expect(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [c.candidateId])!.state).toBe("vetoed");
  });
});

describe("C5 and C1: the S0 gate, a real tested verdict and LEARNED.tested", () => {
  async function arena() {
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk");
    installBaseline(catalog, KEY);
    const { goldens, synonyms, picked } = heldoutGoldens(catalog, report, 8);
    expect(goldens.length).toBe(8);
    const candidate = { ...BASELINE_V0, synonyms };
    return { catalog, report, goldens, candidate, picked };
  }
  it("eight discordant held-out wins and no losses stay tested-insufficient when there are no held-out S0 groups: the S0 shortfall alone holds it", async () => {
    const { catalog, goldens, candidate } = await arena();
    const rep = replay(catalog, BASELINE_V0, candidate, { targetGroups: [], privacy: "team", goldenQueries: goldens });
    expect(rep.heldout.discordant).toBeGreaterThanOrEqual(5); expect(rep.heldout.wins).toBeGreaterThan(rep.heldout.losses);
    expect(rep.canaries.regressions).toBe(0); expect(rep.g0.ok && rep.g2.ok).toBe(true);
    expect(rep.retention).toMatchObject({ groups: 0, insufficient: true });
    expect(rep.verdict).toBe("tested-insufficient");
  });
  it("the same candidate with 30 held-out S0 groups within a point is tested; LEARNED.tested counts it", async () => {
    const { catalog, report, goldens, candidate } = await arena();
    const ids = idMap(report);
    const s0Notes = fx.notes.filter((n) => report.admitted.has(n.noteId) && n.privacyClass === "team" && n.folder === "synth-desk" && splitFor(computeLineageKey(catalog.db, ids.get(n.noteId)!)) === "heldout").slice(8, 45);
    const r = ingestSignals(catalog, s0Notes.map((n, i) => ({ signalId: `s0-${i}`, kind: "S0", principal: "frank", client: "connector" as const, query: n.title, targetNoteId: ids.get(n.noteId)!, interactive: true })));
    expect(r.recorded).toBeGreaterThanOrEqual(30);
    const c = saveCandidate(catalog, KEY, candidate, BASELINE_V0_HASH, "test", []);
    const rep = replay(catalog, BASELINE_V0, candidate, { targetGroups: [], privacy: "team", goldenQueries: goldens });
    expect(rep.retention.groups).toBeGreaterThanOrEqual(30); expect(rep.retention.insufficient).toBe(false); expect(rep.retention.withinOnePoint).toBe(true);
    expect(rep.verdict).toBe("tested");
    gradeCandidate(catalog, c.candidateId, rep);
    expect(catalog.db.get<{ state: string; verdict: string }>("SELECT state, verdict FROM candidates WHERE candidateId = ?", [c.candidateId])).toEqual({ state: "tested", verdict: "tested" });
    const st = await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read"], random: catalog.random }, "library_status", { section: "passdown" });
    expect((st.structured.passdown as { LEARNED: { tested: number; saved: number } }).LEARNED).toMatchObject({ tested: 1, saved: 1 });
    // the understudy still cannot promote it
    expect(promote(catalog, c.candidateId, undefined)).toEqual({ ok: false, code: "receipt-refused:no-approval-channel" });
  });
});

describe("C2: lineage uses receipt-confirmed edges only", () => {
  it("an MCP save with supersedes neither merges lineage groups nor moves a split; confirmed edges do", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "payment-terms");
    const ids = idMap(report);
    const rate = ids.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!, terms = ids.get(fx.notes.find((n) => n.title === "payment-terms")!.noteId)!;
    const before = computeLineageKey(catalog.db, rate);
    const s = await catalog.save(FRANK_CONNECTOR, { content: "# claims to replace the rate card\nbody", collection: "col:synth-desk", supersedes: rate });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(catalog.db.get<{ state: string; origin: string }>("SELECT state, origin FROM edges WHERE src = ?", [s.noteId])).toEqual({ state: "proposed", origin: "mcp-proposal" });
    expect(computeLineageKey(catalog.db, rate)).toBe(before);
    expect(computeLineageKey(catalog.db, s.noteId)).toBe(`lineage:${s.noteId}`); // its own group: the proposal is not a label
    expect(computeLineageKey(catalog.db, terms)).not.toBe(before);
    // Frank confirms the edge with a receipt: now the two are one lineage group
    catalog.apply(FRANK, { kind: "receipt", receipt: RECEIPT }, { kind: "edge.confirm", src: s.noteId, dst: rate, type: "supersedes" });
    expect(computeLineageKey(catalog.db, s.noteId)).toBe(computeLineageKey(catalog.db, rate));
    expect(catalog.db.get<{ state: string; origin: string }>("SELECT state, origin FROM edges WHERE src = ?", [s.noteId])).toEqual({ state: "confirmed", origin: "receipt" });
    // without a receipt the confirmation is refused
    expect(() => catalog.apply(FRANK, { kind: "principal" }, { kind: "edge.confirm", src: s.noteId, dst: rate, type: "supersedes" })).toThrow(/receipt-required/);
  });
});

describe("C3: the ranking of baseline v0 is pinned by a golden fixture", () => {
  it("fixed queries over the synthetic vault give the recorded ordered results", async () => {
    const golden = JSON.parse(readFileSync("test/fixtures/golden-ranking.json", "utf8")) as { baseline: string; fixtureDigest: string; queries: { q: string; principal: string; k: number; expected: { noteId: string; score: number }[] }[] };
    expect(golden.baseline).toBe(BASELINE_V0_HASH);
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx);
    const back = new Map([...idMap(report)].map(([synth, real]) => [real, synth]));
    expect(golden.queries.length).toBeGreaterThanOrEqual(12);
    for (const g of golden.queries) {
      const r = catalog.search(g.principal === "frank" ? FRANK_CONNECTOR : PARTNER, g.q, { k: g.k });
      const got = r.hits.map((h) => ({ noteId: back.get(h.noteId)!, score: Number(h.score.toFixed(3)) }));
      expect(got, `${g.principal}: ${g.q}`).toEqual(g.expected);
    }
  });
});

describe("C4: baselines and scopes", () => {
  it("champion.baseline checks the capability at runtime, ignores a smuggled hash, and refuses a scope whose ancestor has a receipted champion", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const smuggled = { kind: "champion.baseline", capability: "retrieval", scopeId: "global", privacy: "team", playbookHash: "f".repeat(64) } as unknown as Parameters<Catalog["apply"]>[2];
    catalog.apply(SYS, { kind: "system" }, smuggled);
    expect(catalog.db.get<{ playbookHash: string }>("SELECT playbookHash FROM champions")!.playbookHash).toBe(BASELINE_V0_HASH);
    expect(() => catalog.apply(SYS, { kind: "system" }, { kind: "champion.baseline", capability: "focus" as "retrieval", scopeId: "col:synth-desk", privacy: "team" })).toThrow(/capability/);
    const child = { ...smuggled, scopeId: "col:synth-desk" } as unknown as Parameters<Catalog["apply"]>[2];
    catalog.apply(SYS, { kind: "system" }, child);
    expect(catalog.db.all<{ playbookHash: string }>("SELECT playbookHash FROM champions").every((r) => r.playbookHash === BASELINE_V0_HASH)).toBe(true);
    // a receipted champion at global (promoted through the only homing path, with the test verifier)
    const c = saveCandidate(catalog, KEY, { ...BASELINE_V0, synonyms: { a: ["b"] } }, BASELINE_V0_HASH, "test", []);
    expect(promote(catalog, c.candidateId, RECEIPT)).toEqual({ ok: true });
    expect(resolveChampion(catalog, ["global"], "team").frozenBaseline).toBe(false);
    // a baseline at a child scope would roll back the owner-approved lesson for that scope without a receipt: refused
    expect(() => catalog.apply(SYS, { kind: "system" }, { kind: "champion.baseline", capability: "retrieval", scopeId: "col:atlas-notes", privacy: "team" })).toThrow(/ancestor/);
    expect(() => installBaseline(catalog, { scopeId: "folder:anything", privacy: "team" })).toThrow(/ancestor/);
    expect(resolveChampion(catalog, ["col:atlas-notes", "global"], "team").frozenBaseline).toBe(false);
  });
});
