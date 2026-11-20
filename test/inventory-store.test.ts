// S2d item 1: refs.sqlite through the node:sqlite driver, ref_* tables only; a generation round-trips byte-for-byte.
import { describe, it, expect } from "vitest";
import { openNodeSqlite, migrateRefStore, saveGeneration, loadGeneration, latestCompleteGeneration, migrate } from "@kl/core";
import { seedTree, inventory, ORRERY } from "./helpers/s2d-tree.ts";

describe("ref store", () => {
  it("persists a generation with every §6.3 field and loads it back equal; only ref_* tables exist; the latest complete generation respects the 7-day window", async () => {
    const db = openNodeSqlite(":memory:");
    migrateRefStore(db);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index')").map((t) => t.name);
    expect(tables.every((t) => t.startsWith("ref_") || t.startsWith("sqlite_"))).toBe(true);
    const src = seedTree().seedFile(`${ORRERY}/big.txt`, "x", { size: 70 * 1024 * 1024 });
    const complete = await inventory(src, { now: "2026-10-01T12:00:00.000Z" });
    saveGeneration(db, complete);
    const back = loadGeneration(db, complete.generation.id)!;
    expect(back.generation).toEqual(complete.generation);
    expect(back.files).toEqual([...complete.files].sort((a, b) => (a.path < b.path ? -1 : 1)));
    expect(back.references).toEqual(complete.references);
    expect(back.candidates).toEqual(complete.candidates);
    src.setReadError(`${ORRERY}/lib/armillary/ripple-rot.ts`, "unreadable");
    const incomplete = await inventory(src, { now: "2026-10-06T12:00:00.000Z" });
    saveGeneration(db, incomplete);
    expect(loadGeneration(db, incomplete.generation.id)!.generation.complete).toBe(false);
    // the newest generation is incomplete, so the latest COMPLETE one is the older; it is within 7 days of 2026-10-07 and not of 2026-10-09
    expect(latestCompleteGeneration(db, "2026-10-07T00:00:00.000Z")?.generation.id).toBe(complete.generation.id);
    expect(latestCompleteGeneration(db, "2026-10-09T00:00:00.000Z")).toBeUndefined();
    expect(loadGeneration(db, "gen-nope")).toBeUndefined();
    // the catalog schema and the ref schema can share one node:sqlite file without touching each other's tables
    migrate(db);
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ref_%'").length).toBeGreaterThanOrEqual(8);
    db.close();
  });
});
