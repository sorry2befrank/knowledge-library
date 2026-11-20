// S2d item 0 (A3): the team-class ceiling. A save derived from team notes into a collection a named collaborator can
// read must record `team` in the version's class set, so a principal who was never granted `team` cannot reach it,
// whether the grant was made before or after the save. Modelled on test/acl.test.ts. Written to fail on main.
import { describe, it, expect } from "vitest";
import { type Catalog, type Actor } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, type LoadReport } from "./helpers/load.ts";

const fx = generateFixtures();
const SYS: Actor = { principal: "system", clientClass: "kl-device" };
const COLLAB: Actor = { principal: "collab", clientClass: "connector", interactive: true };
const PATH = "frank-journal/derived-from-rate-card.md";
const CLEAN_PATH = "frank-journal/clean-for-collab.md";
const DERIVED = "# Derived\nRetainer tiers A/B/C from the rate card, restated for the journal.";
const CLEAN = "# Clean\nA journal note with no lineage at all.";

type Case = { lineage: "declared" | "undeclared"; collab: "grant-first" | "grant-after" };
const CASES: Case[] = [{ lineage: "declared", collab: "grant-first" }, { lineage: "undeclared", collab: "grant-first" }, { lineage: "declared", collab: "grant-after" }, { lineage: "undeclared", collab: "grant-after" }];

/** `collab` is a named person with a single collection and no `team`: an active principals row with allowed_classes ["frank-private"]. */
function grantCollab(catalog: Catalog) {
  catalog.apply(SYS, { kind: "setup" }, { kind: "principal.create", id: "collab", email: "collab@example.invalid", allowedClasses: ["frank-private"] });
}

async function arena(c: Case) {
  const { catalog } = newCatalog(fx);
  const report: LoadReport = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
  const rateCard = report.admitted.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
  if (c.collab === "grant-first") grantCollab(catalog);
  const grant = `${c.lineage}-${c.collab}`.padEnd(64, "t");
  // Frank derives text from the team note and saves it into col:frank-journal (frank-private), a collection collab can read.
  let derived;
  if (c.lineage === "declared") derived = await catalog.save(FRANK_CONNECTOR, { content: DERIVED, path: PATH, collection: "col:frank-journal", derivedFrom: [rateCard.cite] }, { grant });
  else { expect((await catalog.read(FRANK_CONNECTOR, rateCard.cite, { grant })).ok).toBe(true); derived = await catalog.save(FRANK_CONNECTOR, { content: DERIVED, path: PATH, collection: "col:frank-journal" }, { grant }); }
  if (!derived.ok) throw new Error(`derived save failed: ${JSON.stringify(derived)}`);
  expect(derived.status).toBe("current"); // no new hold: Frank's everyday saves after reading team notes are not held
  // Positive control: a clean note in the same collection, saved in the same run with no lineage.
  const clean = await catalog.save(FRANK_CONNECTOR, { content: CLEAN, path: CLEAN_PATH, collection: "col:frank-journal" }, { grant: "clean".padEnd(64, "c") });
  if (!clean.ok) throw new Error(`clean save failed: ${JSON.stringify(clean)}`);
  if (c.collab === "grant-after") grantCollab(catalog);
  await catalog.drainOutbox();
  return { catalog, derived, clean, rateCard };
}

const missingRead = { ok: false, error: "not-found" };

