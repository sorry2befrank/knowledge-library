// sessions grade: the resume grader (board UNISON-resume-loop.md slice 3, Contract 6 in cli/kl/src/resume-contract.ts).
// It reads one Claude Code session log and reports numbers, paths and citations, never message text: the prompt size of
// the first response (the fixed floor), the prompt at the first scratch write and at the first project change, the
// tokens spent to that change, Library reads and errors, and, only from evidence inputs, whether the old log was opened
// or --resume used. Every unknown is null; an empty list means measured, none found.
//
//   node cli/sessions/src/grade.ts <session.jsonl> [--scratchpad <dir>] [--predecessor <log>] [--old-log <path>]
//        [--launch <file>] [--snapshot-before <file> --snapshot-after <file>] --json
//   node cli/sessions/src/grade.ts --snapshot <paths file>      (prints [{path,size,mtime}] for T8, contents never read)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { unknownGradeReport, type GradeEdit, type GradeReport } from "../../kl/src/resume-contract.ts";

export interface SnapshotEntry { path: string; size: number; mtime: string }
export interface GradeOptions {
  session: string;
  /** A folder whose files are scratch; default: any path under a Claude Code temp folder (`Temp\claude\`). */
  scratchpad?: string;
  /** The predecessor session's log text, for its last prompt size. */
  predecessor?: string;
  /** The old session's log path: with it, oldLogOpened can be false. */
  oldLogPath?: string;
  /** The command line the session was launched with: with it, resumeUsed can be false. */
  launch?: string;
  before?: SnapshotEntry[];
  after?: SnapshotEntry[];
}
export interface GradeIo { stdout: (s: string) => void; stderr: (s: string) => void }

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Tools that read file contents and record what they read: Read and NotebookRead one file, Grep everything under its path.
 *  Glob lists names only, so it reads nothing; a shell command's reads are not observable. */
const FILE_READ_TOOLS = new Set(["Read", "NotebookRead"]);
interface ToolUse { id: string; name: string; input: Record<string, unknown>; messageId: string; cwd?: string }
/** A message's measured token counts, or null when its usage was missing or not whole non-negative numbers. */
interface Message { id: string; line: number; usage: { input: number; written: number; read: number } | null }

const prompt = (m: Message) => (m.usage ? m.usage.input + m.usage.written + m.usage.read : null);
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
/** A path in one comparable form: forward slashes, lower case, `.` and `..` resolved, a relative path placed in the folder
 *  the tool ran in. Null when it cannot be placed: relative with no recorded folder, or drive-relative (`C:x`). */
