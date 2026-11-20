import { describe, expect, it } from "vitest";
import { BASELINE_V0, captureCases, computeLineageKey, ingestSignals, mineSynonyms, replay, splitFor, type Catalog } from "@kl/core";
import { newCatalog, FRANK, FRANK_CONNECTOR } from "./helpers/load.ts";

async function oracle(catalog: Catalog, collection: string, split: "train" | "heldout", folder = "folder:scope-review") {
  for (let i = 0; i < 80; i++) {
    const title = `Scope beacon ${i}`;
    const saved = await catalog.save(FRANK, { collection, folderId: folder, path: `${folder.slice(7)}/oracle-${i}.md`, title, content: `# ${title}\nneedle synthetic retrieval evidence ${i}` });
    if (!saved.ok) throw new Error(`Synthetic save refused: ${saved.status}`);
    const groupKey = computeLineageKey(catalog.db, saved.noteId);
    if (splitFor(groupKey) === split) { await catalog.drainOutbox(); return { ...saved, title, groupKey, path: `${folder.slice(7)}/oracle-${i}.md` }; }
  }
  throw new Error("Could not generate the requested synthetic split");
}

describe("takeover replay privacy and project scope", () => {
  it("mines only golden labels in the requested collection", async () => {
    const { catalog } = newCatalog();
    const inside = await oracle(catalog, "col:synth-desk", "train");
    const outside = await oracle(catalog, "col:atlas-notes", "train");
    const result = mineSynonyms(catalog, BASELINE_V0, { scopeId: "col:synth-desk", privacy: "team" }, [
      { q: "insidelexeme", principal: "frank", expectedNoteId: inside.noteId },
      { q: "outsidelexeme", principal: "frank", expectedNoteId: outside.noteId },
    ]);
    expect(result.trainCases).toBe(1);
    expect(result.targetGroups).toEqual([inside.groupKey]);
    expect(result.delta.synonyms.insidelexeme).toBeDefined();
    expect(result.delta.synonyms.outsidelexeme).toBeUndefined();
  });

  it("mines only golden labels in the requested folder even within one collection", async () => {
    const { catalog } = newCatalog();
    const inside = await oracle(catalog, "col:synth-desk", "train", "folder:inside-review");
    const outside = await oracle(catalog, "col:synth-desk", "train", "folder:outside-review");
    const result = mineSynonyms(catalog, BASELINE_V0, { scopeId: "folder:inside-review", privacy: "team" }, [
      { q: "insidelexeme", principal: "frank", expectedNoteId: inside.noteId },
      { q: "outsidelexeme", principal: "frank", expectedNoteId: outside.noteId },
    ]);
    expect(result.trainCases).toBe(1);
    expect(result.targetGroups).toEqual([inside.groupKey]);
    expect(result.delta.synonyms.outsidelexeme).toBeUndefined();
  });

  it("filters confirmed cases by the requested project before replay and mining", async () => {
    const { catalog } = newCatalog();
    const outside = await oracle(catalog, "col:atlas-notes", "train");
    expect((await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: outside.cite, topic: "outsidelexeme", detail: "Synthetic confirmed-case fixture." })).ok).toBe(true);
    // S1 has no confirmation channel. This explicitly synthetic stored-case fixture exercises the reader, not confirmation authority.
    catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-scope-receipt'");
    const key = { scopeId: "col:synth-desk", privacy: "team" };
    expect(mineSynonyms(catalog, BASELINE_V0, key).trainCases).toBe(0);
    const result = replay(catalog, BASELINE_V0, BASELINE_V0, { ...key, targetGroups: [outside.groupKey] });
    expect(result.heldout.labelSources.confirmedCases).toBe(0);
    expect(result.g2).toMatchObject({ ok: false, targeted: 1, fixed: 0 });
    expect(result.measurement).toMatchObject({ complete: false, missingTargetGroups: [outside.groupKey] });
    expect(result.verdict).toBe("tested-insufficient");
  });

  it("does not report out-of-project unconfirmed observations", async () => {
    const { catalog } = newCatalog();
    const outside = await oracle(catalog, "col:atlas-notes", "heldout");
    expect((await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: outside.cite, topic: "outsidelexeme", detail: "Synthetic observation." })).ok).toBe(true);
    expect(replay(catalog, BASELINE_V0, BASELINE_V0, { scopeId: "col:synth-desk", privacy: "team", targetGroups: [] }).observations.groups).toBe(0);
  });

  it("keeps same-scope confirmed training cases and unconfirmed observations separate", async () => {
    const { catalog } = newCatalog();
    const train = await oracle(catalog, "col:synth-desk", "train");
    expect((await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: train.cite, topic: "insidelexeme", detail: "Synthetic confirmed training fixture." })).ok).toBe(true);
    catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-scope-receipt'");
    const heldout = await oracle(catalog, "col:synth-desk", "heldout");
    expect((await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: heldout.cite, topic: heldout.title, detail: "Synthetic unconfirmed observation." })).ok).toBe(true);
    const key = { scopeId: "col:synth-desk", privacy: "team" };
    const mined = mineSynonyms(catalog, BASELINE_V0, key);
    expect(mined.trainCases).toBe(1);
    expect(mined.delta.synonyms.insidelexeme).toBeDefined();
    const result = replay(catalog, BASELINE_V0, mined.playbook, { ...key, targetGroups: mined.targetGroups });
    expect(result.heldout.labelSources.confirmedCases).toBe(1);
    expect(result.heldout.groups).toBe(0);
    expect(result.observations.groups).toBe(1);
    expect(result.g2).toMatchObject({ ok: true, targeted: 1, fixed: 1 });
  });

  it("excludes private golden and confirmed labels from a global team lesson", async () => {
    const { catalog } = newCatalog();
    const inside = await oracle(catalog, "col:synth-desk", "train");
    const outside = await oracle(catalog, "inbox:frank", "train");
    expect((await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: outside.cite, topic: "privatecaselexeme", detail: "Synthetic private confirmed label." })).ok).toBe(true);
    catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-scope-receipt'");
    const goldens = [{ q: "insidelexeme", principal: "frank", expectedNoteId: inside.noteId }, { q: "privategoldenlexeme", principal: "frank", expectedNoteId: outside.noteId }];
    const team = mineSynonyms(catalog, BASELINE_V0, { scopeId: "global", privacy: "team" }, goldens);
    expect(team.trainCases).toBe(1);
    expect(team.delta.synonyms.privatecaselexeme).toBeUndefined();
    expect(team.delta.synonyms.privategoldenlexeme).toBeUndefined();
    const privateLesson = mineSynonyms(catalog, BASELINE_V0, { scopeId: "global", privacy: "frank-private" }, goldens);
    expect(privateLesson.trainCases).toBe(3);
    expect(privateLesson.delta.synonyms.privatecaselexeme).toBeDefined();
    expect(privateLesson.delta.synonyms.privategoldenlexeme).toBeDefined();
  });

  it("rechecks captured evidence using the originating connector rather than the capture device", async () => {
    const { catalog } = newCatalog();
    const target = await oracle(catalog, "col:synth-desk", "train");
    expect(ingestSignals(catalog, [{ kind: "S1", principal: "frank", client: "connector", scopeId: "col:synth-desk", targetNoteId: target.noteId, query: "capturedlexeme", interactive: true }]).recorded).toBe(1);
    expect(captureCases(catalog).created).toBe(1);
    catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-scope-receipt'");
    expect(catalog.db.get<{ client: string }>("SELECT client FROM cases")!.client).toBe("kl-device");
    const key = { scopeId: "col:synth-desk", privacy: "client:scope-restricted" };
    expect(mineSynonyms(catalog, BASELINE_V0, key).trainCases).toBe(1);
    catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:scope-restricted", class: "client:scope-restricted", clients_ok: ["kl-device"], decision_row: { client: "Synthetic Scope Client" } });
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:scope-restricted"])]);
    catalog.db.run("UPDATE versions SET privacy_class = 'client:scope-restricted' WHERE noteId = ?", [target.noteId]);
    catalog.db.run("UPDATE version_classes SET class = 'client:scope-restricted' WHERE noteId = ?", [target.noteId]);
    expect((await catalog.read(FRANK, target.cite)).ok).toBe(true);
    expect(await catalog.read(FRANK_CONNECTOR, target.cite)).toEqual({ ok: false, error: "not-found" });
    expect(mineSynonyms(catalog, BASELINE_V0, key).trainCases).toBe(0);
  });

  it("excludes an S0 query tied to a private old version even when the current oracle is team-visible", async () => {
    const { catalog } = newCatalog();
    const target = await oracle(catalog, "col:synth-desk", "heldout");
    expect(ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", scopeId: "col:synth-desk", targetNoteId: target.noteId, targetVer: target.ver, query: target.title, interactive: true }]).recorded).toBe(1);
    const next = await catalog.save(FRANK, { collection: "col:synth-desk", folderId: "folder:scope-review", path: target.path, baseVer: target.ver, title: target.title, content: `# ${target.title}\nSynthetic revised team oracle.` });
    expect(next.ok && next.noteId === target.noteId && next.ver > target.ver).toBe(true);
    await catalog.drainOutbox();
    catalog.db.run("UPDATE versions SET privacy_class = 'frank-private' WHERE noteId = ? AND ver = ?", [target.noteId, target.ver]);
    catalog.db.run("UPDATE version_classes SET class = 'frank-private' WHERE noteId = ? AND ver = ?", [target.noteId, target.ver]);
    const result = replay(catalog, BASELINE_V0, BASELINE_V0, { scopeId: "col:synth-desk", privacy: "team", targetGroups: [], goldenQueries: [{ principal: "frank", q: target.title, expectedNoteId: target.noteId }] });
    expect(result.heldout.groups).toBe(1);
    expect(result.retention.groups).toBe(0);
  });

  it("keeps valid S0 evidence and golden labels from the same scope", async () => {
    const { catalog } = newCatalog();
    const inside = await oracle(catalog, "col:synth-desk", "heldout");
    expect(ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", scopeId: "col:synth-desk", targetNoteId: inside.noteId, query: inside.title, interactive: true }]).recorded).toBe(1);
    const result = replay(catalog, BASELINE_V0, BASELINE_V0, { scopeId: "col:synth-desk", privacy: "team", targetGroups: [], goldenQueries: [{ principal: "frank", q: inside.title, expectedNoteId: inside.noteId }] });
    expect(result.retention).toMatchObject({ groups: 1, championRecall3: 1, candidateRecall3: 1 });
    expect(result.heldout).toMatchObject({ groups: 1, championRecall10: 1, candidateRecall10: 1 });
  });

  for (const collection of ["col:atlas-notes", "inbox:frank"]) {
    it(`ranks a team oracle without top-10 competition from ${collection}`, async () => {
      const { catalog } = newCatalog();
      const inside = await oracle(catalog, "col:synth-desk", "heldout");
      for (let i = 0; i < 12; i++) {
        const saved = await catalog.save(FRANK, { collection, title: "needle", content: `# needle\nSynthetic competing note ${i}` });
        expect(saved.ok).toBe(true);
      }
      await catalog.drainOutbox();
      const result = replay(catalog, BASELINE_V0, BASELINE_V0, { scopeId: collection === "inbox:frank" ? "global" : "col:synth-desk", privacy: "team", targetGroups: [], goldenQueries: [{ principal: "frank", q: "needle", expectedNoteId: inside.noteId }] });
      expect(result.heldout.outcomes).toHaveLength(1);
      expect(result.heldout.outcomes[0]).toMatchObject({ championHit: true, candidateHit: true });
    });
  }

  it("marks accuracy unmeasured when another project saturates the search candidate window", async () => {
    const { catalog } = newCatalog();
    const inside = await oracle(catalog, "col:synth-desk", "heldout");
    expect(ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", scopeId: "col:synth-desk", targetNoteId: inside.noteId, targetVer: inside.ver, query: "needle", interactive: true }]).recorded).toBe(1);
    const opts = { scopeId: "col:synth-desk", privacy: "team", targetGroups: [], goldenQueries: [{ principal: "frank", q: "needle", expectedNoteId: inside.noteId }] };
    expect(replay(catalog, BASELINE_V0, BASELINE_V0, opts).heldout.outcomes[0]!.championHit).toBe(true);
    const competing = await catalog.save(FRANK, { collection: "col:atlas-notes", title: "needle", content: `# needle\n${Array.from({ length: 405 }, () => "needle ".repeat(220)).join("\n")}` });
    expect(competing.ok).toBe(true);
    await catalog.drainOutbox();
    if (!competing.ok) throw new Error("Synthetic competing save failed");
    expect(catalog.db.get<{ n: number }>("SELECT count(*) AS n FROM chunks WHERE noteId = ?", [competing.noteId])!.n).toBeGreaterThan(400);
    const crowded = replay(catalog, BASELINE_V0, BASELINE_V0, opts);
    expect(crowded.heldout.groups).toBe(0);
    expect(crowded.heldout.losses).toBe(0);
    expect(crowded.retention).toMatchObject({ groups: 0, insufficient: true });
    expect(crowded.measurement).toMatchObject({ complete: false, omittedGroups: 1, missingTargetGroups: [] });
    expect(crowded.measurement!.saturatedQueries).toBeGreaterThan(0);
    expect(crowded.verdict).toBe("tested-insufficient");
  });

  it("checks the current version class before a team golden can teach the miner", async () => {
    const { catalog } = newCatalog();
    const target = await oracle(catalog, "col:synth-desk", "train");
    catalog.db.run("UPDATE versions SET privacy_class = 'frank-private' WHERE noteId = ?", [target.noteId]);
    catalog.db.run("UPDATE version_classes SET class = 'frank-private' WHERE noteId = ?", [target.noteId]);
    expect((await catalog.read(FRANK_CONNECTOR, target.cite)).ok).toBe(true); // Frank can read it, but a team lesson must not.
    expect(mineSynonyms(catalog, BASELINE_V0, { scopeId: "global", privacy: "team" }, [{ q: "privatelexeme", principal: "frank", expectedNoteId: target.noteId }]).trainCases).toBe(0);
  });

  it("does not mine a golden target that the replay's connector can no longer read", async () => {
    const { catalog } = newCatalog();
    const target = await oracle(catalog, "col:synth-desk", "train");
    catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:scope-restricted", class: "client:scope-restricted", clients_ok: ["kl-device"], decision_row: { client: "Synthetic Scope Client" } });
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:scope-restricted"])]);
    catalog.db.run("UPDATE versions SET privacy_class = 'client:scope-restricted' WHERE noteId = ?", [target.noteId]);
    catalog.db.run("UPDATE version_classes SET class = 'client:scope-restricted' WHERE noteId = ?", [target.noteId]);
    expect(await catalog.read(FRANK_CONNECTOR, target.cite)).toEqual({ ok: false, error: "not-found" });
    expect(mineSynonyms(catalog, BASELINE_V0, { scopeId: "global", privacy: "client:scope-restricted" }, [{ q: "restrictedlexeme", principal: "frank", expectedNoteId: target.noteId }]).trainCases).toBe(0);
  });

  it("does not include query-log diagnostics whose original scope and privacy were not recorded", async () => {
    const { catalog } = newCatalog();
    const target = await oracle(catalog, "col:atlas-notes", "train");
    const q = target.title.toLowerCase();
    // A matching signal stores the query value; query_log alone currently stores only its digest.
    expect(ingestSignals(catalog, [{ kind: "S0", principal: "frank", client: "connector", scopeId: "col:atlas-notes", targetNoteId: target.noteId, query: q, interactive: true }]).recorded).toBe(1);
    catalog.search(FRANK_CONNECTOR, q, { scope: { collection: "col:atlas-notes" } });
    expect(catalog.db.get<{ n: number }>("SELECT count(*) AS n FROM query_log")!.n).toBeGreaterThan(0);
    expect(replay(catalog, BASELINE_V0, BASELINE_V0, { scopeId: "col:synth-desk", privacy: "team", targetGroups: [] }).unlabelled.queries).toBe(0);
  });
});
