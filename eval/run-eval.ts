// Answer-accuracy eval: does an agent that asks the library a question receive the right, current,
// verifiable note? There is no language model on this path. Retrieval is BM25 plus a hand-weighted
// re-rank, so this measures retrieval and citation, not generated prose.
//
// It builds a synthetic archive from eval/golden-set.json through the library's own write path
// (Catalog.save, then the outbox), asks every question through the same tool dispatcher an MCP client
// reaches (callTool: library_search, library_read), and for two cases through real MCP JSON-RPC over
// the HTTP handler. Nothing in search, citation or read is mocked.
//
// `npm run eval` writes eval/RESULTS.md and eval/results.json. Same input, same output: the clock and
// random source are fixed, and no timing or timestamp goes into either file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Catalog, MemoryObjectStore, openNodeSqlite, seededRng, noApprovalChannel, callTool, parseCitation, formatCitation, spanHash, sliceLines, sha256Hex,
  mintToken, tokenScopes, tokenExpiry, clientClassFor, BASELINE_V0_HASH, type Actor, type Op,
} from "@kl/core";
import { createApiHandler } from "@kl/api";
import { generateFixtures } from "../fixtures/gen.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_PATH = join(HERE, "golden-set.json");
export const RESULTS_MD = join(HERE, "RESULTS.md");
export const RESULTS_JSON = join(HERE, "results.json");
const SETUP_SECRET = "synthetic-eval-bootstrap-secret";

// ---------- golden set shape ----------
export interface CorpusNote { key: string; collection: string; path: string; title: string; kind: string; tags?: string[]; body: string; history?: string[]; supersedes?: string; adversarial?: boolean }
export interface EvalCase {
  id: string; category: string; as: string; why: string; check: "answer" | "all" | "abstain" | "no-leak" | "read" | "wrapper" | "mcp-search" | "mcp-read";
  q?: string; accept?: string[]; requireAll?: string[]; maxRank?: number; mustOutrank?: string[]; forbid?: string[]; currentVersion?: boolean; supersededBy?: Record<string, string>;
  target?: string; targetVer?: number; mutate?: "flip-sha8" | "missing-version" | "line-span" | "line-span-wrong-hash"; lines?: [number, number]; expect?: string; knownGap?: string;
}
export interface GoldenSet { name: string; version: number; readers: { id: string; classes: string[] }[]; collections: { id: string; class: string }[]; corpus: CorpusNote[]; cases: EvalCase[] }

// ---------- results shape ----------
export interface HitRecord { rank: number; key: string; ver: number; supersededBy: string | null }
export interface CaseResult { id: string; category: string; as: string; q: string | null; why: string; pass: boolean; reason: string; knownGap: string | null; rank: number | null; hits: HitRecord[] }
export interface CategoryRow { category: string; cases: number; passed: number; hitAt1: string; hitAt5: string }
export interface EvalResults {
  golden: { name: string; version: number; sha256: string; notes: number; cases: number };
  baselineHash: string;
  metrics: {
    casesPassed: number; cases: number;
    rankedCases: number; hitAt1: number; hitAt5: number; mrr: number;
    citationsReturned: number; citationsValid: number; citationValidity: number;
    abstainCases: number; abstainCorrect: number; abstentionAccuracy: number;
    negativeControls: number; negativeControlsRefused: number;
    accessLeaks: number; stateChanges: number;
  };
  categories: CategoryRow[];
  cases: CaseResult[];
}

export function loadGolden(path = GOLDEN_PATH): { golden: GoldenSet; sha256: string } {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return { golden: JSON.parse(raw) as GoldenSet, sha256: sha256Hex(raw) };
}

// ---------- archive ----------
interface Saved { key: string; noteId: string; versions: { ver: number; sha256: string; body: string }[] }