function canon(p: string, cwd?: string): string | null {
  let s = p.replace(/\\/g, "/");
  if (/^[a-z]:(?!\/)/i.test(s)) return null;
  if (!/^([a-z]:)?\//i.test(s)) {
    if (!cwd || canon(cwd) === null) return null;
    s = cwd.replace(/\\/g, "/").replace(/\/?$/, "/") + s;
  }
  const m = /^([a-z]:)?(.*)$/i.exec(s)!;
  const out: string[] = [];
  for (const seg of m[2]!.split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
  return ((m[1] ?? "") + "/" + out.join("/")).toLowerCase();
}
const baseName = (p: string) => p.replace(/\\/g, "/").replace(/^[a-z]:/i, "").replace(/\/+$/, "").split("/").pop()!.toLowerCase();
const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
function usageOf(u: any): Message["usage"] {
  const input = whole(u?.input_tokens), written = whole(u?.cache_creation_input_tokens), read = whole(u?.cache_read_input_tokens);
  return input === undefined || written === undefined || read === undefined ? null : { input, written, read };
}
/** A launch command line split into arguments, quotes respected; null when a quote is left open (unusable evidence). */
function argv(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote = "", started = false;
  for (const c of cmd) {
    if (quote) { if (c === quote) quote = ""; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) out.push(cur); cur = ""; started = false; continue; }
    cur += c; started = true;
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}
/** A citation's parts: its span (#L.. or #$..) and its ~sha8, or null when it is not a citation. */
const citeParts = (cite: string) => { const m = /^kl:[0-9A-HJKMNP-TV-Z]{10}@\d+(#[^~]+)?(?:~([0-9a-f]{8}))?$/.exec(cite); return m ? { span: m[1], sha8: m[2] } : null; };
/** The note text inside library_read's untrusted wrapper (packages/core/src/primitives/untrusted.ts), as sent; null if not wrapped. */
function unwrap(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = /^<untrusted-note-([^\s>]+) cite="[^"]*">([\s\S]*)<\/untrusted-note-\1>$/.exec(text);
  return m ? m[2]! : null;
}
/** Whether span text as sent hashes to the citation's span hash. The wrapper writes `untrusted-note` as `untrusted&#45;note`
 *  and leaves a literal `untrusted&#45;note` alone, so each such spelling may be either; every reading is tried, and with too
 *  many to try the answer is unknown (Codex's review of ffc7a3e). */
function spanMatches(sent: string, sha8: string): boolean | null {
  const pieces = sent.split(/(untrusted&#45;note)/i);
  const n = (pieces.length - 1) / 2;
  if (n > 12) return null;
  for (let mask = 0; mask < 2 ** n; mask++) {
    const text = pieces.map((x, i) => (i % 2 === 1 && (mask >> ((i - 1) / 2)) & 1 ? x.replace("&#45;", "-") : x)).join("");
    if (createHash("sha256").update(text).digest("hex").slice(0, 8) === sha8) return true;
  }
  return false;
}

function parse(log: string) {
  const messages = new Map<string, Message>();
  const tools: ToolUse[] = [];
  const results = new Map<string, { isError: boolean; text: string }>();
  const damaged: number[] = [];
  const lines = log.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { damaged.push(n + 1); continue; }
    if (o.isSidechain) continue;
    const m = o.message;
    if (o.type === "assistant" && m && typeof m.id === "string") {
      // The last valid usage seen wins; a later line without valid usage never erases a measured one.
      const prev = messages.get(m.id);
      messages.set(m.id, { id: m.id, line: prev?.line ?? n + 1, usage: usageOf(m.usage) ?? prev?.usage ?? null });
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "tool_use" && typeof c.id === "string") tools.push({ id: c.id, name: String(c.name), input: c.input ?? {}, messageId: m.id, cwd: typeof o.cwd === "string" ? o.cwd : undefined });
      }
    } else if (o.type === "user" && m && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
        const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("") : "";
        results.set(c.tool_use_id, { isError: c.is_error === true, text });
      }
    }
  }
  return { messages, tools, results, damaged };
}

/** Refuse a snapshot that is not a list of distinct {path, size, mtime} entries: invalid evidence is never reported. */
function checkSnapshot(list: unknown, which: string): SnapshotEntry[] {
  if (!Array.isArray(list)) throw new Error(`invalid ${which} snapshot: not a list`);
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== "object" || typeof e.path !== "string" || e.path === "" || whole(e.size) === undefined || typeof e.mtime !== "string" || Number.isNaN(Date.parse(e.mtime)) || seen.has(e.path)) {
      throw new Error(`invalid ${which} snapshot entry`);
    }
    seen.add(e.path);
  }
  return list as SnapshotEntry[];
}

