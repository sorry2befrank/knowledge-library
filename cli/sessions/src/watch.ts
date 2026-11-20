// AR3 session watch (docs/sessions/AR3-session-watch.md): a read-only report of Claude Code and Codex conversation logs that
// have grown too big or run too long, and of free space on the home volume. It never moves, deletes or writes anything.
// From a log it reads only sizes, mtimes, one start timestamp (Claude) and whether a thread is a spawned subagent and of
// which parent (Codex); nothing read is printed except that parent id. Links below the roots are not followed, and are counted. An entry that cannot be read is skipped
// and counted. Project folder names (which can carry a client name) are printed only with --names, for Frank's own
// terminal, and an error never prints a path.
import * as nodeFs from "node:fs";
import { basename, join } from "node:path";
import { SESSION_ID, parseRolloutName } from "./codex.ts";

/** `subagentOf` marks a spawned Codex subagent thread: its parent's id, or "" when the record does not name one. */
export interface SessionInfo { client: "claude" | "codex"; id: string; project?: string; archived?: true; subagentOf?: string; bytes: number; files: number; startedAt?: number; lastWriteAt: number }
export interface ClientTotals { sessions: number; subagents: number; bytes: number; active: number; retireCandidates: number; retireBytes: number }
export interface RestartFlag { client: "claude" | "codex"; id: string; project?: string; bytes: number; spanDays?: number; idleHours: number; reasons: string[] }
/** A subagent thread that met a restart reason: it is restarted with its parent, so the report names the parent instead. */
export interface HeldSubagent { id: string; parent: string; bytes: number; reasons: string[] }
export interface WatchReport {
  clients: { claude: ClientTotals; codex: ClientTotals; codexArchived: ClientTotals };
  restart: RestartFlag[]; subagents: HeldSubagent[]; subagentsNotFlagged: number; freeBytes?: number; floorBytes: number; belowFloor: boolean; codexHistoryBytes?: number; unreadable: number; linksSkipped: number;
}
type Fs = Pick<typeof nodeFs, "lstatSync" | "readdirSync" | "openSync" | "readSync" | "closeSync" | "statSync" | "statfsSync">;
export interface WatchIo { stdout: (s: string) => void; stderr: (s: string) => void; home: string; now: number; fs?: Fs }

