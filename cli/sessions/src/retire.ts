// AR2 retire (docs/sessions/AR2-retire.md): move ONE old conversation log off the home volume to cold storage, only when every
// check passes. Claude: <id>.jsonl plus its <id>/ folder, once idle and once a successor session was written after it stopped.
// Codex: only a thread Codex itself has archived, with every rollout file of it and of its archived descendants (plain,
// compressed, reverted), and only when no other thread's history forks from them (codex.ts). Codex's state database is opened
// read-only (immutable when no writer has a WAL open) and never written. Each file is copied to a staging name, flushed, put in
// place without replacing anything, SHA-256-checked on both copies and recorded in the manifest before its source is deleted;
// the session's main file moves last, so a failure partway leaves a rerun able to finish. The archive folder must be private
// (owner-only; on Windows by its access list): retire makes a new one so and refuses an existing one that is not. No other
// account may be able to rename or replace it or any folder above it (AR2b, docs/sessions/AR2b-dest-chain.md). Messages
// never print a project folder name. Without --apply it only prints the plan.
import { accessSync, appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, statfsSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SESSION_ID, lineageRefs, parseRolloutName, readFirstLine } from "./codex.ts";

export interface RetireIo {
  stdout: (s: string) => void; stderr: (s: string) => void; home: string; now: number;
  /** Test seams: the copy into the staging name, and the manifest append. */
  copyFile?: (src: string, dst: string) => void; appendFile?: (path: string, data: string) => void;
  /**
   * Test seams for races and drives: right after the plan, before --apply starts; right after retire creates the archive
   * folder; right after it makes that folder private; right after the privacy check; after a source is read, before its copy
   * is made; right after a copy is put in place.
   */
  beforeApply?: () => void; madeFolder?: (dir: string) => void; madePrivate?: (dir: string) => void; checked?: () => void;
  beforeCopy?: (src: string) => void; placed?: (dst: string) => void;
  /** The restore trial's copy of an archive copy back out (tests inject faults); and a hook while it runs. */
  trialCopy?: (src: string, dst: string) => void; duringTrial?: (src: string) => void;
  /** Called after the archive copy's final hash, before the last source check (tests change the source here). */
  afterArchiveCheck?: (src: string) => void;
  /** Test seam: a folder trusted with everything above it, so only the folders below it are judged for AR2b. */
  chainTop?: string;
  /** Test seam: right before --apply makes the new folders (outermost first), after every check made before it. */
  beforeMake?: (dirs: string[]) => void;
}
interface Item { src: string; dst: string; rel: string; size: number; mtimeMs: number; uid: number; label: string }
/** `anchorFrom` is where the session's main files begin (the Claude log, the Codex parent's rollouts): they move only if everything before them did. */
interface Plan { client: "claude" | "codex"; session: string; items: Item[]; anchorFrom: number; checks: string[]; cleanup?: string }

const HOUR = 3_600_000;
const USAGE = "usage: retire claude <session-id> --successor <session-id> --dest <dir> [--min-idle-hours <n>] [--apply]\n       retire codex <thread-id> --dest <dir> [--min-idle-hours <n>] [--apply]\n";
const RESTORE = new URL("../restore.py", import.meta.url);
class Refusal extends Error {}

/** SHA-256 of a file read in chunks, so files over 2 GiB work. */
export function sha256File(path: string, chunk = 4 * 1024 * 1024): string {
  const h = createHash("sha256"), buf = Buffer.alloc(chunk), fd = openSync(path, "r");
  try { let pos = 0, n: number; while ((n = readSync(fd, buf, 0, chunk, pos)) > 0) { h.update(buf.subarray(0, n)); pos += n; } } finally { closeSync(fd); }
  return h.digest("hex");
}

const stripPrefix = (p: string) => p.replace(/^\\\\\?\\/, "");
// One character at a time: lowercasing a whole string turns a word-final capital sigma into the final sigma, while NTFS opens
// it as the plain small sigma (review of 69c50c6).
const norm = (p: string) => (process.platform === "win32" ? Array.from(p, (c) => c.toLowerCase()).join("") : p);
/** The real path of p: links resolved in its longest existing prefix, the rest appended as written. */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...rest); } catch { /* not there yet: try the parent */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(basename(cur)); cur = up;
  }
}
/** Whether `child` is `parent` or inside it, comparing real paths. */
const within = (child: string, parent: string) => {
  const rel = relative(norm(real(parent)), norm(real(child)));
  return rel === "" || !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
};
/** A file's identity (volume and file id); undefined when it does not exist or the file system gives no file id. */
const identity = (p: string) => { try { const s = statSync(p, { bigint: true }); return s.ino === 0n ? undefined : `${s.dev}:${s.ino}`; } catch { return undefined; } };
/**
 * Whether `p`, or its nearest existing ancestor, is one of `roots` or lies inside one, compared by file identity rather than
 * by path text, so a junction, a short name, a share alias or a relocated folder cannot hide it.
 */
function insideAny(p: string, roots: string[]): boolean {
  const ids = new Set(roots.map(identity).filter((x): x is string => x !== undefined));
  const walk = (start: string) => {
    for (let cur = start; ; cur = dirname(cur)) {
      const id = identity(cur);
      if (id !== undefined && ids.has(id)) return true;
      if (dirname(cur) === cur) return false;
    }
  };
  // The written ancestors, and the link-resolved ones: a link to a SUB-folder of a root has that sub-folder's identity.
  return walk(resolve(p)) || walk(real(p));
}
const item = (src: string, dst: string, rel: string, label: string): Item => { const st = lstatSync(src); return { src, dst, rel, size: st.size, mtimeMs: st.mtimeMs, uid: st.uid, label }; };
const newest = (items: { mtimeMs: number }[]) => items.reduce((m, i) => Math.max(m, i.mtimeMs), -Infinity);

function idleCheck(items: Item[], now: number, minIdleHours: number): string {
  const idle = Math.floor((now - newest(items)) / HOUR);
  if (now - newest(items) < minIdleHours * HOUR) throw new Refusal(`idle ${idle} h, under --min-idle-hours ${minIdleHours}; a session still being written is never retired`);
  return `idle ${idle} h (at least ${minIdleHours} h): ok`;
}

/** Regular files under a session folder, sorted; refuses a link or a special file anywhere in it. */
function sessionFiles(dir: string): string[] {
  try { if (!lstatSync(dir).isDirectory()) throw new Refusal("the session folder is a link or not a folder; nothing was moved"); }
  catch (e) { if (e instanceof Refusal) throw e; if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Refusal("the session folder cannot be read; nothing was moved"); }
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Refusal("the session folder holds a link (a junction or symlink); nothing was moved");
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
      else throw new Refusal("the session folder holds a special file; nothing was moved");
    }
  };
  walk(dir);
  return out;
}

/** Every <projects>/<project>/<id>.jsonl, as [project folder, log path]. */
function findClaude(projects: string, id: string): [string, string][] {
  let dirs: string[] = [];
  try { dirs = readdirSync(projects); } catch { return []; }
  return dirs.map((d) => [join(projects, d), join(projects, d, `${id}.jsonl`)] as [string, string]).filter(([, log]) => existsSync(log));
}

function planClaude(io: RetireIo, id: string, successor: string | undefined, dest: string, minIdleHours: number): Plan {
  const projects = join(io.home, ".claude", "projects");
  const found = findClaude(projects, id);
  if (found.length === 0) throw new Refusal(`claude session ${id} not found`);
  if (found.length > 1) throw new Refusal(`claude session ${id} found more than once`);
  const [proj, log] = found[0]!;
  if (lstatSync(proj).isSymbolicLink() || !lstatSync(log).isFile()) throw new Refusal("the session's project folder or log is a link; nothing was moved");
  // The log is the session's anchor: it moves last, so a run that stops partway leaves it, and a rerun, in place.
  const items = [...sessionFiles(join(proj, id)), log].map((src) => { const rel = join("claude-projects", relative(projects, src)); return item(src, join(dest, rel), rel, relative(proj, src)); });
  const checks = [idleCheck(items, io.now, minIdleHours)];
  if (!successor) throw new Refusal("--successor <session-id> is required: name the new session that replaced this one");
  if (successor === id) throw new Refusal("--successor must be a different session");
  const next = findClaude(projects, successor);
  if (next.length !== 1) throw new Refusal(`successor ${successor} not found exactly once`);
  const [nextProj, nextLog] = next[0]!;
  const nextFiles: { mtimeMs: number }[] = [lstatSync(nextLog)];
  const walk = (d: string) => { let names: string[] = []; try { names = readdirSync(d); } catch { return; } for (const n of names) { const st = lstatSync(join(d, n)); if (st.isDirectory()) walk(join(d, n)); else if (st.isFile()) nextFiles.push(st); } };
  walk(join(nextProj, successor));
  if (newest(nextFiles) <= newest(items)) throw new Refusal(`successor ${successor} was not written after ${id} stopped`);
  checks.push(`successor ${successor} written after: ok`);
  return { client: "claude", session: id, items, anchorFrom: items.length - 1, checks, cleanup: join(proj, id) };
}

