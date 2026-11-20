import { Catalog } from "../catalog/catalog.ts";
import type { Actor } from "../catalog/acl.ts";
import { aclPredicate, aclAllowsClassSet } from "../catalog/acl.ts";
import { responseNonce, wrapUntrusted } from "../primitives/untrusted.ts";
import type { RandomBytes } from "../primitives/ids.ts";
import { TOOL_DEFINITIONS } from "./definitions.ts";
import { BASELINE_V0_HASH } from "../understudy/baseline.ts";
import { makeValidator } from "@kl/contracts/worker";
import { HARD_ALARM_ATTEMPTS } from "../catalog/outbox.ts";

export interface ToolContext { catalog: Catalog; actor: Actor; scopes: string[]; random: RandomBytes; grant?: string }
export interface ToolResult { isError: boolean; structured: Record<string, unknown>; text: string }

function fail(code: string, extra: Record<string, unknown> = {}): ToolResult { const structured = { error: code, ...extra }; return { isError: true, structured, text: JSON.stringify(structured) }; }
function ok(structured: Record<string, unknown>): ToolResult { return { isError: false, structured, text: JSON.stringify(structured) }; }

// Every tool's arguments are validated against its inputSchema (additionalProperties: false) before anything else.
const VALIDATORS = new Map(TOOL_DEFINITIONS.map((d) => [d.name, makeValidator(d.inputSchema)]));

export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const def = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!def) return fail("unknown-tool");
  if (!def.scope.some((s) => ctx.scopes.includes(s))) return fail("insufficient-scope");
  const v = VALIDATORS.get(name)!(args ?? {});
  if (!v.valid) return fail("invalid-args", { errors: v.errors });
  const nonce = responseNonce(ctx.random);
  const { catalog, actor } = ctx;
  // The global journal sequence is an activity counter for other collections.
  // Scoped clients receive no global generation; internal caches still use it.
  const generation = () => actor.collectionIds === undefined ? { generation: catalog.head().seq } : {};
  const wrap = (text: string, cite: string) => wrapUntrusted(text, cite, nonce);
  switch (name) {
    case "library_save": {
      const a = args as { content: string; path?: string; collection?: string; title?: string; kind?: string; tags?: string[]; supersedes?: string; baseVer?: number; derivedFrom?: string[]; idempotencyKey?: string };
      // Explicit allow-list: the server sets grant, requestId, lineage and capturedAt.
      const r = await catalog.save(actor, { content: a.content, path: a.path, collection: a.collection, title: a.title, kind: a.kind, tags: a.tags, supersedes: a.supersedes, baseVer: a.baseVer, derivedFrom: a.derivedFrom, idempotencyKey: a.idempotencyKey }, { grant: ctx.grant });
      if (!r.ok) return r.status === "rejected" ? fail("rejected", { ruleCodes: r.ruleCodes, requestId: r.requestId }) : fail("refused", { reason: r.reason, requestId: r.requestId });
      return ok({ cite: r.cite, noteId: r.noteId, ver: r.ver, sha256: r.sha256, deduped: r.deduped, collection: r.collection, status: r.status, reason: r.reason ?? null, custody: r.custody, requestId: r.requestId, ...generation(), completeness: "complete" });
    }
    case "library_search": {
      const a = args as { q: string; scope?: { collection?: string; folder?: string; status?: string; kind?: string }; k?: number; asOf?: string; includeHistory?: boolean };
      const r = catalog.search(actor, a.q, { scope: a.scope, k: a.k, asOf: a.asOf, includeHistory: a.includeHistory, grant: ctx.grant });
      return ok({ queryId: r.queryId, hits: r.hits.map((h) => ({ cite: h.cite, title: wrap(h.title, h.cite), status: h.status, kind: h.kind, role: h.role, path: wrap(h.path, h.cite), snip: wrap(h.snip, h.cite), why: h.why, freshness: h.freshness, supersededBy: h.supersededBy, focus: null })),
        total: r.total, totalIsLowerBound: r.totalIsLowerBound, coverage: r.coverage, ...generation(), completeness: r.total > r.hits.length || r.totalIsLowerBound ? "truncated" : "complete", nonce });
    }
    case "library_read": {
      const a = args as { ref: string; lines?: { from: number; to: number }; maxChars?: number; viaQueryId?: string };
      const r = await catalog.read(actor, a.ref, { lines: a.lines, maxChars: a.maxChars, viaQueryId: a.viaQueryId, grant: ctx.grant });
      if (!r.ok) return fail(r.error, r.candidates ? { candidates: r.candidates } : {});
      return ok({ cite: r.cite, sha256: r.sha256, title: wrap(r.title, r.cite), status: r.status, role: r.role, freshness: r.freshness, supersededBy: r.supersededBy, text: wrap(r.text, r.cite), truncated: r.truncated, next: r.next ?? null, focus: null, ...generation(), completeness: r.truncated ? "truncated" : "complete", nonce });
    }
    case "library_feedback": {
      const a = args as { kind: "correct" | "missed" | "useful" | "pin" | "unpin"; target: string; topic?: string; detail: string; queryId?: string };
      const r = await catalog.feedback(actor, { kind: a.kind, target: a.target, topic: a.topic, detail: a.detail, queryId: a.queryId });
      if (!r.ok) return r.status === "rejected" ? fail("rejected", { ruleCodes: r.ruleCodes }) : fail(r.reason);
      return ok({ ...(actor.collectionIds === undefined ? { eventId: r.eventId } : {}), overrideId: r.overrideId, overrideScope: "principal", caseCreated: r.caseCreated, confirmed: false, ...generation(), completeness: "complete" });
    }
    case "library_status": return ok({ ...status(catalog, actor, (args as { section?: string }).section), ...generation(), completeness: "complete" });
    default: return fail("unknown-tool");
  }
}

