import { describe, it, expect, beforeAll } from "vitest";
import { ingestSignals, captureCases, listCases, mineSynonyms, replay, saveCandidate, gradeCandidate, promote, installBaseline, resolveChampion, renderTurnover, signTestP, BASELINE_V0, BASELINE_V0_HASH, computeLineageKey, splitFor, type Catalog, type ReplayReport, type ReceiptVerifier } from "@kl/core";
import { validate } from "@kl/contracts";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK_CONNECTOR, PARTNER, type LoadReport, idMap, FixedClock } from "./helpers/load.ts";

const fx = generateFixtures();
let catalog: Catalog, report: LoadReport, ids: Map<string, string>, clock: FixedClock;
const KEY = { scopeId: "global", privacy: "team" };
// The fixture's supersession chains get receipt-CONFIRMED edges (S1c C2): only those edges form lineage groups.
const approveAll: ReceiptVerifier = { verify: (r) => (r ? { ok: true } : { ok: false, reason: "no-approval-channel" }) };
const RECEIPT = { receiptId: "fixture-edges", actionKind: "edge.confirm", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "test" };

beforeAll(async () => {
  ({ catalog, clock } = newCatalog(fx, { receipts: approveAll }));
  report = await loadFixtures(catalog, fx, () => true, { confirmEdges: RECEIPT });
  ids = idMap(report);
  installBaseline(catalog, KEY);
});

