// Search: keyword first, learned on top (DESIGN §4.2). Access control is applied in the SQL WHERE
// before ranking, counts and snippets. Learning is query-side (expansion + re-rank weights), so
// replay never needs a reindex.
import { sha256Hex } from "../primitives/sha256.ts";
import type { SqlDriver, SqlParam } from "./driver.ts";
import { aclPredicate, aclAllowsClass, aclAllowsClassSet, type AclContext } from "./acl.ts";
import type { RetrievalPlaybook } from "../understudy/baseline.ts";
import { versionCitation } from "../primitives/citation.ts";
import { existingFtsTables, ftsTableFor, collectionFtsTableFor } from "./search-index.ts";
import { splitClassSet } from "./privacy.ts";

export interface SearchScope { collection?: string; folder?: string; status?: string; kind?: string }
export interface SearchOptions { scope?: SearchScope; k?: number; asOf?: string; includeHistory?: boolean; /** server-set: the client grant, so returned hits are recorded as reads (S1c A4) */ grant?: string }

export interface SearchHit {
  cite: string; noteId: string; ver: number; title: string; status: string; kind: string; role: string; path: string;
  snip: string; why: string[]; freshness: { capturedAt: string; publishedAt: string; authoredAt: string | null; role: string; designated: null; lastVerifiedAt: string; liveness: "last-known"; lastPushAt: string };
  supersededBy: string | null; score: number; /** the hit's class set; used to record the hit as a read, never returned to callers */ privacyClass: string;
}
export interface SearchResult { hits: SearchHit[]; total: number; /** true when the candidate window saturated: total is a lower bound (S1c F) */ totalIsLowerBound: boolean; coverage: { indexed: number; preserved: number; pending: number }; expanded: string[] }
/** Candidate chunks taken from each FTS index by bm25 before the catalog joins (S1c F): the join and the re-rank touch at most this many rows per class. */
export const FTS_CANDIDATE_WINDOW = 400;

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;

export function tokenize(q: string): string[] {
  return (q.toLowerCase().match(TOKEN) ?? []).slice(0, 16);
}

/** Build the FTS5 MATCH expressions: each query term (plus playbook synonyms) is an OR-group; `all` requires every group (AND-first), `any` any group (the fallback). */
export function buildMatch(q: string, playbook: RetrievalPlaybook): { match: string; all: string; expanded: string[] } {
  const terms = tokenize(q);
  const expanded: string[] = [];
  const groups: string[] = [];
  const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
  const lowerQ = q.toLowerCase();
  const alts = new Map<string, Set<string>>();
  for (const t of terms) alts.set(t, new Set([t]));
  for (const [key, syns] of Object.entries(playbook.synonyms)) {
    const k = key.toLowerCase();
    const present = k.includes(" ") ? lowerQ.includes(k) : terms.includes(k);
    if (!present) continue;
    const anchor = k.includes(" ") ? (terms.find((t) => k.split(" ").includes(t)) ?? terms[0]) : k;
    if (!anchor) continue;
    for (const s of syns) { alts.get(anchor)?.add(s.toLowerCase()); expanded.push(s.toLowerCase()); }
  }
  for (const [, set] of alts) groups.push(set.size === 1 ? quote([...set][0]!) : `(${[...set].map(quote).join(" OR ")})`);
  return { match: groups.join(" OR "), all: groups.join(" AND "), expanded };
}

interface Row { noteId: string; ver: number; bm25: number; snip: string; title: string; kind: string; role: string; status: string; supersededBy: string | null; path: string; tags: string; capturedAt: string; publishedAt: string; lastVerifiedAt: string; authoredAt: string | null; lastPushAt: string; sha256: string; privacy_class: string; collectionId: string }

