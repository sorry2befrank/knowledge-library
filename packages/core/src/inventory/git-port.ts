// Rule 5: tracking in the innermost repository within the approved folder. Unknown metadata or Git failure protects.
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type GitTracking = "tracked" | "untracked" | "no-repo" | "git-unknown";
export interface GitPort { tracking(filePath: string, folderRoot: string): GitTracking }
type Repository = { dir: string; gitDir: string };
const MAX_GIT_FILE_BYTES = 4096;
const GIT_TIMEOUT_MS = 5000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_ANCESTORS = 256;
const MAX_REPOSITORIES = 8;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function directory(path: string): boolean { const st = lstatSync(path); return st.isDirectory() && !st.isSymbolicLink(); }

function gitFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Not a regular gitfile");
    const bytes = Buffer.alloc(MAX_GIT_FILE_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_GIT_FILE_BYTES) throw new Error("Oversized gitfile");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}

function discover(filePath: string, folderRoot: string): Repository[] | "unknown" {
  try {
    if (!isAbsolute(filePath) || !isAbsolute(folderRoot)) return "unknown";
    const root = resolve(folderRoot), file = resolve(filePath);
    if (file === root || !contained(root, file)) return "unknown";
    const item = lstatSync(file);
    if (!item.isFile() || item.isSymbolicLink()) return "unknown";
    // Validate every parent first, including parents above a nested repository. A junction must not escape the root.
    let visited = 0;
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (++visited > MAX_ANCESTORS) return "unknown";
      if (!directory(dir)) return "unknown";
      if (relative(root, dir) === "") break;
      if (!contained(root, dirname(dir))) return "unknown";
    }
    const physicalRoot = realpathSync.native(root), physicalFile = realpathSync.native(file);
    if (!contained(physicalRoot, physicalFile)) return "unknown";
    const repositories: Repository[] = [];
    visited = 0;
    for (let dir = dirname(physicalFile); ; dir = dirname(dir)) {
      if (++visited > MAX_ANCESTORS) return "unknown";
      const dotGit = join(dir, ".git");
      let st;
      try { st = lstatSync(dotGit); } catch (error) { if (!absent(error)) return "unknown"; }
      if (st) {
        if (st.isSymbolicLink()) return "unknown";
        if (st.isDirectory()) repositories.push({ dir, gitDir: dotGit });
        else {
          if (!st.isFile() || st.size > MAX_GIT_FILE_BYTES) return "unknown";
          const match = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(gitFile(dotGit));
          if (!match) return "unknown";
          const gitDir = resolve(dir, match[1]!);
          if (!directory(gitDir)) return "unknown";
          repositories.push({ dir, gitDir });
        }
        if (repositories.length > MAX_REPOSITORIES) return "unknown";
      }
      if (relative(physicalRoot, dir) === "") return repositories;
      if (!contained(physicalRoot, dirname(dir))) return "unknown";
    }
  } catch { return "unknown"; }
}

/** Marker discovery only. tracking() additionally verifies every repository's config/index through bounded Git reads. */
export function findRepository(filePath: string, folderRoot: string): { dir: string } | null | "unknown" {
  const result = discover(filePath, folderRoot);
  return result === "unknown" ? result : result.length ? { dir: result[0]!.dir } : null;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // OS process launch values only: never inherit Git overrides, config injection, loader options, credentials or tracing.
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const empty = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1",
    GIT_ALLOW_PROTOCOL: "", LC_ALL: "C", LANG: "C" };
}

/** Bounded read-only index query. The executable/OS launch path remains a trusted caller/deployment choice. */
export function localGitPort(gitBinary = "git"): GitPort {
  return { tracking(filePath, folderRoot) {
    const deadline = performance.now() + GIT_TIMEOUT_MS, repositories = discover(filePath, folderRoot);
    if (repositories === "unknown") return "git-unknown";
    if (!repositories.length) return "no-repo";
    try {
      const physicalFile = realpathSync.native(filePath);
      const empty = process.platform === "win32" ? "NUL" : "/dev/null";
      let innermost: GitTracking = "git-unknown";
      for (const [index, repo] of repositories.entries()) {
        const remaining = Math.min(GIT_TIMEOUT_MS, Math.ceil(deadline - performance.now()));
        if (remaining <= 0) return "git-unknown";
        const rel = relative(repo.dir, physicalFile).split(sep).join("/");
        const r = spawnSync(gitBinary, ["--no-optional-locks", "--literal-pathspecs", "--git-dir=" + repo.gitDir, "--work-tree=" + repo.dir,
          "-c", "core.bare=false", "-c", "core.hooksPath=" + empty, "-c", "core.fsmonitor=false",
          "-c", "credential.helper=", "-c", "protocol.allow=never", "ls-files", "--cached", "--full-name", "-z", "--", rel],
        { cwd: repo.dir, encoding: "utf8", env: gitEnvironment(), timeout: remaining, maxBuffer: GIT_OUTPUT_BYTES, windowsHide: true });
        if (r.error || r.status !== 0 || r.signal || typeof r.stdout !== "string" || r.stdout.includes("\uFFFD")
          || (r.stdout !== "" && !r.stdout.endsWith("\0"))) return "git-unknown";
        const paths = r.stdout.split("\0").filter(Boolean);
        if (paths.some(path => path !== rel)) return "git-unknown";
        if (index === 0) innermost = paths.includes(rel) ? "tracked" : "untracked";
      }
      const again = discover(filePath, folderRoot);
      if (performance.now() > deadline || again === "unknown" || JSON.stringify(again) !== JSON.stringify(repositories)) return "git-unknown";
      return innermost;
    } catch { return "git-unknown"; }
  } };
}