/** Grade one session log. Pure apart from what the options carry; throws on invalid snapshot evidence. */
export function grade(log: string, opts: GradeOptions): GradeReport {
  const before = opts.before === undefined ? undefined : checkSnapshot(opts.before, "before");
  const after = opts.after === undefined ? undefined : checkSnapshot(opts.after, "after");
  const report = unknownGradeReport(opts.session);
  const { messages, tools, results, damaged } = parse(log);
  const order = [...messages.values()];
  report.undetected = damaged.map((n) => `damaged log line ${n}`);
  if (order.length === 0) return report;
  const index = new Map(order.map((m, i) => [m.id, i]));
  report.floorTokens = prompt(order[0]!);
  const per = order.map(prompt);
  report.perCall = per.every((x) => x !== null) ? (per as number[]) : null;

  const isScratch = (p: string) => opts.scratchpad !== undefined
    ? norm(p).startsWith(norm(opts.scratchpad).replace(/\/?$/, "/"))
    : /\/temp\/claude\//.test(norm(p));
  const pathOf = (t: ToolUse) => String(t.input.file_path ?? t.input.notebook_path ?? t.input.path ?? "");
  const edit = (t: ToolUse): GradeEdit | null => { const tokens = prompt(messages.get(t.messageId)!); return tokens === null ? null : { messageId: t.messageId, path: pathOf(t), promptTokens: tokens }; };
  const succeeded = (t: ToolUse) => results.has(t.id) && !results.get(t.id)!.isError;
  const edits = tools.filter((t) => EDIT_TOOLS.has(t.name) && succeeded(t));
  const scratch = edits.find((t) => isScratch(pathOf(t)));
  const project = edits.find((t) => !isScratch(pathOf(t)));
  report.firstScratchWrite = scratch ? edit(scratch) : null;
  if (project) {
    const change = edit(project);
    report.firstProjectChange = change;
    report.resumeCostTokens = change && report.floorTokens !== null ? change.promptTokens - report.floorTokens : null;
    const upto = order.slice(0, index.get(project.messageId)! + 1);
    const endLine = messages.get(project.messageId)!.line;
    const known = upto.every((m) => m.usage !== null) && !damaged.some((n) => n < endLine);
    report.totals = known ? { uncached: upto.reduce((s, m) => s + m.usage!.input, 0), cacheWritten: upto.reduce((s, m) => s + m.usage!.written, 0), cacheRead: upto.reduce((s, m) => s + m.usage!.read, 0) } : null;
  }
  const limit = project ? index.get(project.messageId)! : order.length - 1;
  report.undetected.push(...tools.filter((t) => SHELL_TOOLS.has(t.name) && index.get(t.messageId)! <= limit).map((t) => `${t.name} in ${t.messageId}`));

  // library_read: the request's `ref`, the received result's `cite` and `sha256` (packages/core/src/tools/call.ts).
  const reads = tools.filter((t) => t.name.endsWith("library_read") && results.has(t.id));
  report.libraryReads = reads.map((t) => {
    const ref = String(t.input.ref ?? ""), res = results.get(t.id)!;
    let body: any = null;
    try { body = JSON.parse(res.text); } catch { body = null; }
    // A line span keeps its own citation and is measured by its span hash over the returned text, as the Library checks it
    // (catalog.ts read); a whole version is measured against a received SHA-256 (Codex's review of fedec33).
    const parts = citeParts(ref);
    const cite = parts?.span ? ref : body && typeof body.cite === "string" ? body.cite : ref;
    let fingerprintMatched: boolean | null = null;
    if (!res.isError && body && parts?.sha8) {
      if (parts.span?.startsWith("#L")) {
        const inner = body.truncated === false ? unwrap(body.text) : null;
        fingerprintMatched = inner === null ? null : spanMatches(inner, parts.sha8);
      } else if (!parts.span && typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256)) {
        fingerprintMatched = body.sha256.startsWith(parts.sha8);
      }
    }
    return { cite, ok: !res.isError, fingerprintMatched };
  });
  report.libraryErrors = tools.filter((t) => /library_[a-z_]+$/.test(t.name) && results.get(t.id)?.isError)
    .map((t) => `${t.name.replace(/^.*__/, "")} ${String(t.input.ref ?? t.input.query ?? "")}: ${results.get(t.id)!.text.split("\n")[0]!.slice(0, 160)}`);

  if (opts.oldLogPath !== undefined) {
    // Each tool by what it really reads (Codex's reviews of PR #33): Read and NotebookRead read exactly their path; Grep
    // reads under its path (the working folder when it names none), and whether it read the old log shows only as a file
    // path in its received result, never in matched content; a search pattern or a Write's text is never a read. Paths
    // are compared after resolving `.`, `..` and the working folder. Anything unobserved (a shell call, an unresolved
    // read or search, a path that cannot be placed, a same-named file elsewhere that may be an alias, a damaged log
    // line) leaves the answer unknown, never false.
    const target = canon(opts.oldLogPath), base = baseName(opts.oldLogPath);
    let observed = false, unknown = damaged.length > 0 || target === null;
    const isTarget = (p: string, cwd?: string) => target !== null && canon(p, cwd) === target;
    for (const t of tools) {
      const res = results.get(t.id);
      if (SHELL_TOOLS.has(t.name)) { unknown = true; continue; }
      if (FILE_READ_TOOLS.has(t.name)) {
        const raw = String(t.input.file_path ?? t.input.notebook_path ?? "");
        const same = isTarget(raw, t.cwd);
        if (!same && baseName(raw) !== base) continue;
        if (!res) unknown = true; else if (!res.isError) { if (same) observed = true; else unknown = true; }
        continue;
      }
      if (t.name !== "Grep") continue;
      const root = canon(typeof t.input.path === "string" && t.input.path !== "" ? t.input.path : ".", t.cwd);
      if (root === null || target === null) { unknown = true; continue; }
      if (root !== target && !target.startsWith(root.replace(/\/?$/, "/"))) continue;
      if (!res) { unknown = true; continue; }
      if (res.isError) continue;
      // A result line starts with its file path: alone (files), then `:count`, or `:line:` and the matched text (content).
      // A Windows file name holds no colon, so the path is the text before the first colon past a drive letter; only that
      // field is compared, never the matched text (Codex's review of 43abb34).
      const pathField = (line: string) => { const i = line.indexOf(":", /^[a-z]:/i.test(line) ? 2 : 0); return i < 0 ? line : line.slice(0, i); };
      const listed = res.text.split(/\r?\n/).some((line) => isTarget(pathField(line), t.cwd));
      if (root === target || listed) observed = true; else unknown = true;
    }
    report.oldLogOpened = observed ? true : unknown ? null : false;
  }
  if (opts.launch !== undefined) {
    const args = argv(opts.launch);
    report.resumeUsed = args === null || args.every((x) => x === "") ? null : args.some((x) => /^(--resume|-r|--continue|-c)(=.*)?$/.test(x));
  }
  if (opts.predecessor !== undefined) {
    const p = [...parse(opts.predecessor).messages.values()];
    report.predecessorLastPrompt = p.length ? prompt(p[p.length - 1]!) : null;
  }
  if (before !== undefined && after !== undefined) {
    const byPath = new Map(after.map((e) => [e.path, e]));
    report.untouched = before.map((b) => ({ path: b.path, sizeBefore: b.size, sizeAfter: byPath.get(b.path)?.size ?? null, mtimeBefore: b.mtime, mtimeAfter: byPath.get(b.path)?.mtime ?? null }));
  }
  return report;
}

