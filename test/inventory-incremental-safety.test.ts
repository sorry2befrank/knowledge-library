import { describe, expect, it } from "vitest";
import { MemoryInventorySource, runInventory, type DirEntry, type InventoryConfig, type InventoryResult, type InventorySource } from "@kl/core";

// All trees and source metadata are synthetic. No disk adapter, subprocess or native helper.
const cfg: InventoryConfig = {
  roots: [{ id: "vault", path: "/vault", sets: ["vault"] }, { id: "fleet", path: "/fleet", sets: ["fleet"] }],
  policy: { codeTypes: [".ts"], commonStems: [], fleet: { textExt: [".ts"], ignoreDirs: [], maxBytes: 1024 } },
  mode: "full", now: "2026-10-07T00:00:00.000Z",
};
const tree = () => new MemoryInventorySource().seedDir("/vault").seedDir("/fleet");
const full = (source: InventorySource) => runInventory(source, cfg);
const inc = (source: InventorySource, previous: InventoryResult) => runInventory(source, { ...cfg, mode: "incremental", now: "2026-10-07T01:00:00.000Z", previous });
const from = (r: InventoryResult, path = "/vault/source.md") => r.references.filter((x) => x.source === path);

describe("incremental resolution uses the current target universe", () => {
  it("discovers newly added targets from unchanged link, name, path, fleet and Obsidian sources", async () => {
    const src = tree().seedFile("/vault/source.md", "[[new-target]] new-target folder/new-target.md")
      .seedFile("/fleet/source.ts", "folder/new-target.md")
      .seedFile("/vault/.obsidian/workspace.json", '{"file":"folder/new-target.md"}');
    const first = await full(src);
    expect(from(first)).toContainEqual(expect.objectContaining({ kind: "unresolved", token: "new-target", target: null }));
    src.seedFile("/vault/folder/new-target.md", "New content.");
    const next = await inc(src, first);
    const control = await full(src);
    expect(next.references).toEqual(control.references);
    expect(next.generation.complete).toBe(true);
    for (const kind of ["link", "name", "path", "dependency", "ripple", "obsidian"]) {
      expect(next.references).toContainEqual(expect.objectContaining({ kind, target: "/vault/folder/new-target.md" }));
    }
  });

  it("adds and removes ambiguous candidates when duplicate names appear and disappear", async () => {
    const src = tree().seedFile("/vault/source.md", "[[plan]]").seedFile("/vault/one/plan.md", "One.");
    const first = await full(src);
    expect(from(first)).toEqual([expect.objectContaining({ kind: "link", target: "/vault/one/plan.md" })]);
    src.seedFile("/vault/two/plan.md", "Two.");
    const ambiguous = await inc(src, first);
    expect(from(ambiguous)).toEqual([expect.objectContaining({ kind: "ambiguous", target: null, candidates: ["/vault/one/plan.md", "/vault/two/plan.md"] })]);
    expect(ambiguous.references).toEqual((await full(src)).references);
    src.remove("/vault/one/plan.md");
    const single = await inc(src, ambiguous);
    expect(from(single)).toEqual([expect.objectContaining({ kind: "link", target: "/vault/two/plan.md" })]);
    expect(single.references).toEqual((await full(src)).references);
    src.remove("/vault/two/plan.md");
    const absent = await inc(src, single);
    expect(from(absent)).toEqual([expect.objectContaining({ kind: "unresolved", target: null })]);
    expect(absent.references).toEqual((await full(src)).references);
  });

  it("still reuses known unchanged sources when the target universe is unchanged", async () => {
    const src = tree().seedFile("/vault/source.md", "[[target]]").seedFile("/vault/target.md", "Target.");
    const first = await full(src), before = src.reads;
    const next = await inc(src, first);
    expect(src.reads - before).toBe(0);
    expect(next.generation.filesRead).toBe(0);
    expect(next.references).toEqual(first.references);
    expect(next.generation.lastFullReadAt).toBe(first.generation.lastFullReadAt);
  });

  it("re-extracts after an incomplete generation so a recovered target gains fleet ripple references", async () => {
    const src = tree().seedFile("/vault/folder/target.md", "Target.", { readError: "in-use" })
      .seedFile("/fleet/source.ts", "folder/target.md");
    const first = await full(src);
    expect(first.generation.complete).toBe(false);
    expect(first.references.some((r) => r.kind === "ripple")).toBe(false);
    src.setReadError("/vault/folder/target.md", null);
    const next = await inc(src, first);
    expect(next.generation.complete).toBe(true);
    expect(next.references).toContainEqual(expect.objectContaining({ source: "/fleet/source.ts", kind: "ripple", target: "/vault/folder/target.md" }));
    expect(next.references).toEqual((await full(src)).references);
  });
});