/** Codex's state database, read-only; immutable (no side files) when no writer holds a WAL. */
function openState(state: string): DatabaseSync {
  if (!existsSync(`${state}-wal`)) {
    try { const url = pathToFileURL(state); url.search = "?mode=ro&immutable=1"; return new DatabaseSync(url, { readOnly: true }); } catch { /* a Node without URL paths: open plainly */ }
  }
  return new DatabaseSync(state, { readOnly: true });
}
type Row = { id: string; rollout_path: string; archived: number };

/** Rollout files under a Codex folder, by thread id; links are not followed. */
function rollouts(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n), st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      const r = st.isFile() ? parseRolloutName(n) : undefined;
      if (r) out.set(r.threadId, [...(out.get(r.threadId) ?? []), p]);
    }
  };
  walk(root);
  return out;
}

async function planCodex(io: RetireIo, id: string, dest: string, minIdleHours: number): Promise<Plan> {
  const codex = join(io.home, ".codex"), archived = join(codex, "archived_sessions"), state = join(codex, "state_5.sqlite");
  if (!existsSync(state)) throw new Refusal("Codex state database not found");
  const db = openState(state);
  let rows: Row[];
  try {
    const top = db.prepare("SELECT id, rollout_path, archived FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!top) throw new Refusal(`codex thread ${id} not found`);
    const kids = db.prepare("WITH RECURSIVE sub(id) AS (SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ? UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN sub ON e.parent_thread_id = sub.id) SELECT t.id, t.rollout_path, t.archived FROM threads t JOIN sub ON t.id = sub.id ORDER BY t.id").all(id) as Row[];
    rows = [top, ...kids].map((r) => ({ ...r, id: r.id.toLowerCase() }));
  } finally { db.close(); }
  const live = rollouts(join(codex, "sessions")), stored = rollouts(archived);
  const isArchived = (r: Row) => r.archived === 1 && within(stripPrefix(r.rollout_path), archived);
  const top = rows[0]!;
  if (!isArchived(top)) throw new Refusal(`codex thread ${id} is not archived in Codex; archive it in Codex first (its subagent threads go with it)`);
  if (!stored.get(top.id)?.length) throw new Refusal(`codex thread ${id} is archived in Codex, but its files are missing from archived_sessions`);
  const moving = rows.filter((r) => isArchived(r) && stored.get(r.id)?.length);
  const threads = new Set(moving.map((r) => r.id));
  // A loaded thread holds a writer lock; a lock file can also outlive a crash, so say how to clear a stale one.
  for (const t of threads) {
    if (existsSync(join(codex, "thread-writer-locks", `${t}.lock`))) throw new Refusal(`Codex holds a writer lock for thread ${t} (~/.codex/thread-writer-locks/${t}.lock); close Codex and retry. If Codex is closed, the lock is stale: remove that file and retry`);
  }
  // Codex follows a fork's history to its source: history_base names a ROLLOUT id (which differs after a revert),
  // forked_from_id a thread id. No thread outside the retirement may fork from anything inside it.
  const ids = new Set([...threads, ...moving.flatMap((r) => stored.get(r.id)!.map((p) => parseRolloutName(basename(p))!.rolloutId))]);
  for (const [thread, paths] of [...live, ...stored]) {
    if (threads.has(thread)) continue;
    for (const p of paths) {
      const line = await readFirstLine(p);
      const refs = line === undefined ? undefined : lineageRefs(line);
      if (refs === undefined) throw new Refusal(`cannot read the first line of ${basename(p)} to check for forks; nothing was moved`);
      const source = refs.find((x) => ids.has(x));
      if (source) throw new Refusal(`thread ${thread} forks from ${source}; retiring would break it`);
    }
  }
  const files = (r: Row) => [...stored.get(r.id)!].sort().map((src) => { const rel = join("codex-archived-sessions", relative(archived, src)); return item(src, join(dest, rel), rel, basename(src)); });
  const descendants = moving.slice(1).flatMap(files);
  const items = [...descendants, ...files(top)]; // the parent last
  const checks = [idleCheck(items, io.now, minIdleHours)];
  if (moving.length < rows.length) checks.push(`left in place: ${rows.length - moving.length} descendant thread(s) Codex has not archived`);
  return { client: "codex", session: id, items, anchorFrom: descendants.length, checks };
}

/**
 * Refuse before moving anything if any destination leads back into the folders being retired from (a link inside --dest),
 * is the source file itself, holds different bytes, or if the destination holds a different restore.py. Identical bytes in a
 * different file count as already copied.
 */
function preflight(plan: Plan, dest: string, protectedRoots: string[]): void {
  try { if (lstatSync(join(dest, ".staging")).isSymbolicLink()) throw new Refusal("the destination's .staging folder is a link; nothing was moved"); }
  catch (e) { if (e instanceof Refusal) throw e; /* no staging folder yet */ }
  // Before either is read: a FIFO (or a link to one, or to /dev/zero) would block the read for good.
  for (const p of [join(dest, "manifest.jsonl"), join(dest, "restore.py")]) {
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) throw new Refusal(LINK);
    if (!st.isFile()) throw new Refusal("a file in the destination is not a regular file, so nothing was moved; use a new folder");
  }
  const restore = join(dest, "restore.py");
  if (existsSync(restore) && !readFileSync(restore).equals(readFileSync(RESTORE))) throw new Refusal("the destination holds a different restore.py; use a new folder, so every archive keeps the restore script that matches it");
  for (const i of plan.items) {
    if (insideAny(dirname(i.dst), protectedRoots)) throw new Refusal(`the destination for ${i.label} leads back into the folders being retired from (a link inside --dest?); nothing was moved`);
    if (!existsSync(i.dst)) continue;
    if (identity(i.dst) !== undefined && identity(i.dst) === identity(i.src)) throw new Refusal(`the destination for ${i.label} is the source file itself; nothing was moved`);
    const st = lstatSync(i.dst);
    if (!st.isFile() || st.size !== i.size || sha256File(i.dst) !== sha256File(i.src)) throw new Refusal(`${i.label} exists with different content in the destination; nothing was moved`);
  }
  // A link anywhere retire writes, wherever it leads, would put the files (or the manifest lines) outside the destination and
  // its checks, or make the archive's restore.py a script someone else can change. Node sees a junction as a link only when
  // its target is written with a drive letter, so the real path of each one there is compared with where it should be.
  const base = existsSync(dest) ? realpathSync.native(dest) : "";
  // One whose target is gone and written through a volume's GUID name is not even seen by lstat, only by its folder's listing.
  const listings = new Map<string, string[]>();
  const listed = (p: string) => {
    if (!listings.has(dirname(p))) { let names: string[] = []; try { names = readdirSync(dirname(p)); } catch { /* no folder */ } listings.set(dirname(p), names); }
    // Only a name the fold matches that lstat cannot see either: one lstat sees while it cannot see this one is another name
    // to the file system (a folder with case sensitivity turned on, KELVIN SIGN for k), which retire never writes through
    // (review of 54b7f26).
    return listings.get(dirname(p))!.filter((n) => norm(n) === norm(basename(p))).some((n) => { try { lstatSync(join(dirname(p), n)); return false; } catch { return true; } });
  };
  for (const p of [join(dest, ".staging"), ...inside(dest, plan)]) {
    let st; try { st = lstatSync(p); } catch { if (listed(p)) throw new Refusal(LINK); continue; }
    let r = ""; try { r = realpathSync.native(p); } catch { /* one that cannot be resolved matches nothing */ }
    if (st.isSymbolicLink() || norm(r) !== norm(join(base, relative(dest, p)))) throw new Refusal(LINK);
  }
}
const LINK = "a folder or file in the destination is a link (a junction or symlink), so nothing was moved; use a new folder";
const REPLACED = "the destination folder was replaced during the run, or has no file id to tell, so nothing was moved; use a new folder";
/** The real path, links resolved; the path itself when it cannot be resolved. */
const realOr = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
/** What retire writes through inside the destination: the manifest, restore.py, and every folder and file on the way to the plan's files. */
const inside = (dest: string, plan: Plan) => [...new Set([join(dest, "manifest.jsonl"), join(dest, "restore.py"), ...plan.items.flatMap((i) => { const parts = i.rel.split(/[\\/]/); return parts.map((_, n) => join(dest, ...parts.slice(0, n + 1))); })])];

// Windows' own tools, by absolute path, so a same-named program in the current folder or on PATH is never run.
const system32 = () => join(process.env.SystemRoot ?? "C:/Windows", "System32");
/**
 * Prints this user's SID, then for each folder or file in KL_RETIRE_ACL_PATHS ("|"-separated; no Windows path holds one) a
 * "path <n>" line, the owner and one "Allow|Deny <SID> <rights mask, 8 hex digits> <1 if inherit-only, else 0>" line per
 * access-list entry, or "error". It calls .NET, not Get-Acl: started from PowerShell 7, Windows PowerShell inherits a module
 * path it cannot load Get-Acl's module from.
 */
const ACL_SCRIPT = "$ErrorActionPreference = 'Stop'; 'me ' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $i = 0; " +
  "foreach ($p in ($env:KL_RETIRE_ACL_PATHS -split '[|]')) { 'path ' + $i; $i++; try { " +
  "$a = if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; 'owner ' + $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; " +
  "$a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.AccessControlType.ToString() + ' ' + $_.IdentityReference.Value + ' ' + ('{0:X8}' -f [int]$_.FileSystemRights) + ' ' + [int](($_.PropagationFlags -band 2) -ne 0) } } catch { 'error' } }";
