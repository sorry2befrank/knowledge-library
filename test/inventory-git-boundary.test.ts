import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { findRepository, localGitPort } from "../packages/core/src/inventory/git-port.ts";

const gitBinary = process.env.S2D_TEST_GIT_BINARY ?? "git";
let root: string, a: string, b: string, hooks: string;
let env: NodeJS.ProcessEnv;
const port = localGitPort(gitBinary);
function git(cwd: string, ...args: string[]) {
  return execFileSync(gitBinary, ["-c", "core.hooksPath=" + hooks, "-c", "core.fsmonitor=false", ...args],
    { cwd, env, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
}
function ambient(values: Record<string, string>, operation: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { Object.assign(process.env, values); operation(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
beforeAll(() => {
  root = mkdtempSync(join(process.env.S2D_GIT_PROOF_DIR ?? tmpdir(), "kl-git-boundary-"));
  a = join(root, "approved"), b = join(root, "approved-sibling"), hooks = join(root, "empty-hooks");
  for (const path of [a, b, hooks, join(root, "profile")]) mkdirSync(path);
  env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    SystemDrive: process.env.SystemDrive, TEMP: root, TMP: root, HOME: join(root, "profile"), USERPROFILE: join(root, "profile"),
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_AUTHOR_NAME: "synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" };
  for (const [dir, file] of [[a, "tracked.md"], [b, "unrelated.md"]]) {
    git(dir!, "init", "-q", "-b", "main", "."); writeFileSync(join(dir!, file!), "synthetic fixture\n");
    git(dir!, "add", "--", file!); git(dir!, "commit", "-q", "-m", "synthetic");
  }
  writeFileSync(join(a, "loose.md"), "synthetic untracked control\n");
  writeFileSync(join(a, "[literal].md"), "literal pattern\n"); git(a, "--literal-pathspecs", "add", "--", "[literal].md");
  writeFileSync(join(a, "MixedCase.md"), "case control\n"); git(a, "add", "--", "MixedCase.md");
  mkdirSync(join(a, "nested")); git(join(a, "nested"), "init", "-q", "-b", "main", ".");
  writeFileSync(join(a, "nested", "inner.md"), "synthetic nested\n"); git(join(a, "nested"), "add", "--", "inner.md");
  writeFileSync(join(a, "nested", "inner-loose.md"), "synthetic nested loose\n");
  git(a, "worktree", "add", "-q", join(a, "worktree"), "-b", "linked");
  writeFileSync(join(a, "worktree", "loose.md"), "synthetic worktree loose\n");
  git(a, "-c", "protocol.file.allow=always", "submodule", "add", "-q", b, "submodule");
  writeFileSync(join(a, "submodule", "loose.md"), "synthetic submodule loose\n");
}, 120_000);
afterAll(() => {
  if (process.env.S2D_GIT_PROOF_DIR || !root) return; // Evidence runner retains its owned synthetic fixtures.
  const rel = relative(tmpdir(), root);
  if (rel.startsWith("kl-git-boundary-") && !isAbsolute(rel) && !rel.includes("..")) rmSync(root, { recursive: true, force: true });
});

describe("Git port boundary with real synthetic indexes", () => {
  it("keeps the approved index under ambient repository/index/config redirects", () => {
    expect(port.tracking(join(a, "tracked.md"), a)).toBe("tracked");
    expect(port.tracking(join(a, "loose.md"), a)).toBe("untracked");
    const redirects: Record<string, string>[] = [
      { GIT_INDEX_FILE: join(b, ".git", "index") },
      { GIT_DIR: join(b, ".git"), GIT_WORK_TREE: b },
      { GIT_COMMON_DIR: join(b, ".git") },
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" },
    ];
    for (const values of redirects) ambient(values, () => {
      expect(port.tracking(join(a, "tracked.md"), a)).toBe("tracked");
      expect(port.tracking(join(a, "loose.md"), a)).toBe("untracked");
    });
  });
  it("rejects a sibling-prefix outside repository before discovery", () => {
    expect(findRepository(join(b, "unrelated.md"), a)).toBe("unknown");
    expect(port.tracking(join(b, "unrelated.md"), a)).toBe("git-unknown");
    expect(port.tracking(join(a, "tracked.md"), a)).toBe("tracked");
  });
  it("holds a directory junction escape and a redirected .git directory", () => {
    const alias = join(a, "outside-junction"); symlinkSync(b, alias, process.platform === "win32" ? "junction" : "dir");
    expect(port.tracking(join(alias, "unrelated.md"), a)).toBe("git-unknown");
    const redirected = join(a, "redirected"); mkdirSync(redirected); writeFileSync(join(redirected, "note.md"), "synthetic\n");
    symlinkSync(join(b, ".git"), join(redirected, ".git"), process.platform === "win32" ? "junction" : "dir");
    expect(port.tracking(join(redirected, "note.md"), a)).toBe("git-unknown");
  });
  it("holds malformed ancestor .git metadata even when the inner repository and its index are valid", () => {
    const inner = join(a, "nested", "inner-loose.md"), dotGit = join(a, ".git"), backup = join(a, ".git-test-backup");
    expect(port.tracking(inner, a)).toBe("untracked");
    renameSync(dotGit, backup);
    try {
      writeFileSync(dotGit, "gitdir: ./nonexistent-ancestor-gitdir\n");
      expect(findRepository(inner, a)).toBe("unknown");
      expect(port.tracking(inner, a)).toBe("git-unknown");
    } finally { unlinkSync(dotGit); renameSync(backup, dotGit); }
    expect(port.tracking(inner, a)).toBe("untracked");
  });
  it("holds unreadable ancestor config/index while selecting only the readable innermost index", () => {
    const inner = join(a, "nested", "inner-loose.md");
    expect(port.tracking(inner, a)).toBe("untracked");
    for (const name of ["config", "index"]) {
      const metadata = join(a, ".git", name), saved = readFileSync(metadata);
      try { writeFileSync(metadata, "invalid synthetic metadata\n"); expect(port.tracking(inner, a)).toBe("git-unknown"); }
      finally { writeFileSync(metadata, saved); }
    }
    expect(port.tracking(inner, a)).toBe("untracked");
  });
  it("treats bracket filenames literally despite inherited pathspec modes", () => {
    expect(port.tracking(join(a, "[literal].md"), a)).toBe("tracked");
    ambient({ GIT_GLOB_PATHSPECS: "1", GIT_ICASE_PATHSPECS: "1" }, () => {
      expect(port.tracking(join(a, "[literal].md"), a)).toBe("tracked");
    });
    expect(port.tracking(join(a, "MixedCase.md"), a)).toBe("tracked");
    if (process.platform === "win32") expect(port.tracking(join(a, "mixedcase.md"), a)).toBe("tracked");
  });
  it("preserves innermost repository, linked worktree, submodule and true no-repo controls", () => {
    for (const [dir, tracked] of [["nested", "inner.md"], ["worktree", "tracked.md"], ["submodule", "unrelated.md"]]) {
      expect(findRepository(join(a, dir!, tracked!), a)).toEqual({ dir: join(a, dir!) });
      expect(port.tracking(join(a, dir!, tracked!), a)).toBe("tracked");
      expect(port.tracking(join(a, dir!, dir === "nested" ? "inner-loose.md" : "loose.md"), a)).toBe("untracked");
    }
    const none = join(root, "none"); mkdirSync(none); writeFileSync(join(none, "note.md"), "synthetic no repo\n");
    expect(port.tracking(join(none, "note.md"), none)).toBe("no-repo");
  });
  it("does not load ambient config or execute a configured fsmonitor helper", () => {
    const bad = join(root, "bad-global"); writeFileSync(bad, "not valid Git config\n");
    const marker = join(root, "fsmonitor-ran"), hook = join(root, "fsmonitor.sh");
    writeFileSync(hook, "#!/bin/sh\nprintf invoked > '" + marker.replaceAll("\\", "/") + "'\n", { mode: 0o700 });
    git(a, "config", "core.fsmonitor", hook);
    try {
      ambient({ GIT_CONFIG_GLOBAL: bad, GIT_CONFIG_SYSTEM: bad }, () => {
        expect(port.tracking(join(a, "tracked.md"), a)).toBe("tracked");
        expect(port.tracking(join(a, "loose.md"), a)).toBe("untracked");
      });
      expect(existsSync(marker)).toBe(false);
    } finally { git(a, "config", "--unset", "core.fsmonitor"); }
  });
  it("holds missing files and malformed .git metadata, never classifying uncertainty as absence", () => {
    expect(port.tracking(join(a, "missing.md"), a)).toBe("git-unknown");
    for (const [name, text] of [["garbage", "not git metadata\n"], ["missing", "gitdir: ./missing\n"], ["oversize", "x".repeat(5000)]]) {
      const dir = join(a, name!); mkdirSync(dir); writeFileSync(join(dir, ".git"), text!); writeFileSync(join(dir, "note.md"), "synthetic\n");
      expect(port.tracking(join(dir, "note.md"), a)).toBe("git-unknown");
    }
    expect(localGitPort(join(root, "missing-git")).tracking(join(a, "tracked.md"), a)).toBe("git-unknown");
  });
});
