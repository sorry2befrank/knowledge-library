// Replay harness and grader (DESIGN §7.8). Champion and candidate run in the SAME invocation against the
// same ledger generation. Labels decide accuracy: only labelled held-out cases measure hits and misses.
// Live queries without labels measure RANK CHANGE, not accuracy, and are reported separately.
import type { Catalog } from "../catalog/catalog.ts";
import { aclPredicate, type Actor, type ClientClass } from "../catalog/acl.ts";
import type { SqlParam } from "../catalog/driver.ts";
import { splitClassSet } from "../catalog/privacy.ts";
import { getValue } from "../catalog/ledger.ts";
import { search, type SearchScope } from "../catalog/search.ts";
import { listCases, type CaseRow } from "./cases.ts";
import { RETRIEVAL_ALLOWLIST, type RetrievalPlaybook } from "./baseline.ts";
import { computeLineageKey, splitFor, type Split } from "./lineage.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import { playbookHash } from "./baseline.ts";
import { ApplyRefused } from "../catalog/apply.ts";

export interface GroupOutcome { groupKey: string; cases: number; championHit: boolean; candidateHit: boolean; championRank: number | null; candidateRank: number | null }
export interface GoldenQuery { q: string; principal: string; expectedNoteId: string; client?: ClientClass }

export interface ReplayReport {
  generation: number;
  /** Labelled held-out groups: receipt-confirmed cases and golden queries whose lineage group falls in the held-out split. */
  heldout: { groups: number; wins: number; losses: number; ties: number; discordant: number; championRecall10: number; candidateRecall10: number; championMrr: number; candidateMrr: number; signTestP: number; outcomes: GroupOutcome[]; labelSources: { confirmedCases: number; goldenQueries: number } };
  /** Unconfirmed observations (S4, MCP feedback, ...): may block a promotion, never count toward tested. */
  observations: { groups: number; wouldWin: number; wouldLose: number; note: "unconfirmed observations never count as labels" };
  priorHeldoutLooks: number;
  retention: { groups: number; championRecall3: number; candidateRecall3: number; withinOnePoint: boolean; insufficient: boolean };
  unlabelled: { queries: number; top10Changed: number; meanDisplacement: number; note: "rank change, not accuracy" };
  canaries: { partnerAclLeak: number; goldenLost: number; injectionEffects: number; regressions: number };
  g0: { ok: boolean; touched: string[]; violations: string[] };
  g2: { ok: boolean; targeted: number; fixed: number };
  /** Missing target labels and bounded-search truncation are unmeasured, never successful accuracy evidence. */
  measurement?: { complete: boolean; saturatedQueries: number; omittedGroups: number; missingTargetGroups: string[] };
  verdict: "tested" | "tested-insufficient" | "vetoed";
  heldoutLook: true;
}

const SYSTEM_RANDOM = (n: number) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
void SYSTEM_RANDOM;

function rankOf(hits: { noteId: string }[], noteId: string): number | null { const i = hits.findIndex((h) => h.noteId === noteId); return i < 0 ? null : i + 1; }

export function g0(champion: RetrievalPlaybook, candidate: RetrievalPlaybook): ReplayReport["g0"] {
  const touched: string[] = []; const violations: string[] = [];
  for (const k of new Set([...Object.keys(champion), ...Object.keys(candidate)])) {
    if (k === "version") continue; // consumes and capability are pinned: any change is a veto
    if (JSON.stringify((champion as unknown as Record<string, unknown>)[k]) !== JSON.stringify((candidate as unknown as Record<string, unknown>)[k])) {
      touched.push(k);
      if (!(RETRIEVAL_ALLOWLIST as readonly string[]).includes(k)) violations.push(`field ${k} is not allow-listed for retrieval`);
    }
  }
  if (Object.keys(candidate.synonyms).length > 50) violations.push("more than 50 synonym rules");
  for (const [k, v] of Object.entries(candidate.synonyms)) if (v.length > 5 || k.length > 40) violations.push(`synonym rule ${k} exceeds size limits`);
  if (candidate.retrievalMode !== "keyword") violations.push("retrievalMode is a challenger field, not switchable by a candidate");
  return { ok: violations.length === 0, touched, violations };
}

