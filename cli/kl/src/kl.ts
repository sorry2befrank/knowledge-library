// kl: version, the headersHelper token printer, save, handoff (AR1: check locally, then save as kind "handoff"), and Frank's simple local read path (S2e item A):
// search, read and status, each under one token kind (--as device|cc|cx) with no fallback between kinds.
// Diagnostics go to stderr only; stdout carries only the data the caller asked for.
// Push/sync require a signed, pre-enrolled folder and keep originals untouched. Removal remains separate.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { parseToken } from "@kl/core";
import { HelperClient, helperPath, dpapi } from "./fs/windows-helper.ts";
import type { ArchiveCommandContext } from "./archive/command.ts";

export const KL_VERSION = "0.1.0-s2e";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** The whole stdin value, used only by token store. */
  stdin?: () => Promise<string>;
  /** Production process.platform; synthetic tests may inject the platform. */
  platform?: string;
  /** Whether stdout is a terminal. `--as device` output is for Frank's eyes only and refuses a pipe. Production: process.stdout.isTTY. */
  isTTY?: boolean;
  /** The absolute command that runs this kl, used by `kl mcp-config` for the headers helper. Production: derived from process.argv. */
  klPath?: string;
  /** Executable and script paths as separate arguments; never an already joined shell command. */
  klArgv?: readonly string[];
  /** Trusted local test composition only; ordinary CLI determines its actual process context. */
  archiveContext?: ArchiveCommandContext;
}

export type TokenKind = "cc" | "cx" | "device";
const KINDS: readonly TokenKind[] = ["cc", "cx", "device"];
const ENV_NAME: Record<TokenKind, string> = { cc: "KL_TOKEN_CC", cx: "KL_TOKEN_CX", device: "KL_TOKEN_DEVICE" };

const platformOf = (io: Io) => io.platform ?? process.platform;

/**
 * The DPAPI token store (DESIGN §9.3): %LOCALAPPDATA%\kl\tokens.dpapi, or KL_TOKEN_STORE (injectable for tests).
 * Container: one JSON object {"version":1,"entries":{"<kind>":"<base64>"}}; each entry is one DPAPI (CurrentUser) blob,
 * base64-encoded, protecting the UTF-8 token. Decoding the base64 gives the raw blob, which starts with the DPAPI header.
 */
export function tokenStorePath(env: Record<string, string | undefined>): string {
  return env.KL_TOKEN_STORE ?? join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local"), "kl", "tokens.dpapi");
}
interface StoreFile { version: 1; entries: Record<string, string> }
function readStore(path: string): StoreFile | undefined {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  return parseStore(raw);
}
function parseStore(raw: string): StoreFile {
  if (raw.length > 1_048_576) throw new Error("token store is too large");
  const j: unknown = JSON.parse(raw);
  if (!j || typeof j !== "object" || Array.isArray(j) || Object.keys(j).some(k => k !== "version" && k !== "entries")) throw new Error("invalid token store shape");
  const store = j as Record<string, unknown>;
  if (store.version !== 1 || !store.entries || typeof store.entries !== "object" || Array.isArray(store.entries)) throw new Error("invalid token store shape");
  const entries: Record<string, string> = {};
  for (const [kind, entry] of Object.entries(store.entries)) {
    if (!KINDS.includes(kind as TokenKind) || typeof entry !== "string" || entry.length === 0 || entry.length > 65_536 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry) || Buffer.from(entry, "base64").toString("base64") !== entry) throw new Error("invalid token store entry");
    entries[kind] = entry;
  }
  return { version: 1, entries };
}

/** Where a token comes from. Windows: the DPAPI store first, then KL_TOKEN_<KIND>; KL_TOKEN_FILE is refused. Linux: KL_TOKEN_<KIND>, then the KL_TOKEN_FILE JSON file (tests and CI). */
export async function readToken(io: Io, kind: TokenKind): Promise<string | undefined> {
  const envName = ENV_NAME[kind];
  if (platformOf(io) === "win32") {
    if (io.env.KL_TOKEN_FILE) { io.stderr("kl: KL_TOKEN_FILE is refused on Windows (a plaintext token file breaks DESIGN §2.6); use kl token store\n"); return undefined; }
    let store: StoreFile | undefined;
    try { store = readStore(tokenStorePath(io.env)); } catch (e) { io.stderr(`kl: cannot read the token store: ${(e as Error).message}\n`); return undefined; }
    const entry = store?.entries[kind];
    if (entry !== undefined) {
      const client = new HelperClient(helperPath(io.env));
      try {
        const r = await dpapi(client, "unprotect", new Uint8Array(Buffer.from(entry, "base64")));
        if (!r.ok) { io.stderr(`kl: the stored ${kind} token cannot be decrypted (${r.code})\n`); return undefined; }
        const token = new TextDecoder().decode(r.bytes);
        if (!parseToken(token).ok) { io.stderr(`kl: the stored ${kind} token is not a kl token\n`); return undefined; }
        return token;
      } finally { await client.stop(); }
    }
    return io.env[envName] || undefined;
  }
  if (io.env[envName]) return io.env[envName];
  const file = io.env.KL_TOKEN_FILE;
  if (file) { try { const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>; return j[kind]; } catch (e) { io.stderr(`kl: cannot read ${file}: ${(e as Error).message}\n`); } }
  return undefined;
}

