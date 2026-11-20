// AR3: the read-only session watch (docs/sessions/AR3-session-watch.md). Synthetic session trees only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync, statSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessions, buildReport, formatReport, maskProjects, main, type SessionInfo } from "../cli/sessions/src/watch.ts";
import { parseRolloutName } from "../cli/sessions/src/codex.ts";

const DAY = 86_400_000, HOUR = 3_600_000, MiB = 1024 * 1024, GiB = 1024 * MiB;
const NOW = Date.parse("2026-10-21T18:00:00Z");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kl-watch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Write a file of `bytes` bytes (or the given text) and set its mtime. */
function put(path: string, content: string | number, mtime: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "number" ? Buffer.alloc(content, 0x61) : content);
  utimesSync(path, mtime / 1000, mtime / 1000);
}
const claudeLine = (iso: string) => JSON.stringify({ type: "user", timestamp: iso, message: { content: "synthetic" } }) + "\n";
const S1 = "11111111-1111-4111-8111-111111111111", S2 = "22222222-2222-4222-8222-222222222222", C1 = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const R1 = "0199aaaa-bbbb-7ccc-8ddd-ffffffffffff";
/** Codex names rollouts in local time. */
const local = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).getTime();
const roots = (r = root) => ({ claudeRoot: join(r, "claude"), codexRoot: join(r, "codex", "sessions"), codexArchivedRoot: join(r, "codex", "archived_sessions") });

describe("parseRolloutName", () => {
  it("reads the thread id, the rollout id after a revert, compression, and the local-time start", () => {
    expect(parseRolloutName(`rollout-2026-07-14T09-30-00-${C1}.jsonl`)).toEqual({ threadId: C1, rolloutId: C1, compressed: false, startedAt: local(2026, 7, 14, 9, 30, 0) });
    expect(parseRolloutName(`rollout-2026-07-14T09-30-00-${C1}_${R1}.jsonl.zst`)).toEqual({ threadId: C1, rolloutId: R1, compressed: true, startedAt: local(2026, 7, 14, 9, 30, 0) });
    for (const bad of [`rollout-2026-07-14T09-30-00-not-a-uuid.jsonl`, `rollout-2026-07-14T09-30-00-${C1}.json`, `notes.txt`]) expect(parseRolloutName(bad), bad).toBeUndefined();
  });
});