/** Two-sided sign test on wins vs losses (p = 0.5), a per-comparison diagnostic (DESIGN §7.8). */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses; if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let c = 1, tail = 0;
  for (let i = 0; i <= k; i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export interface LabelledPair { q: string; principal: string; client: ClientClass; expectedNoteId: string; title: string; groupKey: string; source: "confirmed-case" | "golden" }

interface ReplayKey { scopeId: string; privacy: string }
const CLIENTS = new Set<ClientClass>(["connector", "claude-code", "codex", "kl-device"]);
const actorFor = (principal: string, clientClass: ClientClass = "connector"): Actor => ({ principal, clientClass, interactive: false });
const classesFor = (privacy: string) => new Set(["team", ...splitClassSet(privacy)]);

/** A principal's broader access must never broaden the lesson's privacy key. */
function replayAcl(catalog: Catalog, actor: Actor, privacy: string) {
  const acl = catalog.acl(actor), allowed = classesFor(privacy);
  return { ...acl, allowedClasses: acl.allowedClasses.filter((c) => allowed.has(c)) };
}

function searchScope(scopeId: string): SearchScope {
  if (scopeId === "global") return {};
  return scopeId.startsWith("folder:") ? { folder: scopeId } : { collection: scopeId };
}

function scopePredicate(scopeId: string): { sql: string; params: SqlParam[] } {
  if (scopeId === "global") return { sql: "1", params: [] };
  return { sql: scopeId.startsWith("folder:") ? "n.folderId = ?" : "n.collectionId = ?", params: [scopeId] };
}

/** Check both the referenced version and the current oracle before using its title or query. */
function visibleOracle(catalog: Catalog, key: ReplayKey, actor: Actor, target: string, evidenceScope = "global", requireVersion = false) {
  const match = /^([0-9A-HJKMNP-TV-Z]{10})(?:@([1-9][0-9]*))?$/.exec(target);
  // A legacy unversioned observation cannot prove which version's privacy governed its query at capture time.
  if (!match || (requireVersion && !match[2])) return undefined;
  const acl = replayAcl(catalog, actor, key.privacy), access = aclPredicate(acl);
  const scope = scopePredicate(key.scopeId), origin = scopePredicate(evidenceScope);
  const read = (ver?: number) => catalog.db.get<{ noteId: string; ver: number; title: string; privacy_class: string }>(
    `SELECT n.noteId, v.ver, COALESCE(pv.text, '') AS title, v.privacy_class FROM notes n JOIN versions v ON v.noteId = n.noteId JOIN collections col ON col.collectionId = n.collectionId LEFT JOIN values_ pv ON pv.hash = n.title_h WHERE n.noteId = ? AND v.ver = ${ver === undefined ? "n.currentVer" : "?"} AND n.status NOT IN ('withdrawn', 'purge-pending') AND v.custody IN ('verified', 'indexed') AND ${access.sql} AND ${scope.sql} AND ${origin.sql}`,
    [match[1]!, ...(ver === undefined ? [] : [ver]), ...access.params, ...scope.params, ...origin.params]);
  const permitted = (row: ReturnType<typeof read>) => row && splitClassSet(row.privacy_class).length > 0 && splitClassSet(row.privacy_class).every((c) => acl.allowedClasses.includes(c));
  const current = read();
  if (!permitted(current)) return undefined;
  if (match[2] && !permitted(read(Number(match[2])))) return undefined;
  return current;
}

function casePair(catalog: Catalog, key: ReplayKey, c: CaseRow): LabelledPair | undefined {
  if (!splitClassSet(c.privacy).every((p) => classesFor(key.privacy).has(p))) return undefined;
  const row = catalog.db.get<{ client: ClientClass; inputRef: string; sourceSignals: string }>("SELECT client, inputRef, sourceSignals FROM cases WHERE caseId = ?", [c.caseId]);
  if (!row || !CLIENTS.has(row.client)) return undefined;
  let target = c.expectedNoteId, client = row.client;
  try {
    const ref = JSON.parse(row.inputRef) as { target?: unknown };
    if (typeof ref.target === "string") target = ref.target;
    const ids: unknown = JSON.parse(row.sourceSignals);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return undefined;
    // captureCases runs as the system device; use the originating signal's actual client instead of that capture identity.
    const clients = new Set<ClientClass>();
    for (const id of ids) {
      const signal = catalog.db.get<{ principal: string; client: ClientClass; target: string; scopeId: string }>("SELECT principal, client, target, scopeId FROM signals WHERE signalId = ? AND status != 'discarded'", [id]);
      if (!signal || signal.principal !== c.author || !CLIENTS.has(signal.client) || signal.target.split("@")[0] !== c.expectedNoteId
        || !visibleOracle(catalog, key, actorFor(c.author, signal.client), signal.target, signal.scopeId, true)) return undefined;
      clients.add(signal.client);
    }
    if (clients.size > 1) return undefined; // no single replay client can represent ambiguous mixed-client evidence
    if (clients.size === 1) client = [...clients][0]!;
  } catch { return undefined; }
  if (target.split("@")[0] !== c.expectedNoteId) return undefined;
  const oracle = visibleOracle(catalog, key, actorFor(c.author, client), target, c.scopeId, true);
  if (!oracle) return undefined;
  const q = getValue(catalog.db, c.q_h);
  return q ? { q, principal: c.author, client, expectedNoteId: oracle.noteId, title: oracle.title, groupKey: c.groupKey, source: "confirmed-case" } : undefined;
}

/** Labels (DESIGN §7.8): receipt-confirmed cases and golden queries, each in its oracle note's lineage group. */
export function labelledPairs(catalog: Catalog, privacy: string, goldens: GoldenQuery[], scopeId = "global", split?: Split): LabelledPair[] {
  const key = { scopeId, privacy };
  const out: LabelledPair[] = [];
  for (const c of listCases(catalog, { capability: "retrieval", ...(split ? { split } : {}) }).filter((c) => c.q_h && c.label === "miss" && (!split || splitFor(c.groupKey) === split))) {
    const confirmed = catalog.db.get("SELECT 1 FROM cases WHERE caseId = ? AND status = 'confirmed' AND receiptId IS NOT NULL", [c.caseId]);
    if (!confirmed) continue;
    // Corrections require fresh receipt/provenance, live author partition, ACL and dispute checks.
    if (catalog.db.get("SELECT 1 FROM corrections WHERE caseId=?", [c.caseId]) && !catalog.correctionCaseEligible(c.caseId)) continue;
    const pair = casePair(catalog, key, c); if (pair) out.push(pair);
  }
  // A champion for class P trains and is graded only on labels visible at class P (DESIGN §7.9 privacy).
  for (const g of goldens) {
    const groupKey = computeLineageKey(catalog.db, g.expectedNoteId.split("@")[0]!);
    if (split && splitFor(groupKey) !== split) continue; // before any query/title bytes are read
    const client = g.client ?? "connector";
    if (!CLIENTS.has(client)) continue;
    const oracle = visibleOracle(catalog, key, actorFor(g.principal, client), g.expectedNoteId);
    if (!oracle) continue;
    out.push({ ...g, client, expectedNoteId: oracle.noteId, title: oracle.title, groupKey, source: "golden" });
  }
  return out;
}

const SYS = { principal: "system", clientClass: "kl-device" as const };

/** How many replay queries (champion + candidate pairs count as two) fit one CPU-budgeted chunk, with headroom (S1c F): the scheduler chains chunks across alarms. */
export function replayChunkSize(perQueryMs: number, budgetMs = 5000, headroom = 0.8): number { return Math.max(1, Math.floor((budgetMs * headroom) / Math.max(perQueryMs, 0.001))); }

/** Every replay leaves a record (S1c C1): report hash, candidate playbook hash, generation; a held-out look is spent by the replay itself. */
function record(catalog: Catalog, report: ReplayReport, candidate: RetrievalPlaybook, key: { scopeId: string; privacy: string }, lookSpent: boolean): ReplayReport {
  catalog.apply(SYS, { kind: "system" }, { kind: "replay.record", capability: "retrieval", scopeId: key.scopeId, privacy: key.privacy, playbookHash: playbookHash(candidate), reportHash: sha256Hex(canonicalJson(report)), generation: report.generation, lookSpent });
  return report;
}

export function replay(catalog: Catalog, champion: RetrievalPlaybook, candidate: RetrievalPlaybook, opts: { targetGroups: string[]; privacy: string; goldenQueries?: GoldenQuery[]; partnerProbeQueries?: string[]; injectionQueries?: string[]; injectionNoteIds?: Set<string>; frankPrivateNoteIds?: string[]; scopeId?: string }): ReplayReport {
  const { db } = catalog;
  const generation = catalog.head().seq;
  const now = catalog.clock.now();
  const key = { scopeId: opts.scopeId ?? "global", privacy: opts.privacy };
  const priorHeldoutLooks = db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks WHERE capability = 'retrieval' AND scopeId = ? AND privacy = ?", [key.scopeId, key.privacy])!.c;
  // G0 is static: a candidate that touches a forbidden field is vetoed before any held-out group is read, and no look is spent.
  const g0r = g0(champion, candidate);
  if (!g0r.ok) {
    const empty = { groups: 0, wins: 0, losses: 0, ties: 0, discordant: 0, championRecall10: 0, candidateRecall10: 0, championMrr: 0, candidateMrr: 0, signTestP: 1, outcomes: [], labelSources: { confirmedCases: 0, goldenQueries: 0 } };
    return record(catalog, { generation, heldout: empty, observations: { groups: 0, wouldWin: 0, wouldLose: 0, note: "unconfirmed observations never count as labels" }, priorHeldoutLooks,
      retention: { groups: 0, championRecall3: 0, candidateRecall3: 0, withinOnePoint: true, insufficient: true }, unlabelled: { queries: 0, top10Changed: 0, meanDisplacement: 0, note: "rank change, not accuracy" },
      canaries: { partnerAclLeak: 0, goldenLost: 0, injectionEffects: 0, regressions: 0 }, g0: g0r, g2: { ok: true, targeted: 0, fixed: 0 }, verdict: "vetoed", heldoutLook: true }, candidate, key, false);
  }
  // The look budget is checked before held-out groups are read, and enforced again inside apply() when the look is recorded.
  const week = isoWeekOf(now);
  if (db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks WHERE capability = 'retrieval' AND scopeId = ? AND privacy = ? AND isoWeek = ?", [key.scopeId, key.privacy, week])!.c >= 2) throw new ApplyRefused("look-budget-exhausted", `2 held-out looks already spent for this key in ${week}`);
  let saturatedQueries = 0;
  const omittedGroups = new Set<string>();
  const run = (principal: string, q: string, pb: RetrievalPlaybook, client: ClientClass = "connector") => {
    const result = search(db, replayAcl(catalog, actorFor(principal, client), key.privacy), q, { k: 10, scope: searchScope(key.scopeId) }, pb, now);
    if (result.totalIsLowerBound) saturatedQueries++;
    return result;
  };
  // Explicit security canaries deliberately exercise the full consumer ACL, separate from lesson evidence.
  const canaryRun = (principal: string, q: string, pb: RetrievalPlaybook) => search(db, catalog.acl(actorFor(principal)), q, { k: 10 }, pb, now).hits;
  const labelled = labelledPairs(catalog, opts.privacy, opts.goldenQueries ?? [], key.scopeId);

  // G2: every targeted TRAIN group must be fixed by the candidate (labelled train pairs in those groups).
  const train = labelled.filter((p) => splitFor(p.groupKey) === "train" && opts.targetGroups.includes(p.groupKey));
  const requestedGroups = [...new Set(opts.targetGroups)];
  const trainGroups = new Map<string, { failed: boolean; incomplete: boolean }>();
  for (const p of train) {
    const result = run(p.principal, p.q, candidate, p.client);
    const state = trainGroups.get(p.groupKey) ?? { failed: false, incomplete: false };
    if (result.totalIsLowerBound) { state.incomplete = true; omittedGroups.add(p.groupKey); }
    else if (rankOf(result.hits, p.expectedNoteId) === null) state.failed = true;
    trainGroups.set(p.groupKey, state);
  }
  const fixed = [...trainGroups.values()].filter((s) => !s.failed && !s.incomplete).length;
  const missingTargetGroups = requestedGroups.filter((g) => !trainGroups.has(g));
  const measuredTrainFailure = [...trainGroups.values()].some((s) => s.failed);
  const g2 = { ok: fixed === requestedGroups.length, targeted: requestedGroups.length, fixed };

  // G3: labelled held-out groups, one win or loss per group.
  const compare = (pairs: { q: string; principal: string; client: ClientClass; expectedNoteId: string; groupKey: string }[]) => {
    const byGroup = new Map<string, typeof pairs>();
    for (const p of pairs) (byGroup.get(p.groupKey) ?? byGroup.set(p.groupKey, []).get(p.groupKey)!).push(p);
    const outcomes: GroupOutcome[] = [];
    let cR = 0, dR = 0, cM = 0, dM = 0;
    for (const [groupKey, ps] of byGroup) {
      let cHit = false, dHit = false, cRank: number | null = null, dRank: number | null = null;
      let incomplete = false;
      for (const p of ps) {
        const before = run(p.principal, p.q, champion, p.client), after = run(p.principal, p.q, candidate, p.client);
        if (before.totalIsLowerBound || after.totalIsLowerBound) { incomplete = true; continue; }
        const a = rankOf(before.hits, p.expectedNoteId), b = rankOf(after.hits, p.expectedNoteId);
        if (a !== null) { cHit = true; cRank = cRank === null ? a : Math.min(cRank, a); }
        if (b !== null) { dHit = true; dRank = dRank === null ? b : Math.min(dRank, b); }
      }
      if (incomplete) { omittedGroups.add(groupKey); continue; }
      outcomes.push({ groupKey, cases: ps.length, championHit: cHit, candidateHit: dHit, championRank: cRank, candidateRank: dRank });
      if (cHit) cR++; if (dHit) dR++; if (cRank) cM += 1 / cRank; if (dRank) dM += 1 / dRank;
    }
    return { outcomes, cR, dR, cM, dM, wins: outcomes.filter((o) => o.candidateHit && !o.championHit).length, losses: outcomes.filter((o) => !o.candidateHit && o.championHit).length };
  };
  const held = compare(labelled.filter((p) => splitFor(p.groupKey) === "heldout"));
  const { outcomes, cR, dR, cM, dM, wins, losses } = held;
  const n = outcomes.length || 1;
  // Unconfirmed observations in the held-out split: reported, never counted.
  const unconfirmed = listCases(catalog, { capability: "retrieval", split: "heldout" }).filter((c) => c.q_h && c.label === "miss" && !db.get("SELECT 1 FROM cases WHERE caseId = ? AND status = 'confirmed'", [c.caseId]));
  const obs = compare(unconfirmed.flatMap((c) => { const pair = casePair(catalog, key, c); return pair ? [pair] : []; }));
  // S0 retention: recall@3 on retention signals whose oracle note's lineage group is HELD-OUT (one entry per group), must
  // stay within 1 point; fewer than 30 held-out groups is tested-insufficient (DESIGN §7.8).
  const s0 = db.all<{ principal: string; client: ClientClass; scopeId: string; target: string; q_h: string | null }>("SELECT principal, client, scopeId, target, q_h FROM signals WHERE kind = 'S0' AND interactive = 1 AND status != 'discarded'");
  const s0Groups = new Map<string, { principal: string; client: ClientClass; q: string; id: string }>();
  for (const s of s0) {
    if (!CLIENTS.has(s.client)) continue;
    const oracle = visibleOracle(catalog, key, actorFor(s.principal, s.client), s.target, s.scopeId, true);
    if (!oracle) continue;
    const q = getValue(db, s.q_h); if (!q) continue;
    const id = oracle.noteId, g = computeLineageKey(db, id);
    if (splitFor(g) !== "heldout" || s0Groups.has(g)) continue;
    s0Groups.set(g, { principal: s.principal, client: s.client, q, id });
  }
  let s0c = 0, s0d = 0, s0n = 0, retentionIncomplete = false;
  for (const [groupKey, s] of s0Groups) {
    const before = run(s.principal, s.q, champion, s.client), after = run(s.principal, s.q, candidate, s.client);
    if (before.totalIsLowerBound || after.totalIsLowerBound) { retentionIncomplete = true; omittedGroups.add(groupKey); continue; }
    s0n++;
    const a = rankOf(before.hits, s.id), b = rankOf(after.hits, s.id);
    if (a !== null && a <= 3) s0c++; if (b !== null && b <= 3) s0d++;
  }
  const retention = { groups: s0n, championRecall3: s0n ? s0c / s0n : 0, candidateRecall3: s0n ? s0d / s0n : 0, withinOnePoint: s0n === 0 || s0d / s0n >= s0c / s0n - 0.01, insufficient: retentionIncomplete || s0n < 30 };

  // query_log does not persist the original search scope or privacy ceiling. Neither current ACL nor the returned
  // hits prove the query's scope. Omit these unknown-scope diagnostics until trusted context is recorded (S2).
  const unlabelled: ReplayReport["unlabelled"] = { queries: 0, top10Changed: 0, meanDisplacement: 0, note: "rank change, not accuracy" };

  // Canaries: partner ACL replay, golden set, injection.
  let leak = 0, goldenLost = 0, injectionEffects = 0;
  const frankPrivate = new Set(opts.frankPrivateNoteIds ?? db.all<{ noteId: string }>("SELECT noteId FROM notes WHERE privacy_class = 'frank-private'").map((r) => r.noteId));
  for (const q of opts.partnerProbeQueries ?? []) for (const h of canaryRun("partner", q, candidate)) if (frankPrivate.has(h.noteId)) leak++;
  for (const g of labelled.filter((p) => p.source === "golden")) {
    const before = run(g.principal, g.q, champion, g.client), after = run(g.principal, g.q, candidate, g.client);
    if (before.totalIsLowerBound || after.totalIsLowerBound) { omittedGroups.add(g.groupKey); continue; }
    if (rankOf(before.hits, g.expectedNoteId) !== null && rankOf(after.hits, g.expectedNoteId) === null) goldenLost++;
  }
  // Injection canary: replaying injection text as a query must change NOTHING that learning or authority reads
  // (overrides, signals, cases, champions, candidates, confirmed anything) and must not rank a known injection note into the
  // top 10 of any golden query. Each of these can fail.
  const snapshot = () => canonicalJson({
    overrides: db.get<{ c: number }>("SELECT count(*) AS c FROM overrides")!.c, signals: db.get<{ c: number }>("SELECT count(*) AS c FROM signals")!.c, cases: db.get<{ c: number }>("SELECT count(*) AS c FROM cases")!.c,
    champions: db.get<{ c: number }>("SELECT count(*) AS c FROM champions")!.c, candidates: db.get<{ c: number }>("SELECT count(*) AS c FROM candidates")!.c, confirmed: db.get<{ c: number }>("SELECT count(*) AS c FROM cases WHERE status = 'confirmed'")!.c + db.get<{ c: number }>("SELECT count(*) AS c FROM overrides WHERE state = 'confirmed'")!.c,
  });
  const before = snapshot();
  const injectionHits = new Set<string>();
  for (const q of opts.injectionQueries ?? []) for (const h of canaryRun("partner", q, candidate)) injectionHits.add(h.noteId);
  if (snapshot() !== before) injectionEffects++;
  const injectionNotes = opts.injectionNoteIds ?? new Set<string>();
  if (injectionNotes.size) for (const g of opts.goldenQueries ?? []) { if (canaryRun(g.principal, g.q, candidate).some((h) => injectionNotes.has(h.noteId))) injectionEffects++; }
  void injectionHits;
  const regressions = leak + goldenLost + injectionEffects + (retention.withinOnePoint ? 0 : 1);

  const discordant = wins + losses;
  const measurement = { complete: saturatedQueries === 0 && missingTargetGroups.length === 0, saturatedQueries, omittedGroups: omittedGroups.size, missingTargetGroups };
  let verdict: ReplayReport["verdict"] = "tested-insufficient";
  if (!g0r.ok || measuredTrainFailure || regressions > 0) verdict = "vetoed";
  else if (measurement.complete && g2.ok && discordant >= 5 && wins > losses && !retention.insufficient) verdict = "tested"; // incomplete search evidence or too few S0 groups keeps it insufficient
  return record(catalog, {
    generation,
    heldout: { groups: outcomes.length, wins, losses, ties: outcomes.length - discordant, discordant, championRecall10: cR / n, candidateRecall10: dR / n, championMrr: cM / n, candidateMrr: dM / n, signTestP: signTestP(wins, losses), outcomes,
      labelSources: { confirmedCases: labelled.filter((p) => p.source === "confirmed-case").length, goldenQueries: labelled.filter((p) => p.source === "golden").length } },
    observations: { groups: obs.outcomes.length, wouldWin: obs.wins, wouldLose: obs.losses, note: "unconfirmed observations never count as labels" },
    priorHeldoutLooks,
    retention, unlabelled, measurement,
    canaries: { partnerAclLeak: leak, goldenLost, injectionEffects, regressions }, g0: g0r, g2, verdict, heldoutLook: true,
  }, candidate, key, true);
}

function isoWeekOf(iso: string): string {
  const d = new Date(Date.parse(iso)); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
