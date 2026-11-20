import { describe, it, expect, beforeAll } from "vitest";
import { type Catalog } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, PARTNER, FRANK_CONNECTOR, type LoadReport } from "./helpers/load.ts";

const fx = generateFixtures();
let catalog: Catalog, report: LoadReport;
beforeAll(async () => { ({ catalog } = newCatalog(fx)); report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal" || n.folder === "partner-scratch"); });

describe("access before ranking (A3): the partner canary", () => {
  const privateNote = () => fx.notes.find((n) => n.title === "private-hiring-plan")!;
  it("cannot see a frank-private note through search hits, total or coverage", () => {
    const a = report.admitted.get(privateNote().noteId)!;
    const partner = catalog.search(PARTNER, "private hiring plan candidate scorecard", { k: 20 });
    expect(partner.hits.some((h) => h.noteId === a.noteId)).toBe(false);
    const frank = catalog.search(FRANK_CONNECTOR, "private hiring plan candidate scorecard", { k: 20 });
    expect(frank.hits.some((h) => h.noteId === a.noteId)).toBe(true);
    expect(partner.total).toBeLessThan(frank.total);
    expect(partner.coverage.preserved).toBeLessThan(frank.coverage.preserved);
    const count = (f: string) => fx.notes.filter((n) => n.folder === f && n.expected.admission === "admitted").length;
    const team = count("synth-desk");
    expect(frank.coverage.preserved).toBe(team + count("frank-journal"));
    expect(partner.coverage.preserved).toBe(team + count("partner-scratch"));
  });
  it("read, direct object read and version-not-found paths leak no existence: denied is byte-identical to missing", async () => {
    const a = report.admitted.get(privateNote().noteId)!;
    const denied = await catalog.read(PARTNER, a.cite);
    const missing = await catalog.read(PARTNER, "kl:0000000000@1~00000000");
    expect(JSON.stringify(denied)).toBe(JSON.stringify(missing));
    const deniedBytes = await catalog.readBytes(PARTNER, a.noteId, a.ver);
    const missingBytes = await catalog.readBytes(PARTNER, "0000000000", 1);
    expect(JSON.stringify(deniedBytes)).toBe(JSON.stringify(missingBytes));
    // A version that does not exist on a note the partner cannot see must NOT say version-not-found.
    const deniedVersion = await catalog.read(PARTNER, `kl:${a.noteId}@99`);
    expect(deniedVersion).toEqual({ ok: false, error: "not-found" });
    const deniedNoteId = await catalog.read(PARTNER, a.noteId);
    expect(deniedNoteId).toEqual({ ok: false, error: "not-found" });
    // Feedback on a denied note is refused the same way as a missing one.
    expect(await catalog.feedback(PARTNER, { kind: "missed", target: a.cite, detail: "x" })).toEqual({ ok: false, status: "refused", reason: "not-found" });
  });
  it("frank cannot see partner-private either; team is visible to both", async () => {
    const scratch = fx.notes.find((n) => n.folder === "partner-scratch")!;
    const a = report.admitted.get(scratch.noteId)!;
    expect((await catalog.read(FRANK_CONNECTOR, a.cite)).ok).toBe(false);
    expect((await catalog.read(PARTNER, a.cite)).ok).toBe(true);
    const team = fx.notes.find((n) => n.title === "rate-card-2026")!;
    const t = report.admitted.get(team.noteId)!;
    expect((await catalog.read(PARTNER, t.cite)).ok).toBe(true);
  });
  it("a revoked principal sees nothing and cannot save", async () => {
    const { catalog: c } = newCatalog(fx);
    await loadFixtures(c, fx, (n) => n.title === "rate-card-2026");
    const before = c.search(PARTNER, "rate card");
    expect(before.hits.length).toBe(1);
    // revocation is receipt-gated; simulate the post-receipt projection directly to test the read path
    c.db.run("UPDATE principals SET status = 'revoked' WHERE id = 'partner'");
    expect(c.search(PARTNER, "rate card").hits.length).toBe(0);
    expect(await c.save(PARTNER, { content: "x" })).toMatchObject({ ok: false, reason: "principal-not-active" });
  });
});