export function search(db: SqlDriver, acl: AclContext, q: string, opts: SearchOptions, playbook: RetrievalPlaybook, nowIso: string): SearchResult {
  const k = Math.min(Math.max(opts.k ?? 8, 1), 20);
  const { sql: aclSql, params: aclParams } = aclPredicate(acl);
  const { match, expanded } = buildMatch(q, playbook);
  const w = playbook.bm25Weights;
  const where: string[] = [aclSql, "n.status != 'withdrawn'", "v.custody = 'indexed'"];
  const params: SqlParam[] = [...aclParams];
  if (opts.asOf) { where.push("v.vstatus = 'current' AND v.ver = (SELECT max(v2.ver) FROM versions v2 WHERE v2.noteId = n.noteId AND v2.vstatus='current' AND v2.capturedAt <= ? AND v2.publishedAt <= ?)"); params.push(opts.asOf, opts.asOf); }
  else if (!opts.includeHistory) where.push("v.ver = n.currentVer");
  if (opts.scope?.collection) { where.push("n.collectionId = ?"); params.push(opts.scope.collection); }
  if (opts.scope?.folder) { where.push("n.folderId = ?"); params.push(opts.scope.folder); }
  if (opts.scope?.status) { where.push("n.status = ?"); params.push(opts.scope.status); }
  if (opts.scope?.kind) { where.push("n.kind = ?"); params.push(opts.scope.kind); }
  // One query per privacy class the caller may see, each over its own FTS index, so BM25 statistics never
  // include hidden notes. Results are merged, then re-ranked.
  // Every indexed class set whose members are all allowed is a candidate table; the ACL predicate inside each query
  // applies the precise clients_ok rule. Held versions carry class SETS (client:x+client:y), each in its own table.
  const tables = existingFtsTables(db);
  const classes = indexedClassSets(db).filter((c) => tables.has(ftsTableFor(c)) && splitClassSet(c).every((m) => acl.allowedClasses.includes(m)));
  const partitions = acl.collectionIds === undefined ? classes.map(cls => ({ cls, table: ftsTableFor(cls) })) :
    db.all<{ collectionId: string; class: string; clients_ok: string; decision_row: string | null }>("SELECT collectionId,class,clients_ok,decision_row FROM collections WHERE collectionId IN (SELECT value FROM json_each(?))", [JSON.stringify(acl.collectionIds)])
      .filter(col => aclAllowsClass(acl, col.class, JSON.parse(col.clients_ok), col.decision_row !== null))
      .flatMap(col => classes.filter(cls => splitClassSet(cls).every(member => member === col.class || aclAllowsClassSet(db, acl, member))).map(cls => ({ cls, table: collectionFtsTableFor(col.collectionId, cls) })).filter(p => tables.has(p.table)));
  let rows: Row[] = [];
  let total = 0; let totalIsLowerBound = false;
  if (match.length > 0) {
    // Query shape (S1c F): AND-first (every term group must match), falling back to OR when that yields fewer than k versions.
    // Each pass takes a bm25-ordered candidate window from the FTS index ALONE (no join), then joins only those chunk rowids
    // (passed as one JSON parameter, under the 100-bound-parameter limit), so cost is bounded by the window, not by the corpus.
    const pass = (expr: string) => {
      const out: Row[] = []; let n = 0; let saturated = false;
      for (const { cls, table: t } of partitions) {
        const cand = db.all<{ rowid: number; bm25: number; snip: string }>(`SELECT chunk_rowid AS rowid, bm25(${t}, ${w.title}, ${w.headings}, ${w.tags}, ${w.body}, ${w.path}) AS bm25, snippet(${t}, 3, '', '', '…', 12) AS snip FROM ${t} WHERE ${t} MATCH ? ORDER BY bm25 LIMIT ?`, [expr, FTS_CANDIDATE_WINDOW]);
        if (cand.length === 0) continue;
        if (cand.length >= FTS_CANDIDATE_WINDOW) saturated = true;
        const byRow = new Map(cand.map((c) => [c.rowid, c]));
        const joined = db.all<Omit<Row, "bm25" | "snip">>(`SELECT c.rowid AS rowid, c.noteId, c.ver, c.title, n.kind, v.role, n.status, n.supersededBy, COALESCE((SELECT pv.text FROM aliases a JOIN values_ pv ON pv.hash = a.path_h WHERE a.noteId = n.noteId AND a.valid_to IS NULL ORDER BY a.id DESC LIMIT 1), c.path) AS path, c.tags, v.capturedAt, v.publishedAt, v.lastVerifiedAt, v.authoredAt, (SELECT max(v3.publishedAt) FROM versions v3 WHERE v3.noteId = n.noteId) AS lastPushAt, v.sha256, v.privacy_class, n.collectionId FROM chunks c JOIN versions v ON v.noteId = c.noteId AND v.ver = c.ver JOIN notes n ON n.noteId = c.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE c.rowid IN (SELECT value FROM json_each(?)) AND c.privacy_class = ? AND ${where.join(" AND ")}`, [JSON.stringify([...byRow.keys()]), cls, ...params]);
        for (const j of joined) { const c = byRow.get((j as unknown as { rowid: number }).rowid)!; out.push({ ...j, bm25: c.bm25, snip: c.snip }); }
      }
      n = new Set(out.map((r) => `${r.noteId}@${r.ver}`)).size;
      return { out, n, saturated };
    };
    let r = buildMatch(q, playbook).all !== match ? pass(buildMatch(q, playbook).all) : pass(match);
    if (r.n < k && buildMatch(q, playbook).all !== match) r = pass(match);
    rows = r.out.sort((a, b) => a.bm25 - b.bm25);
    total = r.n; totalIsLowerBound = r.saturated;
  }
  // Collapse to best chunk per version, then linear re-rank with playbook weights.
  const best = new Map<string, Row>();
  for (const r of rows) { const key = `${r.noteId}@${r.ver}`; if (!best.has(key)) best.set(key, r); }
  const terms = tokenize(q);
  // Expanded terms are the learned query: they count toward title and tag matching too.
  const matchTerms = [...new Set([...terms, ...expanded.flatMap((e) => tokenize(e))])];
  const phrases = [terms.join(" "), ...expanded.filter((e) => e.includes(" "))].filter((p) => p.includes(" "));
  const now = Date.parse(nowIso);
  const rr = playbook.rerank;
  const scored = [...best.values()].map((r) => {
    const why: string[] = ["bm25"];
    let score = -r.bm25 * rr.bm25;
    const titleL = r.title.toLowerCase().replace(/[-_]+/g, " ");
    const titleTokens = tokenize(titleL);
    if (matchTerms.some((t) => titleTokens.some((tt) => termMatches(tt, t)))) { score += rr.title; why.push("title-match"); }
    if (phrases.some((p) => titleL.includes(p))) { score += rr.title; why.push("title-phrase"); }
    const tagL = r.tags.toLowerCase();
    if (matchTerms.some((t) => tagL.split(" ").includes(t))) { score += rr.tag; why.push("tag-match"); }
    const prior = rr.kindPrior[r.kind] ?? 0;
    if (prior !== 0) { score += prior; why.push("kind-prior"); }
    const ageDays = Math.max(0, (now - Date.parse(r.publishedAt)) / 86400000);
    const rec = rr.recency * Math.exp(-ageDays / 180);
    if (rec > 0.01) { score += rec; why.push("recent"); }
    if (r.status === "superseded") { score -= rr.superseded; why.push("superseded-demoted"); }
    if (expanded.length) why.push("synonym-expanded");
    return { r, score, why };
  }).sort((a, b) => b.score - a.score || a.r.noteId.localeCompare(b.r.noteId));
  const hits: SearchHit[] = scored.slice(0, k).map(({ r, score, why }) => ({
    cite: versionCitation(r.noteId, r.ver, r.sha256), noteId: r.noteId, ver: r.ver, title: r.title, status: r.status, kind: r.kind, role: r.role, path: r.path,
    snip: r.snip.slice(0, 160), why, supersededBy: r.supersededBy, score, privacyClass: r.privacy_class,
    freshness: { capturedAt: r.capturedAt, publishedAt: r.publishedAt, authoredAt: r.authoredAt, role: r.role, designated: null, lastVerifiedAt: r.lastVerifiedAt, liveness: "last-known", lastPushAt: r.lastPushAt },
  }));
  return { hits, total, totalIsLowerBound, coverage: coverage(db, acl), expanded };
}

