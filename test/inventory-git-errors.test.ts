import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { findRepository, localGitPort } from "../packages/core/src/inventory/git-port.ts";

const injected = vi.hoisted(() => ({ path: "", code: "", process: false, calls: 0, advance: undefined as (() => void) | undefined, result: {} as Record<string, unknown>, options: undefined as Record<string, unknown> | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === injected.path) throw Object.assign(new Error("injected metadata error"), { code: injected.code });
      return actual.lstatSync(...args);
    },
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => String(path) === injected.path ? false : actual.existsSync(path),
  };
});
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
    if (!injected.process) return actual.spawnSync(...args);
    injected.calls++; injected.advance?.();
    injected.options = args[2] as unknown as Record<string, unknown>;
    return injected.result;
  } };
});
let root: string, file: string;
beforeAll(() => {
  root = mkdtempSync(join(process.env.S2D_GIT_PROOF_DIR ?? tmpdir(), "kl-git-errors-"));
  file = join(root, "note.md"); writeFileSync(file, "synthetic\n"); mkdirSync(join(root, ".git"));
});
afterEach(() => { injected.path = ""; injected.code = ""; injected.process = false; injected.options = undefined; injected.calls = 0; injected.advance = undefined; vi.restoreAllMocks(); });
describe("injected Git metadata and process failures (not native permission proof)", () => {
  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) it(`holds ${code} from .git inspection`, () => {
    injected.path = join(root, ".git"); injected.code = code;
    expect(findRepository(file, root)).toBe("unknown");
    expect(localGitPort().tracking(file, root)).toBe("git-unknown");
  });
  it("only ENOENT at .git means no repository", () => {
    injected.path = join(root, ".git"); injected.code = "ENOENT";
    expect(findRepository(file, root)).toBe(null);
    expect(localGitPort().tracking(file, root)).toBe("no-repo");
  });
  it("holds failed, truncated, malformed and invalidly decoded process results", () => {
    injected.process = true;
    for (const result of [
      { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), stdout: "" },
      { status: null, error: Object.assign(new Error("overflow"), { code: "ENOBUFS" }), stdout: "" },
      { status: 1, stdout: "" }, { status: 0, signal: "SIGTERM", stdout: "" },
      { status: 0, stdout: "note.md" }, { status: 0, stdout: "different.md\0" }, { status: 0, stdout: "bad\uFFFD.md\0" },
    ]) { injected.result = result; expect(localGitPort().tracking(file, root)).toBe("git-unknown"); }
  });
  it("enforces finite process bounds and a positive environment, with tracked and untracked controls", () => {
    injected.process = true; injected.result = { status: 0, stdout: "note.md\0" };
    expect(localGitPort().tracking(file, root)).toBe("tracked");
    expect(injected.options?.timeout).toEqual(expect.any(Number));
    expect(injected.options?.timeout).toBeGreaterThan(0); expect(injected.options?.timeout).toBeLessThanOrEqual(5000); expect(injected.options?.maxBuffer).toBe(65536);
    expect(injected.options?.windowsHide).toBe(true);
    const env = injected.options?.env as NodeJS.ProcessEnv;
    expect(env.GIT_NO_LAZY_FETCH).toBe("1"); expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1"); expect(env.GIT_ALLOW_PROTOCOL).toBe("");
    expect(env.GIT_INDEX_FILE).toBeUndefined(); expect(env.GIT_DIR).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined();
    injected.result = { status: 0, stdout: "" }; expect(localGitPort().tracking(file, root)).toBe("untracked");
  });
  it("uses one monotonic deadline for all repository queries", () => {
    const nested = join(root, "deadline-inner"); mkdirSync(nested); mkdirSync(join(nested, ".git"));
    const note = join(nested, "note.md"); writeFileSync(note, "synthetic\n");
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    injected.process = true; injected.result = { status: 0, stdout: "" }; injected.advance = () => { now = 5001; };
    expect(localGitPort().tracking(note, root)).toBe("git-unknown");
    expect(injected.calls).toBe(1); // The second query cannot receive a fresh five seconds.
  });
});