describe("collectSessions", () => {
  it("a Claude session is <id>.jsonl plus its <id>/ folder: bytes and files are summed, the last write is the newest file anywhere in it, and the start is the log's first timestamp", () => {
    const proj = join(root, "claude", "synthetic-project");
    put(join(proj, `${S1}.jsonl`), JSON.stringify({ type: "summary" }) + "\n" + claudeLine("2026-10-01T12:00:00Z") + claudeLine("2026-10-02T12:00:00Z"), NOW - 3 * DAY);
    put(join(proj, S1, "subagents", "agent-a.jsonl"), 1000, NOW - 1 * DAY);
    put(join(proj, S1, "tool-results", "r.txt"), 500, NOW - 5 * DAY);
    mkdirSync(join(proj, "memory"), { recursive: true }); // not a session: no memory.jsonl
    put(join(proj, "memory", "MEMORY.md"), 10, NOW);
    const { sessions } = collectSessions(roots());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ client: "claude", id: S1, project: "synthetic-project", files: 3, startedAt: Date.parse("2026-10-01T12:00:00Z"), lastWriteAt: NOW - 1 * DAY });
    expect(sessions[0]!.bytes).toBe(statSync(join(proj, `${S1}.jsonl`)).size + 1500);
  });
  it("a Claude log with no timestamp in its head still gets a start (its creation time)", () => {
    put(join(root, "claude", "p", `${S1}.jsonl`), JSON.stringify({ type: "summary" }) + "\n", NOW - DAY);
    const { sessions } = collectSessions(roots());
    expect(typeof sessions[0]!.startedAt).toBe("number");
  });
  it("where the file system has no creation time, the start falls back to the log's mtime", () => {
    const log = join(root, "claude", "p", `${S1}.jsonl`);
    put(log, JSON.stringify({ type: "summary" }) + "\n", NOW - DAY);
    const noBirth = { ...fs, lstatSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => { const st = fs.lstatSync(p, o) as fs.Stats; if (String(p) === log) Object.defineProperty(st, "birthtimeMs", { value: 0 }); return st; }) as typeof fs.lstatSync };
    expect(collectSessions(roots(), noBirth).sessions[0]!.startedAt).toBe(statSync(log).mtimeMs);
  });
  it("a Codex thread is all of its rollout files, plain, compressed or reverted, grouped under the thread id with the earliest local-time start", () => {
    const day = join(root, "codex", "sessions", "2026", "07", "14");
    put(join(day, `rollout-2026-07-14T09-30-00-${C1}.jsonl.zst`), 2048, NOW - 9 * DAY);
    put(join(day, `rollout-2026-07-15T10-00-00-${C1}_${R1}.jsonl`), 1024, NOW - 2 * HOUR);
    put(join(day, "notes.txt"), 5, NOW); // not a rollout
    const { sessions } = collectSessions(roots());
    expect(sessions).toEqual([{ client: "codex", id: C1, bytes: 3072, files: 2, startedAt: local(2026, 7, 14, 9, 30, 0), lastWriteAt: NOW - 2 * HOUR }]);
  });
  it("threads in archived_sessions are collected as archived", () => {
    put(join(root, "codex", "archived_sessions", `rollout-2026-07-14T09-30-00-${C1}.jsonl.zst`), 4096, NOW - 20 * DAY);
    const { sessions } = collectSessions(roots());
    expect(sessions).toEqual([{ client: "codex", id: C1, archived: true, bytes: 4096, files: 1, startedAt: local(2026, 7, 14, 9, 30, 0), lastWriteAt: NOW - 20 * DAY }]);
  });
  it("links are not followed: a junction or symlink inside a session folder adds nothing", () => {
    const outside = join(root, "outside");
    put(join(outside, "big.bin"), 5000, NOW - DAY);
    put(join(root, "claude", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    mkdirSync(join(root, "claude", "p", S1), { recursive: true });
    symlinkSync(outside, join(root, "claude", "p", S1, "linked"), "junction");
    const { sessions } = collectSessions(roots());
    expect(sessions[0]!.files).toBe(1); expect(sessions[0]!.bytes).toBeLessThan(5000);
  });
  it("an entry that cannot be read is skipped and counted; the rest of the report is still collected", () => {
    put(join(root, "claude", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    put(join(root, "claude", "p", `${S2}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    const locked = join(root, "claude", "p", `${S2}.jsonl`);
    const failing = { ...fs, lstatSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => { if (String(p) === locked) { const e = new Error("EBUSY") as NodeJS.ErrnoException; e.code = "EBUSY"; throw e; } return fs.lstatSync(p, o); }) as typeof fs.lstatSync };
    const { sessions, unreadable } = collectSessions(roots(), failing);
    expect(sessions.map((s) => s.id)).toEqual([S1]); expect(unreadable).toBe(1);
  });
});

describe("buildReport", () => {
  const base = { client: "claude" as const, files: 1, project: "p" };
  const sessions: SessionInfo[] = [
    { ...base, id: "big-active", bytes: 151 * MiB, startedAt: NOW - 3 * DAY, lastWriteAt: NOW - 60_000 },
    { ...base, id: "long-active", bytes: 10 * MiB, startedAt: NOW - 15 * DAY, lastWriteAt: NOW - DAY },
    { ...base, id: "big-but-quiet", bytes: 900 * MiB, startedAt: NOW - 40 * DAY, lastWriteAt: NOW - 3 * DAY },
    { ...base, id: "small-fresh", bytes: MiB, startedAt: NOW - DAY, lastWriteAt: NOW - 60_000 },
    { ...base, client: "codex", id: "old-idle", bytes: 2 * GiB, startedAt: NOW - 90 * DAY, lastWriteAt: NOW - 8 * DAY },
    { ...base, client: "codex", archived: true, id: "archived-one", bytes: 3 * GiB, startedAt: NOW - 120 * DAY, lastWriteAt: NOW - 30 * DAY },
  ];
  it("recommends a restart only for active sessions (written within 2 days) over 150 MiB or running over 14 days", () => {
    const r = buildReport(sessions, { now: NOW, freeBytes: 20 * GiB });
    expect(r.restart.map((x) => x.id).sort()).toEqual(["big-active", "long-active"]);
    expect(r.restart.find((x) => x.id === "big-active")!.reasons).toEqual(["over 150 MiB"]);
    expect(r.restart.find((x) => x.id === "long-active")!.reasons).toEqual(["running 15 days"]);
  });
  it("counts idle sessions per client, and archived Codex threads apart as what AR2 can retire", () => {
    const r = buildReport(sessions, { now: NOW, freeBytes: 20 * GiB });
    expect(r.clients.codex).toEqual({ sessions: 1, subagents: 0, bytes: 2 * GiB, active: 0, retireCandidates: 1, retireBytes: 2 * GiB });
    expect(r.clients.codexArchived).toEqual({ sessions: 1, subagents: 0, bytes: 3 * GiB, active: 0, retireCandidates: 1, retireBytes: 3 * GiB });
    expect(r.clients.claude).toMatchObject({ sessions: 4, active: 3, retireCandidates: 0 });
  });
  it("thresholds are strict: exactly 150 MiB, 14 days running, 2 days quiet or 7 days idle is not past the line", () => {
    const at = (o: Partial<SessionInfo>): SessionInfo => ({ ...base, id: "x", bytes: MiB, startedAt: NOW - DAY, lastWriteAt: NOW, ...o });
    const flags = (s: SessionInfo) => buildReport([s], { now: NOW }).restart.length;
    expect(flags(at({ bytes: 150 * MiB }))).toBe(0); expect(flags(at({ bytes: 150 * MiB + 1 }))).toBe(1);
    expect(flags(at({ startedAt: NOW - 14 * DAY }))).toBe(0); expect(flags(at({ startedAt: NOW - 14 * DAY - 1 }))).toBe(1);
    expect(buildReport([at({ lastWriteAt: NOW - 2 * DAY })], { now: NOW }).clients.claude.active).toBe(1);
    expect(buildReport([at({ lastWriteAt: NOW - 2 * DAY - 1 })], { now: NOW }).clients.claude.active).toBe(0);
    expect(buildReport([at({ lastWriteAt: NOW - 7 * DAY })], { now: NOW }).clients.claude.retireCandidates).toBe(0);
    expect(buildReport([at({ lastWriteAt: NOW - 7 * DAY - 1 })], { now: NOW }).clients.claude.retireCandidates).toBe(1);
  });
  it("an archived Codex thread never gets a restart flag, even when large, long-running and recently written", () => {
    const r = buildReport([{ client: "codex", archived: true, id: "archived-recent", files: 1, bytes: 900 * MiB, startedAt: NOW - 60 * DAY, lastWriteAt: NOW - HOUR }], { now: NOW });
    expect(r.restart).toEqual([]); expect(r.clients.codexArchived.active).toBe(1);
  });
  it("flags free space below the 10 GiB floor", () => {
    expect(buildReport([], { now: NOW, freeBytes: 9.9 * GiB }).belowFloor).toBe(true);
    expect(buildReport([], { now: NOW, freeBytes: 10.1 * GiB }).belowFloor).toBe(false);
  });
});

describe("formatReport", () => {
  const s: SessionInfo[] = [{ client: "claude", id: S2, project: "client-named-folder", files: 2, bytes: 200 * MiB, startedAt: NOW - 20 * DAY, lastWriteAt: NOW - 60_000 }];
  it("masks project folder names unless --names is given", () => {
    const r = buildReport(s, { now: NOW, freeBytes: 9 * GiB });
    const masked = formatReport(r, { names: false });
    expect(masked).toContain(S2); expect(masked).toContain("project #1"); expect(masked).not.toContain("client-named-folder");
    expect(masked).toMatch(/BELOW FLOOR/);
    expect(formatReport(r, { names: true })).toContain("client-named-folder");
  });
  it("says what to do with each Codex total, and reports the history database and unreadable entries", () => {
    const r = buildReport([{ client: "codex", id: C1, files: 1, bytes: GiB, startedAt: NOW - 30 * DAY, lastWriteAt: NOW - 10 * DAY }, { client: "codex", archived: true, id: R1, files: 1, bytes: GiB, startedAt: NOW - 30 * DAY, lastWriteAt: NOW - 10 * DAY }], { now: NOW, freeBytes: 20 * GiB, codexHistoryBytes: 2 * GiB, unreadable: 3 });
    const text = formatReport(r, { names: false });
    expect(text).toMatch(/^codex: 1 threads.*archive them in Codex first/m);
    expect(text).toMatch(/^codex archived: 1 threads, 1\.00 GiB; AR2 can retire these/m);
    expect(text).toMatch(/^codex thread history database: 2\.00 GiB/m);
    expect(text).toMatch(/^unreadable entries skipped: 3/m);
  });
});

describe("main", () => {
  it("--json masks project folder names too, numbering distinct projects in sorted order, unless --names is given", async () => {
    const S3 = "33333333-3333-4333-8333-333333333333";
    for (const [proj, id] of [["zeta-client-folder", S1], ["alpha-client-folder", S2], ["mid-client-folder", S3]] as const) {
      put(join(root, "home", ".claude", "projects", proj, `${id}.jsonl`), claudeLine("2026-09-20T00:00:00Z"), NOW - 60_000); // running 31 days, active
    }
    const run = async (argv: string[]) => { let out = ""; await main(argv, { stdout: (x) => (out += x), stderr: () => {}, home: join(root, "home"), now: NOW }); return out; };
    const masked = JSON.parse(await run(["--json"]));
    expect(masked.restart.map((x: { id: string; project: string }) => `${x.id}=${x.project}`).sort()).toEqual([`${S1}=project #3`, `${S2}=project #1`, `${S3}=project #2`]);
    expect(JSON.stringify(masked)).not.toMatch(/client-folder/);
    expect(await run(["--json", "--names"])).toContain("zeta-client-folder");
  });
  it("is read-only: every file keeps its bytes and mtime, and nothing is created", async () => {
    const proj = join(root, "home", ".claude", "projects", "p");
    put(join(proj, `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    put(join(proj, S1, "x.jsonl"), 300, NOW - DAY);
    put(join(root, "home", ".codex", "sessions", "2026", "10", "01", `rollout-2026-10-01T00-00-00-${C1}.jsonl`), 400, NOW - DAY);
    put(join(root, "home", ".codex", "archived_sessions", `rollout-2026-09-01T00-00-00-${R1}.jsonl.zst`), 400, NOW - 30 * DAY);
    const snap = () => { const out: string[] = []; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const st = statSync(p); out.push(`${p}|${st.size}|${st.mtimeMs}`); } } }; walk(root); return out.sort(); };
    const before = snap();
    let out = "", err = "";
    const code = await main(["--json"], { stdout: (x) => (out += x), stderr: (x) => (err += x), home: join(root, "home"), now: NOW });
    expect(err).toBe(""); expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.clients.claude.sessions).toBe(1); expect(doc.clients.codex.sessions).toBe(1); expect(doc.clients.codexArchived.sessions).toBe(1);
    expect(snap()).toEqual(before);
  });
  const failWith = (code: string, where: string) => () => { const e = new Error(`${code}: open '${where}'`) as NodeJS.ErrnoException; e.code = code; throw e; };
  it("a log that cannot be opened is still counted, with no crash and no folder name in the output", async () => {
    const log = join(root, "home", ".claude", "projects", "client-named-folder", `${S1}.jsonl`);
    put(log, claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    let out = "", err = "";
    const io = { stdout: (x: string) => (out += x), stderr: (x: string) => (err += x), home: join(root, "home"), now: NOW, fs: { ...fs, openSync: failWith("EBUSY", log) as unknown as typeof fs.openSync } };
    const code = await main(["--json"], io);
    expect(code).toBe(0); expect(err).toBe(""); expect(out + err).not.toContain("client-named-folder");
    expect(JSON.parse(out).clients.claude.sessions).toBe(1);
  });
  it("an unexpected failure (a closed pipe) prints only its error code, never a path, even under --json", async () => {
    put(join(root, "home", ".claude", "projects", "client-named-folder", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    let err = "";
    const where = join(root, "home", ".claude", "projects", "client-named-folder");
    const io = { stdout: failWith("EPIPE", where) as unknown as (s: string) => void, stderr: (x: string) => (err += x), home: join(root, "home"), now: NOW };
    const code = await main(["--json"], io);
    expect(code).toBe(1); expect(err).toBe(`watch: could not finish the report (EPIPE)${String.fromCharCode(10)}`);
  });
});

// Re-review of PR #28 (round 3).
describe("round 3", () => {
  const meta = (id: string, payload: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id, ...payload } }) + "\n";
  it("a spawned subagent thread is counted but never flagged for restart; its parent is", () => {
    const day = join(root, "codex", "sessions", "2026", "10", "01");
    put(join(day, `rollout-2026-10-01T00-00-00-${C1}.jsonl`), meta(C1) + "x".repeat(10), NOW - HOUR);
    put(join(day, `rollout-2026-10-01T00-01-00-${R1}.jsonl`), meta(R1, { source: { subagent: { other: {} } }, forked_from_id: C1 }) + "y", NOW - HOUR);
    const { sessions } = collectSessions(roots());
    const r = buildReport(sessions, { now: NOW });
    expect(r.clients.codex.sessions).toBe(2);
    expect(r.restart.map((x) => x.id)).toEqual([C1]); // both run 20 days; only the parent can be restarted
    expect(r.subagentsNotFlagged).toBe(1);
    expect(formatReport(r, { names: false })).toMatch(/^subagent threads not flagged \(restart their parent\): 1/m);
  });
  it("a .jsonl whose name is not a session id is not a session", () => {
    put(join(root, "claude", "p", "acme-client-notes.jsonl"), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    put(join(root, "claude", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    expect(collectSessions(roots()).sessions.map((s) => s.id)).toEqual([S1]);
  });
  it("a linked project or date folder is skipped and counted, not silently dropped", () => {
    const elsewhere = join(root, "elsewhere");
    put(join(elsewhere, `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    mkdirSync(join(root, "claude"), { recursive: true });
    symlinkSync(elsewhere, join(root, "claude", "linked-project"), "junction");
    const { sessions, linksSkipped } = collectSessions(roots());
    expect(sessions).toEqual([]); expect(linksSkipped).toBe(1);
    const text = formatReport(buildReport(sessions, { now: NOW, linksSkipped }), { names: false });
    expect(text).toMatch(/^linked folders skipped: 1/m);
  });
  it("a history database that vanishes between checks costs only its own line", async () => {
    put(join(root, "home", ".claude", "projects", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    put(join(root, "home", ".codex", "thread_history_1.sqlite"), "db", NOW);
    let out = "";
    const io = { stdout: (x: string) => (out += x), stderr: () => {}, home: join(root, "home"), now: NOW, fs: { ...fs, statSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => { if (String(p).endsWith("thread_history_1.sqlite")) { const e = new Error("EBUSY") as NodeJS.ErrnoException; e.code = "EBUSY"; throw e; } return fs.statSync(p, o); }) as typeof fs.statSync } };
    expect(await main(["--json"], io)).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.clients.claude.sessions).toBe(1); expect(doc.codexHistoryBytes).toBeUndefined(); expect(doc.unreadable).toBe(1);
  });
  it("main reports the history database by its real name and free space in bytes (blocks times block size)", async () => {
    put(join(root, "home", ".codex", "thread_history_1.sqlite"), 1234, NOW);
    let out = "";
    const io = { stdout: (x: string) => (out += x), stderr: () => {}, home: join(root, "home"), now: NOW, fs: { ...fs, statfsSync: (() => ({ bavail: 3, bsize: 4096 })) as unknown as typeof fs.statfsSync } };
    expect(await main(["--json"], io)).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.codexHistoryBytes).toBe(1234); expect(doc.freeBytes).toBe(3 * 4096);
  });
  it("an unknown argument is a usage error, and exactly the floor is not below it", async () => {
    let err = "";
    expect(await main(["--everything"], { stdout: () => {}, stderr: (x) => (err += x), home: join(root, "home"), now: NOW })).toBe(2);
    expect(err).toMatch(/^usage: watch/);
    expect(buildReport([], { now: NOW, freeBytes: 10 * GiB }).belowFloor).toBe(false);
    expect(buildReport([], { now: NOW }).freeBytes).toBeUndefined();
    expect(formatReport(buildReport([], { now: NOW }), { names: false })).toMatch(/^free space: unknown$/m);
  });
  it("restart flags are sorted largest first, and masking numbers projects in sorted order whatever the flag order", () => {
    const flagged = (id: string, project: string, bytes: number): SessionInfo => ({ client: "claude", id, project, files: 1, bytes, startedAt: NOW - 20 * DAY, lastWriteAt: NOW - HOUR });
    const r = buildReport([flagged("b", "alpha", 1 * MiB), flagged("a", "zeta", 900 * MiB), flagged("c", "mid", 300 * MiB)], { now: NOW });
    expect(r.restart.map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(maskProjects(r).restart.map((x) => x.project)).toEqual(["project #3", "project #2", "project #1"]);
  });
});

// Third review of PR #28 (round 4).
describe("round 4", () => {
  const meta = (id: string, payload: Record<string, unknown> = {}, type = "session_meta") => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type, payload: { id, ...payload } }) + "\n";
  const day = () => join(root, "codex", "sessions", "2026", "10", "01");
  const spawned = (parent: string) => ({ source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }, parent_thread_id: parent });
  it("a held-back subagent is listed with the parent to restart, even when the parent is not flagged itself", () => {
    put(join(day(), `rollout-2026-10-18T00-00-00-${C1}.jsonl`), meta(C1) + "small parent", NOW - HOUR);
    put(join(day(), `rollout-2026-10-18T00-01-00-${R1}.jsonl`), meta(R1, spawned(C1)) + "x".repeat(151 * MiB), NOW - HOUR);
    const r = buildReport(collectSessions(roots()).sessions, { now: NOW });
    expect(r.restart).toEqual([]);
    expect(r.subagents).toEqual([{ id: R1, parent: C1, bytes: expect.any(Number), reasons: ["over 150 MiB"] }]);
    expect(formatReport(r, { names: false })).toMatch(new RegExp(`^  codex ${R1} subagent of ${C1} `, "m"));
  });
  it("Codex totals say how many threads are spawned subagents, and a quiet subagent is not counted as held back", () => {
    put(join(day(), `rollout-2026-10-01T00-00-00-${C1}.jsonl`), meta(C1), NOW - 10 * DAY);
    put(join(day(), `rollout-2026-10-01T00-01-00-${R1}.jsonl`), meta(R1, spawned(C1)), NOW - 10 * DAY);
    const r = buildReport(collectSessions(roots()).sessions, { now: NOW });
    expect(r.clients.codex).toMatchObject({ sessions: 2, subagents: 1, retireCandidates: 2 });
    expect(r.subagentsNotFlagged).toBe(0);
    expect(formatReport(r, { names: false })).toMatch(/^codex: 2 threads \(1 spawned subagents\)/m);
  });
  it("subagent detection reads the earliest plain rollout, and only a session_meta record counts", () => {
    put(join(day(), `rollout-2026-10-01T00-00-00-${C1}.jsonl`), meta(C1, spawned(R1)), NOW - HOUR);
    put(join(day(), `rollout-2026-10-02T00-00-00-${C1}_${R1}.jsonl`), meta(C1), NOW - HOUR);
    const S5 = "55555555-5555-4555-8555-555555555555";
    put(join(day(), `rollout-2026-10-01T00-00-00-${S5}.jsonl`), meta(S5, spawned(C1), "response_item"), NOW - HOUR);
    const byId = new Map(collectSessions(roots()).sessions.map((s) => [s.id, s]));
    expect(byId.get(C1)!.subagentOf).toBe(R1); expect(byId.get(S5)!.subagentOf).toBeUndefined();
  });
  it("links are counted wherever they are skipped: a Codex date folder, inside a session folder, a project folder", () => {
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(root, "codex", "sessions", "2026"), { recursive: true });
    symlinkSync(elsewhere, join(root, "codex", "sessions", "2026", "11"), "junction");
    put(join(root, "claude", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    mkdirSync(join(root, "claude", "p", S1), { recursive: true });
    symlinkSync(elsewhere, join(root, "claude", "p", S1, "linked"), "junction");
    symlinkSync(elsewhere, join(root, "claude", "linked-project"), "junction");
    expect(collectSessions(roots()).linksSkipped).toBe(3);
  });
  it("main carries the link count into the report, and a home without Codex is not 'unreadable'", async () => {
    put(join(root, "home", ".claude", "projects", "p", `${S1}.jsonl`), claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    symlinkSync(join(root, "home", ".claude", "projects", "p"), join(root, "home", ".claude", "projects", "alias"), "junction");
    let out = "";
    expect(await main(["--json"], { stdout: (x) => (out += x), stderr: () => {}, home: join(root, "home"), now: NOW })).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.linksSkipped).toBe(1); expect(doc.unreadable).toBe(0);
  });
});

// Fourth review of PR #28 (round 5): pin the parent chain and the edges of subagent detection.
describe("round 5", () => {
  const meta = (id: string, payload: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id, ...payload } }) + "\n";
  const live = () => join(root, "codex", "sessions", "2026", "10", "01");
  const P1 = "0199aaaa-0000-7000-8000-0000000000a1", P2 = "0199aaaa-0000-7000-8000-0000000000a2", P3 = "0199aaaa-0000-7000-8000-0000000000a3";
  const subagentOf = () => new Map(collectSessions(roots()).sessions.map((s) => [s.id, s.subagentOf]));
  it("the parent is parent_thread_id, else the spawn source's parent, else forked_from_id, else unnamed", () => {
    put(join(live(), `rollout-2026-10-01T00-00-01-${C1}.jsonl`), meta(C1, { parent_thread_id: P1, source: { subagent: { thread_spawn: { parent_thread_id: P2 } } }, forked_from_id: P3 }), NOW - HOUR);
    put(join(live(), `rollout-2026-10-01T00-00-02-${R1}.jsonl`), meta(R1, { source: { subagent: { thread_spawn: { parent_thread_id: P2 } } }, forked_from_id: P3 }), NOW - HOUR);
    put(join(live(), `rollout-2026-10-01T00-00-03-${S1}.jsonl`), meta(S1, { source: { subagent: "review" }, forked_from_id: P3 }), NOW - HOUR);
    put(join(live(), `rollout-2026-10-01T00-00-04-${S2}.jsonl`), meta(S2, { source: { subagent: "review" } }), NOW - HOUR);
    const m = subagentOf();
    expect([m.get(C1), m.get(R1), m.get(S1), m.get(S2)]).toEqual([P1, P2, P3, ""]);
    const r = buildReport([{ client: "codex", id: S2, subagentOf: "", files: 1, bytes: 200 * MiB, startedAt: NOW - DAY, lastWriteAt: NOW - HOUR }], { now: NOW });
    expect(formatReport(r, { names: false })).toMatch(/subagent of an unnamed parent/);
  });
  it("an active subagent with no restart reason is not held back, and held-back ones are listed largest first", () => {
    const sub = (id: string, bytes: number): SessionInfo => ({ client: "codex", id, subagentOf: C1, files: 1, bytes, startedAt: NOW - DAY, lastWriteAt: NOW - HOUR });
    const r = buildReport([sub("small", MiB), sub("mid", 300 * MiB), sub("big", 900 * MiB)], { now: NOW });
    expect(r.subagents.map((x) => x.id)).toEqual(["big", "mid"]);
  });
  it("archived threads are not classified, and a compressed rollout is never read for detection", () => {
    put(join(root, "codex", "archived_sessions", `rollout-2026-10-01T00-00-00-${C1}.jsonl`), meta(C1, { source: { subagent: "review" }, parent_thread_id: P1 }), NOW - 30 * DAY);
    put(join(live(), `rollout-2026-09-01T00-00-00-${R1}.jsonl.zst`), meta(R1, { source: { subagent: "review" }, parent_thread_id: P1 }), NOW - 30 * DAY);
    put(join(live(), `rollout-2026-10-01T00-00-00-${R1}_${P2}.jsonl`), meta(R1), NOW - HOUR);
    const m = subagentOf();
    expect(m.get(C1)).toBeUndefined(); expect(m.get(R1)).toBeUndefined();
  });
  it("a Claude log that is a link is skipped and counted", () => {
    const log = join(root, "claude", "p", `${S1}.jsonl`);
    put(log, claudeLine("2026-10-01T00:00:00Z"), NOW - DAY);
    const asLink = { ...fs, lstatSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => { const st = fs.lstatSync(p, o) as fs.Stats; if (String(p) === log) Object.defineProperty(st, "isSymbolicLink", { value: () => true }); return st; }) as typeof fs.lstatSync };
    const c = collectSessions(roots(), asLink);
    expect(c.sessions).toEqual([]); expect(c.linksSkipped).toBe(1);
  });
});
