// S1b B4/B6 (outbox durability, crash matrix over every step kind) and C4 (learning observations).
import { describe, it, expect } from "vitest";
import { HARD_ALARM_ATTEMPTS, STEP_KINDS, designSpec, ed25519Signer, generateServiceKey, publishEvidence, installBaseline, replay, BASELINE_V0, ingestSignals, captureCases, listCases, type Catalog, type OutboxRow } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, issueToken, idMap } from "./helpers/load.ts";
import { sha256Hex } from "@kl/core";
import { enrollmentFixture } from "./helpers/enrollment.ts";

const fx = generateFixtures();
const spec = await designSpec();
const CFG = { producerVersion: "0.1.0-s1c", keyId: "k", specRevision: spec.revision, specHash: spec.hash, policyRevision: "proposal-unaccepted", mappingRevision: "none", integrationProjectId: "00000000-0000-4000-8000-000000000001", collectionId: "col:synth-desk", folderId: "folder:synth-desk", authorizedCollections: ["col:synth-desk"], milestonesEnabled: ["ingest-custody", "retrieval-index"] as ("ingest-custody" | "retrieval-index")[] };

/** Established-catalog queue; enrollment is exercised separately on a virgin catalog. */
async function fullQueue() {
  const c = newCatalog(fx);
  // deferCustody keeps custody.verify PENDING (S1c B4): the matrix crashes after its effect too, not only after index and mirror.
  await loadFixtures(c.catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "payment-terms" || n.title === "invoice-export", { dispatch: false, deferCustody: c.blobStore });
  const k = await generateServiceKey();
  await publishEvidence(c.catalog, CFG, await ed25519Signer(k.privateKey, k.keyId));
  const tok = issueToken(c.catalog, "frank", "cc-bearer", [], "queue");
  c.catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "token.revoke", tokenHash: sha256Hex(tok), reason: "owner" }); // not acknowledged: the checkpoint waits in the queue
  return c;
}
async function endState(c: Catalog) {
  return {
    outbox: c.outbox(), custody: c.db.all<{ custody: string; n: number }>("SELECT custody, count(*) AS n FROM versions GROUP BY custody ORDER BY custody"),
    chunks: c.db.get<{ c: number }>("SELECT count(*) AS c FROM chunks")!.c, dup: c.db.get<{ c: number }>("SELECT count(*) AS c FROM (SELECT noteId, ver, n FROM chunks GROUP BY noteId, ver, n HAVING count(*) > 1)")!.c,
    mirrors: (await c.mirror.list("m/")).length, evidence: (await c.mirror.list("outbox/orrery/")).length, authz: (await c.mirror.list("authz/")).length,
    custodyEvents: c.db.get<{ c: number }>("SELECT count(*) AS c FROM events WHERE kind = 'version.custody'")!.c,
    enrollmentState: c.db.get<{value:string}>("SELECT value FROM meta WHERE key='enrollment_state'")?.value ?? null,
    activationEvents: c.db.get<{c:number}>("SELECT count(*) AS c FROM events WHERE kind='enrollment.activate'")!.c,
    tokens: c.db.get<{c:number}>("SELECT count(*) AS c FROM tokens")!.c,
  };
}

