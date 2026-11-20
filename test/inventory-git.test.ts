// S2d item 1: the real read-only git port, on Linux against the installed git, in temporary repositories.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { localGitPort, findRepository } from "@kl/core";

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid", GIT_OPTIONAL_LOCKS: "0" } });
const port = localGitPort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kl-git-"));
  // outer repository with one tracked and one untracked file
  git(root, "init", "-q", "-b", "main", ".");
  writeFileSync(join(root, "tracked.md"), "tracked in the outer repository\n");
  writeFileSync(join(root, "loose.md"), "never added\n");
  git(root, "add", "tracked.md"); git(root, "commit", "-q", "-m", "outer");
  // a nested repository (not a submodule): its own files are tracked only there
  mkdirSync(join(root, "nested")); git(join(root, "nested"), "init", "-q", "-b", "main", ".");
  writeFileSync(join(root, "nested", "inner.md"), "tracked only in the inner repository\n");
  writeFileSync(join(root, "nested", "inner-loose.md"), "untracked in the inner repository\n");
  git(join(root, "nested"), "add", "inner.md"); git(join(root, "nested"), "commit", "-q", "-m", "inner");
  // a linked worktree of the outer repository
  git(root, "worktree", "add", "-q", join(root, "wt"), "-b", "wt-branch");
  writeFileSync(join(root, "wt", "wt-loose.md"), "untracked in the worktree\n");
  // a submodule added from a local path
  const sub = mkdtempSync(join(tmpdir(), "kl-sub-")); git(sub, "init", "-q", "-b", "main", "."); writeFileSync(join(sub, "sub.md"), "in the submodule\n"); git(sub, "add", "sub.md"); git(sub, "commit", "-q", "-m", "sub");
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "submod");
  writeFileSync(join(root, "submod", "sub-loose.md"), "untracked in the submodule\n");
  // an unreadable .git: a .git file that names a gitdir that does not exist
  mkdirSync(join(root, "broken")); writeFileSync(join(root, "broken", ".git"), "gitdir: /nonexistent/kl-broken-gitdir\n"); writeFileSync(join(root, "broken", "x.md"), "under an unreadable .git\n");
  mkdirSync(join(root, "garbage")); writeFileSync(join(root, "garbage", ".git"), "not a git file at all\n"); writeFileSync(join(root, "garbage", "y.md"), "under garbage\n");
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("git port (rule 5's input)", () => {
  it("decides tracking in the innermost repository, follows .git files for linked worktrees and submodules, and answers git-unknown when a .git cannot be read", () => {
    expect(port.tracking(join(root, "tracked.md"), root)).toBe("tracked");
    expect(port.tracking(join(root, "loose.md"), root)).toBe("untracked"); // positive control
    expect(findRepository(join(root, "nested", "inner.md"), root)).toEqual({ dir: join(root, "nested") }); // the nested repository, not the outer one
    expect(port.tracking(join(root, "nested", "inner.md"), root)).toBe("tracked"); // tracked only in the inner repository
    expect(port.tracking(join(root, "nested", "inner-loose.md"), root)).toBe("untracked");
    expect(findRepository(join(root, "wt", "tracked.md"), root)).toEqual({ dir: join(root, "wt") }); // the .git FILE of a linked worktree
    expect(port.tracking(join(root, "wt", "tracked.md"), root)).toBe("tracked");
    expect(port.tracking(join(root, "wt", "wt-loose.md"), root)).toBe("untracked");
    expect(findRepository(join(root, "submod", "sub.md"), root)).toEqual({ dir: join(root, "submod") }); // the .git FILE of a submodule
    expect(port.tracking(join(root, "submod", "sub.md"), root)).toBe("tracked");
    expect(port.tracking(join(root, "submod", "sub-loose.md"), root)).toBe("untracked");
    expect(port.tracking(join(root, "broken", "x.md"), root)).toBe("git-unknown");
    expect(port.tracking(join(root, "garbage", "y.md"), root)).toBe("git-unknown");
    // outside any repository
    const bare = mkdtempSync(join(tmpdir(), "kl-norepo-")); writeFileSync(join(bare, "z.md"), "no repository\n");
    expect(port.tracking(join(bare, "z.md"), bare)).toBe("no-repo");
    rmSync(bare, { recursive: true, force: true });
  });
  it("a git that fails to run answers git-unknown, never tracked or untracked", () => {
    expect(localGitPort("/nonexistent/kl-no-such-git").tracking(join(root, "tracked.md"), root)).toBe("git-unknown");
  });
});
