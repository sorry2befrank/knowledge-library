// AR2: retire one old conversation log to cold storage (docs/sessions/AR2-retire.md). Synthetic trees and a synthetic
// Codex state database only. Nothing moves unless every check passes; each file is verified before its source is deleted.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync, readdirSync, statSync, lstatSync, copyFileSync, appendFileSync, renameSync, symlinkSync, truncateSync, chmodSync, chownSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { aclAccess, aclAccessAll, aclRisk, chainOf, localDriveFormat, localFs, main, MKDIR_SCRIPT, modeAccess, modeRisk, sha256File, type RetireIo } from "../cli/sessions/src/retire.ts";

const HOUR = 3_600_000, NOW = Date.parse("2026-10-21T18:00:00Z");
const OLD = "11111111-1111-4111-8111-111111111111", NEW = "22222222-2222-4222-8222-222222222222", OTHER = "33333333-3333-4333-8333-333333333333";
const T1 = "0199aaaa-0000-7000-8000-000000000001", T1C = "0199aaaa-0000-7000-8000-000000000002", T1G = "0199aaaa-0000-7000-8000-000000000004";
const T2 = "0199aaaa-0000-7000-8000-000000000003", T1R = "0199aaaa-0000-7000-8000-0000000000ff", F1 = "0199aaaa-0000-7000-8000-000000000005";
let root: string, home: string, dest: string, umask: number | undefined;
// POSIX: what a test makes is owner-only, like what retire makes (retire refuses an archive holding anything that is not);
// a test that needs something open sets its mode itself. Windows: the same through the test folder's access list, since Temp
// can grant other accounts (a sandbox group) entries everything made in it would inherit.
// The temp folder by its real path: GitHub's Windows runner keeps TEMP under the runner account's short (8.3) name, and retire
// takes a --dest only by its real path (AR2b).
beforeEach(() => { root = mkdtempSync(join(realpathSync.native(tmpdir()), "kl-retire-")); home = join(root, "home"); dest = join(root, "archive"); if (process.platform !== "win32") umask = process.umask(0o077); else privateDir(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); if (umask !== undefined) process.umask(umask); });