describe("B6: the crash matrix covers every outbox step kind", () => {
  it("a crash after the effect of any step, for every step kind, converges to the same end state on redispatch", async () => {
    const ref = await fullQueue();
    const enrollmentRef = await enrollmentFixture(); enrollmentRef.catalog.enroll(enrollmentRef.grant);
    const kinds = new Set(ref.catalog.db.all<{ step: string }>("SELECT DISTINCT step FROM outbox WHERE state = 'pending'").map((r) => r.step));
    for(const r of enrollmentRef.db.all<{step:string}>("SELECT DISTINCT step FROM outbox WHERE state='pending'")) kinds.add(r.step);
    expect(kinds).toEqual(new Set(STEP_KINDS)); // every step kind is PENDING, custody.verify included
    const n = ref.catalog.outbox().pending;
    await ref.catalog.drainOutbox();
    const want = await endState(ref.catalog);
    expect(want.outbox.pending).toBe(0); expect(want.dup).toBe(0); expect(want.custody).toEqual([{ custody: "indexed", n: want.custody[0]!.n }]); expect(want.evidence).toBe(1); expect(want.authz).toBe(1);
    for (let p = 1; p <= n; p++) {
      const run = await fullQueue();
      const first = await run.catalog.dispatchOutbox({ crashAfterEffect: (_r: OutboxRow, nth) => nth === p, ignoreBackoff: true });
      expect(first.crashed).toBe(true);
      await run.catalog.drainOutbox();
      expect(await endState(run.catalog), `crash after step ${p}`).toEqual(want);
    }
    // Enrollment cannot coexist with the legacy setup fixture: it requires a
    // virgin catalog. Include its actual pending step in the exhaustive matrix.
    await enrollmentRef.catalog.drainOutbox();
    const enrollmentWant=await endState(enrollmentRef.catalog);
    expect(enrollmentWant).toMatchObject({enrollmentState:'active',activationEvents:1,tokens:3,authz:1,outbox:{pending:0,done:1}});
    const enrollmentRun=await enrollmentFixture();enrollmentRun.catalog.enroll(enrollmentRun.grant);
    const crash=await enrollmentRun.catalog.dispatchOutbox({crashAfterEffect:r=>r.step==='enrollment.checkpoint'});
    expect(crash.crashed).toBe(true);expect(enrollmentRun.catalog.outbox().pending).toBe(1);
    await enrollmentRun.catalog.drainOutbox();
    expect(await endState(enrollmentRun.catalog)).toEqual(enrollmentWant);
    enrollmentRef.db.close();enrollmentRun.db.close();
  });
});

describe("B4: no outbox step is lost forever", () => {
  it("a repeatedly failing authz checkpoint stays pending with backoff, becomes a hard alarm, never terminal, and completes when storage recovers", async () => {
    const { catalog, mirror } = newCatalog(fx);
    const tok = issueToken(catalog, "frank", "cc-bearer", [], "b4");
    mirror.failWhen = (k) => k.startsWith("authz/");
    const r = catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "token.revoke", tokenHash: sha256Hex(tok), reason: "owner" });
    await expect(catalog.acknowledge((r.result as { authzSeq: number }).authzSeq)).rejects.toThrow(/not acknowledged/);
    for (let i = 0; i < HARD_ALARM_ATTEMPTS + 2; i++) await catalog.dispatchOutbox({ ignoreBackoff: true });
    const row = catalog.db.get<{ state: string; attempts: number; nextAttemptAt: string | null }>("SELECT state, attempts, nextAttemptAt FROM outbox WHERE step = 'authz.checkpoint'")!;
    expect(row.state).toBe("pending"); expect(row.attempts).toBeGreaterThanOrEqual(HARD_ALARM_ATTEMPTS); expect(row.nextAttemptAt).toBeTruthy();
    expect(catalog.outbox().hardAlarms).toBe(1);
    expect(catalog.db.get("SELECT 1 FROM outbox WHERE state = 'failed'")).toBeUndefined(); // no terminal failure exists
    mirror.failWhen = null;
    await catalog.drainOutbox();
    expect(catalog.outbox()).toEqual({ pending: 0, done: 1, hardAlarms: 0 });
    expect((await mirror.list("authz/")).length).toBe(1);
  });
});