const DAY = 86_400_000, MiB = 1024 * 1024, GiB = 1024 * MiB;
export const WATCH_THRESHOLDS = { maxBytes: 150 * MiB, maxSpanDays: 14, activeDays: 2, idleDays: 7, floorBytes: 10 * GiB } as const;
const HEAD_BYTES = 64 * 1024, META_BYTES = 1024 * 1024;
const newest = (files: { mtimeMs: number }[]) => files.reduce((m, f) => Math.max(m, f.mtimeMs), -Infinity);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export function collectSessions(roots: { claudeRoot: string; codexRoot: string; codexArchivedRoot?: string }, fs: Fs = nodeFs): { sessions: SessionInfo[]; unreadable: number; linksSkipped: number } {
  let unreadable = 0, linksSkipped = 0;
  const lstat = (p: string) => { try { return fs.lstatSync(p); } catch (e) { if (!missing(e)) unreadable++; return undefined; } };
  const names = (p: string) => { try { return fs.readdirSync(p); } catch (e) { if (!missing(e)) unreadable++; return []; } };
  /** Regular files under a path, without following links. */
  const filesUnder = (p: string): { size: number; mtimeMs: number }[] => {
    const st = lstat(p);
    if (!st) return [];
    if (st.isSymbolicLink()) { linksSkipped++; return []; }
    if (st.isFile()) return [{ size: st.size, mtimeMs: st.mtimeMs }];
    return st.isDirectory() ? names(p).flatMap((n) => filesUnder(join(p, n))) : [];
  };
  /** Up to `max` bytes from the start of a file, ending at the first newline when `line`; undefined when it cannot be read. */
  const head = (p: string, max: number, line: boolean): string | undefined => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      const text = buf.subarray(0, n);
      const nl = line ? text.indexOf(0x0a) : -1;
      return (nl >= 0 ? text.subarray(0, nl) : text).toString("utf8");
    } catch { return undefined; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ } }
  };
  /** The first "timestamp" in a Claude log's head, else its creation time, else (no birth time on some file systems) its mtime. */
  const claudeStart = (log: string, birth: number, mtime: number): number => {
    const m = /"timestamp"\s*:\s*"([^"]{10,40})"/.exec(head(log, HEAD_BYTES, false) ?? "");
    const t = m ? Date.parse(m[1]!) : NaN;
    return Number.isFinite(t) ? t : birth > 0 ? birth : mtime;
  };
  /** For a rollout whose session_meta names it a spawned subagent (payload.source.subagent), its parent's id ("" if unnamed). */
  const subagentParent = (rollout: string): string | undefined => {
    try {
      const o = JSON.parse(head(rollout, META_BYTES, true) ?? "");
      const p = o?.type === "session_meta" ? o.payload : undefined;
      if (!p?.source || typeof p.source !== "object" || !("subagent" in p.source)) return undefined;
      const parent = p.parent_thread_id ?? p.source.subagent?.thread_spawn?.parent_thread_id ?? p.forked_from_id;
      return typeof parent === "string" ? parent.toLowerCase() : "";
    } catch { return undefined; }
  };

  const out: SessionInfo[] = [];
  for (const proj of names(roots.claudeRoot)) {
    const pdir = join(roots.claudeRoot, proj), pst = lstat(pdir);
    if (pst?.isSymbolicLink()) { linksSkipped++; continue; }
    if (!pst?.isDirectory()) continue;
    for (const n of names(pdir)) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -".jsonl".length);
      if (!SESSION_ID.test(id)) continue; // not a session log
      const log = join(pdir, n), st = lstat(log);
      if (st?.isSymbolicLink()) { linksSkipped++; continue; }
      if (!st?.isFile()) continue;
      const files = [{ size: st.size, mtimeMs: st.mtimeMs }, ...filesUnder(join(pdir, id))];
      out.push({ client: "claude", id, project: proj, bytes: files.reduce((a, f) => a + f.size, 0), files: files.length, startedAt: claudeStart(log, st.birthtimeMs, st.mtimeMs), lastWriteAt: newest(files) });
    }
  }
  // A Codex thread is every rollout file named for it: plain, compressed, or written after a revert.
  const codex = (root: string, archived: boolean) => {
    const threads = new Map<string, { info: SessionInfo; firstPlain?: { path: string; startedAt: number } }>();
    const walk = (d: string) => {
      for (const n of names(d)) {
        const p = join(d, n), st = lstat(p);
        if (!st) continue;
        if (st.isSymbolicLink()) { linksSkipped++; continue; }
        if (st.isDirectory()) { walk(p); continue; }
        const r = st.isFile() ? parseRolloutName(n) : undefined;
        if (!r) continue;
        const t = threads.get(r.threadId) ?? { info: { client: "codex" as const, id: r.threadId, ...(archived ? { archived: true as const } : {}), bytes: 0, files: 0, startedAt: r.startedAt, lastWriteAt: -Infinity } };
        t.info.bytes += st.size; t.info.files++; t.info.startedAt = Math.min(t.info.startedAt!, r.startedAt); t.info.lastWriteAt = Math.max(t.info.lastWriteAt, st.mtimeMs);
        if (!r.compressed && (!t.firstPlain || r.startedAt < t.firstPlain.startedAt)) t.firstPlain = { path: p, startedAt: r.startedAt };
        threads.set(r.threadId, t);
      }
    };
    walk(root);
    for (const t of threads.values()) {
      // Only live threads can be flagged, and a live thread's first rollout is plain (Codex compresses only idle ones).
      const parent = !archived && t.firstPlain ? subagentParent(t.firstPlain.path) : undefined;
      if (parent !== undefined) t.info.subagentOf = parent;
      out.push(t.info);
    }
  };
  codex(roots.codexRoot, false);
  if (roots.codexArchivedRoot) codex(roots.codexArchivedRoot, true);
  return { sessions: out, unreadable, linksSkipped };
}

export function buildReport(sessions: SessionInfo[], o: { now: number; freeBytes?: number; codexHistoryBytes?: number; unreadable?: number; linksSkipped?: number }, t = WATCH_THRESHOLDS): WatchReport {
  const totals = (): ClientTotals => ({ sessions: 0, subagents: 0, bytes: 0, active: 0, retireCandidates: 0, retireBytes: 0 });
  const clients = { claude: totals(), codex: totals(), codexArchived: totals() };
  const restart: RestartFlag[] = [], subagents: HeldSubagent[] = [];
  for (const s of sessions) {
    const c = s.archived ? clients.codexArchived : clients[s.client];
    c.sessions++; c.bytes += s.bytes;
    if (s.subagentOf !== undefined) c.subagents++;
    const idle = o.now - s.lastWriteAt;
    if (idle > t.idleDays * DAY) { c.retireCandidates++; c.retireBytes += s.bytes; }
    if (idle > t.activeDays * DAY) continue;
    c.active++;
    if (s.archived) continue;
    // "Running" is now minus start: an active session is still running.
    const running = s.startedAt === undefined ? undefined : o.now - s.startedAt;
    const spanDays = running === undefined ? undefined : Math.floor(running / DAY);
    const reasons = [...(s.bytes > t.maxBytes ? [`over ${t.maxBytes / MiB} MiB`] : []), ...(running !== undefined && running > t.maxSpanDays * DAY ? [`running ${spanDays} days`] : [])];
    if (!reasons.length) continue;
    // A subagent is restarted with its parent, never on its own: name the parent instead.
    if (s.subagentOf !== undefined) { subagents.push({ id: s.id, parent: s.subagentOf, bytes: s.bytes, reasons }); continue; }
    restart.push({ client: s.client, id: s.id, project: s.project, bytes: s.bytes, spanDays, idleHours: Math.floor(idle / 3_600_000), reasons });
  }
  restart.sort((a, b) => b.bytes - a.bytes);
  subagents.sort((a, b) => b.bytes - a.bytes);
  return { clients, restart, subagents, subagentsNotFlagged: subagents.length, freeBytes: o.freeBytes, floorBytes: t.floorBytes, belowFloor: o.freeBytes !== undefined && o.freeBytes < t.floorBytes, codexHistoryBytes: o.codexHistoryBytes, unreadable: o.unreadable ?? 0, linksSkipped: o.linksSkipped ?? 0 };
}