/** The extended-length form, which Windows PowerShell reads even over 260 characters while Windows long paths are off. */
const extended = (p: string) => (/^\\\\\?\\/.test(p) ? p : /^\\\\\.\\/.test(p) ? `\\\\?\\${p.slice(4)}` : /^\\\\/.test(p) ? `\\\\?\\UNC\\${p.slice(2)}` : `\\\\?\\${p}`);
/**
 * Besides this user: SYSTEM and Administrators may own a private folder, and they, CREATOR OWNER (whoever creates a file
 * inside) and OWNER RIGHTS (which matches only the owner, already one of these; review of 54b7f26) may be let in.
 */
const OWNERS = ["S-1-5-18", "S-1-5-32-544"], ALLOWED = [...OWNERS, "S-1-3-0", "S-1-3-4"];
let mySid: string | undefined;
/** One access-list entry: the rights mask as a whole number, and whether it only passes to what is made inside. */
export type AclEntry = { allow: boolean; sid: string; mask: number; inheritOnly: boolean };
/**
 * "foreign": owned by another account, which can always change it, so no command of this user's can make it private. Owner
 * and entries are there whenever the list was read, for the AR2b judge.
 */
type Access = { state: "private" | "open" | "foreign" | "unknown"; me?: string; owner?: string; entries?: AclEntry[] };
/**
 * Judges ACL_SCRIPT's output. Private: owned by this user, SYSTEM or Administrators (an owner can always rewrite the list), and
 * every account the list allows in, by SID (so names in any language, unresolved SIDs and local groups all count), is this user
 * or one of ALLOWED. Deny entries do not count; inherit-only ones do, since they reach everything made inside. Unknown: the
 * script failed, or printed anything unexpected.
 */
export function aclAccess(status: number | null, stdout: string): Access {
  const [first, second, ...rest] = stdout.split(/\r?\n/).filter(Boolean);
  const me = /^me (S-1-[0-9-]+)$/.exec(first ?? "")?.[1], owner = /^owner (S-1-[0-9-]+)$/.exec(second ?? "")?.[1];
  const lines = rest.map((l) => /^(Allow|Deny) (S-1-[0-9-]+) ([0-9A-F]{8}) ([01])$/.exec(l));
  if (status !== 0 || !me || !owner || lines.some((m) => !m)) return { state: "unknown", me };
  const entries = lines.map((m): AclEntry => ({ allow: m![1] === "Allow", sid: m![2]!, mask: parseInt(m![3]!, 16), inheritOnly: m![4] === "1" }));
  if (owner !== me && !OWNERS.includes(owner)) return { state: "foreign", me, owner, entries };
  const ok = new Set([me, ...ALLOWED]);
  return { state: entries.every((e) => !e.allow || ok.has(e.sid) || appContainer(e.sid)) ? "private" : "open", me, owner, entries };
}
/**
 * An AppContainer package (S-1-15-2-*, ALL APPLICATION PACKAGES among them) or capability (S-1-15-3-*) SID. No account holds
 * one: Windows checks them only for an AppContainer token, and grants it no more than its own account's entries allow, so such
 * an entry lets no other account in (review of f0154ee, measured with lowbox tokens).
 */
const appContainer = (sid: string) => /^S-1-15-[23]-/.test(sid);
/**
 * Splits ACL_SCRIPT's output into one judged block per path. A missing block has no owner line, and a stray "path" line is an
 * unexpected line in a block, so either is unknown.
 */
export function aclAccessAll(status: number | null, stdout: string, count: number): Access[] {
  const [first = "", ...rest] = stdout.split(/\r?\n/).filter(Boolean);
  const blocks: string[][] = [];
  for (const l of rest) {
    if (l === `path ${blocks.length}`) blocks.push([]);
    else if (blocks.length === 0) return Array.from({ length: count }, () => aclAccess(1, first));
    else blocks[blocks.length - 1]!.push(l);
  }
  return Array.from({ length: count }, (_, n) => aclAccess(status, [first, ...(blocks[n] ?? [])].join("\n")));
}
/** POSIX: private when this user owns it and it has no group or other mode bits. */
export const modeAccess = (mode: number, uid: number, me: number | undefined): Access["state"] => (uid !== me ? "foreign" : (mode & 0o077) === 0 ? "private" : "open");

// AR2b. Rights that let an account remove, rename or take over a folder itself (delete, write DAC, write owner, generic all,
// maximum allowed), and those that let it remove or rename the folders in one (delete child, generic all, maximum allowed):
// a native rename needs only delete child on the parent, whatever the folder's own list says.
const TAKE = 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x02000000, EMPTY = 0x40 | 0x10000000 | 0x02000000;
/** Owns C:\; only an administrator can act as it. */
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** How another account could swap a folder on the way to --dest; "children": by renaming or removing the folders in it. */
export type Risk = "owner" | "children" | "entry" | "unknown";
/**
 * Windows: whether another account could rename, remove or replace a folder on the way to --dest. It owns the folder, or an
 * allow entry that applies to the folder itself (not inherit-only) gives another account TAKE, or, when the next folder down
 * is inside this one, EMPTY. This user, SYSTEM, Administrators and TrustedInstaller are trusted; CREATOR OWNER matches no one
 * on the folder itself, OWNER RIGHTS only the owner, trusted by then, and an AppContainer SID no account. Deny entries do not
 * count: they cannot take back what delete child on the parent gives. A list that could not be read (undefined) is unknown. A
 * volume's root (`root`) cannot be renamed or removed, so delete on it alone does not count there; the rights that rewrite its
 * list do (review of f0154ee: Windows gives Authenticated Users Modify on a new NTFS volume's root).
 */
export function aclRisk(f: { owner: string; entries: AclEntry[] } | undefined, me: string, hasChild: boolean, root = false): Risk | undefined {
  if (!f) return "unknown";
  const trusted = new Set([me, ...OWNERS, TRUSTED_INSTALLER]);
  if (!trusted.has(f.owner)) return "owner";
  const others = f.entries.filter((e) => e.allow && !e.inheritOnly && !trusted.has(e.sid) && e.sid !== "S-1-3-0" && e.sid !== "S-1-3-4" && !appContainer(e.sid));
  if (hasChild && others.some((e) => (e.mask & EMPTY) !== 0)) return "children";
  const take = root ? TAKE & ~0x10000 : TAKE;
  return others.some((e) => (e.mask & take) !== 0) ? "entry" : undefined;
}
/**
 * POSIX: the folder's name (links not followed) is owned by an account other than this user or root, or, when the next folder
 * down is inside it, group or others may write in it without the sticky bit (with it, only the owners judged here can rename).
 */
export function modeRisk(f: { uid: number; mode: number } | undefined, me: number, hasChild: boolean): Risk | undefined {
  if (!f) return "unknown";
  if (f.uid !== me && f.uid !== 0) return "owner";
  return hasChild && (f.mode & 0o022) !== 0 && (f.mode & 0o1000) === 0 ? "children" : undefined;
}
/**
 * Whether a path is there: anything but "no such file" counts, so a folder this user cannot see into is still judged. A path
 * under a file (ENOTDIR on POSIX) or with a name too long (ENAMETOOLONG) cannot be there.
 */
const there = (p: string) => { try { lstatSync(p); return true; } catch (e) { return !["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes((e as NodeJS.ErrnoException).code ?? ""); } };
/** Without a \\?\ or \\.\ prefix before a drive letter, so a real path compares with the path it was written as. */
const plain = (p: string) => p.replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, "");
/** The same path: no such prefix, no trailing separator (on POSIX a backslash is part of a name), and on Windows in any case. */
const samePath = (a: string, b: string) => { const t = (p: string) => norm(plain(p)).replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, ""); return t(a) === t(b); };
/** The real path of dest when it is spelled otherwise than dest, so giving it can be advice; undefined when it is the same. */
function otherReal(dest: string): string | undefined {
  const r = real(dest), t = (p: string) => plain(p).replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
  return t(r) === t(resolve(dest)) ? undefined : r;
}
/**
 * POSIX file systems known to be local disks (statfs types on Linux): ext2-4, xfs, btrfs, tmpfs, zfs, f2fs, overlay (a
 * container's own), ramfs, jfs, reiserfs, bcachefs, nilfs2. On anything else (NFS, CIFS/SMB, 9p as in WSL 2 and Docker
 * Desktop, WSL 1's drvfs, FUSE, virtiofs, vboxsf, a cluster file system, or one nobody listed) the owner and mode seen here
 * need not decide who can rename a folder: the server or host does. An allowlist, so an unlisted type is refused.
 */
const LOCAL_FS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010, 0x794c7630, 0x858458f6, 0x3153464a, 0x52654973, 0xca451a4e, 0x3434]);
export const localFs = (type: number) => LOCAL_FS.has(type);
/** Windows: file systems known to be local disks that keep access lists. */
export const localDriveFormat = (format: string) => format === "NTFS" || format === "ReFS";
/**
 * Windows: prints "fs <format>" for the drive root in KL_RETIRE_DRIVE (.NET's DriveInfo; "fs ?" when it cannot be read), then
 * for each path in KL_RETIRE_PROBE ("|"-separated) "attr <n> <attributes>": the attributes of that very name as Windows opens
 * it, a reparse point not followed (.NET's File.GetAttributes); "-" when it is not there, "?" when it cannot be read.
 */