export async function buildArchive(golden: GoldenSet) {
  const rng = seededRng(7);
  const t0 = Date.parse("2026-06-01T09:00:00.000Z"); let tick = 0;
  const clock = { now: () => new Date(t0 + 1000 * ++tick).toISOString() };
  const catalog = new Catalog({ db: openNodeSqlite(":memory:"), blobStore: new MemoryObjectStore(), mirror: new MemoryObjectStore(), clock, random: (n: number) => rng.bytes(n),
    denyRules: generateFixtures().denyRules, receipts: noApprovalChannel });
  catalog.enableSetup(SETUP_SECRET);
  const sys: Actor = { principal: "system", clientClass: "kl-device" };
  for (const r of golden.readers) {
    catalog.apply(sys, { kind: "setup" }, { kind: "principal.create", id: r.id, email: `${r.id}@example.invalid`, allowedClasses: r.classes });
    const own = r.classes.find((c) => c !== "team")!;
    catalog.apply(sys, { kind: "setup" }, { kind: "collection.create", collectionId: `inbox:${r.id}`, class: own });
  }
  for (const c of golden.collections) catalog.apply(sys, { kind: "setup" }, { kind: "collection.create", collectionId: c.id, class: c.class });
  // One read-only MCP bearer token for reader-a, issued while setup is open (the HTTP parity cases use it).
  const tokenRng = seededRng("eval-token");
  const { token, hash } = mintToken((n) => tokenRng.bytes(n));
  const op: Extract<Op, { kind: "token.issue" }> = { kind: "token.issue", tokenHash: hash, principal: "reader-a", tokenKind: "cc-bearer", scopes: tokenScopes("cc-bearer"), clientClass: clientClassFor("cc-bearer"), expiresAt: tokenExpiry("cc-bearer", clock.now()) };
  catalog.apply(sys, { kind: "setup", bootstrapSecret: SETUP_SECRET }, op);

  const classOf = new Map(golden.collections.map((c) => [c.id, c.class]));
  const owner = (note: CorpusNote): Actor => {
    const cls = classOf.get(note.collection)!;
    const r = golden.readers.find((x) => cls === "team" ? true : x.classes.includes(cls))!;
    return { principal: r.id, clientClass: "kl-device", interactive: true };
  };
  const saved = new Map<string, Saved>();
  for (const n of golden.corpus) {
    const actor = owner(n);
    const s: Saved = { key: n.key, noteId: "", versions: [] };
    for (const body of [...(n.history ?? []), n.body]) {
      const last = s.versions.at(-1);
      const r = await catalog.save(actor, { content: body, path: n.path, collection: n.collection, title: n.title, kind: n.kind, tags: n.tags, baseVer: last?.ver,
        supersedes: n.supersedes ? saved.get(n.supersedes)?.noteId : undefined }, { grant: `eval-${actor.principal}` });
      if (!r.ok) throw new Error(`corpus note ${n.key} was not admitted: ${JSON.stringify(r)}`);
      s.noteId = r.noteId; s.versions.push({ ver: r.ver, sha256: r.sha256, body });
    }
    saved.set(n.key, s);
  }
  await catalog.drainOutbox();
  const notIndexed = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody != 'indexed'")!.c;
  if (notIndexed) throw new Error(`${notIndexed} corpus version(s) were not indexed`);
  return { catalog, saved, token };
}

