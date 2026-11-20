// kl handoff check | save (docs/sessions/AR1-handoff-notes.md): a session handoff note a fresh session reads instead of an old
// transcript. check is local (no token, no network) and never prints a matched value. Its credential and file-name rules are the
// production guard's own, built from the published reference (policy/deny.template.json) by publicReferenceRules. save checks
// first, then sends the note as kind "handoff" at handoffs/<thread>.md under exactly the one token kind named by --as; it
// succeeds only on a current version. No token is read until the note has passed and the request is real.
import { readFileSync } from "node:fs";
import { compileContentPattern, parseCitation, publicReferenceRules, sha256Hex, validCollectionIds, type PublicReferenceRules } from "@kl/core";
import type { Io, TokenKind } from "./kl.ts";

export const HANDOFF_SECTIONS = ["Goal", "Decisions", "State", "Open items", "File map", "Next step"] as const;
export const HANDOFF_MAX_BYTES = 32 * 1024;
const THREAD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS: readonly TokenKind[] = ["cc", "cx", "device"];
/** The placeholders of docs/reference/handoff-template.md and its instruction comment; a note still holding one is unfilled. */
const PLACEHOLDER = /<(?:project|thread|YYYY-MM-DD|old id|who|quote|decision|where recorded or kl: citation|fact|method|item|who\/what|path|what it is)>|Template for a session handoff note/;
const REFERENCE = new URL("../../../policy/deny.template.json", import.meta.url);

/** The guard's public rules from a reference file, or null when it cannot be read or compiled (check then fails closed). */
export function loadGuardRules(url: URL): PublicReferenceRules | null {
  try { return publicReferenceRules(JSON.parse(readFileSync(url, "utf8"))); } catch { return null; }
}
let reference: PublicReferenceRules | null | undefined;
function guardRules(): PublicReferenceRules | null {
  if (reference === undefined) reference = loadGuardRules(REFERENCE);
  return reference;
}
/** Whether the server's ledger rule refuses a library path, matched as the guard does under the reference profile. */
const isLedger = (rules: PublicReferenceRules, path: string) => {
  const p = path.normalize("NFC").toLowerCase();
  return rules.ledgers.some((l) => { const rule = l.replace(/\\/g, "/").normalize("NFC").toLowerCase(); return p === rule || p.endsWith("/" + rule); });
};

export interface HandoffProblem { code: string; line?: number }
export interface HandoffCheck { problems: HandoffProblem[]; title?: string; sections: number; citations: number; bytes: number }

/**
 * Check a handoff note's shape: an H1 title, every required H2 section non-empty, well-formed kl: citations, no unfilled template
 * placeholder outside code, within budget, and nothing the production guard's public rules would refuse: credential shapes
 * (scanned over the whole text, as the guard does, so a value continued onto the next line is caught) and student-record signals.
 * Fenced code follows CommonMark: its headings do not count. `rules` is the guard's public rules; null fails closed.
 */
