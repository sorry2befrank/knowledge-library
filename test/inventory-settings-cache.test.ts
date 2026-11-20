import { describe, expect, it } from "vitest";
import { MemoryInventorySource, runInventory, migrateRefStore, openNodeSqlite, saveGeneration, loadGeneration, type InventoryConfig, type InventoryResult } from "@kl/core";

const config: InventoryConfig = {
  roots: [{ id: "vault", path: "/vault", sets: ["vault"] }],
  policy: { codeTypes: [], commonStems: [], fleet: { textExt: [], ignoreDirs: [], maxBytes: 1024 } },
  mode: "full", now: "2026-10-07T00:00:00.000Z",
};
const full = (src: MemoryInventorySource, settings = config) => runInventory(src, settings);
const incremental = (src: MemoryInventorySource, previous: InventoryResult, settings = config) => runInventory(src, { ...settings, mode: "incremental", now: "2026-10-07T01:00:00.000Z", previous });
const fromSource = (result: InventoryResult) => result.references.filter((r) => r.source === "/vault/source.md");

describe("persisted extraction settings govern reference reuse", () => {
  it("re-resolves unchanged path mentions when a host alias moves to another existing root", async () => {
    const src = new MemoryInventorySource().seedFile("/vault/source.md", "X:/folder/target.md")
      .seedFile("/vault/folder/target.md", "One.").seedFile("/other/folder/target.md", "Two.");
    const firstConfig: InventoryConfig = { ...config, roots: [
      { id: "vault", path: "/vault", hostPaths: ["X:"], sets: ["vault"] },
      { id: "other", path: "/other", sets: ["vault"] },
    ] };
    const nextConfig: InventoryConfig = { ...config, roots: [
      { id: "vault", path: "/vault", sets: ["vault"] },
      { id: "other", path: "/other", hostPaths: ["X:"], sets: ["vault"] },
    ] };
    const first = await full(src, firstConfig);
    expect(fromSource(first)).toEqual([expect.objectContaining({ kind: "path", target: "/vault/folder/target.md" })]);
    const next = await incremental(src, first, nextConfig);
    expect(fromSource(next)).toEqual([expect.objectContaining({ kind: "path", target: "/other/folder/target.md" })]);
    expect(next.references).toEqual((await full(src, nextConfig)).references);
    expect(next.generation.extractionConfigKey).not.toBe(first.generation.extractionConfigKey);
  });

  it("adds a newly eligible bare-name reference when commonStems changes", async () => {
    const src = new MemoryInventorySource().seedFile("/vault/source.md", "plan").seedFile("/vault/plan.md", "Target.");
    const initial: InventoryConfig = { ...config, policy: { ...config.policy, commonStems: ["plan"] } };
    const first = await full(src, initial);
    expect(fromSource(first)).toEqual([]);
    const next = await incremental(src, first);
    expect(fromSource(next)).toEqual([expect.objectContaining({ kind: "name", target: "/vault/plan.md" })]);
    expect(next.references).toEqual((await full(src)).references);
  });

  it("re-resolves the same relative token when targetFolder changes", async () => {
    const src = new MemoryInventorySource().seedFile("/vault/source.md", "sub/target.md")
      .seedFile("/vault/one/sub/target.md", "One.").seedFile("/vault/two/sub/target.md", "Two.");
    const initial: InventoryConfig = { ...config, policy: { ...config.policy, targetFolder: "/vault/one" } };
    const changed: InventoryConfig = { ...config, policy: { ...config.policy, targetFolder: "/vault/two" } };
    const first = await full(src, initial);
    expect(fromSource(first)).toEqual([expect.objectContaining({ kind: "path", target: "/vault/one/sub/target.md" })]);
    const next = await incremental(src, first, changed);
    expect(fromSource(next)).toEqual([expect.objectContaining({ kind: "path", target: "/vault/two/sub/target.md" })]);
    expect(next.references).toEqual((await full(src, changed)).references);
  });

  it("rereads a snapshot with no settings key instead of assuming compatibility", async () => {
    const src = new MemoryInventorySource().seedFile("/vault/source.md", "[[target]]").seedFile("/vault/target.md", "Target.");
    const first = await full(src);
    delete first.generation.extractionConfigKey;
    first.references = []; // a legacy snapshot cannot prove which extraction settings produced it
    const reads = src.reads, next = await incremental(src, first);
    expect(src.reads - reads).toBe(2);
    expect(fromSource(next)).toEqual([expect.objectContaining({ kind: "link", target: "/vault/target.md" })]);
  });

  it("preserves zero-read reuse after persistence and equivalent settings object-key reordering", async () => {
    const db = openNodeSqlite(":memory:");
    try {
      migrateRefStore(db);
      const src = new MemoryInventorySource().seedFile("/vault/source.md", "[[target]]").seedFile("/vault/target.md", "Target.");
      const first = await full(src);
      expect(first.generation.extractionConfigKey).toMatch(/^[0-9a-f]{64}$/);
      saveGeneration(db, first);
      const restored = loadGeneration(db, first.generation.id)!;
      expect(restored.generation.extractionConfigKey).toBe(first.generation.extractionConfigKey);
      const equivalent: InventoryConfig = { ...config, roots: [{ sets: ["vault"], path: "/vault", id: "vault" }], policy: { fleet: { maxBytes: 1024, ignoreDirs: [], textExt: [] }, commonStems: [], codeTypes: [] } };
      const reads = src.reads, next = await incremental(src, restored, equivalent);
      expect(src.reads - reads).toBe(0);
      expect(next.references).toEqual(first.references);
      expect(next.generation.extractionConfigKey).toBe(first.generation.extractionConfigKey);
    } finally { db.close(); }
  });

  it("migrates an actual v1 generation without inventing a settings key and forces re-extraction", async () => {
    const db = openNodeSqlite(":memory:");
    try {
      db.exec("CREATE TABLE ref_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ref_meta VALUES ('schema_version','1');");
      db.exec("CREATE TABLE ref_generations(id TEXT PRIMARY KEY, mode TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL, lastFullReadAt TEXT, filesRead INTEGER NOT NULL, bytesRead INTEGER NOT NULL, flags TEXT NOT NULL, complete INTEGER NOT NULL, incompleteRoots TEXT NOT NULL);");
      db.run("INSERT INTO ref_generations VALUES (?,?,?,?,?,?,?,?,?,?)", ["legacy", "full", config.now, config.now, config.now, 2, 10, "[]", 1, "[]"]);
      migrateRefStore(db);
      migrateRefStore(db); // repeat migration must retain the old row and its unknown context
      expect(db.get<{ value: string }>("SELECT value FROM ref_meta WHERE key='schema_version'")?.value).toBe("2");
      expect(db.get<{ extractionConfigKey: string | null }>("SELECT extractionConfigKey FROM ref_generations WHERE id='legacy'")?.extractionConfigKey).toBeNull();
      const legacy = loadGeneration(db, "legacy")!;
      expect(legacy.generation.extractionConfigKey).toBeUndefined();
      const src = new MemoryInventorySource().seedFile("/vault/source.md", "[[target]]").seedFile("/vault/target.md", "Target.");
      const known = await full(src);
      legacy.files = known.files; // identical known metadata is insufficient without proven settings
      const reads = src.reads, next = await incremental(src, legacy);
      expect(src.reads - reads).toBe(2);
      expect(next.references).toEqual(known.references);
    } finally { db.close(); }
  });
});