const PROBE_SCRIPT = "$ErrorActionPreference = 'Stop'; try { 'fs ' + [IO.DriveInfo]::new($env:KL_RETIRE_DRIVE).DriveFormat } catch { 'fs ?' }; $i = 0; " +
  "foreach ($p in ($env:KL_RETIRE_PROBE -split '[|]')) { try { $a = [string][int][IO.File]::GetAttributes($p) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $a = '-' } catch { $a = '?' }; 'attr ' + $i + ' ' + $a; $i++ }";
const REPARSE_POINT = 0x400;
/**
 * Why a run of Windows PowerShell read nothing: it could not start, was stopped for printing more than retire reads, failed,
 * or printed nothing whose first line it could read; undefined when it ran. A run that fails is no folder's fault, so it gets
 * its own refusal, to try again (reviews of d905c6f and 4dcb602).
 */
function runFailed(r: SpawnSyncReturns<string>, first: RegExp): string | undefined {
  // Any error is a failed run, even one that ends with 0: what it printed may be cut off (review of 00e9059).
  if (r.error) { const code = (r.error as NodeJS.ErrnoException).code; return code === "ENOBUFS" ? "printed more than retire reads" : r.status === null ? "could not be started" : `failed: ${code ?? "error"}`; }
  if (r.status === null) return "could not be started";
  if (r.status !== 0) return `exit ${r.status}`;
  return first.test(r.stdout ?? "") ? undefined : "printed nothing it could read";
}
/** The drive's file system and each path's attributes ("absent", or undefined when unreadable), or why the run failed. */
function probeWindows(root: string, paths: string[]): { fs?: string; attrs: (number | "absent" | undefined)[]; failed?: string } {
  const r = spawnSync(join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], { encoding: "utf8", windowsHide: true, env: { ...process.env, KL_RETIRE_DRIVE: root, KL_RETIRE_PROBE: paths.map(extended).join("|") } });
  const failed = runFailed(r, /^fs /);
  if (failed) return { attrs: [], failed };
  const lines = (r.stdout ?? "").split(/\r?\n/);
  const fs = /^fs (.+)$/.exec(lines[0] ?? "")?.[1];
  const attrs = paths.map((_, n) => {
    const v = lines.map((l) => new RegExp(`^attr ${n} (-|\\?|\\d+)$`).exec(l)?.[1]).find((x) => x !== undefined);
    return v === "-" ? "absent" as const : v === undefined || v === "?" ? undefined : Number(v);
  });
  return { fs: fs === "?" ? undefined : fs, attrs };
}
/** The drive root of a volume given by its GUID name: the real path of a plain folder in it, when the volume has a letter. */
function volumeLetter(volumeRoot: string): string | undefined {
  try {
    for (const e of readdirSync(volumeRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      try { const r = realpathSync.native(join(volumeRoot, e.name)); if (/^[A-Za-z]:\\[^\\]+$/.test(r)) return r.slice(0, 3); } catch { /* try the next */ }
    }
  } catch { /* cannot be listed */ }
  return undefined;
}
/** Why AR2b cannot judge the folders --dest goes through: where, and the real path to give instead when there is one. */
export type Unjudgeable = { at: string; why: "indirect" | "reparse" | "unresolved" | "shared" | "unreadable"; real?: string; fs?: string; failed?: string };
/**
 * The first name on the way to --dest that is not its own real path: a link, a junction, a mount, a short name or a drive
 * letter that stands for another folder (subst, a mapped drive), one whose real path cannot be found (a link that leads
 * nowhere or to itself, a volume with no drive letter), or one its folder lists that cannot be seen (a link whose target is
 * gone). Also any name lstat sees as a link even when its real path compares alike (a junction named KELVIN SIGN to "k",
 * which JavaScript lowercases alike and NTFS does not), and on Windows any name on another volume than the folder above it
 * (a volume mounted into a folder, which lstat need not see). On POSIX, also a folder on a file system not known to be a
 * local disk (outside Linux statfs types are not Linux's, so none is known). Undefined when every name on the way is its own
 * real path on a local disk. AR2b judges the folders of one real path only: following links one at a time missed folders in
 * every review of it. The names --apply makes are not there yet and are not judged here.
 */
function unjudgeableOnce(dest: string): Unjudgeable | undefined {
  const abs = resolve(dest), { root } = parse(abs);
  const names = abs.slice(root.length).split(sep).filter(Boolean);
  const win = process.platform === "win32";
  let probe: ReturnType<typeof probeWindows> | undefined;
  for (let n = 0, cur = root; n <= names.length; cur = join(cur, names[n] ?? ""), n++) {
    // Windows says what each name it opens is: a junction whose target is written through a volume's GUID name is no link to
    // lstat (libuv falls back to stat), and comparing names case-folded the JavaScript way (KELVIN SIGN, a final sigma)
    // misses what NTFS folds otherwise (reviews of 874eac0 and ad8146d).
    const a = win && n > 0 ? probe?.attrs[n - 1] : undefined;
    if (n > 0 && !there(cur)) {
      if (typeof a === "number") return { at: cur, why: "unresolved" }; // Windows sees a name lstat cannot: a link that leads nowhere
      // When Windows says nothing has this very name, a sibling JavaScript lowercases alike is another name to NTFS (review of
      // 69c50c6); the listing is read only when Windows gave no answer, or on POSIX.
      let listed = false; if (a !== "absent") try { listed = readdirSync(dirname(cur)).some((x) => norm(x) === norm(basename(cur))); } catch { /* no folder above */ }
      if (listed) return { at: cur, why: "unresolved" };
      return undefined; // --apply makes the rest
    }
    let r: string;
    try { r = realpathSync.native(plain(cur)); } catch {
      // A volume's GUID name has no real path of its own, but a plain folder in it does when the volume has a drive letter. The
      // root needs its separator: without one (resolve drops it from a bare root) it names the volume, which cannot be listed.
      const letter = n === 0 && /^\\\\[?.]\\Volume\{/i.test(cur) ? volumeLetter(cur.endsWith(sep) ? cur : cur + sep) : undefined;
      // Resolved from the drive letter on, so the advice judged after this is a real path (review of 121575e).
      if (letter) return { at: cur, why: "indirect", real: real(join(letter, ...names)) };
      return { at: cur, why: "unresolved" };
    }
    let link = false; try { link = lstatSync(cur).isSymbolicLink(); } catch { /* realpath read it */ }
    if (!samePath(r, cur) || link) return { at: cur, why: "indirect", real: otherReal(dest) };
    if (win && n > 0) {
      let other = true; try { other = statSync(plain(cur), { bigint: true }).dev !== statSync(plain(dirname(cur)), { bigint: true }).dev; } catch { /* judged as unreadable */ }
      if (other) return { at: cur, why: "indirect", real: otherReal(dest) };
      if (typeof a !== "number") return { at: cur, why: "unresolved" };
      // A reparse point that is exactly its own real path is no link to another folder (a OneDrive or iCloud Drive folder holds
      // cloud-file reparse points), and there is no other path to give (review of 69c50c6). Spelled in any other way here or
      // above (KELVIN SIGN for k, J for j in a case-sensitive folder, other letter case), its real path is the advice, which is
      // judged in turn, so a OneDrive folder ends as "reparse" all the same (reviews of d910e90 and 121575e).
      if ((a & REPARSE_POINT) !== 0) return otherReal(cur) === undefined ? { at: cur, why: "reparse" } : { at: cur, why: "indirect", real: otherReal(dest) };
    }
    if (win && n === 0) {
      // A drive whose driver makes up its access lists (Google Drive's G: says FAT32; FAT and exFAT keep none) is no local disk.
      probe = probeWindows(plain(cur), names.map((_, i) => join(root, ...names.slice(0, i + 1))));
      if (probe.failed) return { at: cur, why: "unreadable", failed: probe.failed };
      if (probe.fs === undefined) return { at: cur, why: "unreadable" };
      if (!localDriveFormat(probe.fs)) return { at: cur, why: "shared", fs: probe.fs };
    }
    if (!win) {
      let t: number | undefined; try { t = Number(statfsSync(cur).type); } catch { /* not known to be local */ }
      if (t === undefined || process.platform !== "linux" || !localFs(t)) return { at: cur, why: "shared" };
    }
  }
  return undefined;
}
/**
 * unjudgeableOnce(dest), whose real path, when it is the advice, is judged too: a real path refused in turn (one under a
 * OneDrive folder, say) is no advice, and its refusal is given instead, so no message leads only to another (review of
 * d910e90). A real path on a network share is advice of its own (a local disk) and is not opened.
 */
export function unjudgeable(dest: string): Unjudgeable | undefined {
  const u = unjudgeableOnce(dest);
  if (u?.why !== "indirect" || u.real === undefined || /^\\\\(?![?.]\\)/.test(u.real)) return u;
  return unjudgeableOnce(u.real) ?? u;
}
const unjudgeableWhy = (u: Unjudgeable) => ({
  // A local FAT32 or exFAT disk and Google Drive's G: both report FAT32, so the format is named, not where it is (review of
  // d910e90).
  shared: u.fs !== undefined ? `--dest is on ${u.at}, whose file system (${u.fs}) is not NTFS or ReFS, so the access lists seen here do not decide who can rename the folders on the way (FAT32 and exFAT keep none, and a cloud drive such as Google Drive's makes them up)`
    : `--dest is on a file system not known to be a local disk (${u.at}); on a network or shared one the owner and mode seen here do not decide who can rename the folders on the way`,
  indirect: `--dest is reached through a link, a junction, a short name or a drive letter that stands for another folder (${u.at}), whose real folders cannot all be judged`,
  reparse: `--dest goes through ${u.at}, which Windows marks as a reparse point but not as a link to another folder (a OneDrive or iCloud Drive folder, say), whose folders cannot all be judged`,
  unresolved: `--dest goes through ${u.at}, whose real path cannot be found (a link that leads nowhere or to itself, a volume with no drive letter, or a folder this user cannot read), so its real folders cannot all be judged`,
  // A run that failed read nothing: the drive's file system is not to blame then (review of 4dcb602).
  unreadable: u.failed !== undefined ? `the folders on the way to --dest could not be read (Windows PowerShell ${u.failed})`
    : `--dest is on ${u.at}, whose file system could not be read, so the folders on the way cannot all be judged`,
}[u.why]);
const unjudgeableFix = (u: Unjudgeable) => ({
  shared: u.fs !== undefined ? "use a folder on a drive formatted NTFS or ReFS" : "use a folder on a local disk",
  unreadable: "check that Windows PowerShell runs, then try again",
  // A real path on a network share is refused too, so it is no advice (a drive letter mapped to a share, review of 874eac0).
  // With no other spelling of --dest to give, saying "give its real path" would send the user back to the same refusal.
  indirect: u.real === undefined ? "use a folder no link, junction, mount or other drive letter leads to" : /^\\\\(?![?.]\\)/.test(u.real) ? "use a folder on a local disk" : `give --dest by its real path: ${u.real}`,
  reparse: "use a folder outside it, on a local disk",
  unresolved: "give --dest by its real path, through folders this user can read",
}[u.why]);
type Step = { dir: string; hasChild: boolean };
/**
 * The folders from --dest up to the root of its drive, each with whether the next one down is inside it. Only meaningful once
 * unjudgeable(dest) is undefined, so that these are the folders retire really goes through. The folders above `top` (a test
 * seam) are trusted; `top` itself is judged.
 */
export function chainOf(dest: string, top: string | undefined): Step[] {
  const above = new Set<string>();
  if (top !== undefined) for (let a = dirname(realOr(top)); ; a = dirname(a)) { const id = identity(a); if (id !== undefined) above.add(id); if (dirname(a) === a) break; }
  const out: Step[] = [];
  for (let dir = resolve(dest), hasChild = false; ; dir = dirname(dir), hasChild = true) {
    const id = identity(dir);
    if (id === undefined || !above.has(id)) out.push({ dir, hasChild });
    if (dirname(dir) === dir) return out;
  }
}
/**
 * Whether only this user can get into each path: by mode on POSIX, and on Windows, where modes do nothing, by the access list,
 * read for all the paths in one start of Windows PowerShell. (The 32 767-character limit is SetEnvironmentVariable's; a child's
 * environment block takes a longer variable, which the test with 9 000 identical copies covers.) Windows reads a junction's
 * own list, not its target's, so judge asks for a --dest that is a link both as written and at its real path.
 */
function access(paths: string[]): { states: Access[]; failed?: string } {
  if (process.platform !== "win32") return { states: paths.map((p): Access => { try { const st = statSync(p); return { state: modeAccess(st.mode, st.uid, process.getuid?.()) }; } catch { return { state: "unknown" }; } }) };
  // Room for every block: a private path prints about 130 bytes, past node's default 1 MiB at about 8 000 paths; and 64 MiB
  // more for long lists, since another account can plant a file with a list of up to 64 KiB, a few hundred KiB as text
  // (review of 4dcb602: 1 700 entries on one file stopped the run).
  const r = spawnSync(join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 + paths.length * 4096, env: { ...process.env, KL_RETIRE_ACL_PATHS: paths.map(extended).join("|") } });
  const out = aclAccessAll(r.status, r.stdout ?? "", paths.length);
  mySid ??= out[0]?.me; // printed before any path is read, so valid even when a read fails
  // A list it cannot read is an "error" block in a run that succeeds; a run that failed read none (review of d905c6f).
  return { states: out, failed: runFailed(r, /^me S-1-/) };
}
/**
 * Makes each folder in KL_RETIRE_NEW_DIRS ("|"-separated, outermost first; Windows allows no "|" in a name, and main refuses
 * one) with kernel32's CreateDirectoryW, handing it a protected access list of this user and SYSTEM, so the list is the
 * folder's from its first moment, and so a name already there (a folder, a file or a junction another account put there
 * after the checks) fails instead of being used. Prints "made <n>" after each, "exists <n>" for a name already there, or
 * "error <code>".
 */
export const MKDIR_SCRIPT = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition '
using System; using System.Runtime.InteropServices;
public static class KlRetireMkdir {
  [StructLayout(LayoutKind.Sequential)] public struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  public static int Make(string path, byte[] descriptor) {
    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      SecurityAttributes a = new SecurityAttributes(); a.nLength = Marshal.SizeOf(typeof(SecurityAttributes)); a.lpSecurityDescriptor = pinned.AddrOfPinnedObject();
      return CreateDirectoryW(path, ref a) ? 0 : Marshal.GetLastWin32Error();
    } finally { pinned.Free(); }
  }
}';
$s = New-Object Security.AccessControl.DirectorySecurity; $s.SetAccessRuleProtection($true, $false);
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) { $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))) }
$d = $s.GetSecurityDescriptorBinaryForm(); $n = 0
foreach ($p in ($env:KL_RETIRE_NEW_DIRS -split '[|]')) { $e = [KlRetireMkdir]::Make($p, $d); if ($e -eq 183) { 'exists ' + $n; exit 3 } elseif ($e -ne 0) { 'error ' + $e; exit 4 }; 'made ' + $n; $n++ }`;
const APPEARED = "a folder or link appeared where retire was making the archive folder, so nothing was moved; use a new folder";
/**
 * Makes the folders --apply needs (outermost first) private from the start, one name at a time, refusing a name that is
 * already there: on Windows each with its access list set as it is created (one made open and fixed after could already hold
 * another account's handle, which no later change takes back), on POSIX 0700. A failure removes the empty folders it made and
 * refuses.
 */
function makeFolders(dirs: string[]): void {
  if (dirs.length === 0) return;
  const undo = (made: string[]) => { for (const d of [...made].reverse()) { try { rmdirSync(d); } catch { break; } } };
  if (process.platform !== "win32") {
    for (const [i, d] of dirs.entries()) {
      try { mkdirSync(d, { mode: 0o700 }); } catch (e) {
        undo(dirs.slice(0, i));
        // Named, with advice, as on Windows (review of 4dcb602): it is --dest or a folder above it, never a project folder.
        const code = (e as NodeJS.ErrnoException).code ?? "error";
        throw new Refusal(code === "EEXIST" ? APPEARED : `could not make the archive folder ${d} (${code}), so nothing was moved; ${["EACCES", "EPERM", "EROFS"].includes(code) ? "use a folder you may make folders in" : "use another folder"}`);
      }
    }
    return;
  }
  const r = spawnSync(join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", MKDIR_SCRIPT], { encoding: "utf8", windowsHide: true, env: { ...process.env, KL_RETIRE_NEW_DIRS: dirs.map(extended).join("|") } });
  const lines = (r.stdout ?? "").split(/\r?\n/);
  const made = lines.filter((l) => /^made \d+$/.test(l)).length;
  if (r.status !== 0 || made !== dirs.length) {
    undo(dirs.slice(0, made));
    if (lines.some((l) => /^exists \d+$/.test(l))) throw new Refusal(APPEARED);
    // Windows' own reason, not "private": that is what the user can act on (review of d910e90).
    const code = lines.map((l) => /^error (\d+)$/.exec(l)?.[1]).find((c) => c !== undefined), d = dirs[Math.min(made, dirs.length - 1)]!;
    if (code === "5") throw new Refusal(`Windows refused to make ${d} (error 5, access denied: this user may not make folders in ${dirname(d)}, or that folder takes away the owner's right to set permissions), so nothing was moved; use a folder you may make folders in`);
    if (code !== undefined) throw new Refusal(`could not make the archive folder ${d} (Windows error ${code}), so nothing was moved; use another folder`);
    // The run itself failed, so no folder was made (review of 4dcb602).
    throw new Refusal(`Windows PowerShell could not make the archive folder (${r.status === null ? "could not be started" : `exit ${r.status}`}), so nothing was moved; check that Windows PowerShell runs, then try again`);
  }
}
/**
 * A name as received, in quotes. Each character takes the first rule that fits it: a quote or backslash is escaped with a
 * backslash; a character in Unicode's C categories (control, format, surrogate, private use, unassigned), in its Z
 * categories other than the space, or with Default_Ignorable_Code_Point is written as \u{...}; any other character is shown
 * as typed. So a control, DEL, a C1 control or a bidi override never reaches the terminal (review of 00e9059); a
 * default-ignorable character, among them the four Hangul filler letters, the combining grapheme joiner and the variation
 * selectors, never prints as nothing (review of 28e862f); every other letter, in any script, is shown as typed (review of
 * 026b826), and so is a character blank by design outside those sets, such as U+2800 BRAILLE PATTERN BLANK (review of
 * e87dcfb).
 */
