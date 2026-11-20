// Independent A/C review. All notes and names below are generated synthetic fixtures.
import { describe, expect, it } from "vitest";
import { BASELINE_V0, BASELINE_V0_HASH, callTool, computeLineageKey, gradeCandidate, ingestSignals, replay, saveCandidate, splitFor, type Catalog } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { FRANK, FRANK_CONNECTOR, PARTNER, newCatalog } from "./helpers/load.ts";

const fx = generateFixtures();
const SYS = { principal: "system", clientClass: "kl-device" as const };
function client(catalog: Catalog, id: string, cls: string, name: string, clients: string[]) {
  catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: id, class: cls, clients_ok: clients, decision_row: { client: name, receiptId: "synthetic-review" } });
}

describe("takeover A/C access boundaries", () => {
  it("a supersedes reference to an unreadable note is refused exactly like a missing note without creating an edge", async () => {
    const { catalog } = newCatalog(fx);
    const hidden = await catalog.save(FRANK, { content: "# Synthetic private reference\nFixture only." });
    if (!hidden.ok) throw new Error(JSON.stringify(hidden));
    for (const supersedes of [hidden.noteId, hidden.cite, "0000000000"]) {
      const result = await catalog.save(PARTNER, { collection: "col:synth-desk", content: "Synthetic replacement claim.", supersedes });
      expect(result).toMatchObject({ ok: false, status: "refused", reason: "supersedes-not-found" });
    }
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM edges")!.c).toBe(0);
  });

  it("LEARNED.tested excludes genuinely replayed insufficient and vetoed candidates", async () => {
    const { catalog } = newCatalog(fx);
    for (const playbook of [BASELINE_V0, { ...BASELINE_V0, consumes: { focus: "synthetic-forbidden-change" } }]) {
      const candidate = saveCandidate(catalog, { scopeId: "global", privacy: "team" }, playbook, BASELINE_V0_HASH, "synthetic", []);
      const report = replay(catalog, BASELINE_V0, playbook, { privacy: "team", targetGroups: [] });
      expect(report.verdict).not.toBe("tested");
      gradeCandidate(catalog, candidate.candidateId, report);
    }
    const status = await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read"], random: catalog.random }, "library_status", { section: "passdown" });
    expect((status.structured.passdown as { LEARNED: { tested: number; saved: number } }).LEARNED).toMatchObject({ saved: 2, tested: 0 });
  });

  it("an edited report at the current replay generation cannot grade its candidate", () => {
    const { catalog } = newCatalog(fx);
    const candidate = saveCandidate(catalog, { scopeId: "global", privacy: "team" }, BASELINE_V0, BASELINE_V0_HASH, "synthetic", []);
    const report = replay(catalog, BASELINE_V0, BASELINE_V0, { targetGroups: [], privacy: "team" });
    expect(report.verdict).toBe("tested-insufficient");
    expect(catalog.db.get<{ seq: number }>("SELECT seq FROM replays ORDER BY id DESC LIMIT 1")!.seq).toBe(catalog.head().seq);
    expect(() => gradeCandidate(catalog, candidate.candidateId, { ...report, verdict: "tested" })).toThrow(/report-not-replayed/);
  });

  it("a current-generation replay cannot grade another playbook even when both candidates predate the replay", () => {
    const { catalog } = newCatalog(fx);
    const key = { scopeId: "global", privacy: "team" };
    const correct = { ...BASELINE_V0, synonyms: { alpha: ["beta"] } };
    saveCandidate(catalog, key, correct, BASELINE_V0_HASH, "synthetic", []);
    const other = saveCandidate(catalog, key, { ...BASELINE_V0, synonyms: { gamma: ["delta"] } }, BASELINE_V0_HASH, "synthetic", []);
    const report = replay(catalog, BASELINE_V0, correct, { targetGroups: [], privacy: "team" });
    expect(catalog.db.get<{ seq: number }>("SELECT seq FROM replays ORDER BY id DESC LIMIT 1")!.seq).toBe(catalog.head().seq);
    expect(() => gradeCandidate(catalog, other.candidateId, report)).toThrow(/report-not-replayed/);
  });

  it("a save naming two approved clients remains unreadable to a connector approved for only one", async () => {
    const { catalog } = newCatalog(fx);
    client(catalog, "col:review-a", "client:review-a", "Examplecorp Robotics", ["kl-device", "connector"]);
    client(catalog, "col:review-b", "client:review-b", "Placeholder and Sample Bakery", ["kl-device"]);
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:review-a", "client:review-b"])]);
    const saved = await catalog.save(FRANK, { collection: "col:synth-desk", content: "# Synthetic joint account\nExamplecorp Robotics and Placeholder and Sample Bakery share this synthetic brief." });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    await catalog.drainOutbox();
    expect(saved.status).toBe("held");
    expect(catalog.db.all<{ class: string }>("SELECT class FROM version_classes WHERE noteId = ? ORDER BY class", [saved.noteId]).map(row => row.class)).toEqual(["client:review-a", "client:review-b"]);
    expect((await catalog.read(FRANK, saved.cite)).ok).toBe(true);
    expect(await catalog.read(FRANK_CONNECTOR, saved.cite)).toEqual({ ok: false, error: "not-found" });
  });

  it("signal intake rejects a client note that the signal's connector cannot read", async () => {
    const { catalog } = newCatalog(fx);
    client(catalog, "col:review-hidden", "client:review-hidden", "Synthetic Review Client", ["kl-device"]);
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:review-hidden"])]);
    const saved = await catalog.save(FRANK, { collection: "col:review-hidden", content: "# Synthetic device-only note\nFixture bytes." });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(await catalog.read(FRANK_CONNECTOR, saved.cite)).toEqual({ ok: false, error: "not-found" });
    const got = ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", query: "synthetic device-only", targetNoteId: saved.noteId, interactive: true }]);
    expect(got).toMatchObject({ recorded: 0, excluded: { inaccessible: 1 } });
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM signals")!.c).toBe(0);
  });

  it("signal intake checks the requested version and rejects a withdrawn note", async () => {
    const { catalog } = newCatalog(fx, { receipts: { verify: () => ({ ok: true }) } });
    const saved = await catalog.save(FRANK, { collection: "col:synth-desk", content: "# Synthetic signal boundary\nFixture bytes." });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    await catalog.drainOutbox();
    const signal = { kind: "S0", principal: "frank", client: "connector" as const, query: "synthetic signal boundary", targetNoteId: saved.noteId, interactive: true };
    expect(ingestSignals(catalog, [{ ...signal, targetVer: saved.ver }]).recorded).toBe(1);
    expect(ingestSignals(catalog, [{ ...signal, targetVer: saved.ver + 100 }])).toMatchObject({ recorded: 0, excluded: { inaccessible: 1 } });
    const receipt = { receiptId: "synthetic-review-withdraw", actionKind: "note.withdraw", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "synthetic", issuedAt: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "synthetic" };
    catalog.apply(FRANK, { kind: "receipt", receipt }, { kind: "note.withdraw", noteId: saved.noteId });
    expect(ingestSignals(catalog, [signal, { ...signal, targetVer: saved.ver }])).toMatchObject({ recorded: 0, excluded: { inaccessible: 2 } });
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM signals")!.c).toBe(1);
  });

  for (const collection of ["inbox:frank", "col:atlas-notes"]) {
    it(`a synth-desk team replay excludes S0 retention evidence from ${collection}`, async () => {
      const { catalog } = newCatalog(fx);
      let heldout: { noteId: string; q: string } | undefined;
      for (let i = 0; i < 30 && !heldout; i++) {
        const q = `synthetic retention fixture ${i}`;
        const saved = await catalog.save(FRANK, { collection, content: `# ${q}\nIndependent access-boundary review.` });
        if (!saved.ok) throw new Error(JSON.stringify(saved));
        if (splitFor(computeLineageKey(catalog.db, saved.noteId)) === "heldout") heldout = { noteId: saved.noteId, q };
      }
      expect(heldout).toBeDefined();
      await catalog.drainOutbox();
      expect(ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", query: heldout!.q, targetNoteId: heldout!.noteId, scopeId: collection, interactive: true }]).recorded).toBe(1);
      const result = replay(catalog, BASELINE_V0, BASELINE_V0, { targetGroups: [], privacy: "team", scopeId: "col:synth-desk" });
      expect(result.retention.groups).toBe(0);
    });
  }
});
