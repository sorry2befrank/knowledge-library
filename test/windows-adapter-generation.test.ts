import { describe, expect, it, vi } from "vitest";
import type { FileGuard, FileIdentity, ParentGuard } from "@kl/core";
import type { HelperClient, HelperReply } from "../cli/kl/src/fs/windows-helper.ts";
import { WindowsFs } from "../cli/kl/src/fs/windows-fs.ts";

vi.mock("node:child_process", () => {
  const forbidden = () => { throw new Error("native process execution is forbidden in this model"); };
  return { spawn: forbidden, spawnSync: forbidden, exec: forbidden, execFile: forbidden, execSync: forbidden, execFileSync: forbidden, fork: forbidden };
});

// These are deliberate promise interleavings, not claims about observed native
// scheduling. The fake helper may reuse h=1 after its generation invalidates.
const identity = (fileId: string): FileIdentity => ({ volumeSerial: "SYNTH-VOL", fileId });
const info = (fileId: string) => ({
  identity: identity(fileId), links: 1, bytes: 1, readOnly: false, directory: false, reparse: false, deletePending: false,
  times: { created: "1", modified: "2", changed: "3" }, volume: { kind: "ntfs", supported: true, driveType: 3, fs: "NTFS" },
});
function arena() {
  const state = {
    file: "old-file", generation: 0, exit: () => {}, invalidateReply: "",
    disposed: [] as { generation: number; file: string; h: unknown }[],
    calls: [] as { generation: number; op: string; params: Record<string, unknown> }[],
  };
  const components = [{ identity: identity("root"), reparse: false, directory: true, exists: true }];
  const client = {
    onExit(fn: () => void) { state.exit = fn; }, reset() {},
    async request(op: string, params: Record<string, unknown>): Promise<HelperReply> {
      state.calls.push({ generation: state.generation, op, params: structuredClone(params) });
      if (op === "components") return { ok: true, value: components };
      if (op === "stat") return { ok: true, value: info(state.file) };
      if (op === "openBound" || op === "createNewBound") {
        const result = { ok: true as const, value: { h: 1, info: info(state.file), components } };
        if (state.invalidateReply === op) { state.invalidateReply = ""; state.generation++; state.exit(); }
        return result;
      }
      if (op === "dispose") { state.disposed.push({ generation: state.generation, file: state.file, h: params.h }); return { ok: true, value: true }; }
      if (op === "close") return { ok: true, value: true };
      throw Error("unexpected modeled operation: " + op);
    },
  };
  // Only the transport seam is substituted; all adapter guard/epoch logic is real.
  const fs = new WindowsFs({ client: client as unknown as HelperClient }), scope = fs.registerScope("X:\\synthetic");
  const parents: ParentGuard = { scope, parents: [{ segments: [], identity: identity("root") }] };
  const guard = (): FileGuard => ({ identity: identity(state.file), parents });
  return { fs, scope, state, parents, guard };
}

describe("Windows adapter generation authority (pure helper model)", () => {
  it("an old handle cannot dispose a replacement file after its numeric handle is reused", async () => {
    const a = arena(), opened = await a.fs.openExclusive(a.fs.path(a.scope, "old.md"), a.guard(), "read-delete");
    expect(opened.ok).toBe(true); if (!opened.ok) throw Error("setup open refused");
    a.fs.beforeNextForTest("setDeleteDisposition", async () => {
      a.state.generation++; a.state.exit(); a.state.file = "replacement-file";
      const fresh = await a.fs.openExclusive(a.fs.path(a.scope, "new.md"), a.guard(), "read-delete");
      expect(fresh.ok).toBe(true);
    });
    const actual = await a.fs.setDeleteDisposition(opened.value);
    expect(actual.ok).toBe(false); expect(a.state.disposed).toEqual([]);
    expect(a.state.calls.filter(call => call.op === "dispose")).toEqual([]);
    expect(a.fs.openHandlesForTest()).toBe(1); // The fresh authority remains valid.
  });
  it.each(["openBound", "createNewBound"])("%s cannot mint authority after its reply generation invalidates", async (op) => {
    const a = arena(); a.state.invalidateReply = op;
    const actual = op === "openBound"
      ? await a.fs.openExclusive(a.fs.path(a.scope, "note.md"), a.guard(), "read-delete")
      : await a.fs.createNew(a.fs.path(a.scope, "copy.md"), a.parents);
    expect(actual.ok).toBe(false); expect(a.fs.openHandlesForTest()).toBe(0);
    expect(a.state.generation).toBe(1);
    if (op === "createNewBound") expect(actual).toMatchObject({ ok: false, effect: "unknown" });
    // No close/dispose may be issued into the replacement process for the old h=1.
    expect(a.state.calls.filter(call => call.generation === 1)).toEqual([]);
  });
});