/** Size and modified time of each existing path; a missing path is left out (its absence is what T8 reports). */
export function snapshot(paths: string[]): SnapshotEntry[] {
  return paths.filter((p) => existsSync(p)).map((p) => { const st = statSync(p); return { path: p, size: st.size, mtime: st.mtime.toISOString() }; });
}

const USAGE = "usage: grade.ts <session.jsonl> [--scratchpad <dir>] [--predecessor <log>] [--old-log <path>] [--launch <file>] [--snapshot-before <file> --snapshot-after <file>] --json\n       grade.ts --snapshot <paths file>\n";
const VALUE_FLAGS = new Set(["--scratchpad", "--predecessor", "--old-log", "--launch", "--snapshot-before", "--snapshot-after", "--snapshot"]);

export function gradeMain(argv: string[], io: GradeIo): number {
  const flags = new Map<string, string>();
  const pos: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--json") json = true;
    else if (VALUE_FLAGS.has(x)) { const v = argv[++i]; if (v === undefined || v.startsWith("--") || flags.has(x)) { io.stderr(USAGE); return 2; } flags.set(x, v); }
    else if (x.startsWith("--")) { io.stderr(USAGE); return 2; }
    else pos.push(x);
  }
  const readText = (p: string) => readFileSync(p, "utf8");
  try {
    if (flags.has("--snapshot")) {
      if (pos.length) { io.stderr(USAGE); return 2; }
      io.stdout(JSON.stringify(snapshot(readText(flags.get("--snapshot")!).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))) + "\n");
      return 0;
    }
    if (pos.length !== 1 || !json || flags.has("--snapshot-before") !== flags.has("--snapshot-after")) { io.stderr(USAGE); return 2; }
    const log = pos[0]!;
    if (!existsSync(log)) { io.stderr(`grade: no session log at ${log}\n`); return 2; }
    const report = grade(readText(log), {
      session: basename(log).replace(/\.jsonl$/i, ""),
      scratchpad: flags.get("--scratchpad"),
      predecessor: flags.has("--predecessor") ? readText(flags.get("--predecessor")!) : undefined,
      oldLogPath: flags.get("--old-log"),
      launch: flags.has("--launch") ? readText(flags.get("--launch")!).trim() : undefined,
      before: flags.has("--snapshot-before") ? JSON.parse(readText(flags.get("--snapshot-before")!)) : undefined,
      after: flags.has("--snapshot-after") ? JSON.parse(readText(flags.get("--snapshot-after")!)) : undefined,
    });
    io.stdout(JSON.stringify(report, null, 2) + "\n");
    return 0;
  } catch (e) {
    io.stderr(`grade: ${(e as Error).message}\n`);
    return 2;
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] && basename(process.argv[1]) === "grade.ts";
if (isMain) process.exit(gradeMain(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }));