describe("required structured state participates in coverage", () => {
  it.each([
    [".obsidian/workspace.json", '{"file":"target.md"', '{"file":"target.md"}', "obsidian"],
    [".obsidian/bookmarks.json", '{"items":[', '{"items":[{"path":"target.md"}]}', "obsidian"],
    ["board.canvas", '{"nodes":[', '{"nodes":[{"file":"target.md"}]}', "canvas"],
  ])("marks malformed %s incomplete, retries it, and recovers when valid", async (relative, malformed, valid, kind) => {
    const statePath = "/vault/" + relative;
    const identity = { volumeSerial: "SYNTH", fileId: "state" };
    const src = tree().seedFile("/vault/target.md", "Target.").seedFile(statePath, malformed, { identity });
    const bad = await full(src);
    expect(bad.generation.complete).toBe(false);
    expect(bad.generation.incompleteRoots).toEqual(["vault"]);
    expect(bad.generation.readErrors).toEqual([{ root: "vault", path: statePath, code: "invalid-structured-state" }]);
    expect(bad.generation.roots.find((r) => r.id === "vault")).toMatchObject({ complete: false, readErrors: 1 });
    expect(bad.generation.roots.find((r) => r.id === "fleet")?.complete).toBe(true);
    expect(bad.files.find((f) => f.path === statePath)?.read).toBe("error");
    expect(bad.candidates).toEqual([{ path: "/vault/target.md", coverage: "coverage-incomplete" }]);
    const reads = src.reads;
    const stillBad = await inc(src, bad);
    expect(src.reads - reads).toBe(2); // incomplete prior coverage is not a cache basis
    expect(stillBad.generation.complete).toBe(false);
    src.seedFile(statePath, valid, { identity });
    const fixed = await inc(src, stillBad);
    expect(fixed.generation.complete).toBe(true);
    expect(fixed.generation.readErrors).toEqual([]);
    expect(fixed.candidates).toEqual([{ path: "/vault/target.md", coverage: "complete" }]);
    expect(from(fixed, statePath)).toEqual([expect.objectContaining({ kind, target: "/vault/target.md" })]);
  });

  it.each([
    [".obsidian/workspace.json", "null"], [".obsidian/workspace.json", "[]"],
    [".obsidian/workspace.json", '{"lastOpenFiles":"target.md"}'],
    [".obsidian/workspace.json", '{"file":7}'],
    [".obsidian/bookmarks.json", '{"items":[{"path":7}]}'],
    ["board.canvas", '{"nodes":{}}'], ["board.canvas", '{"nodes":null}'],
    ["board.canvas", '{"nodes":[null]}'], ["board.canvas", '{"nodes":[{"file":7}]}'],
  ])("reports unsupported reference field shapes in %s: %s", async (relative, content) => {
    const result = await full(tree().seedFile("/vault/target.md", "Target.").seedFile("/vault/" + relative, content));
    expect(result.generation.complete).toBe(false);
    expect(result.generation.readErrors).toEqual([{ root: "vault", path: "/vault/" + relative, code: "invalid-structured-state" }]);
  });

  it("accepts valid empty state and non-file canvas nodes", async () => {
    const result = await full(tree().seedFile("/vault/target.md", "Target.")
      .seedFile("/vault/.obsidian/workspace.json", '{"main":{},"lastOpenFiles":[]}')
      .seedFile("/vault/.obsidian/bookmarks.json", '{"items":[]}')
      .seedFile("/vault/board.canvas", '{"nodes":[{"type":"text","text":"empty"}],"edges":[]}'));
    expect(result.generation.complete).toBe(true);
    expect(result.generation.readErrors).toEqual([]);
    expect(result.references).toEqual([]);
  });
});

describe("unknown metadata never establishes unchanged content", () => {
  const identity = { volumeSerial: "SYNTH", fileId: "source" };
  const cases: [string, (entry: DirEntry) => DirEntry][] = [
    ["size", (e) => ({ ...e, size: null })],
    ["modified", (e) => ({ ...e, times: { ...e.times, modified: null } })],
    ["changed", (e) => ({ ...e, times: { ...e.times, changed: null } })],
    ["created", (e) => ({ ...e, times: { ...e.times, created: null } })],
    ["identity", (e) => ({ ...e, identity: null })],
    ["empty fileId", (e) => ({ ...e, identity: { ...identity, fileId: "" } })],
    ["empty volumeSerial", (e) => ({ ...e, identity: { ...identity, volumeSerial: "" } })],
  ];
  it.each(cases)("rereads when %s is unknown despite equal remaining metadata", async (_name, unknown) => {
    const src = tree().seedFile("/vault/old.md", "Old.").seedFile("/vault/new.md", "New.")
      .seedFile("/vault/source.md", "[[old]]", { identity });
    const port: InventorySource = {
      implementation: "memory", readShared: (path, max) => src.readShared(path, max),
      async list(path) { const result = await src.list(path); return result.ok ? { ...result, entries: result.entries.map((e) => e.name === "source.md" ? unknown(e) : e) } : result; },
    };
    const first = await full(port);
    expect(from(first)).toEqual([expect.objectContaining({ target: "/vault/old.md" })]);
    src.seedFile("/vault/source.md", "[[new]]", { identity }); // same byte length and all known timestamps
    const reads = src.reads;
    const next = await inc(port, first);
    expect(src.reads - reads).toBe(1);
    expect(from(next)).toEqual([expect.objectContaining({ target: "/vault/new.md" })]);
    expect(next.references).toEqual((await full(port)).references);
  });

  it("rereads when only creation time changed", async () => {
    const src = tree().seedFile("/vault/old.md", "Old.").seedFile("/vault/new.md", "New.")
      .seedFile("/vault/source.md", "[[old]]", { identity });
    const first = await full(src);
    src.seedFile("/vault/source.md", "[[new]]", { identity, times: { created: "2026-10-07T00:00:00.000Z" } });
    const reads = src.reads, next = await inc(src, first);
    expect(src.reads - reads).toBe(1);
    expect(from(next)).toEqual([expect.objectContaining({ target: "/vault/new.md" })]);
  });
});
