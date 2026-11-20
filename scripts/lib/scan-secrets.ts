// Credential-shape and workstation-path scan (DESIGN §9.7, S1c E1). Shared by scripts/scan-secrets.ts (CI) and the
// vitest that plants fresh synthetic tokens in a temporary tree. Identities are reviewed by hand, never scanned.
import { spawnSync } from "node:child_process";

// Patterns are assembled from pieces so this file never contains a credential-shaped string itself.
const S = (...parts: string[]) => parts.join("");
/** Credential shapes: the guard's patterns (fixtures/gen.ts contentPatterns) plus GitHub and AWS shapes. Scanned over the WHOLE tree, no exclusions. */
export const CREDENTIAL_PATTERNS: { name: string; pattern: string }[] = [
  { name: "stripe-like (live, test, restricted)", pattern: S("\\b[rs]k_(live|test)_", "[A-Za-z0-9]{16,}") },
  { name: "jwt", pattern: S("\\beyJ", "[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}") },
  { name: "anthropic-like", pattern: S("\\bsk-ant", "-[A-Za-z0-9_-]{20,}") },
  { name: "slack-like", pattern: S("\\bxox", "[abprs]-[A-Za-z0-9_-]{10,}") },
  { name: "google-like", pattern: S("\\bAIza", "[A-Za-z0-9_-]{35}") },
  { name: "meta-like", pattern: S("\\bEAA", "[A-Za-z0-9]{40,}") },
  { name: "square-like", pattern: S("\\bK0", "[0-9]{2}[A-Za-z0-9]{27}") },
  { name: "npm _authToken", pattern: S("_auth", "Token\\s*=\\s*\\S{8,}") },
  { name: "private key block", pattern: S("-----BEGIN ", "[A-Z ]*PRIVATE KEY-----") },
  { name: "environment secret assignment", pattern: S("\\b[A-Z0-9_]*(SECRET|TOKEN|PRIVATE|SERVICE_ROLE|API)_?", "KEY\\s*[=:]\\s*[A-Za-z0-9_./+-]{16,}") },
  { name: "klb_ bearer token", pattern: S("\\bklb_", "[A-Za-z0-9_-]{43}") },
  { name: "github token", pattern: S("\\bghp_", "[A-Za-z0-9]{36}|", "github_pat", "_[A-Za-z0-9_]{20,}") },
  { name: "aws access key id", pattern: S("\\bAKIA", "[0-9A-Z]{16}") },
];
/** Workstation drive paths: the owner's workstation roots (DESIGN §1). Case-insensitive. docs/ (Frank's and Codex's planning text) is excluded, with the two prose files that name the local-state root on purpose. */
export const PATH_PATTERN = S("[A-Za-z]:[/\\\\]", "(Obsidian|repos|Users|orrery|\\.knowledge-library)");
export const PATH_EXCLUSIONS = [":!docs/", ":!README.md", ":!.gitignore"];

export interface ScanHit { pattern: string; line: string }
export interface ScanReport { ok: boolean; hits: ScanHit[]; error?: string }

function gitGrep(cwd: string, args: string[], noIndex: boolean): { status: number; out: string; err: string } {
  // Treat binary-classified files as text too; a NUL must not hide an ASCII credential.
  const r = spawnSync("git", ["grep", ...(noIndex ? ["--no-index"] : []), "-na", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 2, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Scan a tree. git grep exits 0 on hits, 1 on none; anything else is a failure and the scan FAILS CLOSED. noIndex scans a plain directory (the vitest's temporary tree). */
export function scanTree(cwd: string, opts: { noIndex?: boolean } = {}): ScanReport {
  const hits: ScanHit[] = [];
  const run = (name: string, pattern: string, pathspecs: string[], flags: string[] = []) => {
    const r = gitGrep(cwd, [...flags, "-E", "-e", pattern, "--", ".", ...pathspecs], !!opts.noIndex);
    if (r.status === 0) for (const line of r.out.split("\n").filter(Boolean)) hits.push({ pattern: name, line });
    else if (r.status !== 1) return `git grep failed (${r.status}) for ${name}: ${r.err.trim()}`;
    return undefined;
  };
  for (const { name, pattern } of CREDENTIAL_PATTERNS) { const e = run(name, pattern, opts.noIndex ? [":!node_modules", ":!.git"] : []); if (e) return { ok: false, hits, error: e }; }
  const e = run("workstation path", PATH_PATTERN, [...PATH_EXCLUSIONS, ...(opts.noIndex ? [":!node_modules", ":!.git"] : [])], ["-i"]);
  if (e) return { ok: false, hits, error: e };
  return { ok: hits.length === 0, hits };
}