/** Stem-tolerant term equality: equal, or a prefix relation on words of 4+ chars differing by at most 2 chars. */
export function termMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.startsWith(s) && l.length - s.length <= 2;
}

const classSetCache = new WeakMap<SqlDriver, { gen: number; sets: string[] }>();
/** Distinct privacy-class sets present in the projection, cached per ledger generation. */
export function indexedClassSets(db: SqlDriver): string[] {
  const gen = db.get<{ seq: number }>("SELECT max(seq) AS seq FROM events")?.seq ?? 0;
  const hit = classSetCache.get(db);
  if (hit && hit.gen === gen) return hit.sets;
  const sets = db.all<{ privacy_class: string }>("SELECT DISTINCT privacy_class FROM chunks").map((r) => r.privacy_class);
  classSetCache.set(db, { gen, sets });
  return sets;
}

const coverageCache = new WeakMap<SqlDriver, Map<string, { gen: number; cov: SearchResult["coverage"] }>>();
/** Coverage counts under the caller's ACL, cached per ledger generation (every write changes the head). */
export function coverage(db: SqlDriver, acl: AclContext): SearchResult["coverage"] {
  const { sql: aclSql, params: aclParams } = aclPredicate(acl);
  const gen = db.get<{ seq: number }>("SELECT max(seq) AS seq FROM events")?.seq ?? 0;
  const key = JSON.stringify([acl.status, acl.clientClass, [...acl.allowedClasses].sort(), acl.collectionIds === undefined ? null : [...acl.collectionIds].sort()]);
  let m = coverageCache.get(db); if (!m) { m = new Map(); coverageCache.set(db, m); }
  const hit = m.get(key);
  if (hit && hit.gen === gen) return hit.cov;
  const cov = db.get<{ indexed: number; preserved: number; pending: number }>(
    `SELECT sum(CASE WHEN v.custody='indexed' THEN 1 ELSE 0 END) AS indexed, count(*) AS preserved, sum(CASE WHEN v.custody IN ('received', 'verified') THEN 1 ELSE 0 END) AS pending FROM versions v JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE ${aclSql} AND v.ver = n.currentVer AND n.status != 'withdrawn'`, aclParams)!;
  const out = { indexed: cov.indexed ?? 0, preserved: cov.preserved ?? 0, pending: cov.pending ?? 0 };
  m.set(key, { gen, cov: out });
  return out;
}

export function queryHash(q: string): string { return sha256Hex(q.trim().toLowerCase()); }