const shown = (s: string) => `"${Array.from(s, (c) => c === '"' || c === "\\" ? `\\${c}` : c !== " " && /[\p{C}\p{Z}\p{DI}]/u.test(c) ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c).join("")}"`;
/**
 * The advice for an existing folder that is not private. No command to make it private is printed (AR2b, reviews of d910e90
 * to 54b7f26): every form of one misled somewhere. A path a shell expands sent it to the folder above, an account icacls
 * cannot resolve failed it, an explicit entry for another account survived it, a drive root's change reached the whole
 * drive, and folders above that others can swap refused the --dest anyway.
 */
const NEW_FOLDER = "use a new folder (retire makes a new one private)";
const INSIDE = "a folder or file inside the destination"; // never the path: it can name a project folder
type Problem = { what: string; dir: string; access: Access };
/** A folder on the way to --dest that another account could swap; never a project folder (they are all above the archive). */
type Swap = { dir: string; risk: Risk };
/**
 * The first path retire would write through that exists and is not private (`problem`), else the first folder from --dest up
 * to the root of its drive that another account could rename or replace (`swap`); neither when there is none. A copy takes its
 * access list (on Windows) from the folder it is made in (.staging) and keeps it when linked into place, retire appends to the
 * manifest, the archive's restore.py is what a restore runs, and a destination file already there counts as copied, so each
 * of those and every folder on the way must be private too. Making the folder private afterwards (chmod 700, icacls) does not
 * reach what another account put inside while it was open, and on POSIX such a file is owned by that account. Whoever can
 * rename a folder above the archive can put its own folder in its place between a check and a write. Without `privacy` (the
 * dry run for a --dest not made yet), only the folders that exist on the way are judged. One start of Windows PowerShell reads
 * every list.
 */