const gib = (b: number) => `${(b / GiB).toFixed(2)} GiB`;
const size = (b: number) => (b >= GiB ? gib(b) : `${Math.round(b / MiB)} MiB`);

/** A copy of the report whose project folder names are replaced by "project #N", numbering the distinct names in sorted order. */
export function maskProjects(r: WatchReport): WatchReport {
  const projects = [...new Set(r.restart.map((x) => x.project).filter((p): p is string => p !== undefined))].sort();
  return { ...r, restart: r.restart.map((x) => (x.project === undefined ? x : { ...x, project: `project #${projects.indexOf(x.project) + 1}` })) };
}

export function formatReport(report: WatchReport, o: { names: boolean }): string {
  const r = o.names ? report : maskProjects(report);
  const label = (p?: string) => (p === undefined ? "" : `  ${p}`);
  const idle = (c: ClientTotals) => `idle over 7 days ${c.retireCandidates} (${size(c.retireBytes)})`;
  const { claude, codex, codexArchived } = r.clients;
  const lines = [r.freeBytes === undefined ? "free space: unknown" : `free space ${gib(r.freeBytes)}, floor ${gib(r.floorBytes)}: ${r.belowFloor ? "BELOW FLOOR" : "ok"}`];
  lines.push(`claude: ${claude.sessions} sessions, ${size(claude.bytes)}; active ${claude.active}; ${idle(claude)}`);
  lines.push(`codex: ${codex.sessions} threads (${codex.subagents} spawned subagents), ${size(codex.bytes)}; active ${codex.active}; ${idle(codex)}; archive them in Codex first, then AR2 can retire them`);
  lines.push(`codex archived: ${codexArchived.sessions} threads, ${size(codexArchived.bytes)}; AR2 can retire these`);
  if (r.codexHistoryBytes !== undefined) lines.push(`codex thread history database: ${size(r.codexHistoryBytes)}`);
  if (r.unreadable) lines.push(`unreadable entries skipped: ${r.unreadable}`);
  if (r.linksSkipped) lines.push(`linked folders skipped: ${r.linksSkipped}`);
  if (r.subagentsNotFlagged) lines.push(`subagent threads not flagged (restart their parent): ${r.subagentsNotFlagged}`);
  for (const x of r.subagents) lines.push(`  codex ${x.id} subagent of ${x.parent || "an unnamed parent"}  ${size(x.bytes)}  ${x.reasons.join(", ")}`);
  lines.push(`restart recommended: ${r.restart.length}`);
  for (const x of r.restart) lines.push(`  ${x.client} ${x.id}  ${size(x.bytes)}  ${x.reasons.join(", ")}  last write ${x.idleHours} h ago${label(x.project)}`);
  return lines.join("\n") + "\n";
}

export async function main(argv: string[], io: WatchIo): Promise<number> {
  const names = argv.includes("--names"), json = argv.includes("--json");
  if (argv.some((a) => a !== "--names" && a !== "--json")) { io.stderr("usage: watch [--json] [--names]\n"); return 2; }
  const fs = io.fs ?? nodeFs;
  try {
    const c = collectSessions({ claudeRoot: join(io.home, ".claude", "projects"), codexRoot: join(io.home, ".codex", "sessions"), codexArchivedRoot: join(io.home, ".codex", "archived_sessions") }, fs);
    let freeBytes: number | undefined, codexHistoryBytes: number | undefined, unreadable = c.unreadable;
    try { const s = fs.statfsSync(io.home); freeBytes = s.bavail * s.bsize; } catch { freeBytes = undefined; }
    try { codexHistoryBytes = fs.statSync(join(io.home, ".codex", "thread_history_1.sqlite")).size; } catch (e) { if (!missing(e)) unreadable++; }
    const r = buildReport(c.sessions, { now: io.now, freeBytes, codexHistoryBytes, unreadable, linksSkipped: c.linksSkipped });
    io.stdout(json ? JSON.stringify(names ? r : maskProjects(r)) + "\n" : formatReport(r, { names }));
    return 0;
  } catch (e) {
    // Never echo the error's message: it can carry a path with a project folder name.
    io.stderr(`watch: could not finish the report (${(e as NodeJS.ErrnoException).code ?? "error"})\n`);
    return 1;
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] && basename(process.argv[1]) === "watch.ts";
if (isMain) {
  const { homedir } = await import("node:os");
  main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), home: homedir(), now: Date.now() }).then((c) => process.exit(c), () => { process.stderr.write("watch: could not finish the report\n"); process.exit(1); });
}