/** Exact selected store only. No ambient token fallback or second file read after validation. */
async function readExactToken(io:Io,kind:TokenKind,path:string):Promise<string|undefined>{
  if(platformOf(io)!=='win32'){io.stderr('kl: an explicit protected token store requires Windows\n');return undefined;}
  let client:HelperClient|undefined;
  try{
    const {readEnrollmentInput}=await import('./archive/enrollment-command.ts');
    const store=parseStore(JSON.stringify(await readEnrollmentInput(path,1_048_576))),entry=store.entries[kind];
    if(!entry){io.stderr('kl: selected protected token class is unavailable\n');return undefined;}
    client=new HelperClient(helperPath(io.env));
    const result=await dpapi(client,'unprotect',new Uint8Array(Buffer.from(entry,'base64')));
    if(!result.ok){io.stderr('kl: selected protected token cannot be decrypted\n');return undefined;}
    try{const token=new TextDecoder('utf-8',{fatal:true}).decode(result.bytes);if(!parseToken(token).ok)throw Error('invalid-token');return token;}
    finally{result.bytes.fill(0);}
  }catch{io.stderr('kl: selected protected token store is unavailable\n');return undefined;}
  finally{await client?.stop();}
}

/** kl token store <kind>: the token comes from stdin only, is checked for the klb_ format and CRC, and is written DPAPI-protected. Linux: refused, nothing written. */
async function tokenStore(io: Io, kind: TokenKind): Promise<number> {
  if (platformOf(io) !== "win32") { io.stderr("kl token store: DPAPI storage exists on Windows only; on Linux set KL_TOKEN_<KIND> for tests and CI\n"); return 1; }
  if (!io.stdin) { io.stderr("kl token store: no stdin\n"); return 1; }
  const token = (await io.stdin()).trim();
  const parsed = parseToken(token);
  if (!parsed.ok) { io.stderr(`kl token store: not a kl token (${parsed.reason})\n`); return 1; }
  const path = tokenStorePath(io.env);
  let store: StoreFile;
  try { store = readStore(path) ?? { version: 1, entries: {} }; } catch (e) { io.stderr(`kl token store: cannot read the token store: ${(e as Error).message}\n`); return 1; }
  const client = new HelperClient(helperPath(io.env));
  try {
    const r = await dpapi(client, "protect", new TextEncoder().encode(token));
    if (!r.ok) { io.stderr(`kl token store: DPAPI failed (${r.code})\n`); return 1; }
    store.entries[kind] = Buffer.from(r.bytes).toString("base64");
  } finally { await client.stop(); }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store) + "\n");
  io.stderr(`kl: ${kind} token stored (DPAPI, CurrentUser)\n`);
  return 0;
}

/** Parse `--as <kind>`, `--json` and `--url <u>` out of the rest; everything else is positional. */
function parseFlags(rest: string[]): { as?: string; json: boolean; url?: string; positional: string[] } {
  const out: { as?: string; json: boolean; url?: string; positional: string[] } = { json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--as") out.as = rest[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--url") out.url = rest[++i];
    else out.positional.push(a);
  }
  return out;
}

type ToolCall = { name: "library_search"; args: { q: string } } | { name: "library_read"; args: { ref: string } } | { name: "library_status"; args: Record<string, never> };
interface ToolReply { isError?: boolean; structuredContent?: Record<string, unknown> }