function judge(dest: string, plan: Plan, top: string | undefined, privacy = true): { indirect?: Unjudgeable; then?: { problem?: Problem; swap?: Swap }; failed?: string; problem?: Problem; swap?: Swap } {
  const indirect = unjudgeable(dest);
  if (indirect) {
    // Advice is a real path only when it passes everything, the folders above it and its privacy too: one refused in turn is
    // named in the same message with its own reason (review of 121575e). Judged as the dry run judges a new --dest. unjudgeable
    // gives a real path as advice only once that path has passed its rule, so only the folders are judged here, saving a
    // start of Windows PowerShell for each refusal (review of 54b7f26).
    if (indirect.why === "indirect" && indirect.real !== undefined && !/^\\\\(?![?.]\\)/.test(indirect.real)) {
      const then = judgeFolders(indirect.real, plan, top, existsSync(indirect.real));
      if (then.failed) return { failed: then.failed };
      if (then.problem || then.swap) return { indirect, then };
    }
    return { indirect };
  }
  return judgeFolders(dest, plan, top, privacy);
}
/** judge's checks of the folders themselves, for a --dest that is its own real path. */
function judgeFolders(dest: string, plan: Plan, top: string | undefined, privacy: boolean): { failed?: string; problem?: Problem; swap?: Swap } {
  // A --dest that is a link is judged as itself (whoever can change it can send the files elsewhere) and by where it leads.
  const real = realOr(dest);
  const paths: [string, string][] = !privacy ? [] : [[dest, "the destination"], ...(norm(real) !== norm(dest) ? [[real, "the destination"] as [string, string]] : []), [join(dest, ".staging"), "the destination's .staging folder"], ...inside(dest, plan).map((p): [string, string] => [p, INSIDE])];
  const present = paths.filter(([p]) => p === dest || existsSync(p));
  const chain = chainOf(dest, top).filter((c) => there(c.dir));
  const win = process.platform === "win32", all = [...present.map(([p]) => p), ...(win ? chain.map((c) => c.dir) : [])];
  const { states, failed } = all.length > 0 ? access(all) : { states: [] as Access[], failed: undefined };
  if (failed) return { failed }; // nothing was read, so no folder is to blame
  const n = states.slice(0, present.length).findIndex((a) => a.state !== "private");
  const problem = n >= 0 ? { what: present[n]![1], dir: present[n]![0], access: states[n]! } : undefined;
  // The folders are judged after a privacy problem too, so the advice covers both (review of f0154ee), the --dest then as the
  // parent of a new folder inside it. Of the folders others can swap, the one nearest the root is named: any --dest that works
  // must avoid every one of them, and a new folder beside or inside the --dest goes through them all (review of b9acee6).
  let swap: Swap | undefined;
  for (const [i, { dir, hasChild }] of chain.entries()) {
    const a = states[present.length + i], parent = hasChild || (problem !== undefined && samePath(dir, dest));
    const risk = win ? aclRisk(a?.owner && a.entries ? { owner: a.owner, entries: a.entries } : undefined, a?.me ?? "", parent, dirname(dir) === dir)
      : modeRisk((() => { try { return { uid: lstatSync(dir).uid, mode: statSync(dir).mode }; } catch { return undefined; } })(), process.getuid?.() ?? -1, parent);
    if (risk) swap = { dir, risk };
  }
  return { problem, swap };
}
const why = ({ what, access: a }: Problem) => a.state === "open" ? `${what} is open to other accounts on this machine` : a.state === "foreign" ? `${what} is owned by another account` : `the access list of ${what} could not be read`;
const swapWhy = ({ dir, risk }: Swap) => `another account could swap the archive folder during the run: ${{
  children: `${dir} lets other accounts rename or remove the folders in it`, entry: `other accounts may rename, remove or change the permissions of ${dir}`,
  owner: `${dir} is owned by another account`, unknown: process.platform === "win32" ? `the access list of ${dir} could not be read` : `the owner and mode of ${dir} could not be read`,
}[risk]}`;
/** No command: making a folder above the archive private takes it away from whoever else uses it. */
const SAFE_CHAIN = `where every folder from it up to the root of its drive can be changed only by ${process.platform === "win32" ? "you, SYSTEM and Administrators" : "you and root"}`;
const SWAP_FIX = `use a --dest ${SAFE_CHAIN}`;
/**
 * Why the folders refuse a --dest, and what to do. When it is open and a folder above it can be swapped, both are named and
 * the advice covers both, since a new folder beside it goes through the same folders above (review of f0154ee).
 */
function folderWords(problem: Problem | undefined, swap: Swap | undefined): [string, string] {
  if (problem && swap) return [`${why(problem)}, and ${swapWhy(swap)}`, `${NEW_FOLDER} ${SAFE_CHAIN}`];
  return problem ? [why(problem), NEW_FOLDER] : [swapWhy(swap!), SWAP_FIX];
}
/** A run of Windows PowerShell that read no access list at all (review of d905c6f): no folder is to blame, so try again. */
const failedWords = (failed: string): [string, string] => [`the access lists of the folders on the way could not be read (Windows PowerShell ${failed})`, "check that Windows PowerShell runs, then try again"];
/** Why a --dest the real-path rule refuses is refused, and what to do: when its real path is refused too, that reason as well. */
function indirectWords(u: Unjudgeable, then?: { problem?: Problem; swap?: Swap }): [string, string] {
  if (then?.problem || then?.swap) { const [w, fix] = folderWords(then.problem, then.swap); return [`${unjudgeableWhy(u)}, and its real path ${u.real} cannot be used either: ${w}`, fix]; }
  return [unjudgeableWhy(u), unjudgeableFix(u)];
}

/** Put a finished copy in place without ever replacing an existing file. */
function place(partial: string, dst: string): void {
  try { linkSync(partial, dst); return; } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e; }
  // A file system without hard links: check, then rename.
  if (existsSync(dst)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  renameSync(partial, dst);
}