describe("C4: learning observations", () => {
  it("headless feedback creates neither a signal nor a case; interactive feedback's case appears in replay observations", async () => {
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" && (n.flags.golden || n.kind === "decision"));
    installBaseline(catalog, { scopeId: "global", privacy: "team" });
    const a = report.admitted.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
    const headless = await catalog.feedback({ ...FRANK_CONNECTOR, interactive: false }, { kind: "missed", target: a.cite, topic: "fees", detail: "x" });
    expect(headless.ok && headless.caseCreated === false && headless.signalId === null).toBe(true);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM signals")!.c).toBe(0);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM cases")!.c).toBe(0);
    const live = await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: a.cite, topic: "fees", detail: "x" });
    expect(live.ok && live.caseCreated).toBe(true);
    const cases = listCases(catalog, { capability: "retrieval" });
    expect(cases.length).toBe(1); expect(cases[0]!.label).toBe("miss"); expect(cases[0]!.q_h).toBe(sha256Hex("fees"));
    // the feedback case has the same shape as a captured case and shows up as an observation (never a label) in replay
    const rep = replay(catalog, BASELINE_V0, { ...BASELINE_V0, synonyms: { fees: ["rate card"] } }, { targetGroups: [], privacy: "team" });
    const inHeldout = cases[0]!.split === "heldout";
    expect(rep.observations.groups).toBe(inHeldout ? 1 : 0);
    expect(rep.heldout.labelSources.confirmedCases).toBe(0);
  });
  it("too few held-out S0 groups keeps a winning candidate tested-insufficient; the injection canary can fail", async () => {
    const { catalog, clock } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx);
    const ids = idMap(report);
    installBaseline(catalog, { scopeId: "global", privacy: "team" });
    const goldens = fx.goldenQueries.filter((g) => fx.notes.find((n) => n.noteId === g.expectedNoteId)!.privacyClass === "team").map((g) => ({ q: g.q, principal: g.principal, expectedNoteId: ids.get(g.expectedNoteId)! }));
    const rep = replay(catalog, BASELINE_V0, { ...BASELINE_V0, synonyms: { fees: ["rate card"], pricing: ["rate card"], "invoice terms": ["payment terms"], "due date clause": ["payment terms"], "billing statement csv": ["invoice export"], "recovery runbook": ["restore drill runbook"] } }, { targetGroups: [], privacy: "team", goldenQueries: goldens });
    expect(rep.retention.groups).toBe(0); expect(rep.retention.insufficient).toBe(true);
    expect(rep.verdict).not.toBe("tested"); // whatever the wins, no S0 evidence means insufficient
    // the injection canary: a candidate whose synonym rule pushes an injection note into the top 3 of a golden query trips it
    const inj = fx.notes.filter((n) => n.flags.injection).map((n) => ids.get(n.noteId)!).filter(Boolean);
    const beacon = replay(catalog, BASELINE_V0, { ...BASELINE_V0, synonyms: { "rate card": ["injection beacon"], rates: ["injection beacon"] } }, { targetGroups: [], privacy: "team", goldenQueries: goldens, injectionQueries: ["approve focus plan"], injectionNoteIds: new Set(inj) });
    expect(beacon.canaries.injectionEffects).toBeGreaterThan(0); expect(beacon.verdict).toBe("vetoed");
    // ingesting a week of signals with S0 retention gives held-out S0 groups a chance to count
    for (const w of fx.weeks) ingestSignals(catalog, w.signals.map((s) => ({ signalId: s.signalId, kind: s.kind, principal: s.principal, client: s.client, query: s.query, targetNoteId: ids.get(s.targetNoteId)!, interactive: s.interactive, headless: s.headless, selfReferential: s.selfReferential })));
    captureCases(catalog);
    clock.set("2026-10-12T12:00:00.000Z"); // the two replays above spent this week's look budget (replays spend looks, S1c C1)
    const rep2 = replay(catalog, BASELINE_V0, BASELINE_V0, { targetGroups: [], privacy: "team" });
    expect(rep2.retention.groups).toBeGreaterThan(0);
    expect(rep2.retention.groups).toBeLessThanOrEqual(new Set(fx.weeks.flatMap((w) => w.signals.filter((s) => s.kind === "S0").map((s) => s.targetNoteId))).size);
  });
});