/** One MCP tools/call under exactly one token kind. Returns the structuredContent on success, or an exit code after writing stderr. */
async function callTool(io: Io, kind: TokenKind, api: string, call: ToolCall): Promise<{ ok: true; structured: Record<string, unknown> } | { ok: false; code: number }> {
  const token = await readToken(io, kind);
  if (!token) { io.stderr(`kl: no ${kind} token (set ${ENV_NAME[kind]} or KL_TOKEN_FILE)\n`); return { ok: false, code: 1 }; }
  let res: Response;
  try {
    res = await io.fetch(`${api}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.args } }) });
  } catch (e) { io.stderr(`kl: cannot reach ${api}: ${(e as Error).message}\n`); return { ok: false, code: 1 }; }
  if (res.status === 401) { io.stderr(`kl: unauthorized (the ${kind} token was refused)\n`); return { ok: false, code: 1 }; }
  if (!res.ok) { io.stderr(`kl: ${api} answered ${res.status}\n`); return { ok: false, code: 1 }; }
  let body: { result?: ToolReply; error?: { message?: string } };
  try { body = (await res.json()) as typeof body; } catch { io.stderr("kl: the server answer was not JSON\n"); return { ok: false, code: 1 }; }
  if (body.error || !body.result) { io.stderr(`kl: ${body.error?.message ?? "no result"}\n`); return { ok: false, code: 1 }; }
  const structured = body.result.structuredContent ?? {};
  if (body.result.isError) { io.stderr(`kl: ${String(structured.error ?? "error")}\n`); return { ok: false, code: 1 }; }
  return { ok: true, structured };
}

/** Readable output for Frank's own viewing (`--as device`): never JSON, never for a model. */
function readable(call: ToolCall, s: Record<string, unknown>): string {
  if (call.name === "library_search") {
    const hits = (s.hits as { cite: string; title: string; status: string; path: string }[] | undefined) ?? [];
    const lines = hits.map((h) => `${h.cite}  ${h.status}  ${h.title}\n    ${h.path}`);
    return `${lines.join("\n")}${lines.length ? "\n" : ""}${hits.length} of ${String(s.total)} hit(s)\n`;
  }
  if (call.name === "library_read") return `${String(s.cite)}  ${String(s.status)}  ${String(s.title)}\n\n${String(s.text)}${s.truncated ? "\n[truncated]" : ""}\n`;
  return Object.entries(s).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n") + "\n";
}

export function helperCommand(args: readonly string[], platform: NodeJS.Platform = process.platform): string {
  if (!args.length || args.some((arg) => !arg || !isAbsolute(arg) || /[\r\n\0]/.test(arg))) throw new Error("invalid helper path");
  return args.map((arg) => {
    // cmd expands percent variables even inside quotes; delayed expansion may expand exclamation marks.
    if (platform === "win32" && /[%!\"]/.test(arg)) throw new Error("unsupported helper path");
    const plain = platform === "win32" ? /^[A-Za-z0-9_./:\\-]+$/ : /^[A-Za-z0-9_./:-]+$/;
    if (plain.test(arg)) return arg;
    return platform === "win32" ? `"${arg}"` : `'${arg.replaceAll("'", "'\\''")}'`;
  }).join(" ");
}

function mcpConfig(client: "claude" | "codex", url: string, command: string): string {
  const server = `${url.replace(/\/+$/, "")}/mcp`;
  if (client === "claude") return JSON.stringify({ mcpServers: { "knowledge-library": { type: "http", url: server, headersHelper: `${command} token print cc --json` } } }, null, 2) + "\n";
  return `[mcp_servers.knowledge-library]\nurl = ${JSON.stringify(server)}\nhttp_headers_helper = ${JSON.stringify(`${command} token print cx --json`)}\n`;
}

const USAGE = "usage: kl <version|owner-prepare <reviewed-config.json> --state <new-directory>|owner-enroll --state <directory>|owner-release --state <directory> --request <reviewed-release.json>|enroll-install <artifact.json> --trust <owner-pins.json> --root <folder> --state <new-state> --device <id> --api <origin>|push <registered-folder> [--into-repos] [--json]|sync <registered-folder> [--into-repos] [--json]|token print <cc|cx|device> --json [--store <absolute-dpapi-file>]|token store <cc|cx|device>|save <file>|handoff check <file>|handoff save <file> --thread <slug> --collection <id> --as <device|cc|cx> [--dry-run]|search --as <device|cc|cx> [--json] <q>|read --as <device|cc|cx> [--json] <cite>|status --as <device|cc|cx> [--json]|mcp-config <claude|codex> [--url <api>]>\n";

export async function main(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "owner-prepare": case "owner-enroll": case "owner-release": {
      const { ownerEnrollmentCommand } = await import("./archive/owner-enrollment.ts");
      return ownerEnrollmentCommand(cmd, rest, io);
    }
    case "enroll-install": {
      const { enrollmentInstallCommand } = await import("./archive/enrollment-command.ts");
      return enrollmentInstallCommand(rest, io);
    }
    case "push": case "sync": {
      const { archiveCommand } = await import("./archive/command.ts");
      return archiveCommand(cmd, rest, io, () => readToken(io, "device"), io.archiveContext);
    }
    case "version": case "--version": io.stdout(`kl ${KL_VERSION}\n`); return 0;
    case "token": {
      // kl token print cc --json  → {"Authorization":"Bearer klb_…"} on stdout (Claude Code headersHelper). The only token-printing path.
      if (rest[0] === "store" && KINDS.includes(rest[1] as TokenKind) && rest.length === 2) return tokenStore(io, rest[1] as TokenKind);
      if (rest[0] !== "print" || !KINDS.includes(rest[1] as TokenKind) || rest[2] !== "--json" ||
          !(rest.length === 3 || (rest.length === 5 && rest[3] === "--store" && isAbsolute(rest[4]!)))) {
        io.stderr("usage: kl token print <cc|cx|device> --json [--store <absolute-dpapi-file>] | kl token store <cc|cx|device>\n"); return 2;
      }
      const kind = rest[1] as TokenKind;
      const token = rest[3] === "--store" ? await readExactToken(io,kind,rest[4]!) : await readToken(io, kind);
      if (!token) { io.stderr(`kl: no ${kind} token (set ${ENV_NAME[kind]} or KL_TOKEN_FILE)\n`); return 1; }
      io.stdout(JSON.stringify({ Authorization: `Bearer ${token}` }) + "\n");
      return 0;
    }
    case "handoff": {
      const { handoffCommand } = await import("./handoff.ts");
      return handoffCommand(rest, io, (kind) => readToken(io, kind));
    }
    case "save": {
      const api = io.env.KL_API ?? "http://127.0.0.1:8787";
      const token = (await readToken(io, "device")) ?? (await readToken(io, "cc")) ?? (await readToken(io, "cx"));
      if (!token) { io.stderr("kl: no token\n"); return 1; }
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const file = rest[0]; if (!file) { io.stderr("usage: kl save <file> [--collection <id>] [--path <rel>]\n"); return 2; }
      const content = readFileSync(file, "utf8");
      const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
      const res = await io.fetch(`${api}/v1/save`, { method: "POST", headers, body: JSON.stringify({ content, path: opt("--path") ?? file, collection: opt("--collection") }) });
      io.stdout((await res.text()) + "\n"); return res.ok ? 0 : 1;
    }
    case "search": case "read": case "status": {
      const f = parseFlags(rest);
      if (!KINDS.includes(f.as as TokenKind)) { io.stderr(`kl ${cmd}: --as <device|cc|cx> is required\n`); return 2; }
      const kind = f.as as TokenKind;
      let call: ToolCall;
      if (cmd === "search") { const q = f.positional.join(" ").trim(); if (!q) { io.stderr("usage: kl search --as <device|cc|cx> [--json] <query>\n"); return 2; } call = { name: "library_search", args: { q } }; }
      else if (cmd === "read") { const ref = f.positional[0]; if (!ref || f.positional.length !== 1) { io.stderr("usage: kl read --as <device|cc|cx> [--json] <cite>\n"); return 2; } call = { name: "library_read", args: { ref } }; }
      else { if (f.positional.length) { io.stderr("usage: kl status --as <device|cc|cx> [--json]\n"); return 2; } call = { name: "library_status", args: {} }; }
      if (kind === "device") {
        // Frank's own viewing only: readable output on a terminal. Device-fetched text never goes to a vendor model (DESIGN §9.3).
        if (f.json) { io.stderr("kl: --json is not available with --as device; use --as cc or --as cx for a vendor-class read\n"); return 2; }
        if (io.isTTY !== true) { io.stderr("kl: --as device writes only to a terminal; stdout is not one\n"); return 2; }
      }
      const api = f.url ?? io.env.KL_API ?? "http://127.0.0.1:8787";
      const r = await callTool(io, kind, api, call);
      if (!r.ok) return r.code;
      io.stdout(f.json ? JSON.stringify(r.structured) + "\n" : readable(call, r.structured));
      return 0;
    }
    case "mcp-config": {
      const f = parseFlags(rest);
      const client = f.positional[0];
      if ((client !== "claude" && client !== "codex") || f.positional.length !== 1) { io.stderr("usage: kl mcp-config <claude|codex> [--url <api>]\n"); return 2; }
      const url = f.url ?? io.env.KL_API;
      if (!url) { io.stderr("kl mcp-config: no server URL (set KL_API or pass --url)\n"); return 2; }
      let command: string;
      try { command = helperCommand(io.klArgv ?? [io.klPath ?? ""]); }
      catch { io.stderr("kl mcp-config: the kl command path is unknown or cannot be quoted safely\n"); return 1; }
      io.stdout(mcpConfig(client, url, command));
      return 0;
    }
    default: io.stderr(USAGE); return 2;
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] && /kl\.ts$/.test(process.argv[1]);
if (isMain) {
  const script = resolve(process.argv[1]!);
  const stdin = () => new Promise<string>((res, rej) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => res(s)); process.stdin.on("error", rej); });
  main(process.argv.slice(2), { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env, fetch, stdin, platform: process.platform, isTTY: process.stdout.isTTY === true, klArgv: [process.execPath, script] }).then((code) => process.exit(code));
}