function appendLine(manifest: string, line: string, append: (path: string, data: string) => void): void {
  let prefix = "";
  if (existsSync(manifest) && statSync(manifest).size > 0) {
    const fd = openSync(manifest, "r"), b = Buffer.alloc(1);
    try { readSync(fd, b, 0, 1, statSync(manifest).size - 1); } finally { closeSync(fd); }
    if (b[0] !== 0x0a) prefix = "\n"; // a line torn by an earlier crash must not swallow this one
  }
  append(manifest, prefix + line);
  const fd = openSync(manifest, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** `missing`: the folders to make, deepest first, as main worked them out before judging them. */
function apply(plan: Plan, dest: string, io: RetireIo, protectedRoots: string[], missing: string[]): { moved: number; bytes: number; kept: number } {
  // Conversation logs are private: the archive's folders are owner-only (POSIX modes; on Windows an owner-only access list
  // on a folder retire creates), and so is every file in it.
  io.beforeMake?.([...missing].reverse());
  makeFolders([...missing].reverse());
  const first = missing.length > 0 ? missing[missing.length - 1] : undefined;
  // Every write goes through the path, so the folder written to must be the folder checked: another account that can rename
  // a folder above it (a secondary drive root may grant Everyone full control) could put its own folder, or a junction, in its place. Its identity
  // (volume and file id, links followed) is taken now, must hold after the checks below, and before every write after them.
  const destId = identity(dest);
  try {
    if (first !== undefined) {
      // Every folder this run made is private, so one between an existing folder and the archive does not keep what its parent
      // passes down (which can let another account rename it, AR2b).
      io.madeFolder?.(dest);
      io.madePrivate?.(dest);
      // The new archive folder must still be empty, and each new folder above it must hold only the next one.
      const planted = missing.some((d, n) => { const names = readdirSync(d); return n === 0 ? names.length > 0 : names.length !== 1 || norm(names[0]!) !== norm(basename(missing[n - 1]!)); });
      if (planted) throw new Refusal("something was put into the new archive folder before it was private, so nothing was moved; use a new folder");
    }
    // Checked here, with the folder in its final state and before any file is written, not only when the plan was made.
    const { indirect, then, failed, problem, swap } = judge(dest, plan, io.chainTop);
    if (indirect) { const [w, fix] = indirectWords(indirect, then); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    if (failed) { const [w, fix] = failedWords(failed); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    if (problem && first !== undefined) {
      // A new folder that is not private now will not become so: its drive does not keep access settings (FAT and exFAT drives
      // are refused before this on Windows, by their format).
      const reason = { open: "it is still open to other accounts", foreign: "another account owns it", unknown: "its access list could not be read" }[problem.access.state as "open"];
      throw new Refusal(`could not make the new archive folder private (${reason}), so nothing was moved; use a folder on a drive that keeps owner-only access (FAT and exFAT drives do not)`);
    }
    if (problem || swap) { const [w, fix] = folderWords(problem, swap); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    io.checked?.();
    // No identity to hold it to (a drive without file ids) fails closed, as does a change.
    if (destId === undefined || identity(dest) !== destId) throw new Refusal(REPLACED);
  } catch (e) {
    // Leave nothing behind: a rerun would find an existing folder that was never made private. Only folders this run made,
    // and only while empty, are removed.
    if (first !== undefined) for (const d of missing) { try { rmdirSync(d); } catch { break; } }
    throw e;
  }
  const sameDest = () => identity(dest) === destId;
  const restore = join(dest, "restore.py");
  if (!existsSync(restore)) writeFileSync(restore, readFileSync(RESTORE), { mode: 0o600 });
  const manifest = join(dest, "manifest.jsonl"), staging = join(dest, ".staging");
  const copy = io.copyFile ?? ((s: string, d: string) => copyFileSync(s, d, constants.COPYFILE_EXCL));
  const append = io.appendFile ?? ((p: string, data: string) => appendFileSync(p, data, { mode: 0o600 }));
  // Staging leftovers from a crash (only retire's own names): the manifest never names them.
  try { for (const n of readdirSync(staging)) if (/^[0-9a-f]{16}\.partial$/.test(n)) unlinkSync(join(staging, n)); } catch { /* no staging folder */ }
  let moved = 0, bytes = 0, kept = 0;
  for (const [n, i] of plan.items.entries()) {
    if (!sameDest()) { io.stderr(`kept the remaining ${plan.items.length - n} files: the destination folder was replaced during the run\n`); kept += plan.items.length - n; break; }
    if (n >= plan.anchorFrom && kept > 0) { io.stderr(`kept ${i.label}: an earlier file was kept, so the session's main file stays for a rerun\n`); kept++; continue; }
    let created = false;
    try {
      mkdirSync(dirname(i.dst), { recursive: true, mode: 0o700 });
      const before = sha256File(i.src), srcId = identity(i.src);
      io.beforeCopy?.(i.src);
      // Again here: reading a big source takes long enough to swap the folder, and a copy takes the list of where it is made.
      if (!sameDest()) { io.stderr(`kept the remaining ${plan.items.length - n} files: the destination folder was replaced during the run\n`); kept += plan.items.length - n; break; }
      if (!existsSync(i.dst)) {
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const partial = join(staging, `${randomBytes(8).toString("hex")}.partial`);
        try {
          copy(i.src, partial);
          // Owner read and write only: this also clears a read-only attribute a read-only source passed on. Keep its mtime.
          chmodSync(partial, 0o600);
          utimesSync(partial, i.mtimeMs / 1000, i.mtimeMs / 1000);
          const fd = openSync(partial, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
          place(partial, i.dst); created = true; io.placed?.(i.dst);
        } finally { if (existsSync(partial)) unlinkSync(partial); }
      }
      const st = lstatSync(i.src);
      if (lstatSync(i.dst).size !== i.size || sha256File(i.dst) !== before || st.size !== i.size || st.mtimeMs !== i.mtimeMs || sha256File(i.src) !== before) {
        if (created) unlinkSync(i.dst); // never a copy an earlier run left
        io.stderr(`kept ${i.label}: the copy did not verify\n`); kept++; continue;
      }
      if (identity(i.dst) === identity(i.src) || insideAny(dirname(i.dst), protectedRoots)) { io.stderr(`kept ${i.label}: the copy is the source itself or inside the retired folders\n`); kept++; continue; }
      if (!sameDest()) { io.stderr(`kept ${i.label}: the destination folder was replaced during the run\n`); kept++; continue; }
      // Prove a restore before deleting (resume loop, slice 4): copy the archive copy back out, hash that, and remove it. Then
      // check the source again, which has had all this time to change. Any failure keeps both the source and the archive copy;
      // a rerun reuses a verified archive copy.
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const trial = join(staging, `${randomBytes(8).toString("hex")}.trial`), dstId = identity(i.dst);
      let restored: string;
      try {
        (io.trialCopy ?? ((s: string, d: string) => copyFileSync(s, d, constants.COPYFILE_EXCL)))(i.dst, trial);
        restored = sha256File(trial);
        io.duringTrial?.(i.src);
      } catch (e) {
        io.stderr(`kept ${i.label}: the restore trial failed (${(e as NodeJS.ErrnoException).code ?? "error"})\n`); kept++; continue;
      } finally { if (existsSync(trial)) unlinkSync(trial); }
      if (restored !== before) { io.stderr(`kept ${i.label}: the restore trial did not verify\n`); kept++; continue; }
      const now = lstatSync(i.src);
      if (identity(i.src) !== srcId || now.size !== i.size || now.mtimeMs !== i.mtimeMs || sha256File(i.src) !== before) {
        io.stderr(`kept ${i.label}: the source changed during the restore trial\n`); kept++; continue;
      }
      // And the archive side, which the trial gave the same time to change (Codex's review of PR #34): the folder must be the
      // same one, and the archive copy the same file with the same bytes, before anything is recorded or deleted.
      if (!sameDest()) { io.stderr(`kept ${i.label}: the destination folder was replaced during the run\n`); kept++; continue; }
      if (identity(i.dst) !== dstId || lstatSync(i.dst).size !== i.size || sha256File(i.dst) !== before) {
        io.stderr(`kept ${i.label}: the archive copy changed during the restore trial\n`); kept++; continue;
      }
      io.afterArchiveCheck?.(i.src);
      // That archive hash was a long read too (Codex's review of 6e82f52): one last cheap check of the source (identity,
      // size, mtime) immediately before the record and the delete; a change keeps both copies.
      const last = lstatSync(i.src);
      if (identity(i.src) !== srcId || last.size !== i.size || last.mtimeMs !== i.mtimeMs) {
        io.stderr(`kept ${i.label}: the source changed during the final checks\n`); kept++; continue;
      }
      appendLine(manifest, JSON.stringify({ group: plan.client, client: plan.client, session: plan.session, src: i.src, dst: i.dst, rel: i.rel, size: i.size, mtime: i.mtimeMs / 1000, sha256: before, movedAt: Date.now() / 1000 }) + "\n", append);
      unlinkSync(i.src); moved++; bytes += i.size;
    } catch (e) {
      io.stderr(`kept ${i.label}: ${(e as NodeJS.ErrnoException).code ?? "error"}\n`); kept++;
    }
  }
  try { rmdirSync(staging); } catch { /* absent, or not empty */ }
  if (plan.cleanup) removeEmptyDirs(plan.cleanup);
  return { moved, bytes, kept };
}

/** Remove empty folders bottom-up inside (and including) the session's own folder; links are never followed. */
function removeEmptyDirs(dir: string): void {
  let entries: string[];
  try { if (!lstatSync(dir).isDirectory()) return; entries = readdirSync(dir); } catch { return; }
  for (const e of entries) removeEmptyDirs(join(dir, e));
  try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* not empty or gone */ }
}

export async function main(argv: string[], io: RetireIo): Promise<number> {
  const [client, id, ...rest] = argv;
  const f: { successor?: string; dest?: string; minIdle?: string; apply: boolean } = { apply: false };
  const VALUE: Record<string, "successor" | "dest" | "minIdle"> = { "--successor": "successor", "--dest": "dest", "--min-idle-hours": "minIdle" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!, key = VALUE[a];
    if (key) { const v = rest[i + 1]; if (v === undefined || v.startsWith("--")) { io.stderr(`retire: ${a} needs a value\n`); return 2; } f[key] = v; i++; }
    else if (a === "--apply") f.apply = true;
    else { io.stderr(USAGE); return 2; }
  }
  if ((client !== "claude" && client !== "codex") || !id || id.startsWith("--")) { io.stderr(USAGE); return 2; }
  if (!SESSION_ID.test(id) || (f.successor !== undefined && !SESSION_ID.test(f.successor))) { io.stderr("retire: session and thread ids are UUIDs\n"); return 2; }
  const minIdleHours = f.minIdle === undefined ? 24 : Number(f.minIdle);
  if (!Number.isInteger(minIdleHours) || minIdleHours < 1) { io.stderr("retire: --min-idle-hours must be a whole number of at least 1\n"); return 2; }
  try {
    if (!f.dest || !isAbsolute(f.dest)) throw new Refusal("--dest must be an absolute folder");
    // The \\?\UNC\ and \\.\UNC\ forms of a share are its plain \\host\share form (Node takes \\?\UNC\ itself for a drive root),
    // and the \\.\C:\ form is C:\ (Node gives it no long-path handling, so past 260 characters it would fail halfway).
    const dest = resolve(f.dest).replace(/^\\\\[?.]\\UNC\\/i, String.fromCharCode(92, 92)).replace(/^\\\\\.\\(?=[A-Za-z]:\\)/, "");
    // Any other device-namespace form (\\?\GLOBALROOT\Device\Mup\..., \\?\Global\UNC\...) can name a network path that no
    // pattern for shares sees, so it is refused before anything opens it; a drive's folder or a volume's GUID name is not. A
    // drive letter with no separator after it (\\.\C:, and \\.\C:\, whose separator resolve() drops) names the volume
    // device, not its root folder, and with a name after the colon it is relative to the current folder (review of 69c50c6).
    if (/^\\\\[?.]\\(?![A-Za-z]:\\|Volume\{)/i.test(dest)) throw new Refusal("--dest is written in the device namespace, so nothing was moved; give the folder by its local path");
    // Windows drops a trailing dot or space from a folder name, so such an archive could not be opened by ordinary paths.
    if (dest.split(/[\\/]/).some((s) => s !== "." && s !== ".." && /[. ]$/.test(s))) throw new Refusal("--dest has a folder name ending in a dot or a space");
    // A network path's folders above the shared folder are another machine's, and a share named like a drive (C$) can stand
    // for any folder, so AR2b cannot judge them: every \\host\share path is refused, before any check opens it over the
    // network (review of 874eac0). A drive letter mapped to a share is not its own real path, so unjudgeable() refuses that.
    // A share on another machine or in WSL has no local path here, so a local disk is the advice first (review of d910e90).
    if (/^\\\\(?![?.]\\)/.test(dest)) throw new Refusal("--dest is a network path, whose folders cannot all be judged from here, so nothing was moved; use a folder on a local disk, or, for a share of this machine, give the folder by its local path");
    // Before every refusal that names a folder: a --dest inside the folders being retired from could name a project folder
    // (review of 00e9059). After the network refusal, since this opens the path.
    const protectedRoots = [join(io.home, ".claude"), join(io.home, ".claude", "projects"), join(io.home, ".codex"), join(io.home, ".codex", "sessions"), join(io.home, ".codex", "archived_sessions")];
    if (within(dest, join(io.home, ".claude")) || within(dest, join(io.home, ".codex")) || insideAny(dest, protectedRoots)) throw new Refusal("--dest must be outside the folders being retired from");
    // The name is shown as received (review of 4dcb602): no folder can hold such a character, and a --dest inside the folders
    // being retired from is refused before this, so it is never a project folder's name.
    // A quoted path that ends in a backslash (Windows PowerShell 5.1, cmd) arrives with the closing quote and the rest of the
    // line in its last name.
    const bad = process.platform === "win32" ? dest.slice(parse(dest).root.length).split(/[\\/]/).find((s) => /[<>:"|?*\x00-\x1f]/.test(s)) : undefined;
    if (bad !== undefined) throw new Refusal(`--dest has a folder name with a character Windows does not allow (< > : " | ? * or a control character): ${shown(bad)}, so nothing was moved${bad.includes('"') ? "; a path in quotes that ends in a backslash passes the closing quote on as part of the path, so leave that backslash off" : ""}`);
    // A file at or above --dest is no folder to make anything in or to judge, and the dry run says so too (review of d910e90).
    // A path that cannot be read is left to the checks below.
    let near = dest; while (!there(near) && dirname(near) !== near) near = dirname(near);
    let isFolder: boolean | undefined; try { isFolder = statSync(near).isDirectory(); } catch { /* judged below */ }
    if (isFolder === false) throw new Refusal(near === dest ? "--dest is a file, not a folder, so nothing was moved; use a folder" : `--dest goes through ${near}, which is a file, not a folder, so nothing was moved; use a folder whose parents are all folders`);
    // On POSIX a folder this user may not write in is seen before anything is made, by the dry run too (review of 4dcb602).
    // Windows' access lists answer that only by trying, which --apply does (error 5). Only a folder read as one: a link that
    // leads nowhere is left to the real-path rule.
    if (process.platform !== "win32" && near !== dest && isFolder === true) {
      let writable = true; try { accessSync(near, constants.W_OK | constants.X_OK); } catch { writable = false; }
      if (!writable) throw new Refusal(`this user may not make folders in ${near}, so nothing was moved; use a folder you may make folders in`);
    }
    let plan: Plan;
    try {
      plan = client === "claude" ? planClaude(io, id.toLowerCase(), f.successor?.toLowerCase(), dest, minIdleHours) : await planCodex(io, id.toLowerCase(), dest, minIdleHours);
      // POSIX: another account (root through sudo, say) would make an archive the sessions' owner could not open, and its
      // copies would keep that owner, so a rerun as that account would be refused. A file another account wrote into the
      // session (root in a container) is refused under every account until it is given back.
      const uid = process.getuid?.();
      if (uid !== undefined && plan.items.some((i) => i.uid !== uid)) throw new Refusal("a file to move is owned by another account than the one running retire; run retire as the owner of every file (not through sudo), giving back with chown any file another account wrote into the session; nothing was moved");
      preflight(plan, dest, protectedRoots);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      // Never echo the error's message: it can carry a path with a project folder name.
      throw new Refusal(`could not plan the retirement (${(e as NodeJS.ErrnoException).code ?? "error"}); nothing was moved`);
    }
    const total = plan.items.reduce((a, i) => a + i.size, 0);
    if (!f.apply) {
      // --apply makes these checks itself, just before writing.
      const { indirect, then, failed, problem, swap } = judge(dest, plan, io.chainTop, existsSync(dest));
      if (indirect) { const [w, fix] = indirectWords(indirect, then); plan.checks.push(`warning: ${w}; --apply refuses it. To go ahead, ${fix}`); }
      if (failed) { const [w, fix] = failedWords(failed); plan.checks.push(`warning: ${w}; --apply refuses it. To go ahead, ${fix}`); }
      if (problem || swap) { const [w, fix] = folderWords(problem, swap); plan.checks.push(`warning: ${w}; --apply refuses it. To go ahead, ${fix}`); }
      io.stdout(`plan: ${plan.client} ${plan.session} ${plan.items.length} files ${total} bytes -> ${dest}\n${plan.checks.map((c) => `  ${c}\n`).join("")}dry run: nothing moved (add --apply to move)\n`);
      return 0;
    }
    // The folders this run will make, deepest first, worked out once, before they are judged: a name that appears after this
    // (a junction another account allowed to add folders put in the way) is then one retire tries to make, which refuses,
    // rather than one it walks through (review of 874eac0). Comparing paths with what mkdirSync returns fails for the
    // extended-length form, so they are found here.
    const missing: string[] = [];
    for (let d = dest; !there(d) && dirname(d) !== d; d = dirname(d)) missing.push(d); // never a folder that is there, unseen
    // Judged before anything is made, as the dry run judges it: a folder made through a link nobody judged, or under a folder
    // another account can swap, may already be made where they choose. --apply judges again once the folders are made.
    const pre = judge(dest, plan, io.chainTop, existsSync(dest));
    if (pre.indirect) { const [w, fix] = indirectWords(pre.indirect, pre.then); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    if (pre.failed) { const [w, fix] = failedWords(pre.failed); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    if (pre.problem || pre.swap) { const [w, fix] = folderWords(pre.problem, pre.swap); throw new Refusal(`${w}, so nothing was moved; ${fix}`); }
    io.beforeApply?.();
    const r = apply(plan, dest, io, protectedRoots, missing);
    io.stdout(`moved ${r.moved} files (${r.bytes} bytes); kept ${r.kept}; manifest ${join(dest, "manifest.jsonl")}\n`);
    return r.kept === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof Refusal) { io.stderr(`refused: ${e.message}\n`); return 1; }
    throw e;
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] && basename(process.argv[1]) === "retire.ts";
if (isMain) {
  const { homedir } = await import("node:os");
  main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), home: homedir(), now: Date.now() }).then((c) => process.exit(c), (e) => { process.stderr.write(`retire: failed (${(e as NodeJS.ErrnoException).code ?? "error"})\n`); process.exit(1); });
}