// ---------- helpers ----------
const WRAP_RE = /^<untrusted-note-([0-9a-f]{8}) cite="([^"]*)">([\s\S]*)<\/untrusted-note-\1>$/;
function unwrap(s: string): { nonce: string; text: string } | null {
  const m = WRAP_RE.exec(s);
  return m ? { nonce: m[1]!, text: m[3]!.replace(/untrusted&#45;note/gi, (x) => x.replace("&#45;", "-")) } : null;
}
const pct = (n: number, d: number) => (d === 0 ? "-" : `${n}/${d}`);
const ratio = (n: number, d: number) => (d === 0 ? 1 : Math.round((n / d) * 10000) / 10000);

type SearchHit = { cite: string; supersededBy: string | null };

// ---------- runner ----------
export async function runEval(goldenPath = GOLDEN_PATH): Promise<EvalResults> {
  const { golden, sha256 } = loadGolden(goldenPath);
  const { catalog, saved, token } = await buildArchive(golden);
  const keyOf = new Map([...saved.values()].map((s) => [s.noteId, s.key]));
  const noteOf = (key: string) => { const s = saved.get(key); if (!s) throw new Error(`unknown corpus key ${key}`); return s; };
  const collOf = new Map(golden.corpus.map((n) => [n.key, n.collection]));
  const classOf = new Map(golden.collections.map((c) => [c.id, c.class]));
  const readerClasses = new Map(golden.readers.map((r) => [r.id, r.classes]));
  const actorFor = (id: string): Actor => ({ principal: id, clientClass: "connector", interactive: true });
  const tool = (as: string, name: string, args: Record<string, unknown>) => callTool({ catalog, actor: actorFor(as), scopes: ["read"], random: catalog.random }, name, args);
  const api = createApiHandler({ catalog });
  const rpc = async (method: string, params: unknown) => (await (await api(new Request("http://kl.local/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }))).json()) as { result: { structuredContent: Record<string, unknown>; isError: boolean } };
  const before = stateCounts(catalog);

  let citationsReturned = 0, citationsValid = 0, accessLeaks = 0;
  const citationProblems: string[] = [];

  /** Independent ground truth for one returned citation: it parses, reads back, its hash matches, and the text is byte-for-byte the body saved for that version. */
  async function verifyCite(as: string, cite: string): Promise<string | null> {
    const c = parseCitation(cite);
    if (!c || !c.sha8) return "citation does not parse";
    const key = keyOf.get(c.noteId);
    if (!key) return "citation names a note that is not in the corpus";
    const v = noteOf(key).versions.find((x) => x.ver === c.ver);
    if (!v) return "citation names a version that was never saved";
    if (c.sha8 !== v.sha256.slice(0, 8)) return "citation hash is not the saved version's hash";
    const r = await tool(as, "library_read", { ref: cite });
    if (r.isError) return `read refused: ${String(r.structured.error)}`;
    const w = unwrap(String(r.structured.text));
    if (!w) return "read text is not wrapped once";
    if (r.structured.sha256 !== v.sha256 || sha256Hex(w.text) !== sha256Hex(v.body)) return "read text differs from the saved version";
    return null;
  }

  async function search(as: string, q: string, k = 10): Promise<{ hits: HitRecord[]; raw: SearchHit[]; structured: Record<string, unknown> }> {
    const r = await tool(as, "library_search", { q, k });
    if (r.isError) throw new Error(`search failed for ${q}: ${r.text}`);
    const raw = r.structured.hits as SearchHit[];
    const hits: HitRecord[] = [];
    for (const [i, h] of raw.entries()) {
      const c = parseCitation(h.cite);
      const key = c ? keyOf.get(c.noteId) ?? "?" : "?";
      hits.push({ rank: i + 1, key, ver: c?.ver ?? 0, supersededBy: h.supersededBy ? keyOf.get(h.supersededBy) ?? "?" : null });
      // Leak canary, from the golden set's own metadata, not from the library's ACL.
      const cls = classOf.get(collOf.get(key) ?? "") ?? "?";
      if (!readerClasses.get(as)!.includes(cls)) accessLeaks++;
      citationsReturned++;
      const problem = await verifyCite(as, h.cite);
      if (problem) citationProblems.push(`${q}: ${key}: ${problem}`); else citationsValid++;
    }
    return { hits, raw, structured: r.structured };
  }
  const rankOf = (hits: HitRecord[], keys: string[]) => { const r = hits.filter((h) => keys.includes(h.key)).map((h) => h.rank); return r.length ? Math.min(...r) : null; };
  const listTop = (hits: HitRecord[]) => hits.slice(0, 3).map((h) => h.key).join(", ") || "no hits";

  const cases: CaseResult[] = [];
  let negativeControls = 0, negativeControlsRefused = 0;
  for (const c of golden.cases) {
    const base = { id: c.id, category: c.category, as: c.as, q: c.q ?? null, why: c.why, knownGap: c.knownGap ?? null };
    let pass = false, reason = "", rank: number | null = null, hits: HitRecord[] = [];
    switch (c.check) {
      case "answer": {
        ({ hits } = await search(c.as, c.q!));
        rank = rankOf(hits, c.accept!);
        const max = c.maxRank ?? 1;
        const problems: string[] = [];
        if (rank === null) problems.push(`expected note not in the top ${hits.length}; got ${listTop(hits)}`);
        else if (rank > max) problems.push(`expected note at rank ${rank}, needed rank ${max}; above it: ${hits.slice(0, rank - 1).map((h) => h.key).join(", ")}`);
        for (const k of c.mustOutrank ?? []) { const r = rankOf(hits, [k]); if (r !== null && (rank === null || r < rank)) problems.push(`${k} ranks ${r}, above the expected note`); }
        if (c.currentVersion && rank !== null) { const h = hits[rank - 1]!; const cur = noteOf(h.key).versions.at(-1)!.ver; if (h.ver !== cur) problems.push(`cites version ${h.ver}, current is ${cur}`); }
        for (const [old, by] of Object.entries(c.supersededBy ?? {})) { const h = hits.find((x) => x.key === old); if (h && h.supersededBy !== by) problems.push(`${old} is returned with supersededBy=${h.supersededBy ?? "null"}, expected ${by}`); }
        pass = problems.length === 0; reason = problems.join("; ");
        break;
      }
      case "all": {
        ({ hits } = await search(c.as, c.q!));
        const max = c.maxRank ?? 5;
        const missing = c.requireAll!.filter((k) => { const r = rankOf(hits, [k]); return r === null || r > max; });
        rank = missing.length ? null : Math.max(...c.requireAll!.map((k) => rankOf(hits, [k])!));
        pass = missing.length === 0; reason = pass ? "" : `not in the top ${max}: ${missing.join(", ")}; top 3: ${listTop(hits)}`;
        break;
      }
      case "abstain": {
        ({ hits } = await search(c.as, c.q!));
        pass = hits.length === 0; reason = pass ? "" : `returned ${hits.length} hit(s) for a question with no answer; top 3: ${listTop(hits)}`;
        break;
      }
      case "no-leak": {
        ({ hits } = await search(c.as, c.q!));
        const leaked = hits.filter((h) => c.forbid!.includes(h.key));
        pass = leaked.length === 0; reason = pass ? "" : `returned forbidden note(s): ${leaked.map((h) => h.key).join(", ")}`;
        break;
      }
      case "read": {
        const s = noteOf(c.target!);
        const v = c.targetVer ? s.versions.find((x) => x.ver === c.targetVer)! : s.versions.at(-1)!;
        let ref = formatCitation({ noteId: s.noteId, ver: v.ver, sha8: v.sha256.slice(0, 8) });
        let span: string | null = null;
        if (c.mutate === "flip-sha8") ref = formatCitation({ noteId: s.noteId, ver: v.ver, sha8: flipHex(v.sha256.slice(0, 8)) });
        if (c.mutate === "missing-version") ref = formatCitation({ noteId: s.noteId, ver: v.ver + 5, sha8: v.sha256.slice(0, 8) });
        if (c.mutate === "line-span" || c.mutate === "line-span-wrong-hash") {
          const [from, to] = c.lines!; span = sliceLines(v.body, from, to);
          ref = formatCitation({ noteId: s.noteId, ver: v.ver, lines: { from, to }, sha8: c.mutate === "line-span" ? spanHash(span) : flipHex(spanHash(span)) });
        }
        const r = await tool(c.as, "library_read", { ref });
        const expect = c.expect!;
        if (expect.startsWith("error:")) {
          negativeControls++;
          const want = expect.slice(6);
          pass = r.isError && r.structured.error === want;
          if (pass) negativeControlsRefused++;
          reason = pass ? "" : r.isError ? `refused with ${String(r.structured.error)}, expected ${want}` : `read succeeded; expected refusal ${want}`;
        } else if (expect === "ok-span") {
          const w = r.isError ? null : unwrap(String(r.structured.text));
          pass = !!w && w.text === span; reason = pass ? "" : r.isError ? `refused: ${String(r.structured.error)}` : "returned text is not the cited lines";
        } else if (expect === "newer-signal") {
          const cur = s.versions.at(-1)!.ver;
          if (r.isError) { pass = false; reason = `refused: ${String(r.structured.error)}`; }
          else {
            const signals = r.structured.supersededBy !== null || r.structured.status !== "current" || /@(\d+)/.exec(String(r.structured.cite))?.[1] === String(cur);
            pass = signals;
            reason = pass ? "" : `read of version ${v.ver} returned status=${String(r.structured.status)}, supersededBy=null and nothing that says version ${cur} exists`;
          }
        }
        break;
      }
      case "wrapper": {
        const s = noteOf(c.target!); const v = s.versions.at(-1)!;
        const r = await tool(c.as, "library_read", { ref: formatCitation({ noteId: s.noteId, ver: v.ver, sha8: v.sha256.slice(0, 8) }) });
        const text = String(r.structured.text ?? ""); const nonce = String(r.structured.nonce ?? "");
        const opens = (text.match(/<untrusted-note-/g) ?? []).length, closes = (text.match(/<\/untrusted-note-/g) ?? []).length;
        const w = unwrap(text);
        pass = !r.isError && opens === 1 && closes === 1 && !!w && w.nonce === nonce && w.text === v.body;
        reason = pass ? "" : `wrapper broken: ${opens} opening and ${closes} closing tag(s)`;
        break;
      }
      case "mcp-search": {
        const direct = await search(c.as, c.q!);
        hits = direct.hits;
        const viaHttp = await rpc("tools/call", { name: "library_search", arguments: { q: c.q, k: 10 } });
        const norm = (s: Record<string, unknown>) => JSON.stringify((s.hits as unknown[]) ?? []).replaceAll(String(s.nonce), "NONCE");
        pass = !viaHttp.result.isError && norm(viaHttp.result.structuredContent) === norm(direct.structured) && viaHttp.result.structuredContent.total === direct.structured.total;
        reason = pass ? "" : "hits over MCP JSON-RPC differ from the direct tool call";
        break;
      }
      case "mcp-read": {
        const s = noteOf(c.target!); const v = s.versions.at(-1)!;
        const ref = formatCitation({ noteId: s.noteId, ver: v.ver, sha8: v.sha256.slice(0, 8) });
        const direct = await tool(c.as, "library_read", { ref });
        const viaHttp = await rpc("tools/call", { name: "library_read", arguments: { ref } });
        const pick = (x: Record<string, unknown>) => JSON.stringify({ cite: x.cite, sha256: x.sha256, status: x.status, text: String(x.text).replaceAll(String(x.nonce), "NONCE") });
        pass = !direct.isError && !viaHttp.result.isError && pick(viaHttp.result.structuredContent) === pick(direct.structured);
        reason = pass ? "" : "read over MCP JSON-RPC differs from the direct tool call";
        break;
      }
    }
    cases.push({ ...base, pass, reason, rank, hits: hits.slice(0, 5) });
  }

  const after = stateCounts(catalog);
  const stateChanges = Object.keys(before).filter((k) => before[k] !== after[k]).length;
  if (citationProblems.length) for (const p of citationProblems) console.error(`citation problem: ${p}`);

  // ---------- metrics ----------
  const ranked = cases.filter((r) => { const c = golden.cases.find((x) => x.id === r.id)!; return c.check === "answer"; });
  const rr = ranked.map((r) => (r.rank ? 1 / r.rank : 0));
  const abstain = cases.filter((r) => golden.cases.find((x) => x.id === r.id)!.check === "abstain");
  const categories: CategoryRow[] = [...new Set(golden.cases.map((c) => c.category))].map((category) => {
    const rows = cases.filter((r) => r.category === category);
    const rk = rows.filter((r) => golden.cases.find((x) => x.id === r.id)!.check === "answer");
    return { category, cases: rows.length, passed: rows.filter((r) => r.pass).length,
      hitAt1: pct(rk.filter((r) => r.rank === 1).length, rk.length), hitAt5: pct(rk.filter((r) => r.rank !== null && r.rank <= 5).length, rk.length) };
  });
  return {
    golden: { name: golden.name, version: golden.version, sha256, notes: golden.corpus.length, cases: golden.cases.length },
    baselineHash: BASELINE_V0_HASH,
    metrics: {
      casesPassed: cases.filter((c) => c.pass).length, cases: cases.length,
      rankedCases: ranked.length, hitAt1: ranked.filter((r) => r.rank === 1).length, hitAt5: ranked.filter((r) => r.rank !== null && r.rank <= 5).length,
      mrr: Math.round((rr.reduce((a, b) => a + b, 0) / Math.max(1, rr.length)) * 1000) / 1000,
      citationsReturned, citationsValid, citationValidity: ratio(citationsValid, citationsReturned),
      abstainCases: abstain.length, abstainCorrect: abstain.filter((r) => r.pass).length, abstentionAccuracy: ratio(abstain.filter((r) => r.pass).length, abstain.length),
      negativeControls, negativeControlsRefused, accessLeaks, stateChanges,
    },
    categories, cases,
  };
}

function flipHex(h: string): string { return h.split("").map((ch) => (parseInt(ch, 16) ^ 0xf).toString(16)).join(""); }
function stateCounts(catalog: Catalog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["overrides", "champions", "candidates", "cases", "edges"]) out[t] = catalog.db.get<{ c: number }>(`SELECT count(*) AS c FROM ${t}`)!.c;
  out.nonCurrentNotes = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM notes WHERE status != 'current'")!.c;
  return out;
}

// ---------- report ----------
export function renderMarkdown(r: EvalResults): string {
  const m = r.metrics;
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    "# Answer-accuracy eval results",
    "",
    "Generated by `npm run eval` from `eval/golden-set.json`. Do not edit by hand: `npm test` fails if this file does not match a fresh run.",
    "",
    `- Golden set: version ${r.golden.version}, ${r.golden.notes} synthetic notes, ${r.golden.cases} cases, sha256 \`${r.golden.sha256.slice(0, 16)}\``,
    `- Ranking: baseline v0 (BM25 plus a fixed re-rank), playbook hash \`${r.baselineHash.slice(0, 16)}\``,
    "- No language model is involved. This measures which notes and citations an agent receives, not text an agent writes.",
    "",
    "## Summary",
    "",
    "| Metric | Result |",
    "|---|---|",
    `| Cases passed | ${m.casesPassed}/${m.cases} |`,
    `| hit@1 (questions with one expected note) | ${m.hitAt1}/${m.rankedCases} |`,
    `| hit@5 | ${m.hitAt5}/${m.rankedCases} |`,
    `| MRR | ${m.mrr.toFixed(3)} |`,
    `| Citation validity (every returned citation re-read and compared to the saved text) | ${m.citationsValid}/${m.citationsReturned} |`,
    `| Bad citations refused (negative controls) | ${m.negativeControlsRefused}/${m.negativeControls} |`,
    `| Abstention accuracy (no hits when the archive has no answer) | ${m.abstainCorrect}/${m.abstainCases} |`,
    `| Notes returned to a reader who may not see them | ${m.accessLeaks} |`,
    `| Library state changed by the questions | ${m.stateChanges} |`,
    "",
    "## By category",
    "",
    "| Category | Cases | Passed | hit@1 | hit@5 |",
    "|---|---|---|---|---|",
    ...r.categories.map((c) => `| ${c.category} | ${c.cases} | ${c.passed} | ${c.hitAt1} | ${c.hitAt5} |`),
    "",
    "## Every case",
    "",
    "Known gap = a case that fails because of a real limitation in the library today. It stays in the set and is reported, not removed.",
    "",
    "| Case | Category | Question | Result | Rank | Why the case exists | Reason for failure |",
    "|---|---|---|---|---|---|---|",
    ...r.cases.map((c) => `| ${c.id} | ${c.category} | ${c.q ? esc(c.q) : "(read)"} | ${c.pass ? "pass" : c.knownGap ? "FAIL (known gap)" : "FAIL"} | ${c.rank ?? "-"} | ${esc(c.why)} | ${c.pass ? "" : esc(c.reason + (c.knownGap ? `. Cause: ${c.knownGap}` : ""))} |`),
    "",
  ];
  return lines.join("\n");
}

export function renderJson(r: EvalResults): string { return JSON.stringify(r, null, 2) + "\n"; }

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const started = performance.now();
  const r = await runEval();
  writeFileSync(RESULTS_MD, renderMarkdown(r));
  writeFileSync(RESULTS_JSON, renderJson(r));
  const m = r.metrics;
  console.log(`eval: ${m.casesPassed}/${m.cases} cases pass; hit@1 ${m.hitAt1}/${m.rankedCases}, hit@5 ${m.hitAt5}/${m.rankedCases}, citations ${m.citationsValid}/${m.citationsReturned}, abstention ${m.abstainCorrect}/${m.abstainCases}, leaks ${m.accessLeaks} (${Math.round(performance.now() - started)} ms)`);
  for (const c of r.cases.filter((x) => !x.pass)) console.log(`  FAIL ${c.id}${c.knownGap ? " (known gap)" : ""}: ${c.reason}`);
  console.log("wrote eval/RESULTS.md and eval/results.json");
}