/** Per-principal status, filtered to the caller's visible classes. Count-only passdown (DESIGN §7.11); never titles or text. */
export function status(catalog: Catalog, actor: Actor, section?: string): Record<string, unknown> {
  const acl = catalog.acl(actor);
  const db = catalog.db;
  const search = catalog.search(actor, "", { k: 1 }); // empty query: coverage only, nothing matched
  const pred = aclPredicate(acl);
  // Learning rows are keyed by privacy class: only classes this client class may read count (clients_ok applies, S1c A8c).
  const cls = acl.allowedClasses.filter((c) => aclAllowsClassSet(db, acl, c));
  const classMarks = cls.length ? cls.map(() => "?").join(",") : "''";
  // A global learning scope may aggregate other collections; it is not a safe
  // substitute for an explicit token collection boundary.
  const visibleCollections = acl.collectionIds?.filter(id => catalog.canUseCollection(acl, catalog.collectionRow(id)));
  const learningScope = visibleCollections === undefined ? { sql: "1", params: [] as string[] } : {
    sql: "(scopeId IN (SELECT value FROM json_each(?)) OR scopeId IN (SELECT folderId FROM folders WHERE collectionId IN (SELECT value FROM json_each(?))))",
    params: [JSON.stringify(visibleCollections), JSON.stringify(visibleCollections)],
  };
  const learningCount = (table: "candidates" | "champions" | "cases", extra = "1") => count(`SELECT count(*) AS c FROM ${table} WHERE ${extra} AND privacy IN (${classMarks}) AND ${learningScope.sql}`, [...cls, ...learningScope.params]);
  const count = (sql: string, params: (string | number)[] = []) => db.get<{ c: number }>(sql, params)!.c;
  const sections: Record<string, () => unknown> = {
    coverage: () => ({ ...search.coverage, extracted: search.coverage.indexed, accessible: search.coverage.preserved, unsupported: 0, note: "preserved, extracted, indexed, accessible, unsupported and pending are reported separately and never merged" }),
    passdown: () => ({
      MOVED: { applied: 0, held: 0, marked: 0, promoted: 0 },
      BLOCKED: {
        // outbox rows whose version the caller can see and that have failed repeatedly (hard alarms); never other principals' notes
        custodyFailures: count(`SELECT count(DISTINCT v.noteId || '@' || v.ver) AS c FROM outbox o JOIN versions v ON o.target = v.noteId || '@' || v.ver JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE o.state = 'pending' AND o.attempts >= ? AND o.step IN ('custody.verify', 'index.version', 'mirror.meta') AND ${pred.sql}`, [HARD_ALARM_ATTEMPTS, ...pred.params as (string | number)[]]), // one per version, not per row
        // checkpoints and evidence publications are not per-note: a repeatedly failing one is everyone's alarm (S1c B5)
        checkpointFailures: acl.collectionIds === undefined ? count("SELECT count(*) AS c FROM outbox WHERE state = 'pending' AND attempts >= ? AND step IN ('authz.checkpoint', 'evidence.publish')", [HARD_ALARM_ATTEMPTS]) : 0,
        stormStops: 0, disputes: catalog.corrections(actor).disputedIds.length, coverageGaps: search.coverage.pending,
      },
      HIRING: "none",
      NEXT: { pendingApprovals: 0, unconfirmedOverrides: count(`SELECT count(*) AS c FROM overrides o WHERE o.principal = ? AND o.state = 'unconfirmed' AND EXISTS (SELECT 1 FROM notes n JOIN versions v ON v.noteId=n.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE (o.target=n.noteId OR o.target=v.noteId || '@' || v.ver) AND ${pred.sql})`, [actor.principal, ...pred.params as (string | number)[]]), heldSaves: 0,
        conflicts: count(`SELECT count(*) AS c FROM notes n JOIN collections col ON col.collectionId = n.collectionId JOIN versions v ON v.noteId = n.noteId AND v.ver = n.currentVer WHERE n.status = 'conflict' AND ${pred.sql}`, pred.params as (string | number)[]), newTeamSavesByAi: 0 },
      LEARNED: { saved: learningCount("candidates"), tested: learningCount("candidates", "verdict = 'tested'"),
        deployed: learningCount("champions", "frozenBaseline = 0 AND revokedAt IS NULL"), demonstrated: 0, splitConflict: learningCount("cases", "split = 'split-conflict'"), spend: "unknown" },
    }),
    ladder: () => ({ tag: "R0", link: "R0", dedupe: "R0", supersede: "R0", focus: "F0", lessons: "L0", streaks: Object.fromEntries(db.all<{ capability: string; streak: number }>(`SELECT capability, streak FROM ladder_state WHERE ${learningScope.sql}`, learningScope.params).map((r) => [r.capability, r.streak])), ratifications: 0, note: "rungs change only with a ratification receipt" }),
    budget: () => ({ lanes: { work: { monthlyUsd: 2, reservedUsd: 0, spentUsd: 0 }, learning: { monthlyUsd: 2, reservedUsd: 0, spentUsd: 0 } }, inFlight: 0, reconciledAgainstInvoice: "unknown", modelCallsThisMonth: 0 }),
    cycles: () => ({ weekly: { lastRun: null, nextScheduled: null }, focus: { activeGoals: 0, plans: 0 }, rehearsal: { lastRun: null, candidates: learningCount("candidates") }, baselineV0: BASELINE_V0_HASH }),
    approvals: () => ({ pending: 0, channel: "none: the passkey approval page is a later session; every consequential action is refused in S1" }),
  };
  if (section && sections[section]) return { section, [section]: sections[section]!() };
  return Object.fromEntries(Object.entries(sections).map(([k, f]) => [k, f()]));
}