export function checkHandoff(raw: string, path?: string, rules: PublicReferenceRules | null = guardRules()): HandoffCheck {
  const problems: HandoffProblem[] = [];
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > HANDOFF_MAX_BYTES) problems.push({ code: "size.over-budget" });
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split("\n");

  let title: string | undefined, section: string | undefined, fence: string | undefined, comment = false, citations = 0;
  const bodies = new Map<string, string>();
  /** What renders of a line outside fenced code: HTML comments (which may span lines) are removed; inline code cannot open one. */
  const rendered = (l: string) => {
    const masked = l.replace(/(`+).*?\1/g, (m) => "\0".repeat(m.length));
    let out = "", i = 0;
    while (i < l.length) {
      if (comment) { const end = l.indexOf("-->", i); if (end < 0) return out; comment = false; i = end + 3; continue; }
      const start = masked.indexOf("<!--", i);
      if (start < 0) return out + l.slice(i);
      out += l.slice(i, start); comment = true; i = start + 4;
    }
    return out;
  };
  lines.forEach((line, i) => {
    const l = line.replace(/\r$/, "");
    let code = fence !== undefined, v = l;
    if (fence === undefined) {
      v = rendered(l);
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(v);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) { fence = open[1]!; code = true; }
    } else if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(l)) fence = undefined;
    const h = code ? null : /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(v);
    if (h && h[1]!.length === 1) { title ??= h[2]!.trim() || undefined; section = undefined; }
    else if (h && h[1]!.length === 2) { section = h[2]!.trim().toLowerCase(); bodies.set(section, bodies.get(section) ?? ""); }
    else if (section !== undefined) bodies.set(section, bodies.get(section)! + (code ? l : v));
    for (const m of l.matchAll(/kl:[^\s<>()[\]{}"'`,;*|\u2013\u2014\u2026\u2018\u2019\u201C\u201D]+/g)) {
      if (parseCitation(m[0].replace(/[.:!?]+$/, ""))) citations++;
      else problems.push({ code: "citation.invalid", line: i + 1 });
    }
    if (!code && PLACEHOLDER.test(l.replace(/(`+).*?\1/g, ""))) problems.push({ code: "template.unfilled", line: i + 1 });
  });
  if (!title) problems.push({ code: "title.missing" });
  let sections = 0;
  for (const s of HANDOFF_SECTIONS) {
    const body = bodies.get(s.toLowerCase());
    if (body === undefined) problems.push({ code: `section.missing:${s}` });
    else if (!body.trim()) problems.push({ code: `section.empty:${s}` });
    else sections++;
  }

  if (!rules) problems.push({ code: "policy.unavailable" });
  else {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    const lineAt = (index: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
    const seen = new Set<string>();
    for (const { code, pattern } of rules.contentPatterns) {
      for (const [t, inText] of [[text, true], ...(path ? [[path, false]] : [])] as [string, boolean][]) {
        const re = compileContentPattern(pattern);
        let m: RegExpExecArray | null;
        while ((m = re.exec(t))) {
          const line = inText ? lineAt(m.index) : undefined;
          if (!seen.has(`${code}|${line}`)) { seen.add(`${code}|${line}`); problems.push({ code: `credential:${code}`, line }); }
          if (re.lastIndex === m.index) re.lastIndex++;
        }
      }
    }
    // The guard scans the path and every stored field too: content, path, title and kind. Past the budget the note is already
    // refused, and the reference's own input limit (16 MiB) would throw.
    if (bytes <= HANDOFF_MAX_BYTES) {
      const record = rules.recordSignals(path ?? "", [text, ...(path ? [path] : []), ...(title ? [title] : []), "handoff"]);
      if (record.content) problems.push({ code: "student.content" });
      if (record.path) problems.push({ code: "student.path" });
    }
  }
  return { problems, title, sections, citations, bytes };
}

const report = (io: Io, problems: HandoffProblem[]) => { for (const p of problems) io.stderr(`${p.code}${p.line ? ` line ${p.line}` : ""}\n`); };
const HANDOFF_USAGE = "usage: kl handoff check <file> | kl handoff save <file> --thread <slug> --collection <id> --as <device|cc|cx> [--dry-run]\n";
const VALUE_FLAGS: Record<string, "thread" | "collection" | "as"> = { "--thread": "thread", "--collection": "collection", "--as": "as" };

export async function handoffCommand(rest: string[], io: Io, readToken: (kind: TokenKind) => Promise<string | undefined>): Promise<number> {
  const [sub, ...args] = rest;
  const f: { thread?: string; collection?: string; as?: string; dryRun: boolean; positional: string[] } = { dryRun: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const key = VALUE_FLAGS[a];
    if (key) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) { io.stderr(`kl handoff: ${a} needs a value\n`); return 2; }
      if (f[key] !== undefined) { io.stderr(`kl handoff: ${a} given twice\n`); return 2; }
      f[key] = v; i++;
    } else if (a === "--dry-run") f.dryRun = true;
    else if (a.startsWith("--")) { io.stderr(HANDOFF_USAGE); return 2; }
    else f.positional.push(a);
  }
  const saveFlags = f.thread !== undefined || f.collection !== undefined || f.as !== undefined || f.dryRun;
  if ((sub !== "check" && sub !== "save") || f.positional.length !== 1 || (sub === "check" && saveFlags)) { io.stderr(HANDOFF_USAGE); return 2; }
  if (sub === "save") {
    if (f.thread === undefined || !THREAD.test(f.thread)) { io.stderr("kl handoff save: --thread must match ^[a-z0-9][a-z0-9-]{0,63}$\n"); return 2; }
    const rules = guardRules();
    if (rules && new RegExp(rules.badFile, "i").test(`${f.thread}.md`)) { io.stderr(`kl handoff save: --thread ${f.thread} gives a file name the server's basename rule refuses; choose another\n`); return 2; }
    if (rules && isLedger(rules, `handoffs/${f.thread}.md`)) { io.stderr(`kl handoff save: --thread ${f.thread} gives a path the server refuses as a client ledger; choose another\n`); return 2; }
    if (!KINDS.includes(f.as as TokenKind)) { io.stderr("kl handoff save: --as <device|cc|cx> is required\n"); return 2; }
    if (!f.collection) { io.stderr("kl handoff save: --collection <id> is required\n"); return 2; }
    if (!validCollectionIds([f.collection])) { io.stderr("kl handoff save: --collection is not a collection id\n"); return 2; }
  }
  let text: string;
  try { text = readFileSync(f.positional[0]!, "utf8"); } catch (e) { io.stderr(`kl handoff: cannot read the note: ${(e as NodeJS.ErrnoException).code ?? "error"}\n`); return 1; }
  const path = `handoffs/${f.thread}.md`;
  const c = checkHandoff(text, sub === "save" ? path : undefined);
  if (c.problems.length) { report(io, c.problems); return 1; }
  if (sub === "check") { io.stdout(`ok: ${c.sections} sections, ${c.citations} citation(s), ${c.bytes} bytes\n`); return 0; }

  if (f.dryRun) {
    io.stdout(`dry run: nothing sent\npath: ${path}\ncollection: ${f.collection}\nkind: handoff\ntitle: ${c.title}\nbytes: ${c.bytes}\nsha256: ${sha256Hex(text)}\n`);
    return 0;
  }
  const kind = f.as as TokenKind;
  const token = await readToken(kind);
  if (!token) { io.stderr(`kl: no ${kind} token\n`); return 1; }
  const api = io.env.KL_API ?? "http://127.0.0.1:8787";
  let res: Response;
  try {
    res = await io.fetch(`${api}/v1/save`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: text, path, collection: f.collection, kind: "handoff", title: c.title }) });
  } catch (e) { io.stderr(`kl: cannot reach ${api}: ${(e as Error).message}\n`); return 1; }
  if (res.status === 401) { io.stderr(`kl: unauthorized (the ${kind} token was refused)\n`); return 1; }
  let parsed: unknown;
  try { parsed = await res.json(); } catch { io.stderr(`kl handoff: ${api} answered ${res.status} without JSON\n`); return 1; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { io.stderr(`kl handoff: ${api} answered ${res.status} without a JSON object\n`); return 1; }
  const body = parsed as { ok?: boolean; status?: string; error?: string; cite?: string; custody?: string; reason?: string | null; ruleCodes?: string[] };
  if (body.ok === true && body.status === "current") { io.stdout(`saved ${body.cite} current custody=${body.custody}\n`); return 0; }
  const detail = [`status=${body.status ?? res.status}`, body.error ? `error=${body.error}` : "", body.reason ? `reason=${body.reason}` : "", body.ruleCodes?.length ? `rules=${body.ruleCodes.join(",")}` : "", body.cite ? `cite=${body.cite}` : ""].filter(Boolean).join(" ");
  io.stderr(`kl handoff: not saved as current (${detail})\n`);
  return 1;
}