function put(path: string, content: string | Buffer, mtime: number): void {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); utimesSync(path, mtime / 1000, mtime / 1000);
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const proj = () => join(home, ".claude", "projects", "synthetic-project");
/** OLD (idle 30 h, with a subagent folder), NEW (its successor, written 1 h ago) and OTHER (an unrelated session) in one project. */
function claudeTree(): void {
  put(join(proj(), `${OLD}.jsonl`), '{"type":"user","timestamp":"2026-10-01T00:00:00Z"}\n', NOW - 30 * HOUR);
  put(join(proj(), OLD, "subagents", "agent-a.jsonl"), "synthetic subagent\n", NOW - 31 * HOUR);
  put(join(proj(), OLD, "tool-results", "r.txt"), "synthetic result\n", NOW - 32 * HOUR);
  put(join(proj(), `${NEW}.jsonl`), '{"type":"user","timestamp":"2026-10-21T16:00:00Z"}\n', NOW - HOUR);
  put(join(proj(), `${OTHER}.jsonl`), "unrelated\n", NOW - 40 * HOUR);
}
async function run(argv: string[], extra: Partial<RetireIo> = {}) {
  let out = "", err = "";
  // The test's folder is trusted with everything above it (Temp need not be safe from other accounts); the AR2b tests run end
  // to end without this.
  const code = await main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s), home, now: NOW, chainTop: root, ...extra });
  return { code, out, err };
}
const claudeArgs = (...more: string[]) => ["claude", OLD, "--successor", NEW, "--dest", dest, ...more];
const manifest = () => readFileSync(join(dest, "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const python = () => { const py = ["python3", "python"].find((c) => spawnSync(c, ["--version"]).status === 0); if (!py) throw new Error("python is required"); return py; };
const restore = (...args: string[]) => spawnSync(python(), ["-I", join(dest, "restore.py"), ...args], { encoding: "utf8" });
const archived = (rel: string) => join(dest, "claude-projects", "synthetic-project", rel);
const flipByte = (p: string) => { const b = readFileSync(p); b[0] = b[0]! ^ 1; writeFileSync(p, b); };
const fail = (code: string) => { const e = new Error(code) as NodeJS.ErrnoException; e.code = code; return e; };
/** A destination a test makes itself must be private, as retire requires of an existing one: 0700, or an owner-only access list. */
function privateDir(d: string): void {
  mkdirSync(d, { recursive: true });
  if (process.platform !== "win32") { chmodSync(d, 0o700); return; }
  const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(String.fromCharCode(92));
  expect(spawnSync("icacls", [d, "/inheritance:r", "/grant:r", `${me}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]).status).toBe(0);
}
const NETWORK = "refused: --dest is a network path, whose folders cannot all be judged from here, so nothing was moved; use a folder on a local disk, or, for a share of this machine, give the folder by its local path";
/** The access-list entries icacls prints for a path, one per line, without the path itself. */
const aces = (p: string) => spawnSync("icacls", [p], { encoding: "utf8" }).stdout.split(/\r?\n/).map((l) => l.replace(p, "").trim()).filter((l) => /^\S.*:\(/.test(l));
const onlyOwner = (p: string) => {
  const list = aces(p), mine = (a: string) => a.toLowerCase().includes(`${String.fromCharCode(92)}${userInfo().username.toLowerCase()}:`);
  // This user and SYSTEM; an elevated account (as on CI) also leaves one for Administrators, which retire allows.
  expect(list.every((a) => /^NT AUTHORITY.SYSTEM:/.test(a) || /^BUILTIN.Administrators:/.test(a) || mine(a)), list.join("; ")).toBe(true);
  expect(list.some((a) => /^NT AUTHORITY.SYSTEM:/.test(a))).toBe(true); expect(list.some(mine)).toBe(true);
};

describe("sha256File", () => {
  it("hashes in chunks and agrees with a whole-file hash", () => {
    const p = join(root, "f.bin"); put(p, Buffer.from("0123456789abcdef".repeat(1000)), NOW);
    expect(sha256File(p, 7)).toBe(sha(p)); expect(sha256File(p)).toBe(sha(p));
  });
  it.skipIf(process.platform === "win32")("hashes a sparse file over 2 GiB, which readFileSync cannot read", () => {
    const p = join(root, "big.bin"); writeFileSync(p, ""); truncateSync(p, 2 ** 31 + 4096);
    expect(sha256File(p)).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

describe("retire claude", () => {
  it("without --apply prints the plan and moves nothing", async () => {
    claudeTree();
    const r = await run(claudeArgs());
    expect(r.err).toBe(""); expect(r.code).toBe(0);
    expect(r.out).toMatch(/^plan: claude 11111111-\S+ 3 files \d+ bytes/m);
    expect(r.out).toMatch(/dry run: nothing moved/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(dest)).toBe(false);
  });
  it("--apply moves the log and its folder, verified, records each file, removes the emptied folder and leaves the rest of the project alone", async () => {
    claudeTree();
    const before = { log: sha(join(proj(), `${OLD}.jsonl`)), agent: sha(join(proj(), OLD, "subagents", "agent-a.jsonl")), size: statSync(join(proj(), `${OLD}.jsonl`)).size };
    const r = await run(claudeArgs("--apply"));
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/^moved 3 files/m);
    expect(sha(archived(`${OLD}.jsonl`))).toBe(before.log); expect(sha(archived(join(OLD, "subagents", "agent-a.jsonl")))).toBe(before.agent);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false); expect(existsSync(join(proj(), OLD))).toBe(false);
    expect(existsSync(join(proj(), `${NEW}.jsonl`))).toBe(true); expect(existsSync(join(proj(), `${OTHER}.jsonl`))).toBe(true);
    const m = manifest();
    expect(m).toHaveLength(3);
    for (const e of m) { expect(e).toMatchObject({ group: "claude", client: "claude", session: OLD }); expect(sha(e.dst as string)).toBe(e.sha256); expect(join(dest, e.rel as string)).toBe(e.dst); }
    const log = m.find((e) => String(e.src).endsWith(`${OLD}.jsonl`))!;
    expect(log.size).toBe(before.size); expect(log.mtime).toBe((NOW - 30 * HOUR) / 1000);
    expect(m.at(-1)!.src).toBe(join(proj(), `${OLD}.jsonl`)); // the log moves last
    expect(existsSync(join(dest, "restore.py"))).toBe(true);
    expect(readdirSync(dest, { recursive: true }).some((n) => /\.partial$|\.staging/.test(String(n)))).toBe(false);
  });
  it("keeps the project folder even when the session was all it held", async () => {
    put(join(proj(), `${OLD}.jsonl`), "only\n", NOW - 30 * HOUR);
    put(join(home, ".claude", "projects", "other", `${NEW}.jsonl`), "next\n", NOW - HOUR);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(existsSync(proj())).toBe(true); expect(readdirSync(proj())).toEqual([]);
  });
  it("refuses a session written within --min-idle-hours (default 24), which also protects the current session", async () => {
    claudeTree();
    const r = await run(["claude", NEW, "--successor", OLD, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/^refused: .*idle/m); expect(existsSync(join(proj(), `${NEW}.jsonl`))).toBe(true);
    const lower = await run(claudeArgs("--min-idle-hours", "48", "--apply"));
    expect(lower.code).toBe(1); expect(lower.err).toMatch(/idle 30 h/);
    for (const bad of ["0", "1.5", "x"]) expect((await run(claudeArgs("--min-idle-hours", bad))).code, bad).toBe(2);
  });
  it("refuses without a successor written after the session stopped", async () => {
    claudeTree();
    const cases: [string[], RegExp][] = [
      [["claude", OLD, "--dest", dest, "--apply"], /--successor <session-id> is required/],
      [["claude", OLD, "--successor", OLD, "--dest", dest, "--apply"], /--successor must be a different session/],
      [["claude", OLD, "--successor", "99999999-9999-4999-8999-999999999999", "--dest", dest, "--apply"], /successor \S+ not found/],
      [["claude", OLD, "--successor", OTHER, "--dest", dest, "--apply"], /successor \S+ was not written after/],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(1); expect(r.err).toMatch(message);
    }
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(dest)).toBe(false);
  });
  it("refuses a session or successor id that is not a UUID, so an id can never name another file", async () => {
    claudeTree();
    put(join(home, ".claude", "history.jsonl"), "synthetic prompt history\n", NOW - 60 * HOUR);
    for (const argv of [["claude", "../../history", "--successor", NEW, "--dest", dest, "--apply"], ["claude", OLD, "--successor", "../x", "--dest", dest], ["codex", "../../state_5", "--dest", dest]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2); expect(r.err).toMatch(/UUID/);
    }
    expect(existsSync(join(home, ".claude", "history.jsonl"))).toBe(true);
  });
  it("refuses a relative --dest or one inside the folders being retired from, whatever its spelling", async () => {
    claudeTree();
    for (const d of ["relative/archive", join(home, ".claude", "projects", "archive"), join(home, ".codex", "x"), join(home, ".claude", "..archive"), join(home, ".claude", "projects", "..", "x")]) {
      const r = await run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"]);
      expect(r.code, d).not.toBe(0); expect(r.err).toMatch(/--dest/);
    }
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("refuses an unknown session, and a session id found in two projects, without printing a path", async () => {
    claudeTree();
    const r = await run(["claude", "44444444-4444-4444-8444-444444444444", "--successor", NEW, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/not found/); expect(r.err).not.toContain(home);
    put(join(home, ".claude", "projects", "second", `${OLD}.jsonl`), "twin\n", NOW - 30 * HOUR);
    const twice = await run(claudeArgs("--apply"));
    expect(twice.code).toBe(1); expect(twice.err).toMatch(/more than once/);
  });
  it("refuses a session folder that holds a link, so nothing outside it can move", async () => {
    claudeTree();
    const outside = join(root, "outside");
    put(join(outside, "precious.txt"), "not part of any session\n", NOW - 50 * HOUR);
    symlinkSync(outside, join(proj(), OLD, "linked"), "junction");
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/link/);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("never overwrites: different bytes already at a destination (even of the same size) stop the move; identical ones count as already copied", async () => {
    claudeTree();
    const target = archived(`${OLD}.jsonl`);
    const same = Buffer.from(readFileSync(join(proj(), `${OLD}.jsonl`))); same[0] = same[0]! ^ 1;
    privateDir(dest); put(target, same, NOW);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/exists with different content/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(join(proj(), OLD, "subagents", "agent-a.jsonl"))).toBe(true);
    expect(readFileSync(target)).toEqual(same);
    copyFileSync(join(proj(), `${OLD}.jsonl`), target);
    const again = await run(claudeArgs("--apply"));
    expect(again.err).toBe(""); expect(again.code).toBe(0); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false);
  });
  it("a copy whose bytes differ (same length) keeps its source, removes the bad copy, writes no manifest line for it, and exits 1", async () => {
    claudeTree();
    const corrupt = (src: string, dst: string) => { copyFileSync(src, dst); if (src.endsWith(`${OLD}.jsonl`)) flipByte(dst); };
    const r = await run(claudeArgs("--apply"), { copyFile: corrupt });
    expect(r.code).toBe(1); expect(r.err).toMatch(/did not verify/); expect(r.err).not.toContain(home);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(archived(`${OLD}.jsonl`))).toBe(false);
    expect(manifest().map((e) => e.src)).not.toContain(join(proj(), `${OLD}.jsonl`));
  });
  it("a source that changes during the move is kept, and a copy this run did not make is never deleted", async () => {
    claudeTree();
    const result = join(proj(), OLD, "tool-results", "r.txt");
    const earlier = archived(join(OLD, "tool-results", "r.txt"));
    privateDir(dest); put(earlier, readFileSync(result), NOW); // an identical copy left by an earlier run
    // Copying the first planned file (subagents/agent-a.jsonl) changes the next one's source before it is verified.
    const touch = (src: string, dst: string) => { copyFileSync(src, dst); if (src.endsWith("agent-a.jsonl")) appendFileSync(result, "late write\n"); };
    const r = await run(claudeArgs("--apply"), { copyFile: touch });
    expect(r.code).toBe(1); expect(r.err).toMatch(/r\.txt.*did not verify/);
    expect(readFileSync(result, "utf8")).toMatch(/late write/);
    expect(existsSync(earlier)).toBe(true);
  });
  it("a source written to while its own copy runs is kept, with the late write", async () => {
    claudeTree();
    const agent = join(proj(), OLD, "subagents", "agent-a.jsonl");
    const during = (src: string, dst: string) => { copyFileSync(src, dst); if (src === agent) appendFileSync(agent, "written during the copy\n"); };
    const r = await run(claudeArgs("--apply"), { copyFile: during });
    expect(r.code).toBe(1); expect(r.err).toMatch(/agent-a\.jsonl.*did not verify/);
    expect(readFileSync(agent, "utf8")).toMatch(/written during the copy/);
  });
  // Resume loop slice 4: a restore is proven before any source is deleted (board UNISON-resume-loop.md, question 13).
  it("proves a restore before deleting: a restore copy that cannot be made keeps the source and the archive copy, and leaves no trial file", async () => {
    claudeTree();
    // The trial copy is written, then fails: the partial trial file must still be removed.
    const r = await run(claudeArgs("--apply"), { trialCopy: (src, dst) => { copyFileSync(src, dst); throw fail("EIO"); } });
    expect(r.code).toBe(1); expect(r.err).toMatch(/kept .*restore trial.*EIO/);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
    expect(existsSync(archived(join(OLD, "subagents", "agent-a.jsonl")))).toBe(true);
    expect(existsSync(join(dest, "manifest.jsonl")) ? manifest() : []).toEqual([]);
    expect(readdirSync(dest, { recursive: true }).some((n) => /\.trial$/.test(String(n)))).toBe(false);
  });
  it("a restore copy whose bytes differ keeps the source and says the restore trial did not verify", async () => {
    claudeTree();
    const corrupt = (src: string, dst: string) => { copyFileSync(src, dst); if (src.endsWith(`${OLD}.jsonl`)) flipByte(dst); };
    const r = await run(claudeArgs("--apply"), { trialCopy: corrupt });
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`kept ${OLD}\\.jsonl: the restore trial did not verify`));
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(archived(`${OLD}.jsonl`))).toBe(true);
    expect(manifest().map((e) => e.src)).not.toContain(join(proj(), `${OLD}.jsonl`));
  });
  it("a source that changes during the restore trial is kept, with its change", async () => {
    claudeTree();
    const agent = join(proj(), OLD, "subagents", "agent-a.jsonl");
    const r = await run(claudeArgs("--apply"), { duringTrial: (src) => { if (src === agent) appendFileSync(agent, "written during the trial\n"); } });
    expect(r.code).toBe(1); expect(r.err).toMatch(/kept \S*agent-a\.jsonl: the source changed during the restore trial/);
    expect(readFileSync(agent, "utf8")).toMatch(/written during the trial/);
    expect(manifest().map((e) => e.src)).not.toContain(agent);
  });
  // Codex's review of PR #34 (dfecccf): the archive copy and its folder are checked again after the trial too.
  it("an archive copy overwritten after the trial copied it keeps the source and records no move", async () => {
    claudeTree();
    const swap = (src: string, dst: string) => { copyFileSync(src, dst); if (src.endsWith(`${OLD}.jsonl`)) flipByte(src); };
    const r = await run(claudeArgs("--apply"), { trialCopy: swap });
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`kept ${OLD}\\.jsonl: the archive copy changed during the restore trial`));
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    expect(manifest().map((e) => e.src)).not.toContain(join(proj(), `${OLD}.jsonl`));
  });
  it("an archive folder replaced during the trial keeps the source and writes no move record", async () => {
    claudeTree();
    let swapped = false;
    const replace = () => { if (swapped) return; swapped = true; renameSync(dest, `${dest}-moved`); privateDir(dest); };
    const r = await run(claudeArgs("--apply"), { duringTrial: replace });
    expect(r.code).toBe(1); expect(r.err).toMatch(/kept \S*agent-a\.jsonl: the destination folder was replaced during the run/);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
    expect(existsSync(join(dest, "manifest.jsonl"))).toBe(false);
  });
  it("an archive copy replaced by an identical new file during the trial is still refused: it is not the file that was verified", async () => {
    claudeTree();
    // Renamed aside, not deleted: Linux reuses a freed inode number at once, so a delete-and-rewrite can keep the same identity.
    const twin = (src: string) => { if (!src.endsWith(`${OLD}.jsonl`)) return; const a = archived(`${OLD}.jsonl`); const bytes = readFileSync(a); renameSync(a, `${a}.aside`); writeFileSync(a, bytes); };
    const r = await run(claudeArgs("--apply"), { duringTrial: twin });
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`kept ${OLD}\\.jsonl: the archive copy changed during the restore trial`));
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Codex's review of PR #34 (6e82f52): the final archive hash is a read long enough for a writer to append to the source.
  it("a source appended to during the final archive check is kept, with no move recorded", async () => {
    claudeTree();
    const log = join(proj(), `${OLD}.jsonl`);
    const r = await run(claudeArgs("--apply"), { afterArchiveCheck: (src) => { if (src === log) appendFileSync(log, "new bytes while final archive hash runs\n"); } });
    expect(r.code).toBe(1); expect(r.err).toMatch(/the source changed during the final checks/);
    expect(readFileSync(log, "utf8")).toMatch(/new bytes while final archive hash runs/);
    expect(manifest().map((e) => e.src)).not.toContain(log);
  });
  it("a same-size rewrite during the restore trial, with its time put back, is still caught by the hash", async () => {
    claudeTree();
    const agent = join(proj(), OLD, "subagents", "agent-a.jsonl");
    const sneaky = (src: string) => { if (src !== agent) return; const t = statSync(agent).mtime; flipByte(agent); utimesSync(agent, t, t); };
    const r = await run(claudeArgs("--apply"), { duringTrial: sneaky });
    expect(r.code).toBe(1); expect(r.err).toMatch(/kept \S*agent-a\.jsonl: the source changed during the restore trial/);
    expect(existsSync(agent)).toBe(true);
  });
  it("a manifest whose last line was torn by a crash gets a newline first, so the new lines stay readable", async () => {
    claudeTree();
    privateDir(dest);
    writeFileSync(join(dest, "manifest.jsonl"), '{"torn": ');
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const lines = readFileSync(join(dest, "manifest.jsonl"), "utf8").trim().split("\n");
    expect(lines[0]).toBe('{"torn": ');
    expect(lines.slice(1).map((l) => (JSON.parse(l) as { session: string }).session)).toEqual([OLD, OLD, OLD]);
  });
  it("if a manifest line cannot be written, the source stays", async () => {
    claudeTree();
    const r = await run(claudeArgs("--apply"), { appendFile: () => { throw fail("ENOSPC"); } });
    expect(r.code).toBe(1);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
  });
  it("a failure partway keeps the log in place, and a rerun finishes the job", async () => {
    claudeTree();
    const failOnce = (src: string, dst: string) => { if (src.endsWith("r.txt")) throw fail("ENOSPC"); copyFileSync(src, dst); };
    const first = await run(claudeArgs("--apply"), { copyFile: failOnce });
    expect(first.code).toBe(1); expect(first.err).toMatch(/kept .*r\.txt.*ENOSPC/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    const again = await run(claudeArgs("--apply"));
    expect(again.err).toBe(""); expect(again.code).toBe(0);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false); expect(existsSync(join(proj(), OLD))).toBe(false);
    expect(manifest()).toHaveLength(3);
  });
  it("refuses a destination that holds a different restore.py", async () => {
    claudeTree();
    put(join(dest, "restore.py"), "# an older restore script\n", NOW);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/restore\.py/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
});

describe("restore.py", () => {
  it("puts every file back byte for byte with its mtime, removes the archive copies, and never overwrites an existing file", async () => {
    claudeTree();
    const original = sha(join(proj(), `${OLD}.jsonl`));
    const mtime = statSync(join(proj(), `${OLD}.jsonl`)).mtimeMs;
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    put(join(proj(), OLD, "tool-results", "r.txt"), "a newer file at the source path\n", NOW);
    const res = restore(OLD);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/restored 2, skipped 1, missing 0, mismatched 0, failed 0, unreadable lines 0/);
    expect(sha(join(proj(), `${OLD}.jsonl`))).toBe(original); expect(statSync(join(proj(), `${OLD}.jsonl`)).mtimeMs).toBe(mtime);
    expect(readFileSync(join(proj(), OLD, "tool-results", "r.txt"), "utf8")).toBe("a newer file at the source path\n");
    expect(existsSync(archived(`${OLD}.jsonl`))).toBe(false); expect(existsSync(archived(join(OLD, "tool-results", "r.txt")))).toBe(true);
  });
  it("a tampered archive copy is not restored and is kept, and a missing one is reported; both exit 1", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    flipByte(archived(`${OLD}.jsonl`));
    rmSync(archived(join(OLD, "tool-results", "r.txt")));
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/restored 1, skipped 0, missing 1, mismatched 1/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false); expect(existsSync(archived(`${OLD}.jsonl`))).toBe(true);
  });
  it("still restores after the archive folder moves (a new drive letter, a renamed folder)", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const moved = join(root, "archive-moved"); renameSync(dest, moved);
    const res = spawnSync(python(), ["-I", join(moved, "restore.py"), OLD], { encoding: "utf8" });
    expect(res.status, res.stdout + res.stderr).toBe(0); expect(res.stdout).toMatch(/restored 3/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("skips an unreadable manifest line, restores the rest, and exits 1; a byte-order mark is fine", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const m = join(dest, "manifest.jsonl");
    writeFileSync(m, "﻿" + readFileSync(m, "utf8") + '{"torn": \n\n');
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/restored 3, .*unreadable lines 1/);
  });
  it("--dry-run changes nothing, and an unknown flag is a usage error", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const dry = restore("--dry-run", OLD);
    expect(dry.status).toBe(0); expect(dry.stdout).toMatch(/would restore 3/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false);
    expect(restore("--all").status).toBe(2);
  });
});

describe("retire codex", () => {
  const meta = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-07-14T09:30:00Z", type: "session_meta", payload: { id, ...extra } }) + "\n";
  const archDir = () => join(home, ".codex", "archived_sessions");
  const liveDir = () => join(home, ".codex", "sessions", "2026", "07", "14");
  /** A synthetic Codex home: T1 archived (with a reverted rollout), its archived child T1C (compressed) and grandchild T1G; T2 live. */
  function codexHome(o: { wal?: boolean; prefix?: boolean } = {}): string {
    const codex = join(home, ".codex"), arch = archDir();
    put(join(arch, `rollout-2026-07-14T09-30-00-${T1}.jsonl`), meta(T1) + "synthetic parent\n", NOW - 30 * HOUR);
    put(join(arch, `rollout-2026-07-15T09-30-00-${T1}_${T1R}.jsonl`), meta(T1) + "synthetic revert\n", NOW - 30 * HOUR);
    put(join(arch, `rollout-2026-07-14T09-31-00-${T1C}.jsonl.zst`), zstdCompressSync(Buffer.from(meta(T1C, { forked_from_id: T1 }) + "synthetic child\n")), NOW - 30 * HOUR);
    put(join(arch, `rollout-2026-07-14T09-32-00-${T1G}.jsonl`), meta(T1G, { forked_from_id: T1C }) + "synthetic grandchild\n", NOW - 30 * HOUR);
    put(join(liveDir(), `rollout-2026-07-14T09-30-00-${T2}.jsonl`), meta(T2) + "synthetic live\n", NOW - 30 * HOUR);
    const db = new DatabaseSync(join(codex, "state_5.sqlite"));
    if (o.wal) db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);");
    const ins = db.prepare("INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)");
    const p = (x: string) => (o.prefix ? `\\\\?\\${x}` : x);
    // The database keeps the plain name after Codex compresses a rollout, and names the newest rollout after a revert.
    ins.run(T1, p(join(arch, `rollout-2026-07-15T09-30-00-${T1}_${T1R}.jsonl`)), 1);
    ins.run(T1C, p(join(arch, `rollout-2026-07-14T09-31-00-${T1C}.jsonl`)), 1);
    ins.run(T1G, p(join(arch, `rollout-2026-07-14T09-32-00-${T1G}.jsonl`)), 1);
    ins.run(T2, join(liveDir(), `rollout-2026-07-14T09-30-00-${T2}.jsonl`), 0);
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')").run(T1, T1C);
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')").run(T1C, T1G);
    db.close();
    return join(codex, "state_5.sqlite");
  }
  it("refuses a thread Codex has not archived, and says to archive it in Codex first", async () => {
    codexHome();
    const r = await run(["codex", T2, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/archive it in Codex first/);
  });
  it("moves every rollout of an archived thread and its archived descendants (plain, compressed, reverted), parent last, leaving a WAL database byte-identical with no new side files", async () => {
    const state = codexHome({ wal: true });
    const before = sha(state);
    const side = () => readdirSync(join(home, ".codex")).filter((n) => n.startsWith("state_5")).sort();
    const sideBefore = side();
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/^moved 4 files/m);
    expect(readdirSync(join(dest, "codex-archived-sessions")).sort()).toEqual([`rollout-2026-07-14T09-30-00-${T1}.jsonl`, `rollout-2026-07-14T09-31-00-${T1C}.jsonl.zst`, `rollout-2026-07-14T09-32-00-${T1G}.jsonl`, `rollout-2026-07-15T09-30-00-${T1}_${T1R}.jsonl`]);
    expect(readdirSync(archDir())).toEqual([]);
    expect(sha(state)).toBe(before); expect(side()).toEqual(sideBefore);
    const m = manifest();
    expect(m.map((e) => e.session)).toEqual([T1, T1, T1, T1]);
    expect(String(m.at(-1)!.src)).toContain(T1); expect(String(m.at(-1)!.src)).not.toContain(T1C);
  });
  it("accepts the \\\\?\\ path form Codex can store", async () => {
    codexHome({ prefix: true });
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/^moved 4 files/m);
  });
  it("refuses an archived thread whose files are missing, with a message that says so", async () => {
    codexHome();
    for (const n of readdirSync(archDir())) if (n.includes(T1)) rmSync(join(archDir(), n));
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/files are missing/); expect(r.err).not.toMatch(/archive it in Codex first/);
  });
  it("leaves a descendant Codex has not archived in place and says so", async () => {
    const state = codexHome();
    rmSync(join(archDir(), `rollout-2026-07-14T09-32-00-${T1G}.jsonl`));
    put(join(liveDir(), `rollout-2026-07-14T09-32-00-${T1G}.jsonl`), meta(T1G) + "live grandchild\n", NOW - 30 * HOUR);
    const db = new DatabaseSync(state); db.prepare("UPDATE threads SET archived = 0, rollout_path = ? WHERE id = ?").run(join(liveDir(), `rollout-2026-07-14T09-32-00-${T1G}.jsonl`), T1G); db.close();
    const r = await run(["codex", T1, "--dest", dest]);
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/3 files/); expect(r.out).toMatch(/left in place: 1/);
  });
  it("refuses when a thread outside the retirement forks from one inside it, reading plain and compressed first lines", async () => {
    codexHome();
    const fork = JSON.stringify({ timestamp: "2026-07-16T00:00:00Z", type: "session_meta", payload: { id: F1, history_base: { thread_id: T1 } } }) + "\n";
    put(join(home, ".codex", "sessions", "2026", "07", "16", `rollout-2026-07-16T00-00-00-${F1}.jsonl.zst`), zstdCompressSync(Buffer.from(fork + "synthetic fork\n")), NOW - 30 * HOUR);
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`${F1} forks from ${T1}`));
    expect(readdirSync(archDir()).length).toBe(4);
  });
  it("an unarchived descendant that forks from a thread being retired blocks the retirement", async () => {
    const state = codexHome();
    const db = new DatabaseSync(state); db.prepare("UPDATE threads SET archived = 0 WHERE id = ?").run(T1G); db.close();
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`${T1G} forks from ${T1C}`));
  });
  it("refuses when a rollout's first line cannot be read to check for forks", async () => {
    codexHome();
    put(join(home, ".codex", "sessions", "2026", "07", "16", `rollout-2026-07-16T00-00-00-${F1}.jsonl`), "not json\n", NOW - 30 * HOUR);
    const r = await run(["codex", T1, "--dest", dest]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/cannot read/);
  });
  it("refuses an archived thread written within --min-idle-hours", async () => {
    codexHome();
    utimesSync(join(archDir(), `rollout-2026-07-14T09-30-00-${T1}.jsonl`), (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/idle 1 h/);
  });
  it("restore.py by thread id brings back the subagent threads retired with it", async () => {
    codexHome();
    expect((await run(["codex", T1, "--dest", dest, "--apply"])).code).toBe(0);
    const res = restore(T1);
    expect(res.status, res.stdout).toBe(0); expect(res.stdout).toMatch(/restored 4/);
    expect(readdirSync(archDir()).length).toBe(4);
  });
  // Re-review of PR #29 (round 3).
  it("a fork whose history_base names a ROLLOUT id of a moving thread (a revert) blocks the retirement", async () => {
    codexHome();
    const fork = JSON.stringify({ timestamp: "2026-07-16T00:00:00Z", type: "session_meta", payload: { id: F1, history_base: { thread_id: T1R } } }) + "\n";
    put(join(home, ".codex", "sessions", "2026", "07", "16", `rollout-2026-07-16T00-00-00-${F1}.jsonl`), fork + "synthetic fork\n", NOW - 30 * HOUR);
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`${F1} forks from ${T1R}`));
  });
  it("refuses while Codex holds a writer lock file for a moving thread, and says how to clear a stale one", async () => {
    codexHome();
    put(join(home, ".codex", "thread-writer-locks", `${T1C}.lock`), "", NOW - 30 * HOUR);
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(new RegExp(`writer lock.*${T1C}`)); expect(r.err).toMatch(/stale/); expect(r.err).not.toContain(home);
  });
  it("a row marked archived whose path is outside archived_sessions is not treated as archived", async () => {
    const state = codexHome();
    const db = new DatabaseSync(state); db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(join(liveDir(), `rollout-2026-07-14T09-30-00-${T1}.jsonl`), T1); db.close();
    const r = await run(["codex", T1, "--dest", dest]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/not archived in Codex/);
  });
  it("an archived descendant whose files are gone is left in place and reported", async () => {
    codexHome();
    rmSync(join(archDir(), `rollout-2026-07-14T09-32-00-${T1G}.jsonl`));
    const r = await run(["codex", T1, "--dest", dest]);
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/3 files/); expect(r.out).toMatch(/left in place: 1/);
  });
  // Third review of PR #29 (round 4).
  it("refuses a link inside --dest that leads into a sub-folder of Codex's live sessions", async () => {
    codexHome();
    mkdirSync(dest, { recursive: true });
    mkdirSync(join(home, ".codex", "sessions", "2026"), { recursive: true });
    symlinkSync(join(home, ".codex", "sessions", "2026"), join(dest, "codex-archived-sessions"), "junction");
    const r = await run(["codex", T1, "--dest", dest, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/leads back into/);
    expect(readdirSync(archDir()).length).toBe(4);
  });
});

describe("round 4: retire", () => {
  it("refuses a link inside --dest that leads into a sub-folder of the Claude projects folder", async () => {
    claudeTree();
    mkdirSync(join(home, ".claude", "projects", "other-project"), { recursive: true });
    mkdirSync(dest, { recursive: true });
    symlinkSync(join(home, ".claude", "projects", "other-project"), join(dest, "claude-projects"), "junction");
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/leads back into/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it.skipIf(process.platform !== "win32")("refuses a --dest through the admin-share alias plus a junction to a sub-folder of the projects folder", async (ctx) => {
    claudeTree();
    mkdirSync(join(home, ".claude", "projects", "other-project"), { recursive: true });
    symlinkSync(join(home, ".claude", "projects", "other-project"), join(root, "alias"), "junction");
    const unc = String.fromCharCode(92, 92) + "localhost" + String.fromCharCode(92) + join(root, "alias", "archive").replace(/^([A-Za-z]):/, "$1$");
    if (!existsSync(join(unc, ".."))) { ctx.skip(); return; }
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", unc]);
    // Since AR2b a network path is refused before any check opens it over the network (review of 874eac0).
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest is a network path/);
  });
  it("refuses a staging folder that is a link, and clears only its own leftovers", async () => {
    claudeTree();
    const elsewhere = join(root, "elsewhere"); put(join(elsewhere, "keep.partial"), "not retire's", NOW);
    privateDir(dest);
    symlinkSync(elsewhere, join(dest, ".staging"), "junction");
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/staging/); expect(existsSync(join(elsewhere, "keep.partial"))).toBe(true);
    rmSync(join(dest, ".staging"), { recursive: false, force: true });
    put(join(dest, ".staging", "user-notes.partial"), "not retire's either", NOW);
    put(join(dest, ".staging", "0123456789abcdef.partial"), "a crash leftover", NOW);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(readdirSync(join(dest, ".staging"))).toEqual(["user-notes.partial"]);
  });
});

describe("round 4: restore.py", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file restored whose archive copy cannot be removed counts as restored, with the copy reported as left", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const folder = join(dest, "claude-projects", "synthetic-project");
    chmodSync(folder, 0o555);
    try {
      const res = restore(OLD);
      expect(res.stdout).toMatch(/restored 3, .*failed 0/); expect(res.stdout).toMatch(/archive copies left 1/);
      expect(res.status).toBe(0);
    } finally { chmodSync(folder, 0o755); }
  });
  it("--dry-run counts an archive copy it cannot read as failed and still prints the summary", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    rmSync(archived(`${OLD}.jsonl`)); mkdirSync(archived(`${OLD}.jsonl`));
    const dry = restore("--dry-run", OLD);
    expect(dry.status).toBe(1); expect(dry.stdout).toMatch(/would restore 2, .*failed 1/);
  });
  it("a line whose fields have the wrong types (or a NaN mtime) is counted as unreadable; the rest restore", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const m = join(dest, "manifest.jsonl");
    appendFileSync(m, '{"src": null, "dst": "x", "sha256": "y"}' + String.fromCharCode(10) + '{"src": "a", "dst": "b", "sha256": "c", "mtime": NaN}' + String.fromCharCode(10));
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/restored 3, .*unreadable lines 2/);
  });
  it("for 2026-10-21 entries the session is read from the path inside the client folder, not from an ancestor with an id", async () => {
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), join(dest, "restore.py"));
    const project = join(home, ".claude", "projects", `C--Temp-claude-x-${OTHER}-scratchpad`);
    const lines = [OLD, NEW].map((id) => {
      const copy = join(dest, "claude-projects", `C--Temp-claude-x-${OTHER}-scratchpad`, `${id}.jsonl`);
      put(copy, `${id} bytes\n`, NOW - 90 * HOUR);
      return JSON.stringify({ group: "claude", src: join(project, `${id}.jsonl`), dst: copy, size: 1, mtime: (NOW - 90 * HOUR) / 1000, sha256: sha(copy), movedAt: 1 });
    });
    writeFileSync(join(dest, "manifest.jsonl"), lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    const wide = restore("scratchpad");
    expect(wide.status).toBe(2); expect(wide.stdout).toMatch(/2 sessions/);
  });
  it("restores a 2026-10-21 style Codex entry (codex-sessions, no rel) from an archive that has moved", async () => {
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), join(dest, "restore.py"));
    const name = `rollout-2026-07-14T09-30-00-${T2}.jsonl`;
    const src = join(home, ".codex", "sessions", "2026", "07", "14", name);
    const copy = join(dest, "codex-sessions", "2026", "07", "14", name);
    put(copy, "old codex bytes\n", NOW - 90 * HOUR);
    writeFileSync(join(dest, "manifest.jsonl"), JSON.stringify({ group: "codex", src, dst: join(root, "gone", "2026-10-21", "codex-sessions", "2026", "07", "14", name), size: 16, mtime: (NOW - 90 * HOUR) / 1000, sha256: sha(copy), movedAt: 1 }) + String.fromCharCode(10));
    const res = restore(T2);
    expect(res.status, res.stdout + res.stderr).toBe(0); expect(readFileSync(src, "utf8")).toBe("old codex bytes\n");
  });
});

describe("round 3: retire", () => {
  it("never deletes the only copy when a link inside --dest leads back to the source tree", async () => {
    claudeTree();
    mkdirSync(dest, { recursive: true });
    symlinkSync(join(home, ".claude", "projects"), join(dest, "claude-projects"), "junction");
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest|back into/);
    expect(readFileSync(join(proj(), `${OLD}.jsonl`), "utf8")).toMatch(/2026-10-01/);
  });
  it("refuses a --dest reached through a link into the folders being retired from", async () => {
    claudeTree();
    const alias = join(root, "alias");
    symlinkSync(join(home, ".claude"), alias, "junction");
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", join(alias, "archive"), "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest/);
    expect(existsSync(join(home, ".claude", "archive"))).toBe(false);
  });
  it("refuses a destination file that is a link to the source itself (deleting the source would leave it dangling)", async (ctx) => {
    claudeTree();
    const target = archived(`${OLD}.jsonl`);
    mkdirSync(join(target, ".."), { recursive: true });
    try { symlinkSync(join(proj(), `${OLD}.jsonl`), target, "file"); } catch { ctx.skip(); return; } // Windows without the symlink privilege
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/is the source file itself/);
    expect(readFileSync(join(proj(), `${OLD}.jsonl`), "utf8")).toMatch(/2026-10-01/);
  });
  it.skipIf(process.platform !== "win32")("refuses a --dest given through the admin-share alias of a protected folder", async (ctx) => {
    claudeTree();
    const unc = String.fromCharCode(92, 92) + "localhost" + String.fromCharCode(92) + join(home, ".claude", "x").replace(/^([A-Za-z]):/, "$1$");
    if (!existsSync(join(unc, ".."))) { ctx.skip(); return; } // no admin share on this machine
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", unc]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest is a network path/); // refused before it is opened (AR2b)
  });
  it("refuses a --dest with a folder name ending in a dot or a space", async () => {
    claudeTree();
    for (const d of [join(root, "archive."), join(root, "archive "), join(root, "x.", "archive")]) {
      const r = await run(["claude", OLD, "--successor", NEW, "--dest", d]);
      expect(r.code, JSON.stringify(d)).toBe(1); expect(r.err).toMatch(/--dest/);
    }
  });
  it("keeps the source mtime on the archive copy, on every platform", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(statSync(archived(`${OLD}.jsonl`)).mtimeMs).toBe(NOW - 30 * HOUR);
  });
  it.skipIf(process.platform === "win32")("archive copies are owner-only (0600) and the archive folders 0700, whatever the source's mode", async () => {
    claudeTree();
    process.umask(0o022); // the usual umask, so the modes below are retire's own
    chmodSync(join(proj(), `${OLD}.jsonl`), 0o644);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(statSync(archived(`${OLD}.jsonl`)).mode & 0o777).toBe(0o600);
    expect(statSync(dest).mode & 0o077).toBe(0); expect(statSync(join(dest, "claude-projects")).mode & 0o077).toBe(0);
    expect(statSync(join(dest, "manifest.jsonl")).mode & 0o077).toBe(0); expect(statSync(join(dest, "restore.py")).mode & 0o077).toBe(0);
    expect(restore(OLD).status).toBe(0);
    expect(statSync(join(proj(), `${OLD}.jsonl`)).mode & 0o077).toBe(0);
  });
  // Fourth review (round 5): on Windows mode bits do nothing; the archive folder's access list is what keeps it private.
  // Fifth review (round 6): an existing destination that is not private is refused, not just warned about.
  // AR2b: a parent that gives everyone full control on itself lets them swap the new folder, so it is now refused (see the AR2b
  // tests); full control passed down through inherit-only entries is what a new folder must not keep.
  it.skipIf(process.platform !== "win32")("on Windows a new archive folder gets an access list of only this user and SYSTEM, even under a parent whose folders inherit full control for everyone", async () => {
    claudeTree();
    const parent = join(root, "open-parent"); mkdirSync(parent);
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-1-0:(OI)(CI)(IO)F"]).status).toBe(0); // Everyone, by its SID
    const d = join(parent, "2026-10-22");
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0);
    onlyOwner(d); onlyOwner(join(d, "claude-projects", "synthetic-project", `${OLD}.jsonl`)); onlyOwner(join(d, "manifest.jsonl"));
  });
  // AR2b (reviews of d910e90 to 54b7f26): no command to make it private is printed. Every form of one misled somewhere: a path a
  // shell expands sent it to the folder above, an account icacls cannot resolve failed it, an explicit entry for another
  // account survived it, a drive root's change reached the whole drive, and folders above that could be swapped refused anyway.
  it("--apply refuses an existing destination open to other accounts; the dry run says to use a new folder, which goes ahead", async () => {
    claudeTree();
    mkdirSync(dest);
    // POSIX: readable by group and others. Windows: an explicit Everyone entry to read it. Neither lets others remove anything,
    // so a new folder inside it or beside it goes ahead.
    if (process.platform === "win32") expect(spawnSync("icacls", [dest, "/grant", "*S-1-1-0:(OI)(CI)RX"]).status).toBe(0); else chmodSync(dest, 0o755);
    const dry = await run(claudeArgs());
    expect(dry.code).toBe(0); expect(dry.out).toMatch(/warning: the destination is open to other accounts on this machine; --apply refuses it. To go ahead, use a new folder \(retire makes a new one private\)$/m);
    expect(dry.out).not.toMatch(/icacls|chmod|make this one private/);
    const refused = await run(claudeArgs("--apply"));
    expect(refused.code).toBe(1); expect(refused.err).toMatch(/refused: the destination is open to other accounts on this machine, so nothing was moved; use a new folder \(retire makes a new one private\)$/m);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(join(dest, "manifest.jsonl"))).toBe(false);
    const fresh = join(root, "fresh-archive");
    const ok = await run(["claude", OLD, "--successor", NEW, "--dest", fresh, "--apply"]);
    expect(ok.err).toBe(""); expect(ok.code).toBe(0); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false);
    if (process.platform === "win32") onlyOwner(fresh); else expect(statSync(fresh).mode & 0o077).toBe(0);
  });
  it.skipIf(process.platform !== "win32")("on Windows an existing destination open to any other account is refused, not only Everyone, Users and Authenticated Users", async () => {
    claudeTree();
    privateDir(dest);
    expect(spawnSync("icacls", [dest, "/grant", "*S-1-5-32-546:(OI)(CI)RX"]).status).toBe(0); // the Guests group
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination is open to other accounts/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    expect(r.err).toMatch(/so nothing was moved; use a new folder \(retire makes a new one private\)$/m);
  });
  // Review of 4dcb602: a file inside the destination with a very long access list (one another account could plant) is read
  // in full and refused for what it is, not as a run of Windows PowerShell that failed.
  it.skipIf(process.platform !== "win32")("on Windows a file inside the destination with 1 500 access-list entries is read and refused as open", async () => {
    claudeTree();
    privateDir(dest); writeFileSync(join(dest, "manifest.jsonl"), "");
    const grant = "$ErrorActionPreference = 'Stop'; $f = [IO.FileInfo]$env:F; $a = $f.GetAccessControl('Access'); " +
      "foreach ($n in 1..1500) { $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier(\"S-1-5-21-1111111111-2222222222-3333333333-$n\")), 'ReadData', 'Allow'))) }; $f.SetAccessControl($a)";
    expect(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", grant], { env: { ...process.env, F: join(dest, "manifest.jsonl") } }).status).toBe(0);
    const dry = await run(claudeArgs());
    expect(dry.code).toBe(0); expect(dry.out).toContain("warning: a folder or file inside the destination is open to other accounts on this machine; --apply refuses it. To go ahead, use a new folder");
  }, 120_000);
  // Review of 54b7f26: in an existing destination with case sensitivity turned on, a name that differs from one retire writes
  // only in letter case is another name, not a link, and retire writes its own beside it.
  it.skipIf(process.platform !== "win32")("on Windows an existing case-sensitive destination holding case twins of retire's names is used, not refused as a link", async (ctx) => {
    claudeTree();
    privateDir(dest);
    if (spawnSync("fsutil", ["file", "setCaseSensitiveInfo", dest, "enable"]).status !== 0) { ctx.skip(); return; }
    mkdirSync(join(dest, "Claude-Projects")); writeFileSync(join(dest, "Manifest.jsonl"), ""); mkdirSync(join(dest, ".Staging"));
    const dry = await run(claudeArgs());
    expect(dry.code).toBe(0); expect(dry.out).not.toContain("warning:");
    const r = await run(claudeArgs("--apply"));
    expect(r.err).toBe(""); expect(r.code).toBe(0);
    expect(existsSync(archived(`${OLD}.jsonl`))).toBe(true); expect(readFileSync(join(dest, "Manifest.jsonl"), "utf8")).toBe("");
    expect(readdirSync(join(dest, "Claude-Projects"))).toEqual([]);
  });
  it.skipIf(process.platform !== "win32")("on Windows a .staging folder open to other accounts is refused, since a copy takes its access list from where it is made", async () => {
    claudeTree();
    privateDir(dest); mkdirSync(join(dest, ".staging"));
    expect(spawnSync("icacls", [join(dest, ".staging"), "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination's \.staging folder is open to other accounts/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Security review of 39ac361: the owner of a folder can always rewrite its access list, so it counts as well; and the check
  // runs inside --apply, after the folder is in its final state.
  it("judges an access list by its owner and allow entries, and anything unexpected as unknown", () => {
    const ME = "S-1-5-21-1-2-3-1001", OTHER_USER = "S-1-5-21-1-2-3-1002";
    const out = (...lines: string[]) => lines.join("\r\n") + "\r\n";
    // One entry as ACL_SCRIPT prints it: type, SID, rights mask (8 hex digits), and 1 when it is inherit-only.
    const ace = (type: string, sid: string, mask = "001F01FF", inheritOnly = "0") => `${type} ${sid} ${mask} ${inheritOnly}`;
    const priv = aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME), ace("Allow", "S-1-5-18"), ace("Allow", "S-1-5-32-544"), ace("Allow", "S-1-3-0", "10000000", "1"), ace("Deny", OTHER_USER, "00010000")));
    expect(priv.state).toBe("private"); expect(priv.me).toBe(ME); expect(priv.owner).toBe(ME);
    expect(priv.entries).toEqual([
      { allow: true, sid: ME, mask: 0x1f01ff, inheritOnly: false }, { allow: true, sid: "S-1-5-18", mask: 0x1f01ff, inheritOnly: false },
      { allow: true, sid: "S-1-5-32-544", mask: 0x1f01ff, inheritOnly: false }, { allow: true, sid: "S-1-3-0", mask: 0x10000000, inheritOnly: true },
      { allow: false, sid: OTHER_USER, mask: 0x10000, inheritOnly: false },
    ]);
    // A mask with the top bit set (generic read) is read as a positive number.
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME, "E0010000"))).entries).toEqual([{ allow: true, sid: ME, mask: 0xe0010000, inheritOnly: false }]);
    // OWNER RIGHTS matches only the owner, which must already be this user, SYSTEM or Administrators (review of 54b7f26).
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME), ace("Allow", "S-1-3-4"))).state).toBe("private");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${OTHER_USER}`, ace("Allow", ME), ace("Allow", "S-1-3-4"))).state).toBe("foreign");
    // AppContainer package and capability SIDs let no account in that its own entries do not (review of f0154ee).
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME), ace("Allow", "S-1-15-3-4096"), ace("Allow", "S-1-15-2-1"))).state).toBe("private");
    expect(aclAccess(0, out(`me ${ME}`, "owner S-1-5-32-544", ace("Allow", ME))).state).toBe("private");
    expect(aclAccess(0, out(`me ${ME}`, "owner S-1-5-18", ace("Allow", ME))).state).toBe("private");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${OTHER_USER}`, ace("Allow", ME))).state).toBe("foreign");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${OTHER_USER}`, ace("Allow", "S-1-1-0"))).state).toBe("foreign");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", OTHER_USER))).state).toBe("open");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", "S-1-1-0"))).state).toBe("open");
    // Inside the archive an inherit-only entry still counts: it reaches every file and folder made there.
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", "S-1-1-0", "001F01FF", "1"))).state).toBe("open");
    expect(aclAccess(1, out(`me ${ME}`, `owner ${ME}`))).toEqual({ state: "unknown", me: ME });
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, "Allow something else")).state).toBe("unknown");
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, `Allow ${ME}`)).state).toBe("unknown"); // no mask
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME, "1F01FF"))).state).toBe("unknown"); // not 8 digits
    expect(aclAccess(0, out(`me ${ME}`, `owner ${ME}`, ace("Allow", ME, "001F01FF", "2"))).state).toBe("unknown");
    expect(aclAccess(0, out(`me ${ME}`, ace("Allow", ME))).state).toBe("unknown");
    expect(aclAccess(0, out(`owner ${ME}`, ace("Allow", ME))).state).toBe("unknown");
    expect(aclAccess(null, "").state).toBe("unknown");
  });
  it("judges a POSIX folder private only when this user owns it and no group or other bits are set", () => {
    expect(modeAccess(0o40700, 1000, 1000)).toBe("private");
    expect(modeAccess(0o40750, 1000, 1000)).toBe("open");
    expect(modeAccess(0o40701, 1000, 1000)).toBe("open");
    expect(modeAccess(0o40700, 1001, 1000)).toBe("foreign");
    expect(modeAccess(0o40755, 1001, 1000)).toBe("foreign");
  });
  it("refuses a new archive folder that something was put into before it was made private, and moves nothing", async () => {
    claudeTree();
    const planted = (d: string) => { mkdirSync(join(d, ".staging")); };
    const r = await run(claudeArgs("--apply"), { madeFolder: planted });
    expect(r.code).toBe(1); expect(r.err).toMatch(/refused: something was put into the new archive folder before it was private, so nothing was moved; use a new folder/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(join(dest, "manifest.jsonl"))).toBe(false); expect(existsSync(join(dest, "restore.py"))).toBe(false);
  });
  // Review of e365baf: what was planted survives that first refusal, so a rerun must check it too; and a new folder that will
  // not stay private gets advice for a new folder.
  it.skipIf(process.platform !== "win32")("on Windows a folder planted before the new archive folder was private is refused on the rerun too", async () => {
    claudeTree();
    const plant = (d: string) => { mkdirSync(join(d, "claude-projects")); expect(spawnSync("icacls", [join(d, "claude-projects"), "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); };
    const first = await run(claudeArgs("--apply"), { madeFolder: plant });
    expect(first.code).toBe(1); expect(first.err).toMatch(/something was put into the new archive folder/);
    const dry = await run(claudeArgs());
    expect(dry.out).toMatch(/warning: a folder or file inside the destination is open to other accounts on this machine; --apply refuses it/);
    const again = await run(claudeArgs("--apply"));
    expect(again.code).toBe(1); expect(again.err).toMatch(/refused: a folder or file inside the destination is open to other accounts on this machine, so nothing was moved; use a new folder/);
    expect(again.err).not.toMatch(/synthetic-project|claude-projects/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it.skipIf(process.platform !== "win32")("on Windows an open manifest (retire appends to it) or restore.py (others could change it) in a private destination is refused", async () => {
    claudeTree();
    for (const name of ["manifest.jsonl", "restore.py"]) {
      rmSync(dest, { recursive: true, force: true }); privateDir(dest);
      if (name === "restore.py") copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), join(dest, name)); else writeFileSync(join(dest, name), "");
      expect(spawnSync("icacls", [join(dest, name), "/grant", "*S-1-1-0:F"]).status).toBe(0);
      const r = await run(claudeArgs("--apply"));
      expect(r.code, name).toBe(1); expect(r.err).toMatch(/a folder or file inside the destination is open to other accounts/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    }
  });
  it("a new archive folder that does not stay private (a drive that ignores access settings) is removed, with advice for a new folder", async () => {
    claudeTree();
    const ignored = (d: string) => { if (process.platform === "win32") expect(spawnSync("icacls", [d, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); else chmodSync(d, 0o755); };
    const r = await run(claudeArgs("--apply"), { madePrivate: ignored });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refused: could not make the new archive folder private \(it is still open to other accounts\), so nothing was moved; use a folder on a drive that keeps owner-only access/);
    expect(r.err).not.toMatch(/chmod|icacls/); expect(existsSync(dest)).toBe(false); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("checks an existing destination inside --apply, right before writing, not only in the plan", async () => {
    claudeTree();
    privateDir(dest);
    // The folder turns open after the plan was made (here: as retire is about to use it).
    const opened = () => { if (process.platform === "win32") expect(spawnSync("icacls", [dest, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); else chmodSync(dest, 0o755); };
    const r = await run(claudeArgs("--apply"), { beforeApply: opened });
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination is open to other accounts/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  /** Run with an environment variable set, then put it back (deleting it when it was not set). */
  async function withEnv<T>(name: string, value: string, f: () => Promise<T>): Promise<T> {
    const saved = process.env[name];
    process.env[name] = value;
    try { return await f(); } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
  }
  /** Run with Windows' own folder unreachable, so neither icacls nor PowerShell can start. */
  const withoutSystemTools = <T>(f: () => Promise<T>) => withEnv("SystemRoot", join(root, "no-windows"), f);
  it.skipIf(process.platform !== "win32")("on Windows works when started from PowerShell 7, whose module path Windows PowerShell then inherits", async (ctx) => {
    const pwsh = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSHOME"], { encoding: "utf8" });
    if (pwsh.status !== 0) { ctx.skip(); return; }
    claudeTree();
    const modules = [join(pwsh.stdout.trim(), "Modules"), process.env.PSModulePath].filter(Boolean).join(";");
    const r = await withEnv("PSModulePath", modules, () => run(claudeArgs("--apply")));
    expect(r.err).toBe(""); expect(r.code).toBe(0); onlyOwner(dest);
  });
  it.skipIf(process.platform !== "win32")("on Windows a new archive folder that cannot be made private is removed, so a rerun cannot archive into it; an empty folder that was already there stays, however --dest is written", async () => {
    claudeTree();
    const BS = String.fromCharCode(92);
    // The same folder as a plain path, in the extended-length form, and through the admin share (when this machine has it).
    const forms: [string, (p: string) => string][] = [["plain", (p) => p], ["extended", (p) => `${BS}${BS}?${BS}${p}`], ["share", (p) => `${BS}${BS}localhost${BS}${p.replace(/^([A-Za-z]):/, "$1$")}`]];
    for (const [name, form] of forms) {
      const before = join(root, `already-there-${name}`); mkdirSync(before);
      if (!existsSync(form(before))) continue; // no admin share here
      const d = form(join(before, "new-parent", "2026-10-22"));
      for (let n = 0; n < 2; n++) {
        // Windows' tools unreachable (this code), and an unknown account name (which the code before the fifth review granted).
        const r = await withEnv("USERDOMAIN", "NOSUCHDOMAIN", () => withoutSystemTools(() => run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"])));
        // Since AR2b's check before anything is made, Windows PowerShell's failure refuses first, naming no folder (review of
        // 4dcb602); the share is refused as a network path before that. Either way nothing is left.
        expect(r.code, `${name} ${r.out}`).toBe(1); expect(r.err).toMatch(/refused: (--dest is a network path, whose folders cannot all be judged from here|the folders on the way to --dest could not be read \(Windows PowerShell could not be started\)), so nothing was moved/);
        expect(existsSync(join(before, "new-parent")), name).toBe(false); expect(existsSync(before), name).toBe(true); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
      }
    }
    const d = join(root, "already-there-plain", "new-parent", "2026-10-22");
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0); onlyOwner(d);
  });
  it.skipIf(process.platform !== "win32")("on Windows SYSTEM, Administrators, CREATOR OWNER and deny entries do not make a destination open", async () => {
    claudeTree();
    privateDir(dest);
    expect(spawnSync("icacls", [dest, "/grant", "*S-1-5-32-544:(OI)(CI)F", "*S-1-3-0:(OI)(CI)F", "/deny", "*S-1-5-32-546:(OI)(CI)W"]).status).toBe(0);
    const r = await run(claudeArgs("--apply"));
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  it.skipIf(process.platform !== "win32")("on Windows a destination with no access list at all (full control for everyone) is refused", async () => {
    claudeTree();
    mkdirSync(dest);
    // .NET rather than Get-Acl/Set-Acl, which fail to load when this runs under PowerShell 7; only the Access section, since
    // writing the whole descriptor needs a privilege an ordinary user does not hold.
    const nullList = "$ErrorActionPreference = 'Stop'; $d = [IO.DirectoryInfo]$env:D; $a = $d.GetAccessControl('Access'); $a.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL', 'Access'); $d.SetAccessControl($a)";
    expect(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", nullList], { env: { ...process.env, D: dest } }).status).toBe(0);
    expect(spawnSync("icacls", [dest], { encoding: "utf8" }).stdout).toMatch(/No permissions are set/);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination is open to other accounts/);
  });
  // Review of 3f3c24d: paths over 260 characters are read in the extended-length form, so a long project folder name does not
  // stop a second session (or a rerun) going into the same archive; and an existing destination that long is judged normally.
  it.skipIf(process.platform !== "win32")("on Windows a second session of a project whose archive folder is over 260 characters goes into the same archive", async () => {
    const longProj = join(home, ".claude", "projects", "p".repeat(200));
    put(join(longProj, `${OLD}.jsonl`), "old one\n", NOW - 30 * HOUR);
    put(join(longProj, `${OTHER}.jsonl`), "old two\n", NOW - 40 * HOUR);
    put(join(longProj, `${NEW}.jsonl`), "new\n", NOW - HOUR);
    expect(join(dest, "claude-projects", "p".repeat(200)).length).toBeGreaterThan(260);
    const one = await run(claudeArgs("--apply"));
    expect(one.err).toBe(""); expect(one.code).toBe(0);
    const two = await run(["claude", OTHER, "--successor", NEW, "--dest", dest, "--apply"]);
    expect(two.err).toBe(""); expect(two.code).toBe(0); expect(existsSync(join(longProj, `${OTHER}.jsonl`))).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("on Windows an existing private destination over 260 characters is read and used like any other", async () => {
    claudeTree();
    const long = join(root, ...Array.from({ length: 6 }, (_, i) => `${"x".repeat(45)}${i}`));
    mkdirSync(long, { recursive: true });
    expect(long.length).toBeGreaterThan(260);
    const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(String.fromCharCode(92));
    const BS = String.fromCharCode(92);
    expect(spawnSync("icacls", [`${BS}${BS}?${BS}${long}`, "/inheritance:r", "/grant:r", `${me}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]).status).toBe(0);
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", long, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  it.skipIf(process.platform !== "win32")("on Windows an existing destination whose access list cannot be read is refused under --apply, and the dry run says why", async () => {
    claudeTree();
    privateDir(dest);
    // Since AR2b the folders on the way are read first, by the same Windows PowerShell, so that is what fails first; no folder is
    // blamed for it (review of 4dcb602).
    const what = "the folders on the way to --dest could not be read (Windows PowerShell could not be started)";
    const dry = await withoutSystemTools(() => run(claudeArgs()));
    expect(dry.code).toBe(0); expect(dry.out).toContain(`warning: ${what}; --apply refuses it. To go ahead, check that Windows PowerShell runs, then try again`);
    const r = await withoutSystemTools(() => run(claudeArgs("--apply")));
    expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${what}, so nothing was moved; check that Windows PowerShell runs, then try again`);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it.skipIf(process.platform !== "win32")("on Windows an identical copy already in the destination with its own open entry is refused, so the source stays", async () => {
    claudeTree();
    privateDir(dest);
    put(archived(`${OLD}.jsonl`), readFileSync(join(proj(), `${OLD}.jsonl`)), NOW - 30 * HOUR);
    expect(spawnSync("icacls", [archived(`${OLD}.jsonl`), "/grant", "*S-1-1-0:F"]).status).toBe(0);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/a folder or file inside the destination is open to other accounts/); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("refuses a link (a junction or symlink) on the way to a file in the destination, which would put the files outside it", async () => {
    claudeTree();
    privateDir(dest);
    const outside = join(root, "outside"); mkdirSync(outside);
    if (process.platform === "win32") expect(spawnSync("icacls", [outside, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); else chmodSync(outside, 0o755);
    symlinkSync(outside, join(dest, "claude-projects"), "junction");
    for (const args of [claudeArgs(), claudeArgs("--apply")]) {
      const r = await run(args);
      expect(r.code).toBe(1); expect(r.err).toMatch(/refused: a folder or file in the destination is a link \(a junction or symlink\), so nothing was moved; use a new folder/);
    }
    expect(readdirSync(outside)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Review of a576d03: what another account planted while a folder was open survives chmod 700 (or icacls) on the folder.
  it("refuses a manifest or restore.py that is a link, which would send the manifest lines, or the restore, elsewhere", async (ctx) => {
    claudeTree();
    for (const name of ["manifest.jsonl", "restore.py"]) {
      rmSync(dest, { recursive: true, force: true }); privateDir(dest);
      const elsewhere = join(root, `elsewhere-${name}`);
      if (name === "restore.py") copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), elsewhere); else writeFileSync(elsewhere, "");
      try { symlinkSync(elsewhere, join(dest, name), "file"); } catch { ctx.skip(); return; } // Windows without the symlink privilege
      const r = await run(claudeArgs("--apply"));
      expect(r.code, name).toBe(1); expect(r.err).toMatch(/a folder or file in the destination is a link/);
      expect(readFileSync(elsewhere, "utf8").includes(OLD)).toBe(false); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    }
  });
  // Review of d923379: Node reports a junction as a link only when its target is written with a drive letter, and Windows reads
  // a junction's own access list, not its target's; a FIFO restore.py hung the read; a root run makes an archive its owner
  // cannot open.
  const BS = String.fromCharCode(92);
  /** The same folder, written through the volume's GUID name instead of its drive letter. */
  const volumeForm = (p: string) => spawnSync("mountvol", [p.slice(0, 3), "/L"], { encoding: "utf8" }).stdout.trim() + p.slice(3);
  const junction = (link: string, target: string) => expect(spawnSync("cmd", ["/d", "/c", "mklink", "/J", link, target], { encoding: "utf8" }).status).toBe(0);
  const openFolder = (p: string) => { mkdirSync(p, { recursive: true }); expect(spawnSync("icacls", [p, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); };
  it.skipIf(process.platform !== "win32")("on Windows a junction written through the volume's GUID name is refused, at .staging or on the way", async () => {
    claudeTree();
    for (const at of [".staging", "claude-projects"]) {
      rmSync(dest, { recursive: true, force: true }); privateDir(dest);
      const target = join(root, `open-${at.replace(".", "")}`); rmSync(target, { recursive: true, force: true }); openFolder(target);
      junction(join(dest, at), volumeForm(target));
      expect(lstatSync(join(dest, at)).isSymbolicLink()).toBe(false); // why lstat alone is not enough
      for (const args of [claudeArgs(), claudeArgs("--apply")]) {
        const r = await run(args);
        expect(r.code, `${at} ${args.join(" ")}`).toBe(1); expect(r.err).toMatch(/a folder or file in the destination is a link/);
      }
      expect(readdirSync(target)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    }
    // Its target gone: lstat still says no link, and the real path cannot be found.
    rmSync(dest, { recursive: true, force: true }); privateDir(dest);
    const gone = join(root, "gone"); openFolder(gone); junction(join(dest, ".staging"), volumeForm(gone)); rmSync(gone, { recursive: true, force: true });
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/a folder or file in the destination is a link/);
    // rmSync cannot see it either (ENOTEMPTY on the runner); rmdir removes the junction alone.
    expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(dest, ".staging")]).status).toBe(0);
    // The same named in other letter case, which the folder's listing still matches (review of 54b7f26).
    rmSync(dest, { recursive: true, force: true }); privateDir(dest);
    const gone2 = join(root, "gone2"); openFolder(gone2); junction(join(dest, ".STAGING"), volumeForm(gone2)); rmSync(gone2, { recursive: true, force: true });
    const r2 = await run(claudeArgs("--apply"));
    expect(r2.code).toBe(1); expect(r2.err).toMatch(/a folder or file in the destination is a link/);
    expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(dest, ".STAGING")]).status).toBe(0);
    // Its target shut to this user: lstat sees the junction, but its real path cannot be found.
    rmSync(dest, { recursive: true, force: true }); privateDir(dest);
    const shut = join(root, "shut"); mkdirSync(shut); junction(join(dest, ".staging"), volumeForm(shut));
    const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(BS);
    expect(spawnSync("icacls", [shut, "/deny", `${me}:(OI)(CI)(RX)`]).status).toBe(0);
    try {
      const s = await run(claudeArgs("--apply"));
      expect(s.code).toBe(1); expect(s.err).toMatch(/a folder or file in the destination is a link/);
    } finally { spawnSync("icacls", [shut, "/remove:d", me]); }
  });
  // AR2b (review of a08befc): a --dest that is a junction is not its own real path, so it is refused before anything is
  // written, whatever either list says.
  it.skipIf(process.platform !== "win32")("on Windows a --dest that is a junction to an open folder is refused, and nothing is written there", async () => {
    claudeTree();
    const parent = join(root, "private-parent"); privateDir(parent);
    const target = join(root, "open-target"); openFolder(target);
    const d = join(parent, "archive"); junction(d, target);
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest is reached through a link, a junction/); expect(readdirSync(target)).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("on POSIX a manifest or restore.py that is not a regular file (a FIFO) is refused without being read", async () => {
    claudeTree();
    for (const name of ["manifest.jsonl", "restore.py"]) {
      rmSync(dest, { recursive: true, force: true }); privateDir(dest);
      expect(spawnSync("mkfifo", [join(dest, name)]).status).toBe(0);
      const r = await run(claudeArgs());
      expect(r.code, name).toBe(1); expect(r.err).toMatch(/refused: a file in the destination is not a regular file, so nothing was moved; use a new folder/);
    }
  });
  it.skipIf(process.platform === "win32")("on POSIX refuses to run as an account other than the sessions' owner (root through sudo, say), whose archive that owner could not open", async () => {
    claudeTree();
    const me = process.getuid!();
    for (const other of [0, me + 1].filter((o) => o !== me)) { // run as root, uid 0 is this account, not another
      const as = vi.spyOn(process, "getuid").mockReturnValue(other);
      try {
        const r = await run(claudeArgs("--apply"));
        expect(r.code, String(other)).toBe(1); expect(r.err).toMatch(/refused: a file to move is owned by another account than the one running retire; run retire as the owner of every file \(not through sudo\), giving back with chown any file another account wrote into the session/); expect(existsSync(dest)).toBe(false);
      } finally { as.mockRestore(); }
    }
  });
  // Review of 8c07ceb: a junction --dest is judged by its own list as well as its target's; and the folder may not be swapped
  // during the run.
  it.skipIf(process.platform !== "win32")("on Windows a --dest junction whose own list is open is refused, even when it leads to a private folder", async () => {
    claudeTree();
    const parent = join(root, "open-parent"); openFolder(parent);
    const target = join(root, "private-target"); privateDir(target);
    const d = join(parent, "archive"); junction(d, target);
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", d, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toMatch(/--dest is reached through a link, a junction/); expect(readdirSync(target)).toEqual([]);
  });
  it("stops, keeping the rest of the sources, when the destination folder is replaced during the run", async () => {
    claudeTree();
    let swapped = false;
    const swap = (src: string, dst: string) => {
      copyFileSync(src, dst);
      if (!swapped) { swapped = true; renameSync(dest, `${dest}-moved`); privateDir(dest); }
    };
    const r = await run(claudeArgs("--apply"), { copyFile: swap });
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination folder was replaced during the run/);
    expect(readdirSync(dest)).toEqual([]);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
  });
  it("replaced while a source is being read, before its copy is made, makes no copy in the replacement", async () => {
    claudeTree();
    let swapped = false, copiesAfter = 0;
    const swap = () => { if (!swapped) { swapped = true; renameSync(dest, `${dest}-moved`); privateDir(dest); } };
    const counting = (src: string, dst: string) => { if (swapped) copiesAfter++; copyFileSync(src, dst); };
    const r = await run(claudeArgs("--apply"), { beforeCopy: swap, copyFile: counting });
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination folder was replaced during the run/);
    expect(copiesAfter).toBe(0); expect(readdirSync(dest)).toEqual([]);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
  });
  it("replaced right after the privacy check, is refused: the folder kept to is the one that was checked", async () => {
    claudeTree();
    privateDir(dest);
    const swap = () => { renameSync(dest, `${dest}-moved`); privateDir(dest); };
    const r = await run(claudeArgs("--apply"), { checked: swap });
    expect(r.code).toBe(1); expect(r.err).toMatch(/the destination folder was replaced during the run/);
    expect(readdirSync(dest)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("replaced after a copy is in place but before it is recorded (even by a folder holding the same copy), writes no manifest line there and keeps that source", async () => {
    claudeTree();
    let swapped = false;
    // The replacement holds an identical copy, so the copy's own check passes; only the folder's identity tells.
    const swap = (dst: string) => {
      if (swapped) return;
      swapped = true; const moved = `${dest}-moved`; renameSync(dest, moved); privateDir(dest);
      put(dst, readFileSync(join(moved, dst.slice(dest.length + 1))), statSync(join(moved, dst.slice(dest.length + 1))).mtimeMs);
    };
    const r = await run(claudeArgs("--apply"), { placed: swap });
    expect(r.code).toBe(1); expect(r.err).toMatch(/kept \S+: the destination folder was replaced during the run/);
    expect(existsSync(join(dest, "manifest.jsonl"))).toBe(false);
    for (const f of [`${OLD}.jsonl`, join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) expect(existsSync(join(proj(), f)), f).toBe(true);
  });
  it.skipIf(process.platform === "win32")("on POSIX a file inside the destination open to group or others is refused, even when the folder itself is private", async () => {
    claudeTree();
    privateDir(dest); writeFileSync(join(dest, "manifest.jsonl"), ""); chmodSync(join(dest, "manifest.jsonl"), 0o666);
    const r = await run(claudeArgs("--apply"));
    expect(r.code).toBe(1); expect(r.err).toMatch(/a folder or file inside the destination is open to other accounts/); expect(readFileSync(join(dest, "manifest.jsonl"), "utf8")).toBe("");
  });
  it.skipIf(process.platform !== "win32")("on Windows a destination given in the device form is read and used like any other", async () => {
    claudeTree();
    privateDir(dest);
    const BS = String.fromCharCode(92);
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", `${BS}${BS}.${BS}${dest}`, "--apply"]);
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  // AR2b (review of 8e5b50d): a share named like a drive (C$) can stand for any folder, and a junction to another volume reached
  // through one is not seen, so a network path is refused even when it is this machine's administrative share.
  it.skipIf(process.platform !== "win32")("on Windows a destination given through the admin share is refused, with advice to give its local path", async (ctx) => {
    claudeTree();
    const BS = String.fromCharCode(92);
    const share = `${BS}${BS}localhost${BS}${dest.replace(/^([A-Za-z]):/, "$1$")}`;
    privateDir(dest);
    if (!existsSync(share)) { ctx.skip(); return; } // no admin share here
    const r = await run(["claude", OLD, "--successor", NEW, "--dest", share, "--apply"]);
    expect(r.code).toBe(1); expect(r.err).toContain(NETWORK);
  });
  it.skipIf(process.platform !== "win32")("on Windows 9 000 identical copies already in the archive are read in one start (a long variable, over 1 MiB of output)", async () => {
    claudeTree();
    privateDir(dest);
    const N = 9000, names = Array.from({ length: N }, (_, n) => `${String(n).padStart(4, "0")}-${"r".repeat(40)}.txt`);
    for (const name of names) {
      const src = join(proj(), OLD, "tool-results", name);
      put(src, `result ${name}\n`, NOW - 31 * HOUR); put(archived(join(OLD, "tool-results", name)), `result ${name}\n`, NOW - 31 * HOUR);
    }
    expect(names.reduce((a, n) => a + archived(join(OLD, "tool-results", n)).length + 5, 0)).toBeGreaterThan(32_767);
    // The dry run makes the same single read as --apply, without syncing 9 000 manifest lines.
    const r = await run(claudeArgs());
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(r.out).toMatch(/9003 files/); expect(r.out).not.toMatch(/warning/);
  }, 300_000);
  it("reads many paths in one start of Windows PowerShell, and judges each block on its own", () => {
    const ME = "S-1-5-21-1-2-3-1001", OTHER_USER = "S-1-5-21-1-2-3-1002";
    const full = (sid: string) => `Allow ${sid} 001F01FF 0`;
    const out = [`me ${ME}`, "path 0", `owner ${ME}`, full(ME), "path 1", "error", "path 2", `owner ${OTHER_USER}`, full(ME), "path 3", `owner ${ME}`, full("S-1-1-0")].join("\r\n");
    expect(aclAccessAll(0, out, 5).map((a) => a.state)).toEqual(["private", "unknown", "foreign", "open", "unknown"]);
    expect(aclAccessAll(0, out, 5)[0]!.me).toBe(ME);
    expect(aclAccessAll(1, out, 2).map((a) => a.state)).toEqual(["unknown", "unknown"]);
    expect(aclAccessAll(0, [`me ${ME}`, "path 1", `owner ${ME}`, full(ME)].join("\n"), 2).map((a) => a.state)).toEqual(["unknown", "unknown"]);
    expect(aclAccessAll(0, ["path 0", `owner ${ME}`, full(ME)].join("\n"), 1).map((a) => a.state)).toEqual(["unknown"]);
    expect(aclAccessAll(0, [`me ${ME}`, "WARNING: something", "path 0", `owner ${ME}`, full(ME)].join("\n"), 1).map((a) => a.state)).toEqual(["unknown"]);
  });
  it("retires a read-only source file", async () => {
    claudeTree();
    chmodSync(join(proj(), OLD, "tool-results", "r.txt"), 0o444);
    const r = await run(claudeArgs("--apply"));
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(existsSync(join(proj(), OLD))).toBe(false);
  });
  it("clears staging leftovers from an earlier crash", async () => {
    claudeTree();
    privateDir(dest);
    put(join(dest, ".staging", "0123456789abcdef.partial"), "left by a crash", NOW);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(existsSync(join(dest, ".staging"))).toBe(false);
  });
  it("refuses a successor found in two projects", async () => {
    claudeTree();
    put(join(home, ".claude", "projects", "second", `${NEW}.jsonl`), "twin\n", NOW - HOUR);
    const r = await run(claudeArgs());
    expect(r.code).toBe(1); expect(r.err).toMatch(/successor \S+ not found exactly once/);
  });
  it("idle exactly the minimum is enough, one hour less is not, and the default is 24 hours", async () => {
    claudeTree();
    utimesSync(join(proj(), `${OLD}.jsonl`), (NOW - 24 * HOUR) / 1000, (NOW - 24 * HOUR) / 1000);
    for (const f of [join(OLD, "subagents", "agent-a.jsonl"), join(OLD, "tool-results", "r.txt")]) utimesSync(join(proj(), f), (NOW - 25 * HOUR) / 1000, (NOW - 25 * HOUR) / 1000);
    expect((await run(claudeArgs())).code).toBe(0);
    expect((await run(claudeArgs("--min-idle-hours", "25"))).code).toBe(1);
    utimesSync(join(proj(), `${OLD}.jsonl`), (NOW - 23 * HOUR) / 1000, (NOW - 23 * HOUR) / 1000);
    expect((await run(claudeArgs())).code).toBe(1);
  });
  it("a successor whose newest write is no later than the session's is refused, counting the successor's folder too", async () => {
    claudeTree();
    utimesSync(join(proj(), `${NEW}.jsonl`), (NOW - 30 * HOUR) / 1000, (NOW - 30 * HOUR) / 1000);
    expect((await run(claudeArgs())).err).toMatch(/was not written after/);
    put(join(proj(), NEW, "subagents", "late.jsonl"), "later\n", NOW - HOUR);
    expect((await run(claudeArgs())).code).toBe(0);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable session folder is refused without printing a path", async () => {
    claudeTree();
    chmodSync(join(proj(), OLD, "tool-results"), 0o000);
    try {
      const r = await run(claudeArgs());
      expect(r.code).toBe(1); expect(r.err).not.toContain(home); expect(r.err).toMatch(/^(refused|retire): /m);
    } finally { chmodSync(join(proj(), OLD, "tool-results"), 0o755); }
  });
});

describe("round 3: restore.py", () => {
  const second = "44444444-4444-4444-8444-444444444444";
  it("never touches an unrelated <name>.partial at the source, and restores the mtime from the manifest", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    put(join(proj(), OLD, "tool-results", "r.txt.partial"), "unrelated user file\n", NOW);
    const res = restore(OLD);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readFileSync(join(proj(), OLD, "tool-results", "r.txt.partial"), "utf8")).toBe("unrelated user file\n");
    expect(readFileSync(join(proj(), OLD, "tool-results", "r.txt"), "utf8")).toBe("synthetic result\n");
    expect(statSync(join(proj(), `${OLD}.jsonl`)).mtimeMs).toBe(NOW - 30 * HOUR);
  });
  it("a manifest line with bytes that are not UTF-8 is counted and skipped; the rest restore", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const m = join(dest, "manifest.jsonl");
    const lines = readFileSync(m).toString("utf8").split(String.fromCharCode(10));
    writeFileSync(m, Buffer.concat([Buffer.from(lines[0]! + String.fromCharCode(10)), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x80, 0x22, 0x7d, 0x0a]), Buffer.from(lines.slice(1).join(String.fromCharCode(10)))]));
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/restored 3, .*unreadable lines 1/);
  });
  it("an empty filter is a usage error; a filter that matches nothing exits 1; an upper-case session id still matches", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect(restore("").status).toBe(2);
    const none = restore("99999999-9999-4999-8999-999999999999");
    expect(none.status).toBe(1); expect(none.stdout).toMatch(/no entries match/);
    const upper = restore(OLD.toUpperCase());
    expect(upper.status, upper.stdout).toBe(0); expect(upper.stdout).toMatch(/restored 3/);
  });
  it("a filter that matches more than one session is refused unless --all-matching is given", async () => {
    claudeTree();
    put(join(proj(), `${second}.jsonl`), "second session\n", NOW - 40 * HOUR);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    expect((await run(["claude", second, "--successor", NEW, "--dest", dest, "--apply"])).code).toBe(0);
    const wide = restore("synthetic-project");
    expect(wide.status).toBe(2); expect(wide.stdout + wide.stderr).toMatch(/2 sessions/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false);
    const all = restore("--all-matching", "synthetic-project");
    expect(all.status, all.stdout).toBe(0); expect(all.stdout).toMatch(/restored 4/);
  });
  it("--dry-run hashes the archive copies, so a tampered one is reported", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    flipByte(archived(`${OLD}.jsonl`));
    const dry = restore("--dry-run", OLD);
    expect(dry.status).toBe(1); expect(dry.stdout).toMatch(/would restore 2, .*mismatched 1/);
  });
  it("restores a 2026-10-21 style entry (no rel, no session) from an archive that has moved", async () => {
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), join(dest, "restore.py"));
    const src = join(home, ".claude", "projects", "old-project", `${OLD}.jsonl`);
    const copy = join(dest, "claude-projects", "old-project", `${OLD}.jsonl`);
    put(copy, "old archive bytes\n", NOW - 90 * HOUR);
    const gone = join(root, "Q-drive-gone", "2026-10-21", "claude-projects", "old-project", `${OLD}.jsonl`);
    writeFileSync(join(dest, "manifest.jsonl"), JSON.stringify({ group: "claude", src, dst: gone, size: 18, mtime: (NOW - 90 * HOUR) / 1000, sha256: sha(copy), movedAt: 1 }) + String.fromCharCode(10));
    const res = restore(OLD);
    expect(res.status, res.stdout + res.stderr).toBe(0); expect(readFileSync(src, "utf8")).toBe("old archive bytes\n");
  });
  it("a hand-edited rel that leaves the archive folder is treated as missing", async () => {
    mkdirSync(dest, { recursive: true });
    copyFileSync(new URL("../cli/sessions/restore.py", import.meta.url), join(dest, "restore.py"));
    const outside = join(root, "outside.txt"); put(outside, "not in the archive\n", NOW);
    const src = join(home, ".claude", "projects", "p", `${OLD}.jsonl`);
    writeFileSync(join(dest, "manifest.jsonl"), JSON.stringify({ src, dst: join(root, "gone", "x"), rel: join("..", "outside.txt"), session: OLD, size: 19, mtime: 1, sha256: sha(outside), movedAt: 1 }) + String.fromCharCode(10));
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/missing 1/); expect(existsSync(outside)).toBe(true); expect(existsSync(src)).toBe(false);
  });
  it("restores a read-only archive copy and removes it afterwards", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    chmodSync(archived(`${OLD}.jsonl`), 0o444);
    const res = restore(OLD);
    expect(res.status, res.stdout + res.stderr).toBe(0); expect(existsSync(archived(`${OLD}.jsonl`))).toBe(false);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it("one entry that cannot be restored is counted as failed; the rest still restore", async () => {
    claudeTree();
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    put(join(proj(), OLD), "a file where the session folder should be\n", NOW);
    const res = restore(OLD);
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/restored 1, .*failed 2/);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  it.skipIf(process.platform !== "win32")("restores paths longer than 260 characters on Windows", async () => {
    const longProject = "p".repeat(200);
    const lp = join(home, ".claude", "projects", longProject);
    put(join(lp, `${OLD}.jsonl`), "long\n", NOW - 30 * HOUR);
    put(join(lp, OLD, "subagents", "a".repeat(40) + ".jsonl"), "long sub\n", NOW - 31 * HOUR);
    put(join(home, ".claude", "projects", "other", `${NEW}.jsonl`), "next\n", NOW - HOUR);
    expect((await run(claudeArgs("--apply"))).code).toBe(0);
    const res = restore(OLD);
    expect(res.status, res.stdout + res.stderr).toBe(0); expect(res.stdout).toMatch(/restored 2/);
  });
});

// AR2b (docs/sessions/AR2b-dest-chain.md): another account that can rename or replace any folder from --dest up to the root
// of its drive could swap the archive folder between a check and a write, so such a --dest is refused before anything is
// written. On some Windows machines a secondary drive root gives everyone full control on itself, which a private folder below it does not change.
describe("AR2b: a --dest another account could swap", () => {
  // End to end, without the chainTop seam, in a folder under the home folder: there every folder up to the root of the drive
  // can be changed only by this user, SYSTEM and Administrators (Temp, where the other tests run, need not be).
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(homedir(), ".kl-retire-chain-")); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const args = (d: string, ...more: string[]) => ["claude", OLD, "--successor", NEW, "--dest", d, ...more];
  const apply = (d: string) => run(args(d, "--apply"), { chainTop: undefined });
  /** Open to everyone the way some secondary drive roots are: full control on the folder itself and on what it holds. */
  const openToAll = (p: string) => { mkdirSync(p, { recursive: true }); if (process.platform === "win32") expect(spawnSync("icacls", [p, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); else chmodSync(p, 0o777); };
  const SWAP = "refused: another account could swap the archive folder during the run: ";
  const kept = (d: string) => { expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true); expect(existsSync(d)).toBe(false); };
  const link = (at: string, target: string) => { if (process.platform === "win32") expect(spawnSync("cmd", ["/d", "/c", "mklink", "/J", at, target], { encoding: "utf8" }).status).toBe(0); else symlinkSync(target, at); };

  it("a new --dest under the home folder is accepted", async () => {
    claudeTree();
    const r = await apply(join(base, "archive", "2026-10-22"));
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(false);
  });
  it("a layout with a private archive folder in an everyone-full-control drive root is refused, since anyone can rename it", async () => {
    claudeTree();
    const drive = join(base, "drive"); openToAll(drive);
    const archive = join(drive, ".agent-archive"); privateDir(archive);
    const d = join(archive, "2026-10-22");
    // Judged before anything is made (security review of 8e5b50d): a folder made under a folder others can swap may already
    // be made in theirs.
    let made = false;
    const r = await run(args(d, "--apply"), { chainTop: undefined, madeFolder: () => { made = true; } });
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${drive} lets other accounts rename or remove the folders in it, so nothing was moved; use a --dest where every folder from it up to the root of its drive can be changed only by `);
    expect(made).toBe(false); kept(d);
  });
  it("the dry run warns about that layout, and says --apply refuses it", async () => {
    claudeTree();
    const drive = join(base, "drive"); openToAll(drive);
    const archive = join(drive, ".agent-archive"); privateDir(archive);
    const r = await run(args(join(archive, "2026-10-22")), { chainTop: undefined });
    expect(r.code).toBe(0); expect(r.out).toContain(`warning: another account could swap the archive folder during the run: ${drive} lets other accounts rename or remove the folders in it; --apply refuses it.`);
  });
  // Review of a08befc (21 agents): following links one at a time kept missing folders (subst and mapped drive roots, volumes
  // with no letter, '..' through a link, names that lowercase alike, 8.3 targets, UNC forms, loops). AR2b now judges the
  // folders of one real path only: every name on the way must be its own real path, or --dest is refused before anything is
  // made, with the real path to give instead.
  const INDIRECT = "--dest is reached through a link, a junction, a short name or a drive letter that stands for another folder";
  const UNRESOLVED = (at: string) => `--dest goes through ${at}, whose real path cannot be found (a link that leads nowhere or to itself, a volume with no drive letter, or a folder this user cannot read), so its real folders cannot all be judged`;
  /**
   * Refused in the dry run (a warning) and by --apply (nothing made, nothing moved), naming where (when `at` is given). An
   * "unresolved" one is a name whose real path cannot be found at all.
   */
  const refusedIndirect = async (d: string, at: string | undefined, label: string, why: "indirect" | "unresolved" = "indirect", fix = "give --dest by its real path") => {
    const what = why === "indirect" ? `${INDIRECT} (${at ?? ""}` + (at ? "), whose real folders cannot all be judged" : "") : UNRESOLVED(at!);
    const dry = await run(args(d), { chainTop: undefined });
    expect(dry.code, label).toBe(0); expect(dry.out, label).toContain(`warning: ${what}`);
    // Refused before anything is made: making a folder through a link nobody judged already writes where it leads.
    let made = false;
    const r = await run(args(d, "--apply"), { chainTop: undefined, beforeMake: () => { made = true; } });
    expect(r.code, label).toBe(1); expect(r.err, label).toContain(`refused: ${what}`); expect(r.err, label).toContain(`so nothing was moved; ${fix}`);
    expect(made, label).toBe(false);
    expect(existsSync(join(proj(), `${OLD}.jsonl`)), label).toBe(true);
    return r.err;
  };
  it("a --dest reached through a link, or that is one, is refused, and the message gives its real path", async () => {
    claudeTree();
    const target = join(base, "target"); privateDir(target);
    const parent = join(base, "parent"); privateDir(parent);
    const j = join(parent, "j"); link(j, target);
    const err = await refusedIndirect(join(j, "2026-10-22"), j, "through");
    expect(err.toLowerCase()).toContain(`real path: ${join(target, "2026-10-22")}`.toLowerCase());
    await refusedIndirect(j, j, "itself");
    expect(readdirSync(target)).toEqual([]);
  });
  // Review of 121575e: the real path offered as advice is judged in full, the folders above it and its privacy too; one that is
  // refused in turn is named in the same message with its own reason, never offered.
  it("a --dest whose real path is refused too says why in one message, and never offers that path", async () => {
    claudeTree();
    const drive = join(base, "drive"); openToAll(drive);
    const target = join(drive, "target"); privateDir(target);
    const links = join(base, "links"); privateDir(links); link(join(links, "j"), target);
    const swapWhat = `${INDIRECT} (${join(links, "j")}), whose real folders cannot all be judged, and its real path ${join(target, "2026-10-22")} cannot be used either: another account could swap the archive folder during the run: ${drive} lets other accounts rename or remove the folders in it`;
    const dry = await run(args(join(links, "j", "2026-10-22")), { chainTop: undefined });
    expect(dry.code).toBe(0); expect(dry.out).toContain(`warning: ${swapWhat}; --apply refuses it. To go ahead, use a --dest where every folder`);
    expect(dry.out).not.toContain("give --dest by its real path");
    const r = await run(args(join(links, "j", "2026-10-22"), "--apply"), { chainTop: undefined, beforeMake: () => { throw new Error("nothing may be made"); } });
    expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${swapWhat}, so nothing was moved; use a --dest where every folder`);
    // A link to an existing folder that is open to other accounts: its real path is refused for that.
    const open = join(base, "open-target"); mkdirSync(open); // readable by everyone, removable by no one else
    if (process.platform === "win32") expect(spawnSync("icacls", [open, "/grant", "*S-1-1-0:(OI)(CI)RX"]).status).toBe(0); else chmodSync(open, 0o755);
    link(join(links, "k"), open);
    const r2 = await run(args(join(links, "k"), "--apply"), { chainTop: undefined, beforeMake: () => { throw new Error("nothing may be made"); } });
    expect(r2.code).toBe(1); expect(r2.err).toContain(`refused: ${INDIRECT} (${join(links, "k")}), whose real folders cannot all be judged, and its real path ${open} cannot be used either: the destination is open to other accounts on this machine, so nothing was moved; use a new folder`);
    expect(readdirSync(target)).toEqual([]); expect(readdirSync(open)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Review of f0154ee: an existing --dest that is open, under a folder that lets others remove what it holds, is refused for
  // both in one message, with advice that covers both: a new folder beside it would be refused for the folder above.
  it("an existing --dest open to others under a folder they may empty is refused naming both, and the advice covers both", async () => {
    claudeTree();
    const drive = join(base, "drive"); openToAll(drive);
    const existing = join(drive, "archive"); mkdirSync(existing); // takes the drive's open list (POSIX: mode 0755)
    if (process.platform !== "win32") chmodSync(existing, 0o755);
    const who = process.platform === "win32" ? "you, SYSTEM and Administrators" : "you and root";
    const both = `the destination is open to other accounts on this machine, and another account could swap the archive folder during the run: ${drive} lets other accounts rename or remove the folders in it`;
    const fix = `use a new folder (retire makes a new one private) where every folder from it up to the root of its drive can be changed only by ${who}`;
    const dry = await run(args(existing), { chainTop: undefined });
    expect(dry.code).toBe(0); expect(dry.out).toContain(`warning: ${both}; --apply refuses it. To go ahead, ${fix}`);
    const r = await run(args(existing, "--apply"), { chainTop: undefined });
    expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${both}, so nothing was moved; ${fix}`);
    // The same reached through a link: its real path is named with both reasons.
    const links = join(base, "links"); privateDir(links); link(join(links, "m"), existing);
    const r2 = await run(args(join(links, "m"), "--apply"), { chainTop: undefined });
    expect(r2.code).toBe(1); expect(r2.err).toContain(`refused: ${INDIRECT} (${join(links, "m")}), whose real folders cannot all be judged, and its real path ${existing} cannot be used either: ${both}, so nothing was moved; ${fix}`);
    expect(readdirSync(existing)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Review of b9acee6: an open --dest that itself lets others remove what it holds (a folder made by hand on C:\, or D:\ given
  // as --dest) is named as the folder to avoid, since a new folder inside it would be refused for it.
  it("an existing --dest open to others that lets them empty it too is refused naming it, with advice that covers a new folder inside it", async () => {
    claudeTree();
    const p = join(base, "p"); privateDir(p);
    const existing = join(p, "archive"); mkdirSync(existing);
    if (process.platform === "win32") expect(spawnSync("icacls", [existing, "/grant", "*S-1-1-0:(OI)(CI)F"]).status).toBe(0); else chmodSync(existing, 0o777);
    const who = process.platform === "win32" ? "you, SYSTEM and Administrators" : "you and root";
    const both = `the destination is open to other accounts on this machine, and another account could swap the archive folder during the run: ${existing} lets other accounts rename or remove the folders in it`;
    const r = await run(args(existing, "--apply"), { chainTop: undefined });
    expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${both}, so nothing was moved; use a new folder (retire makes a new one private) where every folder from it up to the root of its drive can be changed only by ${who}`);
    // A new folder beside it, as that advice allows, goes ahead.
    const beside = await run(args(join(p, "archive2"), "--apply"), { chainTop: undefined });
    expect(beside.err).toBe(""); expect(beside.code).toBe(0);
  });
  it("of several folders on the way that others may empty, the one nearest the root is named, since every one must be avoided", async () => {
    claudeTree();
    const outer = join(base, "outer"); openToAll(outer);
    const inner = join(outer, "inner"); openToAll(inner);
    const r = await run(args(join(inner, "2026-10-22"), "--apply"), { chainTop: undefined });
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${outer} lets other accounts rename or remove the folders in it`);
  });
  it("links that follow other links, lead nowhere or lead to themselves are refused, never followed and never a crash", async () => {
    claudeTree();
    // A link whose target holds another link (review of a26ab30).
    const open = join(base, "open"); openToAll(open);
    const t1 = join(open, "T1"); privateDir(t1); mkdirSync(join(t1, "B"));
    const safe = join(base, "safe"); privateDir(safe);
    link(join(t1, "B", "J2"), safe);
    const links = join(base, "links"); privateDir(links); link(join(links, "J1"), t1);
    await refusedIndirect(join(links, "J1", "B", "J2", "2026-10-22"), join(links, "J1"), "nested");
    // A link whose stored target goes through another link.
    const z = join(base, "z"); privateDir(z); mkdirSync(join(z, "q"));
    const p = join(base, "p"); privateDir(p); link(join(p, "k"), z);
    const a = join(base, "a"); privateDir(a); link(join(a, "j"), join(p, "k", "q"));
    await refusedIndirect(join(a, "j", "2026-10-22"), join(a, "j"), "stored through");
    // A link whose target is gone, and one that leads to itself.
    const gone = join(base, "gone"); privateDir(gone);
    const dangling = join(base, "d"); privateDir(dangling); link(join(dangling, "j"), gone); rmSync(gone, { recursive: true });
    await refusedIndirect(join(dangling, "j", "2026-10-22"), join(dangling, "j"), "dangling", "unresolved");
    const loop = join(base, "loop"); privateDir(loop); link(join(loop, "j"), join(loop, "j"));
    await refusedIndirect(join(loop, "j", "2026-10-22"), join(loop, "j"), "loop", "unresolved");
    expect(readdirSync(safe)).toEqual([]); expect(readdirSync(join(z, "q"))).toEqual([]);
    if (process.platform === "win32") for (const l of [join(dangling, "j"), join(loop, "j")]) spawnSync("cmd", ["/d", "/c", "rmdir", l]);
  });
  it.skipIf(process.platform !== "win32")("on Windows a folder above --dest that lets others only remove what it holds is refused", async () => {
    claudeTree();
    const parent = join(base, "parent"); privateDir(parent);
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-1-0:(DC)"]).status).toBe(0); // delete child, on the folder itself only
    const archive = join(parent, "archive"); privateDir(archive);
    const d = join(archive, "2026-10-22");
    const r = await apply(d);
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${parent} lets other accounts rename or remove the folders in it`);
    kept(d);
  });
  it.skipIf(process.platform !== "win32")("on Windows a folder above --dest that others may remove, or whose permissions or owner they may change, is refused", async () => {
    claudeTree();
    for (const right of ["DE", "WDAC", "WO"]) {
      const above = join(base, `above-${right}`); privateDir(above);
      expect(spawnSync("icacls", [above, "/grant", `*S-1-1-0:(${right})`]).status).toBe(0);
      const d = join(above, "2026-10-22");
      const r = await apply(d);
      expect(r.code, right).toBe(1); expect(r.err, right).toContain(`${SWAP}other accounts may rename, remove or change the permissions of ${above}`);
      kept(d);
    }
  });
  it.skipIf(process.platform !== "win32")("on Windows a folder above --dest whose full control for everyone is inherit-only is accepted, and the new folder is still private", async () => {
    claudeTree();
    const parent = join(base, "parent"); privateDir(parent);
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-1-0:(OI)(CI)(IO)F"]).status).toBe(0);
    const d = join(parent, "2026-10-22");
    const r = await apply(d);
    expect(r.err).toBe(""); expect(r.code).toBe(0); onlyOwner(d);
  });
  it.skipIf(process.platform === "win32")("on POSIX a folder above --dest writable by group or others is refused, and with the sticky bit (like /tmp) it is accepted", async () => {
    claudeTree();
    const parent = join(base, "parent"); mkdirSync(parent);
    for (const mode of [0o777, 0o770, 0o707, 0o720]) {
      chmodSync(parent, mode);
      const d = join(parent, "2026-10-22");
      const r = await apply(d);
      expect(r.code, mode.toString(8)).toBe(1); expect(r.err, mode.toString(8)).toContain(`${SWAP}${parent} lets other accounts rename or remove the folders in it`);
      kept(d);
    }
    chmodSync(parent, 0o1777);
    const r = await apply(join(parent, "2026-10-22"));
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() !== 0)("on POSIX a folder above --dest owned by another account is refused", async () => {
    claudeTree();
    const parent = join(base, "parent"); mkdirSync(parent); chownSync(parent, 1000, 1000);
    const r = await apply(join(parent, "2026-10-22"));
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${parent} is owned by another account`);
  });
  // Review of a26ab30 (two reviewers): a folder this user cannot list, network shares, new folders between an existing one and
  // the archive, and the seam's own folder.
  // Since a08befc's review the real path of every folder on the way must be found, and here it cannot: refused, never skipped.
  it.skipIf(process.platform !== "win32")("on Windows a folder on the way that this user cannot see into is refused, not skipped", async () => {
    claudeTree();
    const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(String.fromCharCode(92));
    const u = join(base, "u"); privateDir(u);
    const x = join(u, "x"), y = join(x, "y"), w = join(y, "w");
    privateDir(w); // this user's own folder, reached through x and y
    // y lets others remove what it holds and gives this user nothing; x gives this user nothing, and u lets this user only pass
    // through. existsSync then says y is not there, though it is (stat and Windows PowerShell both read it).
    expect(spawnSync("icacls", [y, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-1-0:(DC)"]).status).toBe(0);
    expect(spawnSync("icacls", [x, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F"]).status).toBe(0);
    expect(spawnSync("icacls", [u, "/grant:r", `${me}:(X)`]).status).toBe(0);
    try {
      expect(existsSync(y)).toBe(false); // what the first version filtered on
      await refusedIndirect(join(w, "2026-10-22"), x, "cannot see into", "unresolved"); // x is the first this user cannot read
    } finally {
      for (const d of [u, x, y]) expect(spawnSync("icacls", [d, "/grant", `${me}:(OI)(CI)F`]).status).toBe(0);
    }
  });
  it.skipIf(process.platform !== "win32")("on Windows a --dest on a network path is refused in every form, administrative shares too", async () => {
    claudeTree();
    const BS = String.fromCharCode(92);
    const C$ = (p: string) => `localhost${BS}${p.replace(/^([A-Za-z]):/, "$1$")}`;
    // A share on another machine or in WSL has no local path here, so the advice is a local disk first (review of d910e90).
    for (const pre of [`${BS}${BS}`, `${BS}${BS}?${BS}UNC${BS}`, `${BS}${BS}.${BS}UNC${BS}`]) {
      for (const d of [`${pre}localhost${BS}pub${BS}arch`, pre + C$(join(base, "arch", "2026-10-22")), `${pre}localhost${BS}Z$${BS}arch`, `${pre}nas${BS}backup${BS}arch`, `${pre}wsl.localhost${BS}Ubuntu${BS}arch`]) {
        const r = await run(args(d, "--apply"), { chainTop: undefined });
        expect(r.code, d).toBe(1); expect(r.err, d).toContain(NETWORK);
      }
    }
    expect(existsSync(join(base, "arch"))).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("on Windows a --dest written in the device namespace other than a drive letter or a volume is refused before anything opens it", async () => {
    claudeTree();
    const BS = String.fromCharCode(92);
    const C$ = `localhost${BS}${join(base, "arch").replace(/^([A-Za-z]):/, "$1$")}`;
    for (const pre of [`${BS}${BS}?${BS}`, `${BS}${BS}.${BS}`]) {
      for (const d of [`${pre}GLOBALROOT${BS}Device${BS}Mup${BS}${C$}`, `${pre}Global${BS}UNC${BS}${C$}`, `${pre}GLOBALROOT${BS}Device${BS}HarddiskVolume1${BS}x`]) {
        const r = await run(args(d, "--apply"), { chainTop: undefined });
        expect(r.code, d).toBe(1); expect(r.err, d).toContain("refused: --dest is written in the device namespace, so nothing was moved; give the folder by its local path");
      }
    }
    // The bare drive names the volume device, not its root folder, and with a name after the colon it is relative to the
    // current folder: refused the same way, also when the current folder is that drive's root (review of 69c50c6).
    const drive = base.slice(0, 2), here = process.cwd();
    try {
      process.chdir(parse(base).root);
      for (const d of [`${BS}${BS}.${BS}${drive}`, `${BS}${BS}.${BS}${drive}${BS}`, `${BS}${BS}?${BS}${drive}`, `${BS}${BS}?${BS}${drive}${BS}`, `${BS}${BS}.${BS}${drive}arch`, `${BS}${BS}?${BS}${drive}arch`]) {
        for (const more of [[], ["--apply"]]) {
          const r = await run(args(d, ...more), { chainTop: undefined });
          expect(r.code, `${d} ${more}`).toBe(1); expect(r.err, d).toContain("refused: --dest is written in the device namespace, so nothing was moved; give the folder by its local path");
        }
      }
    } finally { process.chdir(here); }
    expect(existsSync(join(base, "arch"))).toBe(false); expect(existsSync(join(parse(base).root, "arch"))).toBe(false);
  });
  // Review of ad8146d: whether a name is a reparse point is asked of Windows for that name, so a parent this user may open but
  // not list does not stop a folder below it.
  it.skipIf(process.platform !== "win32")("on Windows a folder under one this user may pass through but not list is judged, not refused as a link", async () => {
    claudeTree();
    const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(String.fromCharCode(92));
    const u = join(base, "u"), y = join(u, "y"); privateDir(u); privateDir(y);
    // /grant:r replaces only an entry with the same inheritance, so remove this user's first, then let it open u (traverse, read
    // attributes, synchronize: its real path can be found) but not list it. With traverse alone, the real path of u cannot be
    // found (measured, EPERM), which is refused as unresolved. An elevated account (as on CI) keeps an Administrators entry
    // that would let it list u, so that goes too.
    expect(spawnSync("icacls", [u, "/remove:g", me, "*S-1-5-32-544"]).status).toBe(0); expect(spawnSync("icacls", [u, "/grant", `${me}:(X,RA,S)`]).status).toBe(0);
    try {
      expect(() => readdirSync(u)).toThrow();
      const r = await apply(join(y, "2026-10-22"));
      expect(r.err).toBe(""); expect(r.code).toBe(0);
    } finally { expect(spawnSync("icacls", [u, "/grant:r", `${me}:(OI)(CI)F`]).status).toBe(0); }
  });
  // Review of 69c50c6: names are compared as NTFS folds them. A new name Windows says is not there is made, whatever a sibling
  // JavaScript lowercases alike is called, and an existing folder whose name ends a word in capital sigma opens through a
  // plain small sigma, as NTFS opens it.
  it.skipIf(process.platform !== "win32")("on Windows names are compared as NTFS folds them, so a look-alike sibling or a word-final sigma is no link", async () => {
    const greek = (...c: number[]) => String.fromCharCode(...c);
    const accepted = async (d: string, label: string) => {
      rmSync(home, { recursive: true, force: true }); claudeTree();
      const dry = await run(args(d), { chainTop: undefined });
      expect(dry.code, label).toBe(0); expect(dry.out, label).not.toContain("warning:");
      const r = await apply(d);
      expect(r.err, label).toBe(""); expect(r.code, label).toBe(0);
    };
    // A new k beside a plain folder named KELVIN SIGN, and new Greek capitals ending in sigma beside the same word in small
    // letters ending in the final sigma: NTFS keeps each pair apart.
    const kel = join(base, "kel"); privateDir(kel); mkdirSync(join(kel, String.fromCharCode(0x212a)));
    await accepted(join(kel, "k", "2026-10-22"), "k beside KELVIN SIGN");
    expect(readdirSync(join(kel, String.fromCharCode(0x212a)))).toEqual([]);
    const caps = greek(0x391, 0x3a1, 0x3a7, 0x395, 0x399, 0x39f, 0x3a3), small = greek(0x3b1, 0x3c1, 0x3c7, 0x3b5, 0x3b9, 0x3bf, 0x3c2);
    const gr = join(base, "gr"); privateDir(gr); mkdirSync(join(gr, small));
    await accepted(join(gr, caps, "2026-10-22"), "Greek capitals beside small letters");
    expect(readdirSync(join(gr, small))).toEqual([]); expect(existsSync(join(gr, caps, "2026-10-22", "manifest.jsonl"))).toBe(true);
    // An existing private folder named in capitals ending in sigma, given in small letters with the plain sigma.
    const logos = join(base, greek(0x39b, 0x39f, 0x393, 0x39f, 0x3a3)); privateDir(logos);
    await accepted(join(base, greek(0x3bb, 0x3bf, 0x3b3, 0x3bf, 0x3c3), "2026-10-22"), "existing capitals given in small letters");
    expect(existsSync(join(logos, "2026-10-22", "manifest.jsonl"))).toBe(true);
  });
  // Review of 69c50c6: a folder Windows marks as a reparse point that is its own real path (a OneDrive or iCloud Drive folder)
  // is refused, saying what it is, without advice to give the same path again. Runs where this user has such a folder.
  const oneDrive = process.platform === "win32" && process.env.OneDrive && existsSync(process.env.OneDrive) ? realpathSync.native(process.env.OneDrive) : undefined;
  const oneDriveReparse = oneDrive !== undefined && (Number(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[int][IO.File]::GetAttributes($env:P)"], { encoding: "utf8", env: { ...process.env, P: oneDrive } }).stdout.trim()) & 0x400) !== 0;
  it.skipIf(!oneDriveReparse)("on Windows a OneDrive folder on the way is refused as a reparse point, not as a link, with advice that can be followed", async () => {
    claudeTree();
    const what = `--dest goes through ${oneDrive}, which Windows marks as a reparse point but not as a link to another folder (a OneDrive or iCloud Drive folder, say), whose folders cannot all be judged`;
    // Also given in other letter case, through a short name below it, or through a junction to it: each is refused for the
    // folder itself, never with advice that leads to that refusal (reviews of 69c50c6 and d910e90).
    const lower = oneDrive!.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const short = /<DIR>\s+(\S+~\d+)\s+\S/.exec(spawnSync("cmd", ["/d", "/c", "dir", "/x", "/ad", oneDrive!], { encoding: "utf8" }).stdout)?.[1];
    const toIt = join(base, "to-onedrive"); link(toIt, oneDrive!);
    try {
      // And through the volume's GUID name, whose real path is found from the drive letter on (review of 121575e).
      const volume = spawnSync("mountvol", [oneDrive!.slice(0, 3), "/L"], { encoding: "utf8" }).stdout.trim();
      const spellings = [join(oneDrive!, `kl-retire-test-${process.pid}`, "2026-10-22"), oneDrive!, join(lower, `kl-retire-test-${process.pid}`), join(toIt, `kl-retire-test-${process.pid}`), toIt, ...(short ? [join(oneDrive!, short, `kl-retire-test-${process.pid}`)] : []),
        volume + join(lower, `kl-retire-test-${process.pid}`).slice(3), volume + join(toIt, `kl-retire-test-${process.pid}`).slice(3)];
      for (const d of spellings) {
        const dry = await run(args(d), { chainTop: undefined });
        expect(dry.code, d).toBe(0); expect(dry.out, d).toContain(`warning: ${what}; --apply refuses it. To go ahead, use a folder outside it, on a local disk`);
        expect(dry.out, d).not.toContain("real path");
      }
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", toIt]).status).toBe(0); }
    // Refused before anything is made; were it not, nothing would be made in this user's OneDrive either.
    const r = await run(args(join(oneDrive!, `kl-retire-test-${process.pid}`, "2026-10-22"), "--apply"), { chainTop: undefined, beforeMake: () => { throw new Error("nothing may be made here"); } });
    expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${what}, so nothing was moved; use a folder outside it, on a local disk`);
    expect(existsSync(join(oneDrive!, `kl-retire-test-${process.pid}`))).toBe(false);
  });
  // Review of d905c6f: when the one Windows PowerShell run that reads the access lists fails, no folder is blamed (each would
  // read as "could not be read", and the one named was the drive's root): it is refused as a failed run, to try again.
  it.skipIf(process.platform !== "win32")("on Windows a failed run reading the access lists is refused as such, blaming no folder", async () => {
    claudeTree();
    const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const real = cp.spawnSync;
    const d = join(base, "arch", "2026-10-22");
    const what = "the access lists of the folders on the way could not be read (Windows PowerShell exit 1)";
    const tryAgain = "check that Windows PowerShell runs, then try again";
    // The runs reading access lists fail from the failFrom-th on (counted per retire run).
    let starts = 0, failFrom = 1, status: number | null = 1, error: Error | undefined, out = "";
    try {
      cp.spawnSync = ((cmd: string, argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
        if (opts?.env?.KL_RETIRE_ACL_PATHS !== undefined && ++starts >= failFrom) return { pid: 0, output: [null, out, ""], stdout: out, stderr: "", status, signal: null, error };
        return real(cmd, argv, opts as Parameters<typeof real>[2]);
      }) as unknown as typeof real;
      syncBuiltinESMExports();
      const dry = await run(args(d), { chainTop: undefined });
      expect(dry.code).toBe(0); expect(dry.out).toContain(`warning: ${what}; --apply refuses it. To go ahead, ${tryAgain}`);
      expect(dry.out).not.toContain("swap");
      // A run that ends well but prints nothing it can read failed too.
      starts = 0; status = 0;
      const empty = await run(args(d), { chainTop: undefined });
      expect(empty.out).toContain(`warning: the access lists of the folders on the way could not be read (Windows PowerShell printed nothing it could read); --apply refuses it. To go ahead, ${tryAgain}`);
      // Stopped for printing more than retire reads (review of 4dcb602).
      starts = 0; status = null; error = Object.assign(new Error("spawnSync powershell.exe ENOBUFS"), { code: "ENOBUFS" });
      const big = await run(args(d), { chainTop: undefined });
      expect(big.out).toContain("warning: the access lists of the folders on the way could not be read (Windows PowerShell printed more than retire reads)");
      // Any error is a failed run, even one that ends with 0 after a first line that reads well: what follows may be cut off
      // (review of 00e9059).
      starts = 0; status = 0; error = Object.assign(new Error("spawnSync powershell.exe EPIPE"), { code: "EPIPE" }); out = "me S-1-5-21-1-2-3-1001\r\n";
      const piped = await run(args(d), { chainTop: undefined });
      expect(piped.out).toContain("warning: the access lists of the folders on the way could not be read (Windows PowerShell failed: EPIPE)");
      starts = 0; status = 1; error = undefined; out = "";
      const r = await run(args(d, "--apply"), { chainTop: undefined, beforeMake: () => { throw new Error("nothing may be made"); } });
      expect(r.code).toBe(1); expect(r.err).toContain(`refused: ${what}, so nothing was moved; ${tryAgain}`);
      // Failing only once the folders are made: refused the same way, and the folders it made are removed.
      starts = 0; failFrom = 2;
      const after = await run(args(d, "--apply"), { chainTop: undefined });
      expect(after.code).toBe(1); expect(after.err).toContain(`refused: ${what}, so nothing was moved; ${tryAgain}`);
      expect(existsSync(join(base, "arch"))).toBe(false);
      // Through a link, whose real path cannot be judged either.
      const target = join(base, "target"); privateDir(target);
      const links = join(base, "links"); privateDir(links); link(join(links, "j"), target);
      starts = 0; failFrom = 1;
      const viaLink = await run(args(join(links, "j", "2026-10-22")), { chainTop: undefined });
      expect(viaLink.code).toBe(0); expect(viaLink.out).toContain(`warning: ${what}; --apply refuses it. To go ahead, ${tryAgain}`);
      expect(viaLink.out).not.toContain("real path");
    } finally { cp.spawnSync = real; syncBuiltinESMExports(); }
    expect(existsSync(join(base, "arch"))).toBe(false); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Review of f0154ee: Windows gives Authenticated Users Modify (delete included) on a new NTFS volume's root, which cannot be
  // renamed or removed, so it refuses nothing. This drive's root has no such entry, so the access-list report for it is added
  // to; that also tests that the chain marks its last step as the root.
  it.skipIf(process.platform !== "win32")("on Windows a drive root that gives other accounts Modify on itself, as Windows does for a new volume, does not refuse a --dest", async () => {
    claudeTree();
    const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const real = cp.spawnSync;
    const d = join(base, "arch", "2026-10-22");
    try {
      cp.spawnSync = ((cmd: string, argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
        const r = real(cmd, argv, opts as Parameters<typeof real>[2]);
        const paths = opts?.env?.KL_RETIRE_ACL_PATHS?.split("|");
        if (paths && /^\\\\\?\\[A-Za-z]:\\$/.test(paths[paths.length - 1]!) && typeof r.stdout === "string") r.stdout = `${r.stdout.trimEnd()}\r\nAllow S-1-5-11 001301BF 0\r\n`;
        return r;
      }) as unknown as typeof real;
      syncBuiltinESMExports();
      const dry = await run(args(d), { chainTop: undefined });
      expect(dry.code).toBe(0); expect(dry.out).not.toContain("warning:");
      const r = await apply(d);
      expect(r.err).toBe(""); expect(r.code).toBe(0);
    } finally { cp.spawnSync = real; syncBuiltinESMExports(); }
  });
  // Review of d910e90: in a folder with case sensitivity turned on, a junction to a sibling whose name differs only in letter
  // case is a link to another folder, and that folder's path is the advice, since it passes.
  it.skipIf(process.platform !== "win32")("on Windows a junction to its case twin in a case-sensitive folder is refused as a link, giving the twin's path", async (ctx) => {
    claudeTree();
    const cs = join(base, "cs"); privateDir(cs);
    if (spawnSync("fsutil", ["file", "setCaseSensitiveInfo", cs, "enable"]).status !== 0) { ctx.skip(); return; }
    mkdirSync(join(cs, "j")); mkdirSync(join(cs, "k"));
    // J's target is written through the volume's GUID name (no link to lstat), K's as a drive path (a link to lstat).
    const volume = spawnSync("mountvol", [cs.slice(0, 3), "/L"], { encoding: "utf8" }).stdout.trim();
    link(join(cs, "J"), volume + join(cs, "j").slice(3)); link(join(cs, "K"), join(cs, "k"));
    try {
      for (const [name, twin] of [["J", "j"], ["K", "k"]]) {
        const err = await refusedIndirect(join(cs, name!, "2026-10-22"), join(cs, name!), `case twin ${name}`);
        expect(err, name).toContain(`give --dest by its real path: ${join(cs, twin!, "2026-10-22")}`);
      }
      expect(readdirSync(join(cs, "j"))).toEqual([]); expect(readdirSync(join(cs, "k"))).toEqual([]);
    } finally { for (const n of ["J", "K"]) expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(cs, n)]).status).toBe(0); }
  });
  // Review of d910e90: a drive that is not NTFS or ReFS is named by its format, with advice to use such a drive. No FAT32 or
  // exFAT drive is at hand, so the probe's report of the format is replaced; that also tests the call of the check.
  it.skipIf(process.platform !== "win32")("on Windows a --dest on a FAT32 or exFAT drive is refused naming the format, with advice to use NTFS or ReFS", async () => {
    claudeTree();
    const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const real = cp.spawnSync;
    const d = join(base, "arch", "2026-10-22"), root = parse(base).root;
    try {
      for (const format of ["FAT32", "exFAT"]) {
        cp.spawnSync = ((cmd: string, argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
          const r = real(cmd, argv, opts as Parameters<typeof real>[2]);
          if (opts?.env?.KL_RETIRE_DRIVE !== undefined && typeof r.stdout === "string") r.stdout = r.stdout.replace(/^fs .*$/m, `fs ${format}`);
          return r;
        }) as unknown as typeof real;
        syncBuiltinESMExports();
        const what = `--dest is on ${root}, whose file system (${format}) is not NTFS or ReFS, so the access lists seen here do not decide who can rename the folders on the way (FAT32 and exFAT keep none, and a cloud drive such as Google Drive's makes them up)`;
        const dry = await run(args(d), { chainTop: undefined });
        expect(dry.code, format).toBe(0); expect(dry.out, format).toContain(`warning: ${what}; --apply refuses it. To go ahead, use a folder on a drive formatted NTFS or ReFS`);
        const r = await apply(d);
        expect(r.code, format).toBe(1); expect(r.err, format).toContain(`refused: ${what}, so nothing was moved; use a folder on a drive formatted NTFS or ReFS`);
      }
    } finally { cp.spawnSync = real; syncBuiltinESMExports(); }
    expect(existsSync(join(base, "arch"))).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("on Windows a --dest with a character Windows does not allow in a name is refused before anything is made", async () => {
    claudeTree();
    // The name is shown as received (review of 4dcb602): no folder can hold such a character, so it is never a project folder.
    for (const bad of ["new|odd", "a<b", "a>b", "a?b", "a*b"]) {
      const r = await apply(join(base, "x", bad, "2026-10-22"));
      expect(r.code, bad).toBe(1); expect(r.err, bad).toContain(`refused: --dest has a folder name with a character Windows does not allow (< > : " | ? * or a control character): ${JSON.stringify(bad)}, so nothing was moved`);
    }
    // A quoted path that ends in a backslash ('C:\My Archive\' in Windows PowerShell 5.1 or cmd) arrives with the closing quote
    // and the rest of the line in it: the message says so.
    const quoted = `My Archive" --apply`;
    const r = await apply(join(base, quoted));
    expect(r.code).toBe(1); expect(r.err).toContain(`: ${JSON.stringify(quoted)}, so nothing was moved; a path in quotes that ends in a backslash passes the closing quote on as part of the path, so leave that backslash off`);
    // Characters a terminal acts on (DEL, a C1 control, a right-to-left override) are written out, never printed (review of
    // 00e9059).
    const BS = String.fromCharCode(92);
    const odd = `a|${String.fromCharCode(0x7f)}${String.fromCharCode(0x9b)}${String.fromCharCode(0x202e)}b`;
    const r2 = await apply(join(base, odd));
    expect(r2.code).toBe(1); expect(r2.err).toContain(`: "a|${BS}u{7f}${BS}u{9b}${BS}u{202e}b", so nothing was moved`);
    expect([...r2.err].every((c) => c.charCodeAt(0) < 0x7f)).toBe(true);
    // Letters in any script are shown as typed: only invisible and format characters are written out (review of 026b826).
    const fr = `Donn${String.fromCharCode(0xe9)}es" --apply`, ja = `${String.fromCharCode(0x30a2, 0x30fc, 0x30ab, 0x30a4, 0x30d6)}|2026`;
    for (const name of [fr, ja]) {
      const r3 = await apply(join(base, name));
      expect(r3.code, name).toBe(1); expect(r3.err, name).toContain(`: ${JSON.stringify(name)}, so nothing was moved`);
    }
    // So are letters and marks that show nothing (a Hangul filler, the combining grapheme joiner, a variation selector;
    // review of 28e862f).
    const blank = `a${String.fromCharCode(0x3164)}b${String.fromCharCode(0x34f)}c${String.fromCharCode(0xfe0f)}|d`;
    const r4 = await apply(join(base, blank));
    expect(r4.code).toBe(1); expect(r4.err).toContain(`: "a${BS}u{3164}b${BS}u{34f}c${BS}u{fe0f}|d", so nothing was moved`);
    expect(readdirSync(base)).toEqual([]);
  });
  it.skipIf(process.platform !== "win32")("on Windows every folder retire makes is private, so a new folder between an existing one and the archive is not refused for what it would inherit", async () => {
    claudeTree();
    const parent = join(base, "parent"); privateDir(parent);
    // Authenticated Users may change what is made inside: the default on an NTFS drive.
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-5-11:(OI)(CI)(IO)M"]).status).toBe(0);
    const d = join(parent, "new1", "new2");
    const dry = await run(args(d), { chainTop: undefined });
    expect(dry.code).toBe(0); expect(dry.out).not.toMatch(/warning/);
    const r = await apply(d);
    expect(r.err).toBe(""); expect(r.code).toBe(0); onlyOwner(join(parent, "new1")); onlyOwner(d);
  });
  it.skipIf(process.platform !== "win32")("on Windows a junction written through a volume's GUID name, a subst or mapped drive letter, a short name, or a --dest written as a volume name is refused", async () => {
    claudeTree();
    const BS = String.fromCharCode(92);
    const target = join(base, "target"); privateDir(target);
    // A junction written through the volume's GUID name, which lstat does not see as a link.
    const parent = join(base, "parent"); privateDir(parent);
    const volume = spawnSync("mountvol", [target.slice(0, 3), "/L"], { encoding: "utf8" }).stdout.trim();
    const j = join(parent, "j"); link(j, volume + target.slice(3));
    try {
      expect(lstatSync(j).isSymbolicLink()).toBe(false);
      await refusedIndirect(join(j, "2026-10-22"), j, "GUID junction");
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", j]).status).toBe(0); } // rmSync would go through it
    // The same with its target gone: lstat cannot see it at all, only its folder's listing shows it.
    const gone = join(base, "gone"); privateDir(gone);
    const g = join(parent, "g"); link(g, volume + gone.slice(3)); rmSync(gone, { recursive: true });
    try {
      expect(existsSync(g)).toBe(false); expect(readdirSync(parent)).toContain("g");
      await refusedIndirect(join(g, "2026-10-22"), g, "GUID junction to nothing", "unresolved");
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", g]).status).toBe(0); }
    // --dest written as the volume's name: refused, and since the volume has a drive letter, the message gives that path, also
    // when nothing below the volume's root exists yet (review of 874eac0).
    for (const form of [volume, volume.replace(/^(.)(.)\?/, "$1$2.")]) {
      const byVolume = form + join(target, "2026-10-22").slice(3);
      const err = await refusedIndirect(byVolume, parse(byVolume).root, "volume name");
      expect(err.toLowerCase()).toContain(`real path: ${join(target, "2026-10-22")}`.toLowerCase());
      const fresh = `kl-retire-${process.pid}-nothing-here`;
      const atRoot = await refusedIndirect(form + join(fresh, "2026-10-22"), form, "volume name, new under the root");
      expect(atRoot.toLowerCase()).toContain(`real path: ${join(target.slice(0, 3), fresh, "2026-10-22")}`.toLowerCase());
      // The volume's bare root: without its trailing separator it names the volume itself, which cannot be listed (review of
      // ad8146d). Its real path, the drive's root, is owned by another account, so it is named, not offered (review of 121575e).
      const bare = await refusedIndirect(form, form.slice(0, -1), "volume root", "indirect", "use a new folder");
      expect(bare.toLowerCase()).toContain(`its real path ${target.slice(0, 3)} cannot be used either: the destination is owned by another account`.toLowerCase());
    }
    // A junction whose name JavaScript lowercases to its target's (KELVIN SIGN and k), which NTFS keeps apart: the real path
    // compares alike in any case, but lstat sees a link; and the same with the target written through the volume's GUID name,
    // which lstat does not see, but the folder's listing does (review of 874eac0).
    const KELVIN = String.fromCharCode(0x212a);
    const a = join(base, "a"); privateDir(a); mkdirSync(join(a, "k"));
    symlinkSync(join(a, "k"), join(a, KELVIN), "junction");
    await refusedIndirect(join(a, KELVIN, "2026-10-22"), join(a, KELVIN), "Kelvin");
    const a2 = join(base, "a2"); privateDir(a2); mkdirSync(join(a2, "k"));
    link(join(a2, KELVIN), volume + join(a2, "k").slice(3));
    try {
      expect(lstatSync(join(a2, KELVIN)).isSymbolicLink()).toBe(false);
      await refusedIndirect(join(a2, KELVIN, "2026-10-22"), join(a2, KELVIN), "Kelvin, GUID target");
      expect(readdirSync(join(a2, "k"))).toEqual([]);
      // A plain folder whose sibling is a reparse point that lowercases alike is no link itself (review of ad8146d).
      rmSync(home, { recursive: true, force: true }); claudeTree();
      const r = await apply(join(a2, "k", "2026-10-22"));
      expect(r.err).toBe(""); expect(r.code).toBe(0);
      rmSync(home, { recursive: true, force: true }); claudeTree(); // that run moved the session the steps below retire
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(a2, KELVIN)]).status).toBe(0); }
    // Greek sigma: NTFS folds capital sigma to the plain small sigma, JavaScript to the final one, so the --dest name opens the
    // junction while JavaScript compares it alike to the plain folder beside it (review of ad8146d). Windows is asked what the
    // name it opens is.
    const [finalS, smallS, capitalS] = [0x3c2, 0x3c3, 0x3a3].map((c) => String.fromCharCode(c));
    const g2 = join(base, "g2"); privateDir(g2); mkdirSync(join(g2, `a${finalS}`));
    link(join(g2, `a${smallS}`), volume + join(g2, `a${finalS}`).slice(3));
    try {
      await refusedIndirect(join(g2, `a${capitalS}`, "2026-10-22"), join(g2, `a${capitalS}`), "Greek sigma, GUID target");
      expect(readdirSync(join(g2, `a${finalS}`))).toEqual([]);
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(g2, `a${smallS}`)]).status).toBe(0); }
    // A junction named as it is stored, but under a folder named KELVIN SIGN beside k, through which its real path differs:
    // a link to another folder, whose path is the advice (review of 121575e).
    const a3 = join(base, "a3"); privateDir(a3); mkdirSync(join(a3, "k", "data"), { recursive: true }); mkdirSync(join(a3, KELVIN));
    link(join(a3, KELVIN, "data"), volume + join(a3, "k", "data").slice(3));
    try {
      const err = await refusedIndirect(join(a3, KELVIN, "data", "2026-10-22"), join(a3, KELVIN, "data"), "under KELVIN SIGN, GUID target");
      expect(err).toContain(`give --dest by its real path: ${join(a3, "k", "data", "2026-10-22")}`);
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(a3, KELVIN, "data")]).status).toBe(0); }
    // The same junction with its target gone: lstat cannot see it and the folder's listing names it the other way, but Windows
    // still opens it.
    const g3 = join(base, "g3"); privateDir(g3);
    const gone3 = join(base, "gone3"); privateDir(gone3);
    link(join(g3, `a${smallS}`), volume + gone3.slice(3)); rmSync(gone3, { recursive: true });
    try {
      expect(existsSync(join(g3, `a${capitalS}`))).toBe(false); expect(readdirSync(g3)).toEqual([`a${smallS}`]);
      await refusedIndirect(join(g3, `a${capitalS}`, "2026-10-22"), join(g3, `a${capitalS}`), "Greek sigma, GUID junction to nothing", "unresolved");
    } finally { expect(spawnSync("cmd", ["/d", "/c", "rmdir", join(g3, `a${smallS}`)]).status).toBe(0); }
    // A subst drive letter: the letter stands for a folder whose parents are on another drive (review of a08befc).
    const letter = "ZYXWVUTSRQPONMLKJ".split("").find((l) => !existsSync(`${l}:${BS}`));
    if (letter) {
      expect(spawnSync("subst", [`${letter}:`, target]).status).toBe(0);
      try {
        await refusedIndirect(`${letter}:${BS}`, `${letter}:${BS}`, "subst root");
        await refusedIndirect(`${letter}:${BS}2026-10-22`, `${letter}:${BS}`, "subst folder");
      } finally { spawnSync("subst", [`${letter}:`, "/D"]); }
      // A drive letter mapped to a share (here this machine's administrative share).
      const unc = `${BS}${BS}localhost${BS}${target.replace(/^([A-Za-z]):/, "$1$")}`;
      if (existsSync(unc) && spawnSync("net", ["use", `${letter}:`, unc, "/persistent:no"]).status === 0) {
        try {
          // Its real path is a network path, which is refused too, so the message does not offer it (review of 874eac0).
          const err = await refusedIndirect(`${letter}:${BS}2026-10-22`, `${letter}:${BS}`, "mapped drive", "indirect", "use a folder on a local disk");
          expect(err).not.toContain(`real path: ${BS}${BS}`);
        } finally { spawnSync("net", ["use", `${letter}:`, "/delete", "/y"]); }
      }
    }
    // A short (8.3) name on the way: its real path is the long name.
    const long = join(base, "a long folder name"); privateDir(long);
    const short = spawnSync("cmd", ["/d", "/c", `for %I in ("${long}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
    // %~sI shortens every folder on the way that has a short name, so the first one is not necessarily the last.
    if (short && short.toLowerCase() !== long.toLowerCase()) await refusedIndirect(join(short, "2026-10-22"), undefined, "short name");
    expect(readdirSync(target)).toEqual([]);
  }, 180_000); // some 40 dry runs and --apply runs, each starting Windows PowerShell several times (review of 54b7f26)
  it.skipIf(process.platform !== "win32")("on Windows a new folder is private from the moment it is made, not made open and fixed after", async () => {
    claudeTree();
    const parent = join(base, "parent"); privateDir(parent);
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-1-0:(OI)(CI)(IO)F"]).status).toBe(0); // what it passes down
    const seen: string[] = [];
    const look = (made: string) => { for (const d of [dirname(made), made]) seen.push(...aces(d).filter((a) => !/^NT AUTHORITY.SYSTEM:/.test(a) && !/^BUILTIN.Administrators:/.test(a) && !a.toLowerCase().includes(`${String.fromCharCode(92)}${userInfo().username.toLowerCase()}:`))); };
    const r = await run(args(join(parent, "new1", "2026-10-22"), "--apply"), { chainTop: undefined, madeFolder: look });
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(seen).toEqual([]);
    // A later change to the parent's list does not reach them either. (Measured: icacls on the parent changes neither a
    // protected nor an unprotected child made with an explicit list; the list is protected anyway, against tools that
    // re-apply inheritance.)
    expect(spawnSync("icacls", [parent, "/grant", "*S-1-5-32-546:(OI)(CI)(IO)RX"]).status).toBe(0); // Guests, to change it
    onlyOwner(join(parent, "new1")); onlyOwner(join(parent, "new1", "2026-10-22"));
  });
  // Review of 8e5b50d and 874eac0: what the creation script may do, since no test can watch a folder between its creation and
  // its list. Positive: one import, kernel32's CreateDirectoryW, handed the pinned descriptor; nothing that could set a list
  // afterwards.
  it("the folder-making script sets each list as the folder is created, exclusively, and never afterwards", () => {
    expect(MKDIR_SCRIPT.match(/DllImport/g)).toHaveLength(1);
    expect(MKDIR_SCRIPT).toMatch(/\[DllImport\("kernel32\.dll"[^\]]*\)\] static extern bool CreateDirectoryW\(/);
    expect(MKDIR_SCRIPT).toContain("a.lpSecurityDescriptor = pinned.AddrOfPinnedObject();");
    expect(MKDIR_SCRIPT.match(/CreateDirectory/g)).toHaveLength(2); // the import and the call
    expect(MKDIR_SCRIPT).not.toMatch(/advapi32|IntPtr\.Zero|Set\w*Security|SetAccessControl|Set-Acl|cacls|\bmkdir\b|New-Item/i);
  });
  // (No behavioral test can tell a list set at creation from one set right after: measured, a parent that takes the owner's
  // right to change a list (OWNER RIGHTS) makes Windows refuse a list handed over at creation too, error 5.)
  it("a junction put where the first new folder goes before --apply works out what to make is refused too, and nothing is made through it", async () => {
    claudeTree();
    const target = join(base, "target"); privateDir(target);
    const d = join(base, "new1", "2026-10-22");
    let inTarget: string[] = [];
    const r = await run(args(d, "--apply"), { chainTop: undefined, beforeApply: () => link(join(base, "new1"), target), madeFolder: () => { inTarget = readdirSync(target); } });
    expect(r.code).toBe(1); expect(r.err).toContain("refused: a folder or link appeared where retire was making the archive folder, so nothing was moved; use a new folder");
    expect(inTarget).toEqual([]); expect(readdirSync(target)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    if (process.platform === "win32") spawnSync("cmd", ["/d", "/c", "rmdir", join(base, "new1")]);
  });
  // Review of 874eac0: a Windows drive whose driver makes up its access lists (Google Drive's G: reports FAT32) is not a local
  // disk any more than a POSIX network mount is: only NTFS and ReFS are.
  it("on Windows only NTFS and ReFS are known to be local disks", () => {
    for (const f of ["NTFS", "ReFS"]) expect(localDriveFormat(f), f).toBe(true);
    for (const f of ["FAT32", "FAT", "exFAT", "", "rclone", "Dokan", "ntfs-3g", "CDFS", "UDF"]) expect(localDriveFormat(f), f).toBe(false);
  });
  it("a folder or link that appears where retire is about to make a new folder is refused, and nothing is made through it", async () => {
    claudeTree();
    const target = join(base, "target"); privateDir(target);
    const d = join(base, "new1", "2026-10-22");
    const r = await run(args(d, "--apply"), { chainTop: undefined, beforeMake: () => link(join(base, "new1"), target) });
    expect(r.code).toBe(1); expect(r.err).toContain("refused: a folder or link appeared where retire was making the archive folder, so nothing was moved; use a new folder");
    expect(readdirSync(target)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    if (process.platform === "win32") spawnSync("cmd", ["/d", "/c", "rmdir", join(base, "new1")]);
  });
  it.skipIf(process.platform !== "win32")("on Windows a new --dest in the device form past 260 characters is accepted end to end", async () => {
    claudeTree();
    const BS = String.fromCharCode(92);
    const long = join(base, "dev", ...Array.from({ length: 5 }, (_, i) => `${"d".repeat(50)}${i}`));
    expect(long.length).toBeGreaterThan(260);
    mkdirSync(join(base, "dev"));
    const r = await apply(`${BS}${BS}.${BS}${long}`);
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(existsSync(join(long, "manifest.jsonl"))).toBe(true);
    // Written plainly too, with Windows long paths off: every path is passed on in the extended form (review of d905c6f).
    rmSync(home, { recursive: true, force: true }); claudeTree();
    const plain = join(base, "plain", ...Array.from({ length: 5 }, (_, i) => `${"p".repeat(50)}${i}`));
    expect(plain.length).toBeGreaterThan(260);
    const r2 = await apply(plain);
    expect(r2.err).toBe(""); expect(r2.code).toBe(0); expect(existsSync(`${BS}${BS}?${BS}${join(plain, "manifest.jsonl")}`)).toBe(true);
  });
  it.skipIf(process.platform !== "linux")("outside Linux no file system is known to be a local disk, since statfs types there are not Linux's", async () => {
    claudeTree();
    const was = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const r = await apply(join(base, "arch", "2026-10-22"));
      expect(r.code).toBe(1); expect(r.err).toContain("refused: --dest is on a file system not known to be a local disk (");
    } finally { Object.defineProperty(process, "platform", was); }
  });
  it.skipIf(process.platform === "win32")("on POSIX a name ending in a backslash that is a link is refused: a backslash is part of a name there", async () => {
    claudeTree();
    const x = join(base, "X"); mkdirSync(x);
    symlinkSync(x, join(base, "X\\"));
    await refusedIndirect(join(base, "X\\"), join(base, "X\\"), "X backslash");
  });
  it.skipIf(process.platform === "win32")("on POSIX a folder whose name holds a backslash is one folder, judged like any other", async () => {
    claudeTree();
    const odd = join(base, "share\\x"); mkdirSync(odd); chmodSync(odd, 0o777);
    const r = await apply(join(odd, "2026-10-22"));
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${odd} lets other accounts rename or remove the folders in it`);
    // And a link below it is still seen: split on "\" too, the walk would stop at "share", which is not there.
    chmodSync(odd, 0o700);
    const target = join(base, "target"); mkdirSync(target); symlinkSync(target, join(odd, "j"));
    await refusedIndirect(join(odd, "j", "2026-10-22"), join(odd, "j"), "link below a backslash name");
  });
  it.skipIf(process.platform === "win32" || !process.env.KL_TEST_SHARED_DIR)("on POSIX a --dest on a network or shared file system (here KL_TEST_SHARED_DIR) is refused", async () => {
    claudeTree();
    const d = join(process.env.KL_TEST_SHARED_DIR!, `kl-retire-${process.pid}`, "2026-10-22");
    const r = await apply(d);
    expect(r.code).toBe(1); expect(r.err).toContain("refused: --dest is on a file system not known to be a local disk (");
    expect(r.err).toContain("so nothing was moved; use a folder on a local disk"); expect(existsSync(d)).toBe(false);
  });
  // Security review of 8e5b50d: a list of shared file systems misses the ones nobody listed (vboxsf, lustre, gpfs, ...), so
  // only known local disks are accepted.
  it("accepts only file systems known to be local disks, by their type", () => {
    for (const t of [0xef53 /* ext2-4 */, 0x58465342 /* xfs */, 0x9123683e /* btrfs */, 0x01021994 /* tmpfs */, 0x2fc12fc1 /* zfs */, 0xf2f52010 /* f2fs */, 0x794c7630 /* overlay */]) expect(localFs(t), t.toString(16)).toBe(true);
    for (const t of [0x6969 /* nfs */, 0xff534d42 /* cifs */, 0xfe534d42 /* smb2 */, 0x01021997 /* 9p */, 0x53464846 /* drvfs */, 0x65735546 /* fuse */, 0x6a656a63 /* virtiofs */, 0x786f4256 /* vboxsf */, 0x0bd00bd0 /* lustre */, 0x12345678 /* made up */]) expect(localFs(t), t.toString(16)).toBe(false);
  });
  it("something put into a new folder above the archive before it was private is refused, and nothing moves", async () => {
    claudeTree();
    const d = join(root, "new-parent", "2026-10-22");
    const r = await run(args(d, "--apply"), { madeFolder: (made) => writeFileSync(join(dirname(made), "planted"), "x") });
    expect(r.code).toBe(1); expect(r.err).toContain("refused: something was put into the new archive folder before it was private, so nothing was moved");
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Mutation round 2 of a08befc: the drive root written as \\?\C:\ or \\.\C:\ must compare with the plain real paths below it,
  // or every --dest in those forms reads as going through a link. The seam hid it (the root is above every test folder).
  it.skipIf(process.platform !== "win32")("on Windows a new --dest given in the extended or device form, or in other letter case, is accepted end to end", async () => {
    const BS = String.fromCharCode(92);
    for (const [name, written] of [["extended", (p: string) => `${BS}${BS}?${BS}${p}`], ["device", (p: string) => `${BS}${BS}.${BS}${p}`], ["case", (p: string) => p.toUpperCase()]] as const) {
      rmSync(home, { recursive: true, force: true }); claudeTree();
      mkdirSync(join(base, name));
      const r = await apply(written(join(base, name, "2026-10-22")));
      expect(r.err, name).toBe(""); expect(r.code, name).toBe(0); expect(existsSync(join(base, name, "2026-10-22", "manifest.jsonl")), name).toBe(true);
    }
  });
  it("a --dest that cannot be made is refused, not a crash, and the folders made on the way are removed", async () => {
    claudeTree();
    const parent = join(base, "parent"); privateDir(parent);
    // A file where a folder must go, or as --dest itself: refused by the dry run too, saying so (review of d910e90).
    writeFileSync(join(parent, "blocker"), "a file, not a folder");
    for (const [d, text] of [[join(parent, "blocker", "2026-10-22"), `--dest goes through ${join(parent, "blocker")}, which is a file, not a folder, so nothing was moved; use a folder whose parents are all folders`], [join(parent, "blocker"), "--dest is a file, not a folder, so nothing was moved; use a folder"]]) {
      for (const more of [[], ["--apply"]]) {
        const r = await run(args(d!, ...more), { chainTop: undefined });
        expect(r.code, d).toBe(1); expect(r.err, d).toContain(`refused: ${text}`);
      }
    }
    expect(readdirSync(parent)).toEqual(["blocker"]);
    // A first new folder that can be made, then a name no file system takes (256 characters): the first one is removed.
    // Named, with advice, on POSIX too (review of 4dcb602).
    const two = await apply(join(parent, "new1", "y".repeat(256)));
    expect(two.code).toBe(1); expect(two.err).toContain(`refused: could not make the archive folder ${join(parent, "new1", "y".repeat(256))} (${process.platform === "win32" ? "Windows error " : ""}`);
    expect(two.err).toMatch(/\), so nothing was moved; use another folder$/m);
    expect(readdirSync(parent)).toEqual(["blocker"]);
    expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
  });
  // Review of 00e9059: a --dest inside the folders being retired from is refused as such before any refusal that names a folder,
  // so no message prints a project folder's name.
  it("a --dest inside a project folder is refused as such before any refusal that would name the folder", async () => {
    claudeTree();
    const project = basename(proj());
    const cases = [join(proj(), `${OLD}.jsonl`, "x"), ...(process.platform === "win32" ? [join(proj(), `x" --apply`)] : [join(proj(), "archive")])];
    if (process.platform !== "win32") chmodSync(proj(), 0o555); // one this user may not write in
    try {
      for (const d of cases) {
        for (const more of [[], ["--apply"]]) {
          const r = await run(args(d, ...more), { chainTop: undefined });
          expect(r.code, d).toBe(1); expect(r.err, d).toContain("refused: --dest must be outside the folders being retired from"); expect(r.err, d).not.toContain(project);
        }
      }
    } finally { if (process.platform !== "win32") chmodSync(proj(), 0o755); }
  });
  // Review of 4dcb602: on POSIX a folder this user may not write in is seen before anything is made, by the dry run too (root
  // may write anywhere, so the test runs as another account only).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("on POSIX a --dest under a folder this user may not write in is refused by the dry run and --apply", async () => {
    claudeTree();
    const shut = join(base, "shut"); mkdirSync(shut); chmodSync(shut, 0o555);
    try {
      for (const more of [[], ["--apply"]]) {
        const r = await run(args(join(shut, "2026-10-22"), ...more), { chainTop: undefined });
        expect(r.code, more.join(" ")).toBe(1); expect(r.err).toContain(`refused: this user may not make folders in ${shut}, so nothing was moved; use a folder you may make folders in`);
      }
      expect(readdirSync(shut)).toEqual([]);
    } finally { chmodSync(shut, 0o755); }
  });
  // Review of 4dcb602: when the Windows PowerShell run that makes the folders fails as a whole, it says so and what to do.
  it.skipIf(process.platform !== "win32")("on Windows a failed run making the folders says no folder was made, and to try again", async () => {
    claudeTree();
    const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const real = cp.spawnSync;
    try {
      cp.spawnSync = ((cmd: string, argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
        if (opts?.env?.KL_RETIRE_NEW_DIRS !== undefined) return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null };
        return real(cmd, argv, opts as Parameters<typeof real>[2]);
      }) as unknown as typeof real;
      syncBuiltinESMExports();
      const r = await apply(join(base, "arch", "2026-10-22"));
      expect(r.code).toBe(1); expect(r.err).toContain("refused: Windows PowerShell could not make the archive folder (exit 1), so nothing was moved; check that Windows PowerShell runs, then try again");
    } finally { cp.spawnSync = real; syncBuiltinESMExports(); }
    expect(existsSync(join(base, "arch"))).toBe(false);
  });
  // Review of d910e90: Windows' own reason is given, not "private".
  it.skipIf(process.platform !== "win32")("on Windows a --dest in a folder this user may not make folders in is refused with Windows' reason", async () => {
    claudeTree();
    const me = [process.env.USERDOMAIN, userInfo().username].filter(Boolean).join(String.fromCharCode(92));
    const denied = join(base, "denied"); privateDir(denied);
    expect(spawnSync("icacls", [denied, "/deny", `${me}:(AD)`]).status).toBe(0);
    try {
      const r = await apply(join(denied, "2026-10-22"));
      expect(r.code).toBe(1); expect(r.err).toContain(`refused: Windows refused to make ${join(denied, "2026-10-22")} (error 5, access denied: this user may not make folders in ${denied}, or that folder takes away the owner's right to set permissions), so nothing was moved; use a folder you may make folders in`);
      expect(readdirSync(denied)).toEqual([]); expect(existsSync(join(proj(), `${OLD}.jsonl`))).toBe(true);
    } finally { expect(spawnSync("icacls", [denied, "/remove:d", me]).status).toBe(0); }
  });
  it("the chain always reaches the root of the drive", () => {
    expect(chainOf(join(base, "a", "b"), undefined).some((s) => s.dir === parse(base).root && s.hasChild)).toBe(true);
  });
  it("the test seam judges its own folder too, and trusts only the folders above it", async () => {
    claudeTree();
    const t = join(base, "t"); openToAll(t);
    const r = await run(args(join(t, "archive"), "--apply"), { chainTop: t });
    expect(r.code).toBe(1); expect(r.err).toContain(`${SWAP}${t} lets other accounts rename or remove the folders in it`);
  });

  const ME = "S-1-5-21-1-2-3-1001", OTHER = "S-1-5-21-1-2-3-1002", TI = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  const FULL = 0x1f01ff;
  const acl = (owner: string, ...entries: [boolean, string, number, boolean?][]) => ({ owner, entries: entries.map(([allow, sid, mask, inheritOnly = false]) => ({ allow, sid, mask, inheritOnly })) });
  it("judges a Windows folder by its owner, its own entries, and whether it lets others remove the folders in it", () => {
    expect(aclRisk(acl(ME, [true, ME, FULL], [true, "S-1-5-18", FULL]), ME, true)).toBeUndefined();
    for (const owner of ["S-1-5-18", "S-1-5-32-544", TI]) expect(aclRisk(acl(owner, [true, ME, FULL]), ME, true), owner).toBeUndefined();
    expect(aclRisk(acl(OTHER, [true, ME, FULL]), ME, false)).toBe("owner");
    // Removing, renaming or taking over the folder itself: delete, write DAC, write owner, generic all, maximum allowed, Modify.
    for (const mask of [0x10000, 0x40000, 0x80000, 0x10000000, 0x02000000, 0x1301bf]) expect(aclRisk(acl(ME, [true, OTHER, mask]), ME, false), mask.toString(16)).toBe("entry");
    // Removing the folders in it: delete child, generic all, maximum allowed; only for a folder with the next one inside it.
    for (const mask of [0x40, 0x10000000, 0x02000000]) expect(aclRisk(acl(ME, [true, "S-1-1-0", mask]), ME, true), mask.toString(16)).toBe("children");
    expect(aclRisk(acl(ME, [true, "S-1-1-0", 0x40]), ME, false)).toBeUndefined();
    expect(aclRisk(acl("S-1-5-18", [true, "S-1-1-0", FULL]), ME, true)).toBe("children"); // an everyone-full-control drive root
    // Read and traverse, add a folder or a file, generic read, write and execute (none removes anything), inherit-only and
    // deny entries, and the trusted accounts do not count.
    for (const mask of [0x1200a9, 0x4, 0x2, 0xe0000000]) expect(aclRisk(acl(ME, [true, "S-1-1-0", mask]), ME, true), mask.toString(16)).toBeUndefined();
    expect(aclRisk(acl(ME, [true, "S-1-1-0", FULL, true]), ME, true)).toBeUndefined();
    expect(aclRisk(acl(ME, [false, "S-1-1-0", FULL]), ME, true)).toBeUndefined();
    for (const sid of ["S-1-5-18", "S-1-5-32-544", "S-1-3-0", TI]) expect(aclRisk(acl(ME, [true, sid, FULL]), ME, true), sid).toBeUndefined();
    // OWNER RIGHTS applies only to the owner, who is trusted by then.
    expect(aclRisk(acl(ME, [true, "S-1-3-4", FULL]), ME, true)).toBeUndefined();
    expect(aclRisk(undefined, ME, true)).toBe("unknown");
    // A volume's root cannot be renamed or removed, so delete on it alone does not count; the rights that rewrite its list do,
    // and delete child still does. Windows' own list for a new NTFS volume's root gives Authenticated Users Modify on it
    // (review of f0154ee).
    expect(aclRisk(acl("S-1-5-18", [true, "S-1-5-11", 0x1301bf]), ME, true, true)).toBeUndefined();
    expect(aclRisk(acl("S-1-5-18", [true, "S-1-5-11", 0x1301bf]), ME, true, false)).toBe("entry");
    for (const mask of [0x40000, 0x80000, 0x10000000, 0x02000000]) expect(aclRisk(acl(ME, [true, OTHER, mask]), ME, false, true), mask.toString(16)).toBe("entry");
    expect(aclRisk(acl("S-1-5-18", [true, "S-1-1-0", FULL]), ME, true, true)).toBe("children");
    // AppContainer package and capability SIDs only narrow what an AppContainer's own account is allowed: no account holds
    // them (review of f0154ee, measured with lowbox tokens).
    for (const sid of ["S-1-15-3-4096", "S-1-15-2-1", "S-1-15-2-1-2-3-4-5-6-7"]) expect(aclRisk(acl(ME, [true, sid, FULL]), ME, true), sid).toBeUndefined();
    expect(aclRisk(acl(ME, [true, "S-1-5-19", 0x40]), ME, true)).toBe("children");
    expect(aclRisk(acl("S-1-15-3-4096", [true, ME, FULL]), ME, true)).toBe("owner");
  });
  it("judges a POSIX folder by the owner of its name and whether group or others may write in it without the sticky bit", () => {
    expect(modeRisk({ uid: 1000, mode: 0o40700 }, 1000, true)).toBeUndefined();
    expect(modeRisk({ uid: 0, mode: 0o40755 }, 1000, true)).toBeUndefined();
    expect(modeRisk({ uid: 1001, mode: 0o40700 }, 1000, false)).toBe("owner");
    for (const mode of [0o40777, 0o40770, 0o40707, 0o40720, 0o40702]) expect(modeRisk({ uid: 0, mode }, 1000, true), mode.toString(8)).toBe("children");
    expect(modeRisk({ uid: 0, mode: 0o41777 }, 1000, true)).toBeUndefined();
    expect(modeRisk({ uid: 1000, mode: 0o40777 }, 1000, false)).toBeUndefined();
    expect(modeRisk(undefined, 1000, true)).toBe("unknown");
  });
});
