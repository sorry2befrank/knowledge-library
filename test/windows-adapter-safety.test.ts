// Pure protocol models. These establish guard transfer/effect semantics, not Windows lock behavior.
import { describe, it, expect } from "vitest";
import { WindowsFs } from "../cli/kl/src/fs/windows-fs.ts";
import type { HelperClient } from "../cli/kl/src/fs/windows-helper.ts";
import type { CreatedHandle, FileGuard, ParentGuard } from "@kl/core";

const id = (fileId: string) => ({ volumeSerial: "synthetic-volume", fileId });
const info = (fileId: string) => ({ identity: id(fileId), links: 1, bytes: 1, readOnly: false, directory: false, reparse: false, deletePending: false, times: { created: "1", modified: "2", changed: "3" }, volume: { kind: "ntfs", supported: true, driveType: 3, fs: "NTFS" } });
const component = (identity: ReturnType<typeof id>) => ({ identity, reparse: false, directory: true, exists: true });
const unknown = { ok: false, code: "closed-handle", effect: "unknown" } as const;

function arena(options: { createUnknown?: boolean; postCreateChange?: boolean; closeFails?: boolean; statLinks?: number; unknownOp?: string; oldHelper?: boolean } = {}) {
  const state = { destination: id("destination"), artifact: false, placement: false, closed: 0, killed: 0, calls: [] as string[] };
  const components = (segments: string[]) => [component(id("root")), component(segments[0] === "held" ? id("held") : state.destination)];
  let exit = () => {};
  const client = {
    onExit(fn: () => void) { exit = fn; }, reset() {}, kill() { state.killed++; exit(); },
    async request(op: string, p: Record<string, any>) {
      state.calls.push(op);
      if (options.oldHelper && op.endsWith("Bound")) return { ok: false, code: "unknown-op", effect: "none" };
      // Model the native bound protocol's guard enforcement. The real lock implementation is tested separately.
      if (op.endsWith("Bound") && JSON.stringify(p.parents.map((v: any) => v.identity)) !== JSON.stringify(components(p.segments).map(c => c.identity))) return { ok: false, code: "parent-changed", effect: "none" };
      if (op === "components") return { ok: true, value: components(p.segments) };
      if (op === "createNew" || op === "createNewBound") {
        state.artifact = true;
        if (options.createUnknown) return unknown;
        const cs = components(p.segments);
        if (options.postCreateChange) cs[1] = component(id("changed-after-create"));
        return { ok: true, value: { h: 1, info: info("file"), components: cs } };
      }
      if (op === "open" || op === "openBound") return { ok: true, value: { h: 1, info: info("file"), components: components(p.segments) } };
      if (op === "stat") return { ok: true, value: { ...info("file"), links: options.statLinks ?? 1 } };
      if (op === "rename" || op === "renameBound") { state.placement = true; return { ok: true, value: info("file") }; }
      if (op === "dispose") return { ok: false, code: "access-denied", effect: "none" };
      if (op === "close") { state.closed++; return options.closeFails ? unknown : { ok: true, value: true }; }
      if (op === options.unknownOp) return unknown;
      if (["append", "flush", "readOnly"].includes(op)) return { ok: true, value: true };
      throw new Error(`Unexpected modeled operation ${op}`);
    },
  };
  const fs = new WindowsFs({ client: client as unknown as HelperClient }), scope = fs.registerScope("X:\\synthetic-model");
  const parents = (name: string): ParentGuard => ({ scope, parents: [{ segments: [], identity: id("root") }, { segments: [name], identity: id(name === "held" ? "held" : "destination") }] });
  const fileGuard = (name: string): FileGuard => ({ identity: id("file"), parents: parents(name) });
  const path = (name: string) => fs.path(scope, name, "file.txt");
  const create = async (): Promise<CreatedHandle> => { const r = await fs.createNew(path("held"), parents("held")); expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.code); return r.value; };
  return { fs, state, parents, fileGuard, path, create };
}

describe("Windows adapter safety protocol", () => {
  for (const operation of ["openExclusive", "createNew", "renameNoReplace"] as const) {
    it(`transfers destination guards to the helper for ${operation}`, async () => {
      const a = arena(), handle = operation === "renameNoReplace" ? await a.create() : undefined;
      a.fs.beforeNextForTest(operation, () => { a.state.destination = id("replacement"); });
      const result = operation === "openExclusive" ? await a.fs.openExclusive(a.path("work"), a.fileGuard("work"), "read") : operation === "createNew" ? await a.fs.createNew(a.path("work"), a.parents("work")) : await a.fs.renameNoReplace(handle!, a.path("work"), a.parents("work"));
      expect(result).toMatchObject({ ok: false, code: "parent-changed", effect: "none" });
      expect(a.state.placement).toBe(false);
      if (operation === "createNew") expect(a.state.artifact).toBe(false);
    });
  }
  it("preserves an unknown create effect", async () => {
    const a = arena({ createUnknown: true });
    expect(await a.fs.createNew(a.path("held"), a.parents("held"))).toMatchObject({ ok: false, effect: "unknown" });
    expect(a.state.artifact).toBe(true);
  });
  for (const closeFails of [false, true]) {
    it(`preserves a created artifact after rejected handoff (close failure ${closeFails})`, async () => {
      const a = arena({ postCreateChange: true, closeFails });
      expect(await a.fs.createNew(a.path("held"), a.parents("held"))).toMatchObject({ ok: false, code: "parent-changed", effect: "unknown" });
      expect(a.state.artifact).toBe(true);
      expect(a.state.closed).toBe(1);
      expect(a.state.calls).not.toContain("dispose");
      expect(a.state.killed).toBe(closeFails ? 1 : 0);
    });
  }
  for (const operation of ["append", "flush", "readOnly"] as const) {
    it(`preserves an unknown ${operation} effect`, async () => {
      const a = arena({ unknownOp: operation }), h = await a.create();
      const result = operation === "append" ? await a.fs.appendCreated(h, Buffer.from("synthetic")) : operation === "flush" ? await a.fs.flushCreated(h) : await a.fs.setReadOnly(h, true);
      expect(result).toMatchObject({ ok: false, effect: "unknown" });
    });
  }
  it("refuses a Created handle after its link count changes", async () => {
    const a = arena({ statLinks: 2 }), h = await a.create();
    expect(await a.fs.statHandle(h)).toMatchObject({ ok: false, code: "hard-linked" });
    expect(await a.fs.appendCreated(h, Buffer.from("no-write"))).toMatchObject({ ok: false, code: "hard-linked" });
    expect(a.state.calls).not.toContain("append");
  });
  it("refuses an older helper that does not enforce bound operations", async () => {
    const a = arena({ oldHelper: true });
    expect(await a.fs.createNew(a.path("held"), a.parents("held"))).toMatchObject({ ok: false, code: "unsupported", effect: "none" });
    expect(a.state.artifact).toBe(false);
  });
  it("allows guarded create, append, flush, rename, attributes and close", async () => {
    const a = arena(), h = await a.create();
    expect((await a.fs.statHandle(h)).ok).toBe(true);
    expect((await a.fs.appendCreated(h, Buffer.from("control"))).ok).toBe(true);
    expect((await a.fs.flushCreated(h)).ok).toBe(true);
    expect((await a.fs.renameNoReplace(h, a.path("work"), a.parents("work"))).ok).toBe(true);
    expect((await a.fs.setReadOnly(h, true)).ok).toBe(true);
    expect((await a.fs.close(h)).ok).toBe(true);
    expect(a.state.placement).toBe(true);
  });
});