describe("A3: a team-derived note never reaches a principal without team (S2d item 0)", () => {
  for (const lineage of ["declared", "observed"] as const) {
    it(`${lineage}: a multi-client admission hold retains a broader team source`, async () => {
      const clientClasses = ["client:examplecorp", "client:testfirm"];
      const { catalog } = newCatalog({ ...fx, principals: fx.principals.map((p) => p.id === "frank" ? { ...p, allowedClasses: [...p.allowedClasses, ...clientClasses] } : p) });
      try {
        catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:testfirm-approved", class: "client:testfirm", clients_ok: ["connector"], decision_row: { client: "Testfirm Partners" } });
        catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:examplecorp-approved", class: "client:examplecorp", clients_ok: ["connector"], decision_row: { client: "Examplecorp Robotics" } });
        catalog.apply(SYS, { kind: "setup" }, { kind: "principal.create", id: COLLAB.principal, email: "collab@example.invalid", allowedClasses: ["frank-private", ...clientClasses] });
        const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026");
        const team = report.admitted.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
        const clean = await catalog.save(FRANK_CONNECTOR, {
          content: "Examplecorp Robotics and Testfirm Partners: a clean shared client note.", collection: "col:frank-journal",
        }, { grant: `multi-clean-${lineage}`.padEnd(64, "c") });
        if (!clean.ok) throw new Error(`multi-client control save failed: ${JSON.stringify(clean)}`);
        expect(clean.status).toBe("held");
        expect(clean.collection).toBe("inbox:frank");
        expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [clean.noteId, clean.ver])!.privacy_class).toBe(clientClasses.join("+"));
        await catalog.drainOutbox();
        expect((await catalog.read(COLLAB, clean.cite)).ok).toBe(true);
        expect((await catalog.readBytes(COLLAB, clean.noteId, clean.ver)).ok).toBe(true);
        const grant = `multi-team-${lineage}`.padEnd(64, "t");
        if (lineage === "observed") expect((await catalog.read(FRANK_CONNECTOR, team.cite, { grant })).ok).toBe(true);
        const mixed = await catalog.save(FRANK_CONNECTOR, {
          content: "Examplecorp Robotics and Testfirm Partners: shared client summary derived from the team rate card.", collection: "col:frank-journal",
          ...(lineage === "declared" ? { derivedFrom: [team.cite] } : {}),
        }, { grant });
        if (!mixed.ok) throw new Error(`multi-client derived save failed: ${JSON.stringify(mixed)}`);
        expect(mixed.status).toBe("held");
        expect(mixed.collection).toBe("inbox:frank");
        expect(mixed.reason).toBe("client.match.quarantine"); // admission holds it; the team source itself does not narrow
        await catalog.drainOutbox();
        expect((await catalog.read(FRANK_CONNECTOR, mixed.cite)).ok).toBe(true);
        expect(await catalog.read(COLLAB, mixed.cite)).toEqual(missingRead);
        expect(await catalog.readBytes(COLLAB, mixed.noteId, mixed.ver)).toEqual(await catalog.readBytes(COLLAB, "0000000000", 1));
        expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [mixed.noteId, mixed.ver])!.privacy_class).toBe([...clientClasses, "team"].join("+"));
        expect(catalog.db.all<{ class: string }>("SELECT class FROM version_classes WHERE noteId = ? AND ver = ? ORDER BY class", [mixed.noteId, mixed.ver]).map((r) => r.class)).toEqual([...clientClasses, "team"]);
      } finally { catalog.db.close(); }
    });
  }
  for (const lineage of ["declared", "observed"] as const) {
    it(`${lineage}: a held save with team and private sources retains team when the requested destination is team`, async () => {
      const { catalog } = newCatalog(fx);
      try {
        const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "private-hiring-plan");
        const team = report.admitted.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
        const priv = report.admitted.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
        grantCollab(catalog);
        const grant = `mixed-${lineage}`.padEnd(64, "m");
        if (lineage === "observed") {
          expect((await catalog.read(FRANK_CONNECTOR, team.cite, { grant })).ok).toBe(true);
          expect((await catalog.read(FRANK_CONNECTOR, priv.cite, { grant })).ok).toBe(true);
        }
        const mixed = await catalog.save(FRANK_CONNECTOR, {
          content: "A held synthesis from the rate card and private hiring plan.",
          collection: "col:synth-desk",
          ...(lineage === "declared" ? { derivedFrom: [team.cite, priv.cite] } : {}),
        }, { grant });
        if (!mixed.ok) throw new Error(`mixed save failed: ${JSON.stringify(mixed)}`);
        expect(mixed.status).toBe("held");
        expect(mixed.collection).toBe("inbox:frank");
        await catalog.drainOutbox();
        expect((await catalog.read(FRANK_CONNECTOR, mixed.cite)).ok).toBe(true);
        // Positive control: team is only the requested destination here, so a private-only held copy stays readable.
        const privateOnly = await catalog.save(FRANK_CONNECTOR, {
          content: "A held private-only summary with no team source.",
          collection: "col:synth-desk", derivedFrom: [priv.cite],
        }, { grant: `private-only-${lineage}`.padEnd(64, "p") });
        if (!privateOnly.ok) throw new Error(`private control save failed: ${JSON.stringify(privateOnly)}`);
        expect(privateOnly.status).toBe("held");
        expect(privateOnly.collection).toBe("inbox:frank");
        await catalog.drainOutbox();
        expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [privateOnly.noteId, privateOnly.ver])!.privacy_class).toBe("frank-private");
        expect((await catalog.read(COLLAB, privateOnly.cite)).ok).toBe(true);
        expect((await catalog.readBytes(COLLAB, privateOnly.noteId, privateOnly.ver)).ok).toBe(true);
        // The inbox admits frank-private, but the source team class must still deny this collaborator.
        expect(await catalog.read(COLLAB, mixed.cite)).toEqual(missingRead);
        expect(await catalog.readBytes(COLLAB, mixed.noteId, mixed.ver)).toEqual(await catalog.readBytes(COLLAB, "0000000000", 1));
        expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [mixed.noteId, mixed.ver])!.privacy_class).toBe("frank-private+team");
        expect(catalog.db.all<{ class: string }>("SELECT class FROM version_classes WHERE noteId = ? AND ver = ? ORDER BY class", [mixed.noteId, mixed.ver]).map((r) => r.class)).toEqual(["frank-private", "team"]);
      } finally { catalog.db.close(); }
    });
  }
  for (const c of CASES) {
    it(`${c.lineage}/${c.collab}: collab cannot reach the derived note by any path, and each denial looks like a missing note; collab reads the clean note`, async () => {
      const { catalog, derived, clean } = await arena(c);
      // --- read: the cite, the bare noteId, and @99, each byte-identical to a missing note
      const missing = await catalog.read(COLLAB, "kl:0000000000@1~00000000");
      expect(missing).toEqual(missingRead);
      for (const ref of [derived.cite, derived.noteId, `kl:${derived.noteId}@99`]) expect(JSON.stringify(await catalog.read(COLLAB, ref)), ref).toBe(JSON.stringify(missing));
      expect((await catalog.read(COLLAB, clean.cite)).ok).toBe(true); // positive control
      expect((await catalog.read(FRANK_CONNECTOR, derived.cite)).ok).toBe(true); // Frank reads the derived note
      expect((await catalog.read(FRANK, derived.cite)).ok).toBe(true);
      // --- search: hits, total and coverage.preserved
      const hits = catalog.search(COLLAB, "restated", { k: 20 });
      expect(hits.hits.some((h) => h.noteId === derived.noteId)).toBe(false);
      const cleanHits = catalog.search(COLLAB, "clean journal note lineage", { k: 20 });
      expect(cleanHits.hits.some((h) => h.noteId === clean.noteId)).toBe(true); // positive control
      const frankSearch = catalog.search(FRANK_CONNECTOR, "restated", { k: 20 });
      expect(frankSearch.hits.some((h) => h.noteId === derived.noteId)).toBe(true);
      expect(hits.total).toBeLessThan(frankSearch.total);
      const journalVisible = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId = 'col:frank-journal' AND v.ver = n.currentVer AND n.status != 'withdrawn'")!.c;
      expect(hits.coverage.preserved).toBe(journalVisible - 1); // every journal note except the derived one
      expect(frankSearch.coverage.preserved).toBeGreaterThan(hits.coverage.preserved);
      // --- readBytes
      const missingBytes = await catalog.readBytes(COLLAB, "0000000000", 1);
      expect(JSON.stringify(await catalog.readBytes(COLLAB, derived.noteId, derived.ver))).toBe(JSON.stringify(missingBytes));
      expect((await catalog.readBytes(COLLAB, clean.noteId, clean.ver)).ok).toBe(true); // positive control
      // --- feedback
      expect(await catalog.feedback(COLLAB, { kind: "missed", target: derived.cite, detail: "x" })).toEqual({ ok: false, status: "refused", reason: "not-found" });
      expect((await catalog.feedback(COLLAB, { kind: "missed", target: clean.cite, detail: "x" })).ok).toBe(true); // positive control
      // --- a collab save of the identical bytes at the same path: a brand-new note, never deduped against the hidden one
      const same = await catalog.save(COLLAB, { content: DERIVED, path: PATH, collection: "col:frank-journal" });
      expect(same.ok && same.deduped === false && same.noteId !== derived.noteId && same.ver === 1, JSON.stringify(same)).toBe(true);
      const sameClean = await catalog.save(COLLAB, { content: CLEAN, path: CLEAN_PATH, collection: "col:frank-journal" });
      expect(sameClean.ok && sameClean.deduped === true && sameClean.noteId === clean.noteId, JSON.stringify(sameClean)).toBe(true); // positive control
      // the derived version itself is untouched, and it records team in its class set (the storage form of the fix)
      expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE noteId = ?", [derived.noteId])!.c).toBe(1);
      const classes = catalog.db.all<{ class: string }>("SELECT class FROM version_classes WHERE noteId = ? ORDER BY class", [derived.noteId]).map((r) => r.class);
      expect(classes).toEqual(["frank-private", "team"]);
    });
  }
  it("a principal that holds every source class keeps today's results; team as the destination's own class is not recorded", async () => {
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "private-hiring-plan");
    const rateCard = report.admitted.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
    const priv = report.admitted.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
    // team source into a team destination: plain team
    const teamToTeam = await catalog.save(FRANK_CONNECTOR, { content: "team derived into team", collection: "col:synth-desk", derivedFrom: [rateCard.cite] });
    expect(teamToTeam.ok && teamToTeam.status === "current").toBe(true);
    expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ?", [teamToTeam.ok ? teamToTeam.noteId : ""])!.privacy_class).toBe("team");
    // frank-private source into team: held at frank-private, team (the destination's own class) stays dropped as today
    const grant = "every".padEnd(64, "e");
    await catalog.read(FRANK_CONNECTOR, priv.cite, { grant });
    const held = await catalog.save(FRANK_CONNECTOR, { content: "team summary of the private plan", collection: "col:synth-desk" }, { grant });
    expect(held.ok && held.status === "held").toBe(true);
    expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ?", [held.ok ? held.noteId : ""])!.privacy_class).toBe("frank-private");
    // team source into frank-private: current (no hold), class set records team; Frank, who holds both, reads it
    const g2 = "both".padEnd(64, "b");
    await catalog.read(FRANK_CONNECTOR, rateCard.cite, { grant: g2 });
    const r = await catalog.save(FRANK_CONNECTOR, { content: "journal note after a team read" }, { grant: g2 });
    expect(r.ok && r.status === "current").toBe(true);
    expect(catalog.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ?", [r.ok ? r.noteId : ""])!.privacy_class).toBe("frank-private+team");
    expect((await catalog.read(FRANK_CONNECTOR, r.ok ? r.cite : "")).ok).toBe(true);
  });
});