describe("Understudy spine: signals → cases → candidate → replay → (no) promotion (A10 baseline v0 replay)", () => {
  let ingest = { recorded: 0, excluded: { headless: 0, selfReferential: 0, nonInteractive: 0, unknownPrincipal: 0, inaccessible: 0 } };
  it("ingests six simulated weeks; headless and self-referential streams are excluded, never recorded", () => {
    for (const w of fx.weeks) {
      const r = ingestSignals(catalog, w.signals.map((s) => ({ signalId: s.signalId, kind: s.kind, principal: s.principal, client: s.client, query: s.query, targetNoteId: ids.get(s.targetNoteId)!, interactive: s.interactive, headless: s.headless, selfReferential: s.selfReferential })));
      ingest.recorded += r.recorded; for (const k of Object.keys(r.excluded) as (keyof typeof r.excluded)[]) ingest.excluded[k] += r.excluded[k];
    }
    const fake = fx.weeks.flatMap((w) => w.signals).filter((s) => !s.truth.genuine);
    expect(ingest.excluded.headless + ingest.excluded.selfReferential).toBe(fake.length);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM signals")!.c).toBe(ingest.recorded);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM signals WHERE confirmed = 1")!.c).toBe(0);
    // partner signals about a frank-private note never land (none in the fixture, but the guard exists)
    const priv = ids.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
    const r = ingestSignals(catalog, [{ kind: "S4", principal: "partner", client: "connector", query: "x", targetNoteId: priv, interactive: true }]);
    expect(r).toMatchObject({ recorded: 0, excluded: { inaccessible: 1 } });
  });
  it("captures labelled signals as cases in lineage-safe groups with a frozen split", () => {
    const r = captureCases(catalog);
    expect(r.created).toBeGreaterThan(20);
    expect(captureCases(catalog).created).toBe(0); // idempotent
    const cases = listCases(catalog, { capability: "retrieval" });
    expect(new Set(cases.map((c) => c.split))).toEqual(expect.any(Set));
    for (const c of cases) { expect(c.groupKey).toMatch(/^lineage:/); expect(c.split).toBe(splitFor(c.groupKey)); }
    // a supersession chain with CONFIRMED edges is one lineage component; the edges are confirmed, not proposed
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM edges WHERE state = 'confirmed'")!.c).toBeGreaterThanOrEqual(7);
    const chain = fx.notes.filter((n) => n.title.startsWith("HANDOFF-")).map((n) => ids.get(n.noteId)!);
    const keys = new Set(chain.map((id) => computeLineageKey(catalog.db, id)));
    expect(keys.size).toBe(1);
    const unrelated = computeLineageKey(catalog.db, ids.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!);
    expect(keys.has(unrelated)).toBe(false);
    for (const c of cases) expect(validate("signals-cases/v1", { caseId: c.caseId, capability: c.capability, scopeId: c.scopeId, privacy: c.privacy, groupKey: c.groupKey, lineageKey: c.groupKey, inputRef: "x", frozenFeatures: {}, expected: {}, split: c.split, sourceSignals: [], author: c.author, client: "connector", status: "unconfirmed" }).valid).toBe(true);
  });
  let rep: ReplayReport, candidateId: string;
  const goldens = () => fx.goldenQueries.filter((g) => g.principal === "frank" || fx.notes.find((n) => n.noteId === g.expectedNoteId)!.privacyClass === "team").map((g) => ({ q: g.q, principal: g.principal, expectedNoteId: ids.get(g.expectedNoteId)! }));
  it("the deterministic miner sees only LABELLED train pairs (goldens; no receipt-confirmed cases exist in S1), never unconfirmed observations or held-out groups", () => {
    const champion = resolveChampion(catalog, ["global"], "team");
    expect(champion.frozenBaseline).toBe(true); expect(champion.hash).toBe(BASELINE_V0_HASH);
    // Without goldens there are no labels at all in S1: the miner has nothing to learn from, by design.
    expect(Object.keys(mineSynonyms(catalog, champion.playbook, KEY).delta.synonyms).length).toBe(0);
    const mined = mineSynonyms(catalog, champion.playbook, KEY, goldens());
    expect(Object.keys(mined.delta.synonyms).length).toBeGreaterThan(0);
    const heldoutGroups = new Set(goldens().map((g) => computeLineageKey(catalog.db, g.expectedNoteId)).filter((k) => splitFor(k) === "heldout"));
    for (const g of mined.targetGroups) { expect(splitFor(g)).toBe("train"); expect(heldoutGroups.has(g)).toBe(false); }
    const saved = saveCandidate(catalog, KEY, mined.playbook, champion.hash, "synonym-miner/v1", mined.targetGroups);
    candidateId = saved.candidateId;
    rep = replay(catalog, champion.playbook, mined.playbook, { targetGroups: mined.targetGroups, privacy: "team", goldenQueries: goldens(),
      partnerProbeQueries: ["private hiring plan", "candidate scorecard", "journal"], injectionQueries: fx.notes.filter((n) => n.flags.injection).map((n) => n.body.slice(0, 60)) });
    expect(rep.g0.ok).toBe(true); expect(rep.g0.touched).toEqual(["synonyms"]);
    expect(rep.g2.ok).toBe(true); expect(rep.g2.fixed).toBe(rep.g2.targeted);
  });
  it("G3 runs champion and candidate in one invocation; only labels decide accuracy, observations and unlabelled replay are reported separately; canaries hold", () => {
    expect(rep.generation + 1).toBe(catalog.head().seq); // the replay's own record is the ledger head
    expect(rep.heldout.labelSources.confirmedCases).toBe(0); // no approval channel in S1: no confirmed case can exist
    const teamVisible = goldens().filter((g) => fx.notes.find((n) => ids.get(n.noteId) === g.expectedNoteId)!.privacyClass === "team");
    expect(rep.heldout.labelSources.goldenQueries).toBe(teamVisible.length); // the frank-private golden is not a team label
    expect(rep.heldout.wins + rep.heldout.losses + rep.heldout.ties).toBe(rep.heldout.groups);
    expect(rep.heldout.candidateRecall10).toBeGreaterThanOrEqual(rep.heldout.championRecall10);
    expect(rep.heldout.signTestP).toBeGreaterThan(0); expect(rep.heldout.signTestP).toBeLessThanOrEqual(1);
    expect(rep.priorHeldoutLooks).toBe(0);
    expect(rep.observations.groups).toBeGreaterThan(0); expect(rep.observations.note).toMatch(/never count as labels/);
    expect(rep.unlabelled.note).toBe("rank change, not accuracy");
    expect(rep.canaries).toMatchObject({ partnerAclLeak: 0, goldenLost: 0, injectionEffects: 0, regressions: 0 });
    expect(["tested", "tested-insufficient"]).toContain(rep.verdict);
    gradeCandidate(catalog, candidateId, rep);
    // state follows the verdict: tested only for verdict tested, otherwise graded (or vetoed)
    expect(catalog.db.get<{ state: string; verdict: string }>("SELECT state, verdict FROM candidates WHERE candidateId = ?", [candidateId])).toEqual({ state: rep.verdict === "tested" ? "tested" : "graded", verdict: rep.verdict });

  });
  it("G0 vetoes a candidate that touches a forbidden field or flips retrievalMode", () => {
    const bad = { ...BASELINE_V0, synonyms: { x: ["y"] }, retrievalMode: "hybrid" as unknown as "keyword" };
    const r = replay(catalog, BASELINE_V0, bad, { targetGroups: [], privacy: "team" });
    expect(r.verdict).toBe("vetoed"); expect(r.g0.violations.join()).toMatch(/retrievalMode/);
    const acl = { ...BASELINE_V0, acl: { partner: "everything" } } as unknown as typeof BASELINE_V0;
    expect(replay(catalog, BASELINE_V0, acl, { targetGroups: [], privacy: "team" }).g0.violations.join()).toMatch(/not allow-listed/);
  });
  it("the look budget allows two held-out looks per key per ISO week, spent by replays; a report that no replay produced never grades", () => {
    // the G3 test above spent one look this ISO week; the second replay is allowed, the third is refused BEFORE any held-out read
    const c2 = saveCandidate(catalog, KEY, { ...BASELINE_V0, synonyms: { a: ["b"] } }, BASELINE_V0_HASH, "test", []);
    const r2 = replay(catalog, BASELINE_V0, { ...BASELINE_V0, synonyms: { a: ["b"] } }, { targetGroups: [], privacy: "team" });
    expect(r2.priorHeldoutLooks).toBe(1);
    gradeCandidate(catalog, c2.candidateId, r2);
    const c3 = saveCandidate(catalog, KEY, { ...BASELINE_V0, synonyms: { c: ["d"] } }, BASELINE_V0_HASH, "test", []);
    expect(() => replay(catalog, BASELINE_V0, { ...BASELINE_V0, synonyms: { c: ["d"] } }, { targetGroups: [], privacy: "team" })).toThrow(/look-budget-exhausted/);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks")!.c).toBe(2);
    // next ISO week, with look budget available: a hand-written report is refused for not being a replay, not for the budget
    clock.set("2026-10-12T12:00:00.000Z");
    expect(() => catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "candidate.grade", candidateId: c3.candidateId, report: { verdict: "tested", generation: catalog.head().seq, heldoutLook: true } })).toThrow(/report-not-replayed/);
    expect(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [c3.candidateId])!.state).toBe("saved");
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks")!.c).toBe(2);
  });
  it("promotion without an approval receipt is impossible; the champion stays baseline v0", () => {
    // a catalog with the S1 verifier (no approval channel); the shared catalog above accepts receipts only to confirm fixture edges
    const { catalog: c } = newCatalog(fx);
    installBaseline(c, KEY);
    const cand = saveCandidate(c, KEY, { ...BASELINE_V0, synonyms: { a: ["b"] } }, BASELINE_V0_HASH, "test", []).candidateId;
    const fake = { receiptId: "forged", actionKind: "champion.promote", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "sig" };
    expect(promote(c, cand, fake)).toEqual({ ok: false, code: "receipt-refused:no-approval-channel" });
    expect(promote(c, cand, undefined)).toEqual({ ok: false, code: "receipt-refused:no-approval-channel" });
    expect(promote(c, cand, fake, { principal: "partner", clientClass: "kl-device" })).toEqual({ ok: false, code: "receipt-refused:no-approval-channel" });
    // no other homing path: a second baseline row is refused, principals cannot call champion ops, and the row count is still 1
    expect(() => c.apply({ principal: "frank", clientClass: "kl-device" }, { kind: "system" }, { kind: "champion.baseline", capability: "retrieval", scopeId: "global", privacy: "team" })).toThrow(/baseline-exists/);
    expect(() => c.apply({ principal: "frank", clientClass: "connector" }, { kind: "principal" }, { kind: "champion.promote", candidateId: cand })).toThrow(/receipt-required/);
    expect(c.db.get<{ c: number }>("SELECT count(*) AS c FROM champions")!.c).toBe(1);
    expect(resolveChampion(c, ["folder:x", "col:synth-desk", "global"], "team")).toMatchObject({ scopeId: "global", frozenBaseline: true, hash: BASELINE_V0_HASH });
    expect(c.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [cand])!.state).toBe("saved"); // never deployed
    // live search still uses the baseline, here and on the shared catalog where a candidate was graded
    expect(c.championPlaybook("global", "team")).toEqual(BASELINE_V0);
    expect(catalog.championPlaybook("global", "team")).toEqual(BASELINE_V0);
    expect(["tested", "graded"]).toContain(catalog.db.get<{ state: string }>("SELECT state FROM candidates WHERE candidateId = ?", [candidateId])!.state);
  });
  it("the sign test is a per-comparison diagnostic", () => {
    expect(signTestP(0, 0)).toBe(1); expect(signTestP(5, 5)).toBeCloseTo(1, 5); expect(signTestP(8, 1)).toBeCloseTo(0.0390625, 6); expect(signTestP(10, 0)).toBeCloseTo(2 / 1024, 9);
  });
  it("privacy: a frank-private label never shapes the team champion's candidate", async () => {
    await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: ids.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!, topic: "secret scorecard", detail: "private" });
    const privCases = listCases(catalog, { capability: "retrieval", privacy: "frank-private" });
    expect(privCases.length).toBeGreaterThan(0);
    const privGolden = fx.goldenQueries.filter((g) => g.q === "private hiring plan").map((g) => ({ q: "secret scorecard", principal: g.principal, expectedNoteId: ids.get(g.expectedNoteId)! }));
    const mined = mineSynonyms(catalog, BASELINE_V0, KEY, [...goldens(), ...privGolden]);
    // the frank-private oracle note is not team-visible: a team-privacy candidate must not learn from it
    expect(Object.keys(mined.delta.synonyms).join(" ")).not.toContain("scorecard");
    const frankPrivate = new Set(fx.notes.filter((n) => n.privacyClass === "frank-private").map((n) => ids.get(n.noteId)));
    expect(catalog.search(PARTNER, "secret scorecard", { k: 20 }).hits.every((h) => !frankPrivate.has(h.noteId))).toBe(true);
  });
  it("the turnover writer renders a turnover/v1 document", () => {
    const doc = { session: "S1", date: "2026-10-05", lane: "cloud" as const, branch: "cloud/s1-spine", built: ["x"], exitEvidence: [{ check: "npm test", result: "pass" as const, evidence: "n tests" }], decisions: [{ decision: "d", why: "w" }], conflictsWithDesign: [], packPending: [{ test: "t", needs: "pack" }], funding_source: "credit" as const, spend_usd: "unknown" as const, nextStep: "S1b" };
    expect(validate("turnover/v1", doc).valid).toBe(true);
    const md = renderTurnover(doc);
    expect(md).toContain("# Turnover S1"); expect(md).toContain("spend_usd: unknown"); expect(md).toContain("`t` needs pack");
  });
});
