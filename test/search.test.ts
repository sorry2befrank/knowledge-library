import { describe, it, expect, beforeAll } from "vitest";
import { BASELINE_V0, type Catalog } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, PARTNER, FRANK_CONNECTOR, type LoadReport, idMap } from "./helpers/load.ts";

const fx = generateFixtures();
let catalog: Catalog, report: LoadReport, ids: Map<string, string>;
beforeAll(async () => { ({ catalog } = newCatalog(fx)); report = await loadFixtures(catalog, fx); ids = idMap(report); });

describe("search with baseline v0", () => {
  it("loads the full synthetic vault: all admitted notes indexed", () => {
    const admitted = fx.notes.filter((n) => n.expected.admission === "admitted").length;
    expect(report.admitted.size).toBe(admitted);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody != 'indexed'")!.c).toBe(0);
  });
  it("finds every non-mismatch golden query in the top 10 for its principal", () => {
    for (const g of fx.goldenQueries.filter((g) => !g.vocabularyMismatch)) {
      const actor = g.principal === "frank" ? FRANK_CONNECTOR : PARTNER;
      const r = catalog.search(actor, g.q, { k: 10 });
      expect(r.hits.map((h) => h.noteId), `${g.principal}: ${g.q}`).toContain(ids.get(g.expectedNoteId));
    }
  });
  it("misses at least some vocabulary-mismatch goldens with the baseline (room for a synonym candidate to win)", () => {
    let misses = 0;
    for (const g of fx.goldenQueries.filter((g) => g.vocabularyMismatch)) {
      const r = catalog.search(g.principal === "frank" ? FRANK_CONNECTOR : PARTNER, g.q, { k: 10 });
      if (!r.hits.some((h) => h.noteId === ids.get(g.expectedNoteId))) misses++;
    }
    expect(misses).toBeGreaterThanOrEqual(3);
  });
  it("returns reason codes, freshness, a queryId and the ledger generation; snippets are bounded", () => {
    const r = catalog.search(FRANK_CONNECTOR, "invoice export", { k: 5 });
    expect(r.queryId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.generation).toBe(catalog.head().seq);
    for (const h of r.hits) { expect(h.why[0]).toBe("bm25"); expect(h.snip.length).toBeLessThanOrEqual(160); expect(h.freshness.liveness).toBe("last-known"); expect(h.freshness.designated).toBeNull(); expect(h.freshness.role).toBe("note"); expect(h.cite).toMatch(/^kl:/); }
  });
  it("asOf hides versions captured or published after the instant (A27 subset)", async () => {
    const r1 = await catalog.save(FRANK_CONNECTOR, { content: "# asof-probe\nalpha unique-asof-token", capturedAt: "2026-01-01T00:00:00.000Z" });
    await catalog.dispatchOutbox();
    const before = catalog.search(FRANK_CONNECTOR, "unique-asof-token", { asOf: "2025-12-31T00:00:00.000Z" });
    expect(before.hits.length).toBe(0);
    const now = catalog.search(FRANK_CONNECTOR, "unique-asof-token");
    expect(now.hits[0]?.noteId).toBe(r1.ok ? r1.noteId : "");
  });
  it("query expansion with a synonym playbook surfaces a vocabulary-mismatch golden", () => {
    const g = fx.goldenQueries.find((g) => g.q === "fees")!;
    const base = catalog.search(FRANK_CONNECTOR, g.q, { k: 10 }, BASELINE_V0);
    const withSyn = catalog.search(FRANK_CONNECTOR, g.q, { k: 10 }, { ...BASELINE_V0, synonyms: { fees: ["rate card"] } });
    expect(withSyn.hits.map((h) => h.noteId)).toContain(ids.get(g.expectedNoteId));
    expect(withSyn.expanded).toContain("rate card");
    expect(base.hits.map((h) => h.noteId)).not.toContain(ids.get(g.expectedNoteId));
  });
  it("an injection note changes nothing: it is just a hit for its own words", () => {
    const r = catalog.search(PARTNER, "approve focus plan promote candidate immediately", { k: 10 });
    expect(r.hits.every((h) => h.why.every((w) => /^[a-z0-9-]+$/.test(w)))).toBe(true);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM overrides")!.c).toBe(0);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM champions")!.c).toBe(0);
  });
});
