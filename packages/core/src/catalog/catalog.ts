// The Catalog façade: guard → BlobWriter → apply() → outbox. Every read authorizes through a
// currently accessible version, never through possession of a SHA. The server, never the caller, decides
// lineage, the request id, the grant and the destination.
import { admit, type AdmissionResult, type DenyRules, type ClientDecision } from "../admission/guard.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import { mintId, type RandomBytes } from "../primitives/ids.ts";
import { parseCitation, versionCitation, sliceLines, spanHash, formatCitation } from "../primitives/citation.ts";
import type { SqlDriver } from "./driver.ts";
import { migrate } from "./schema.ts";
import { BlobWriter, type ObjectStore } from "./blobs.ts";
import { apply, ApplyRefused, type ApplyDeps, type Clock } from "./apply.ts";
import type { Authority, Op, NoteKind } from "./ops.ts";
import { loadAcl, aclPredicate, aclAllowsClass, aclAllowsCollection, type Actor, type AclContext } from "./acl.ts";
import { noApprovalChannel, type ReceiptVerifier } from "./receipts.ts";
import { dispatchOutbox, outboxSummary, type DispatchOptions } from "./outbox.ts";
import { getValue, ledgerHead, verifyChain } from "./ledger.ts";
import { projectStoredCorrections, correctionCaseEligible, storedCorrection, correctionTarget, correctionAction, correctionEvidenceHash, isCurrentCorrection } from "./corrections.ts";
import type { ApprovalReceipt } from "./receipts.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { wrapUntrusted, responseNonce } from "../primitives/untrusted.ts";
import { search, queryHash, type SearchOptions, type SearchResult } from "./search.ts";
import { BASELINE_V0, type RetrievalPlaybook } from "../understudy/baseline.ts";
import { lineageCeiling, canonicalClassSet, splitClassSet } from "./privacy.ts";
import { verifiedEnrollment, type VerifiedEnrollment } from "../auth/enrollment.ts";
import { referenceProfile } from "../admission/reference-policy.ts";
export { isNarrowerClass, narrowestClass, classBreadth, isConfidentialClass, isComparableClass, canonicalClassSet, splitClassSet, lineageCeiling } from "./privacy.ts";

export interface CatalogDeps { db: SqlDriver; blobStore: ObjectStore; mirror: ObjectStore; clock?: Clock; random?: RandomBytes; receipts?: ReceiptVerifier; denyRules: DenyRules; correctionOwner?: string; moveEligibility?: (noteId: string, ver: number) => boolean }

/** Caller-supplied save fields. Everything else (requestId, grant, lineage, actor, capturedAt for MCP) is set by the server. */
export interface SaveInput {
  content: string | Uint8Array; path?: string; collection?: string; title?: string; kind?: NoteKind | string; tags?: string[]; supersedes?: string;
  baseVer?: number; derivedFrom?: string[]; idempotencyKey?: string;
  /** kl push only (kl-device): the folder identity and the device's observed times. */
  folderId?: string; capturedAt?: string; observedMtime?: string;
}
/** Server-side context for a save: the client grant (bearer token hash) and a correlation id. */
export interface SaveContext { grant?: string; requestId?: string; /** Internal push planner: always compute current admission before any twin shortcut. */ push?: true }

export interface PreparedSave { prepared: true; admitted: NonNullable<AdmissionResult["admitted"]>; requestId: string; reason?: string; op: Extract<Op, { kind: "version.create" }> }

export interface Freshness { capturedAt: string; publishedAt: string; authoredAt: string | null; role: string; designated: { noteId: string; ver: number; receiptId: string } | null; lastVerifiedAt: string; liveness: "last-known"; lastPushAt: string }

export type SaveResult =
  | { ok: true; cite: string; noteId: string; ver: number; sha256: string; deduped: boolean; collection: string; status: "current" | "sibling" | "proposed-edit" | "held"; custody: "verified" | "received" | "indexed"; requestId: string; reason?: string }
  | { ok: false; status: "rejected"; ruleCodes: string[]; requestId: string }
  | { ok: false; status: "refused"; reason: string; requestId: string };

export type ReadErrorCode = "not-found" | "version-not-found" | "withdrawn" | "not-indexed-yet" | "unavailable-storage" | "corrupt-object" | "conflict" | "unversioned-resolution";
export type ReadResult =
  | { ok: true; cite: string; noteId: string; ver: number; sha256: string; title: string; status: string; role: string; path: string; text: string; truncated: boolean; next?: string; freshness: Freshness; supersededBy: string | null; lines?: { from: number; to: number } }
  | { ok: false; error: ReadErrorCode; candidates?: { ver: number; capturedAt: string }[] };
export type FeedbackResult =
  | { ok: true; eventId: number; overrideId: string; overrideScope: "principal"; caseCreated: boolean; confirmed: false; signalId: string | null }
  | { ok: false; status: "rejected"; ruleCodes: string[] } | { ok: false; status: "refused"; reason: string };

const SYSTEM_ACTOR: Actor = { principal: "system", clientClass: "kl-device" };
const LINEAGE_WINDOW_MS = 2 * 3600 * 1000;

export class Catalog {
  readonly db: SqlDriver;
  readonly blobs: BlobWriter;
  readonly mirror: ObjectStore;
  readonly clock: Clock;
  readonly random: RandomBytes;
  readonly receipts: ReceiptVerifier;
  readonly denyRules: DenyRules;
  /** Trusted server configuration, never copied from a request/manifest. Absent means no confirmation. */
  readonly correctionOwner?: string;
  /** Trusted live evidence of no active focus run, open hold, or restore record. Missing evidence means proposal only. */
  readonly moveEligibility: (noteId: string, ver: number) => boolean;

  constructor(deps: CatalogDeps) {
    this.db = deps.db; this.blobs = new BlobWriter(deps.blobStore); this.mirror = deps.mirror;
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
    this.random = deps.random ?? ((n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; });
    this.receipts = deps.receipts ?? noApprovalChannel;
    this.denyRules = deps.denyRules; this.correctionOwner = deps.correctionOwner;
    this.moveEligibility = deps.moveEligibility ?? (() => false);
    migrate(this.db); // a new catalog starts sealed
  }

  private applyDeps(): ApplyDeps { return { db: this.db, clock: this.clock, random: this.random, receipts: this.receipts, correctionOwner: this.correctionOwner, moveEligibility: this.moveEligibility, admissionPolicy:this.denyRules }; }
  apply(actor: Actor, authority: Authority, op: Op) { return apply(this.applyDeps(), actor, authority, op); }
  private applySystem(op: Op) { return this.apply(SYSTEM_ACTOR, { kind: "system" }, op); }

  private correctionReadDeps() { return { db: this.db, receipts: this.receipts, now: this.clock.now(), ownerPrincipal: this.correctionOwner }; }

  /** Authenticated server context only. scopeId can narrow results, never authorize them. */
  corrections(actor: Actor, scopeId?: string) { return projectStoredCorrections(this.correctionReadDeps(), actor, scopeId); }

  renderCorrections(actor: Actor, scopeId?: string) {
    const view = this.corrections(actor, scopeId), nonce = responseNonce(this.random);
    const render = (rows: typeof view.live) => rows.map(row => ({ id: row.id, author: row.author,
      state: row.state, publication: row.publication, evidenceCite: row.evidenceCite,
      text: wrapUntrusted(JSON.stringify({ topic: row.topic, statement: row.statement }), row.evidenceCite, nonce) }));
    return { live: render(view.live), heldUnderNext: render(view.heldUnderNext), nonce };
  }

  /** Server-side approval-page input only; no new MCP confirmation tool or issuer exists. */
  correctionConfirmationRequest(actor: Actor, id: string) {
    const row = storedCorrection(this.db, id);
    const target = row ? correctionTarget(this.db, actor, row.targetNoteId, row.targetVer) : undefined;
    if (!row || !target || target.collectionId !== row.scopeId || target.sha256 !== row.targetSha256) throw new ApplyRefused("not-found");
    if (row.state !== "proposed" || !isCurrentCorrection(this.db, row)) throw new ApplyRefused("correction-stale");
    const op = correctionAction(row);
    return { op, actionHash: sha256Hex(canonicalJson(op)), evidenceHash: correctionEvidenceHash(row) };
  }

  confirmCorrection(actor: Actor, request: { correctionId: string; expectedSeq: number }, receipt: ApprovalReceipt | undefined) {
    return this.apply(actor, { kind: "receipt", receipt }, { kind: "correction.confirm", correctionId: request.correctionId, expectedSeq: request.expectedSeq });
  }

  revertCorrection(actor: Actor, request: { correctionId: string; expectedSeq: number }) {
    return this.apply(actor, { kind: "principal" }, { kind: "correction.revert", correctionId: request.correctionId, expectedSeq: request.expectedSeq });
  }

  /** Internal training gate; not exposed as a principal-visible count of other authors' proposals. */
  correctionCaseEligible(caseId: string) { return correctionCaseEligible(this.correctionReadDeps(), caseId); }

  /** Setup mode (explicit): principals and collections may be created; tokens need the bootstrap secret. Seals itself after the first owner token. */
  enableSetup(bootstrapSecret: string): void {
    if (this.db.get("SELECT 1 FROM meta WHERE key='setup_consumed' AND value='1'") ||
        this.db.get("SELECT 1 FROM meta WHERE key='enrollment_hash'") ||
        (!this.inSetupMode() && this.db.get("SELECT 1 FROM principals LIMIT 1"))) throw new ApplyRefused("setup-already-consumed");
    if (bootstrapSecret.length < 16) throw new Error("bootstrap secret too short");
    this.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('setup_secret_h', ?)", [sha256Hex(bootstrapSecret)]);
    this.db.run("UPDATE meta SET value = '1' WHERE key = 'setup_mode'");
  }
  sealSetup(): void { this.db.transaction(() => {
    this.db.run("UPDATE meta SET value = '0' WHERE key = 'setup_mode'"); this.db.run("DELETE FROM meta WHERE key = 'setup_secret_h'");
    this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('setup_consumed','1')");
  }); }
  inSetupMode(): boolean { return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key='setup_mode'")?.value === "1"; }

  /** Only a verified owner grant, matching the actually loaded admission policy, can initialize trust. */
  enroll(grant: VerifiedEnrollment) {
    const g = verifiedEnrollment(grant, this.clock.now()), profile = referenceProfile(this.denyRules);
    if (!profile?.ready || profile.policyHash !== g.claims.policy.policyHash || profile.epoch !== g.claims.policy.epoch)
      throw new ApplyRefused("enrollment-policy-unavailable");
    return this.apply({principal:g.claims.principal,clientClass:"kl-device"}, {kind:"enrollment"}, {kind:"enrollment.initialize",grant:g});
  }

  async acknowledgeEnrollment(authzSeq: number): Promise<void> {
    const row = this.db.get<{id:number;state:string}>("SELECT id,state FROM outbox WHERE step='enrollment.checkpoint' AND target=?", [String(authzSeq)]);
    if (!row || this.db.get<{value:string}>("SELECT value FROM meta WHERE key='enrollment_authz_seq'")?.value !== String(authzSeq))
      throw new ApplyRefused("enrollment-checkpoint-missing");
    if (row.state !== "done") await this.dispatchOutbox({only:row.id});
    if (this.db.get<{state:string}>("SELECT state FROM outbox WHERE id=?", [row.id])?.state !== "done" ||
        this.db.get<{value:string}>("SELECT value FROM meta WHERE key='enrollment_state'")?.value !== "active")
      throw new ApplyRefused("enrollment-checkpoint-pending");
  }

  acl(actor: Actor): AclContext { return loadAcl(this.db, actor); }

  decisions(): ClientDecision[] {
    return this.db.all<{ collectionId: string; class: string; store_ok: number; clients_ok: string; decision_row: string | null }>("SELECT * FROM collections WHERE class LIKE 'client:%'")
      .filter((c) => c.decision_row)
      .map((c) => ({ client: JSON.parse(c.decision_row!).client as string, store_ok: c.store_ok === 1, clients_ok: JSON.parse(c.clients_ok), collection: c.collectionId, class: c.class }));
  }

  /** Run the admission guard exactly as every write path does (content, path and extra fields). */
  guard(input: { content: string | Uint8Array; path?: string; requestedCollection?: string; requestId: string; saverInbox?: string; fields?: Record<string, string | string[] | undefined> }): AdmissionResult {
    return admit(this.denyRules, { ...input, decisions: this.decisions() });
  }

  collectionRow(id: string) { return this.db.get<{ collectionId: string; class: string; clients_ok: string; binary: number; decision_row: string | null }>("SELECT collectionId, class, clients_ok, binary, decision_row FROM collections WHERE collectionId = ?", [id]); }
  /** The write rule (DESIGN §9.4): class allowed; a confidential collection needs a decision row AND the client class in its own clients_ok. */
  canUseCollection(acl: AclContext, col: { collectionId: string; class: string; clients_ok: string; decision_row: string | null } | undefined): boolean { return !!col && aclAllowsCollection(acl, col.collectionId) && aclAllowsClass(acl, col.class, JSON.parse(col.clients_ok) as string[], col.decision_row !== null); }

  /** Resolve (noteId, ver) under the caller's ACL. Denied and missing are indistinguishable. */
  private resolve(acl: AclContext, noteId: string, ver: number | null) {
    const { sql, params } = aclPredicate(acl);
    const row = (v: number | null) => this.db.get<{ noteId: string; ver: number; sha256: string; status: string; supersededBy: string | null; title_h: string | null; capturedAt: string; publishedAt: string; lastVerifiedAt: string; custody: string; path_h: string | null; role: string; authoredAt: string | null; privacy_class: string; lastPushAt: string; collectionId: string }>(
      `SELECT v.noteId, v.ver, v.sha256, n.status, n.supersededBy, n.title_h, n.collectionId, v.capturedAt, v.publishedAt, v.lastVerifiedAt, v.custody, v.role, v.authoredAt, v.privacy_class, (SELECT max(v3.publishedAt) FROM versions v3 WHERE v3.noteId = n.noteId) AS lastPushAt, (SELECT a.path_h FROM aliases a WHERE a.noteId = n.noteId AND a.valid_to IS NULL ORDER BY a.id DESC LIMIT 1) AS path_h
       FROM versions v JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE v.noteId = ? AND ${v === null ? "v.ver = n.currentVer" : "v.ver = ?"} AND ${sql}`, v === null ? [noteId, ...params] : [noteId, v, ...params]);
    const exact = row(ver);
    if (exact) return { kind: "found" as const, row: exact };
    const anyVisible = this.db.get(`SELECT 1 FROM versions v JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE v.noteId = ? AND ${sql} LIMIT 1`, [noteId, ...params]);
    return anyVisible ? { kind: "version-not-found" as const } : { kind: "not-found" as const };
  }

  /** The note a (collection, path) names, if the caller can read its current version. When a hidden note holds the path, the caller's own shadow alias (S1c B2) names their note; aliasBlocked when there is none yet. */
  private resolvePath(acl: AclContext, actor: Actor, collectionId: string, path: string, folderId?: string): { noteId?: string; aliasBlocked: boolean } {
    const scope=folderId===undefined ? "" : " AND n.folderId = ?";
    const params=folderId===undefined ? [collectionId,path] : [collectionId,path,folderId];
    const matches=this.db.all<{noteId:string}>(`SELECT a.noteId FROM aliases a JOIN notes n ON n.noteId=a.noteId JOIN values_ pv ON pv.hash=a.path_h WHERE a.collectionId=? AND pv.text=? AND a.valid_to IS NULL AND a.owner IS NULL${scope}` ,params);
    // An unscoped legacy save must not arbitrarily choose between equally named folders.
    const visible=matches.filter(m=>this.resolve(acl,m.noteId,null).kind==="found");
    if(visible.length>1) throw new ApplyRefused("ambiguous-folder-path");
    const alias=visible[0] ?? matches[0];
    if (!alias) return { aliasBlocked: false };
    if (this.resolve(acl, alias.noteId, null).kind === "found") return { noteId: alias.noteId, aliasBlocked: false };
    const shadows = this.db.all<{ noteId: string }>(`SELECT a.noteId FROM aliases a JOIN notes n ON n.noteId=a.noteId JOIN values_ pv ON pv.hash=a.path_h WHERE a.collectionId=? AND pv.text=? AND a.valid_to IS NULL AND a.owner=?${scope}`, [collectionId,path,actor.principal,...(folderId===undefined?[]:[folderId])]).filter(s=>this.resolve(acl,s.noteId,null).kind==="found");
    if(shadows.length>1) throw new ApplyRefused("ambiguous-folder-path");
    return shadows[0] ? {noteId:shadows[0].noteId,aliasBlocked:true} : {aliasBlocked:true};
  }

  /** Classes read through this grant in the lineage window (DESIGN §3.3); search hits count as reads (S1c A4). */
  private recentReadClasses(actor: Actor, grant: string | undefined): string[] {
    if (!grant) return [];
    const since = new Date(Date.parse(this.clock.now()) - LINEAGE_WINDOW_MS).toISOString();
    return this.db.all<{ privacy_class: string }>("SELECT DISTINCT privacy_class FROM reads WHERE principal = ? AND grant_h = ? AND ts >= ?", [actor.principal, grant, since]).flatMap((r) => splitClassSet(r.privacy_class));
  }
  private isWithdrawn(noteId: string): boolean { const n = this.db.get<{ status: string }>("SELECT status FROM notes WHERE noteId = ?", [noteId]); return !!n && (n.status === "withdrawn" || n.status === "purge-pending"); }

  async prepareSave(actor: Actor, input: SaveInput, ctx: SaveContext = {}, maxBytes = 1 << 20): Promise<SaveResult | PreparedSave> {
    const requestId = ctx.requestId ?? mintId(this.random);
    const acl = this.acl(actor);
    if (acl.status !== "active") return { ok: false, status: "refused", reason: "principal-not-active", requestId };
    const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
    if (bytes.length > maxBytes) return { ok: false, status: "refused", reason: "content-too-large", requestId };
    const inbox = `inbox:${actor.principal}`;
    const collection = input.collection ?? inbox;
    const col = this.collectionRow(collection);
    if (!this.canUseCollection(acl, col)) return { ok: false, status: "refused", reason: "collection.not-allowed", requestId };
    // Scope request keys too: a grant cannot probe another collection by reusing
    // its owner's guessed key, nor collide with a legitimate sibling workflow.
    if (actor.collectionIds !== undefined && input.idempotencyKey) input = { ...input, idempotencyKey: `collection:${sha256Hex(canonicalJson([collection, input.idempotencyKey]))}` };
    const sha256 = sha256Hex(bytes);
    const title = input.title ?? titleFrom(input);

    // Revalidate detected content and metadata before a replay can return a citation or dedup can
    // durably bind a new idempotency key. The final pass below still applies current lineage/routing.
    // Every stored string is scanned: content, path and the fields (kl-device times and folder id included, S1c A7).
    const fields = { title, tags: input.tags, kind: input.kind, folderId: input.folderId, capturedAt: input.capturedAt, observedMtime: input.observedMtime };
    const pre = admit(this.denyRules, { requestId, content: bytes, path: input.path, requestedCollection: collection, decisions: this.decisions(), saverInbox: inbox, fields, lineage: { hold: false } });
    if (pre.outcome === "rejected" || !pre.admitted) {
      for (const h of pre.revokeTokenHashes) {
        try { const r = this.applySystem({ kind: "token.revoke", tokenHash: h, reason: "guard-hit" }); await this.acknowledge((r.result as { authzSeq: number }).authzSeq); } catch { /* best effort */ }
      }
      return { ok: false, status: "rejected", ruleCodes: pre.ruleCodes, requestId };
    }

    // Target note under the saver's ACL; a hidden note at the same path answers exactly like a brand-new note.
    let target: {noteId?:string;aliasBlocked:boolean};
    try { target=input.path ? this.resolvePath(acl,actor,collection,input.path,actor.clientClass==="kl-device"?input.folderId:undefined) : {aliasBlocked:false}; }
    catch(e) {if(e instanceof ApplyRefused) return {ok:false,status:"refused",reason:e.code,requestId}; throw e;}
    // Withdrawn stays withdrawn: checked before every dedup or replay short-circuit (S1c A6).
    if (target.noteId && this.isWithdrawn(target.noteId)) return { ok: false, status: "refused", reason: "withdrawn", requestId };
    // Idempotency and dedup run BEFORE any blob reservation. A replay is resolved under the caller's access (S1c A5).
    if (input.idempotencyKey) {
      const prior = this.db.get<{ noteId: string; ver: number; sha256: string }>("SELECT noteId, ver, sha256 FROM idempotency WHERE key_h = ? AND principal = ?", [sha256Hex(input.idempotencyKey), actor.principal]);
      if (prior && prior.sha256 !== sha256) return { ok: false, status: "refused", reason: "idempotency-key-conflict", requestId };
      if (prior) {
        if (this.isWithdrawn(prior.noteId)) return { ok: false, status: "refused", reason: "withdrawn", requestId };
        const r = this.resolve(acl, prior.noteId, prior.ver);
        if (r.kind !== "found") return { ok: false, status: "refused", reason: "held-for-review", requestId }; // never a cite the caller cannot read
        const v = this.db.get<{ vstatus: string; custody: string; held: number }>("SELECT vstatus, custody, held FROM versions WHERE noteId = ? AND ver = ?", [prior.noteId, prior.ver])!;
        return { ok: true, cite: versionCitation(prior.noteId, prior.ver, prior.sha256), noteId: prior.noteId, ver: prior.ver, sha256: prior.sha256, deduped: true, collection: r.row.collectionId, status: v.held ? "held" : (v.vstatus as "current"), custody: v.custody as "verified", requestId, reason: v.held ? "review" : undefined };
      }
    }
    if (target.noteId) {
      const n = this.db.get<{ currentVer: number }>("SELECT currentVer FROM notes WHERE noteId = ?", [target.noteId])!;
      if (input.baseVer !== undefined && !this.db.get("SELECT 1 FROM versions WHERE noteId = ? AND ver = ?", [target.noteId, input.baseVer])) return { ok: false, status: "refused", reason: "base-version-not-found", requestId };
      const parent = input.baseVer ?? n.currentVer;
      const twin = this.db.get<{ ver: number; vstatus: string; custody: string; held: number }>("SELECT ver, vstatus, custody, held FROM versions WHERE noteId = ? AND sha256 = ? AND (ver = ? OR parentVer IS ?) ORDER BY ver DESC LIMIT 1", [target.noteId, sha256, n.currentVer, parent]);
      // A pending proposal pushed back as the same bytes against the current version is promoted inside apply() (S1c B1), not short-circuited here.
      const promotes = twin && twin.vstatus === "proposed-edit" && input.baseVer === n.currentVer;
      if (twin && !promotes && !ctx.push) {
        if (input.idempotencyKey) { try { this.apply(actor, { kind: "system" }, { kind: "idempotency.bind", idempotencyKey: input.idempotencyKey, noteId: target.noteId, ver: twin.ver, sha256 }); } catch (e) { if (e instanceof ApplyRefused) return { ok: false, status: "refused", reason: e.code, requestId }; throw e; } }
        return { ok: true, cite: versionCitation(target.noteId, twin.ver, sha256), noteId: target.noteId, ver: twin.ver, sha256, deduped: true, collection, status: twin.held ? "held" : twin.vstatus as "current", custody: twin.custody as "verified", requestId, ...(twin.held ? {reason:"review"} : {}) };
      }
    }
    // Lineage: declared sources resolved under the saver's ACL; unresolvable means no lineage declared.
    const declared = input.derivedFrom ?? [];
    const declaredClasses: string[] = []; let declaredResolved = declared.length > 0;
    for (const d of declared) {
      const c = parseCitation(d); const r = c ? this.resolve(acl, c.noteId, c.ver) : null;
      if (!r || r.kind !== "found") { declaredResolved = false; break; }
      declaredClasses.push(r.row.privacy_class);
    }
    const readClasses = this.recentReadClasses(actor, ctx.grant);
    // supersedes: resolved under the saver's ACL; a hidden target answers exactly like a missing one.
    if (input.supersedes) { const c = parseCitation(input.supersedes); const id = c?.noteId ?? input.supersedes; if (this.resolve(acl, id, c?.ver ?? null).kind !== "found") return { ok: false, status: "refused", reason: "supersedes-not-found", requestId }; input = { ...input, supersedes: id }; }

    // Lineage is decided against the FINAL destination class, so a client-name reroute is known first: the guard is pure,
    // so a first pass (no lineage) learns the destination; the second pass applies the server's lineage decision.
    const finalDest = pre.destination?.collection ?? collection;
    const finalDestClass = this.collectionRow(finalDest)?.class ?? col!.class;
    let lineage: NonNullable<Parameters<typeof admit>[1]["lineage"]> = { hold: false };
    const readsNarrowing = lineageCeiling(readClasses, finalDestClass);
    const all = lineageCeiling([...(declaredResolved ? declaredClasses : []), ...readClasses], finalDestClass);
    if (readsNarrowing.hold && !declaredResolved) lineage = { hold: true, code: "lineage-uncertain", ceiling: readsNarrowing.ceiling };
    else if (all.hold) lineage = { hold: true, code: "lineage-narrower-source", ceiling: all.ceiling };
    // Sources BROADER than the destination (team) never hold, but they are recorded in the stored class set, so a
    // principal granted the destination without that source class cannot read the derivative (S2d item 0, A3).
    const broaderSources = all.broader;

    // 1. Admission guard before any durable write, over every stored string.
    const g = admit(this.denyRules, { requestId, content: bytes, path: input.path, requestedCollection: collection, decisions: this.decisions(), saverInbox: inbox, fields, lineage });
    for (const h of g.revokeTokenHashes) {
      try { const r = this.applySystem({ kind: "token.revoke", tokenHash: h, reason: "guard-hit" }); await this.acknowledge((r.result as { authzSeq: number }).authzSeq); } catch { /* best effort */ }
    }
    if (g.outcome === "rejected" || !g.admitted) return { ok: false, status: "rejected", ruleCodes: g.ruleCodes, requestId };
    // 2. Re-authorize the final destination: a client-name match may have rerouted the save.
    let dest = g.destination?.collection ?? collection;
    let held = g.outcome === "held";
    let reason: string | undefined = held ? g.ruleCodes.join(",") : undefined;
    const destRow = this.collectionRow(dest);
    // Admission may hold a save without a narrowing lineage hold (for example a multi-client match).
    // Broader source requirements still apply to that held copy.
    let privacyClass = canonicalClassSet([held ? (g.destination?.privacyClassCeiling ?? destRow?.class ?? col!.class) : (destRow?.class ?? col!.class), ...broaderSources]);
    if (!this.canUseCollection(acl, destRow)) {
      // A caller who cannot see the destination learns only "held: review" (DESIGN §3.3, S1c A8a); the copy keeps the destination's class in its ceiling.
      dest = inbox; held = true; reason = "review";
      privacyClass = canonicalClassSet([privacyClass, ...(destRow ? [destRow.class] : [])]);
    }
    const saveTarget = dest === collection ? target : { aliasBlocked: false };
    return { prepared: true, admitted: g.admitted, requestId, reason, op: {
        kind: "version.create", noteId: saveTarget.noteId, aliasBlocked: saveTarget.aliasBlocked, collectionId: dest, folderId: actor.clientClass === "kl-device" ? input.folderId : undefined, path: input.path, title, noteKind: (input.kind as NoteKind) ?? "note",
        privacyClass, role: "note", sha256, bytes: bytes.length, baseVer: input.baseVer, supersedes: input.supersedes, derivedFrom: declared,
        origin: `${actor.principal}@${actor.clientClass}`, capturedAt: actor.clientClass === "kl-device" && input.capturedAt ? input.capturedAt : this.clock.now(), observedMtime: actor.clientClass === "kl-device" ? input.observedMtime : undefined, idempotencyKey: input.idempotencyKey, held, pendingRefId: undefined,
    } };
  }

  async save(actor: Actor, input: SaveInput, ctx: SaveContext = {}): Promise<SaveResult> {
    const plan = await this.prepareSave(actor, input, ctx);
    if (!("prepared" in plan)) return plan;
    const { requestId, reason, op } = plan;
    const { sha256, collectionId: dest, held } = op;
    // 3. Fenced blob lifetime: pending reference, then put-if-absent with digest check; the reference is released on every outcome.
    const pendingRefId = `save:${requestId}`;
    try { this.applySystem({ kind: "blob.reserve", sha256, refId: pendingRefId }); }
    catch (e) { if (e instanceof ApplyRefused) return { ok: false, status: "refused", reason: e.code, requestId }; throw e; }
    let applied = false;
    try {
      await this.blobs.put(plan.admitted);
      // 4. One apply() transaction: event, projection, outbox (custody.verify first, then index, then mirror).
      const r = this.apply(actor, { kind: "principal" }, { ...op, pendingRefId });
      applied = true;
      const res = r.result as { noteId: string; ver: number; status: "current" | "sibling" | "proposed-edit"; deduped: boolean };
      // 5. The post-commit check runs now as the first outbox step for this version; custody: verified only if it passes.
      const custody = res.deduped ? (this.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ? AND ver = ?", [res.noteId, res.ver])?.custody ?? "received") : await this.verifyCustody(res.noteId, res.ver);
      return { ok: true, cite: versionCitation(res.noteId, res.ver, sha256), noteId: res.noteId, ver: res.ver, sha256, deduped: res.deduped, collection: dest,
        status: held ? "held" : res.status, custody: custody as "verified" | "received", requestId, reason: held ? reason : (res.status === "sibling" ? "base-version-mismatch" : res.status === "proposed-edit" ? "baseVer-required" : undefined) };
    } catch (e) {
      if (e instanceof ApplyRefused) return { ok: false, status: "refused", reason: e.code, requestId };
      throw e;
    } finally {
      if (!applied) { try { this.applySystem({ kind: "blob.release", sha256, refId: pendingRefId }); } catch { /* the row may not exist */ } }
    }
  }

  /** Run this version's custody.verify step now (the post-commit HEAD + SHA-256 check) and report the custody it reached. */
  async verifyCustody(noteId: string, ver: number): Promise<"received" | "verified" | "indexed"> {
    const row = this.db.get<{ id: number; state: string }>("SELECT id, state FROM outbox WHERE idempotencyKey = ?", [`custody:${noteId}@${ver}`]);
    if (row && row.state === "pending") await this.dispatchOutbox({ only: row.id });
    return (this.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ? AND ver = ?", [noteId, ver])?.custody ?? "received") as "received" | "verified" | "indexed";
  }

  async read(actor: Actor, ref: string, opts: { lines?: { from: number; to: number }; maxChars?: number; viaQueryId?: string; grant?: string } = {}): Promise<ReadResult> {
    const acl = this.acl(actor);
    const maxChars = Math.min(Math.max(opts.maxChars ?? 12000, 1), 200000);
    const cite = parseCitation(ref);
    let noteId: string, ver: number | null;
    if (cite) { noteId = cite.noteId; ver = cite.ver; }
    else if (/^[0-9A-HJKMNP-TV-Z]{10}$/.test(ref)) { noteId = ref; ver = null; }
    else if (ref.startsWith("vault:")) return { ok: false, error: "unversioned-resolution", candidates: [] };
    else return { ok: false, error: "not-found" };
    const r = this.resolve(acl, noteId, ver);
    if (r.kind !== "found") return { ok: false, error: r.kind };
    if (r.row.status === "withdrawn") return { ok: false, error: "withdrawn" };
    if (r.row.custody === "received") return { ok: false, error: "not-indexed-yet" }; // readable only after custody is verified
    const bytes = await this.blobs.get(r.row.sha256);
    if (!bytes) return { ok: false, error: "unavailable-storage" };
    if (sha256Hex(bytes) !== r.row.sha256) return { ok: false, error: "corrupt-object" };
    const full = new TextDecoder().decode(bytes);
    if (cite?.sha8 && !cite.lines && cite.sha8 !== r.row.sha256.slice(0, 8)) return { ok: false, error: "corrupt-object" };
    let text = full; const lines = cite?.lines ?? opts.lines;
    if (lines) { text = sliceLines(full, lines.from, lines.to); if (cite?.sha8 && cite.lines && spanHash(text) !== cite.sha8) return { ok: false, error: "corrupt-object" }; }
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    this.recordRead(actor, opts.grant, r.row.noteId, r.row.ver, r.row.privacy_class, opts.viaQueryId);
    return { ok: true, cite: versionCitation(r.row.noteId, r.row.ver, r.row.sha256), noteId: r.row.noteId, ver: r.row.ver, sha256: r.row.sha256, title: getValue(this.db, r.row.title_h) ?? r.row.noteId, status: r.row.status, role: r.row.role,
      path: getValue(this.db, r.row.path_h) ?? "", text, truncated, next: truncated ? formatCitation({ noteId: r.row.noteId, ver: r.row.ver, lines: { from: (lines?.from ?? 1) + text.split("\n").length, to: full.split("\n").length } }) : undefined,
      freshness: { capturedAt: r.row.capturedAt, publishedAt: r.row.publishedAt, authoredAt: r.row.authoredAt, role: r.row.role, designated: null, lastVerifiedAt: r.row.lastVerifiedAt, liveness: "last-known", lastPushAt: r.row.lastPushAt }, supersededBy: r.row.supersededBy && this.resolve(acl, r.row.supersededBy, null).kind === "found" ? r.row.supersededBy : null, lines };
  }

  private recordRead(actor: Actor, grant: string | undefined, noteId: string, ver: number, privacyClass: string, viaQueryId?: string): void {
    this.db.run("INSERT INTO reads(principal, grant_h, noteId, ver, privacy_class, viaQueryId, ts) VALUES (?,?,?,?,?,?,?)", [actor.principal, grant ?? null, noteId, ver, privacyClass, viaQueryId ?? null, this.clock.now()]);
  }

  /** Direct object read (/v1/version/<noteId>@<ver>/bytes): same ACL, custody gate and reads row as read(). */
  async readBytes(actor: Actor, noteId: string, ver: number, opts: { grant?: string } = {}): Promise<{ ok: true; bytes: Uint8Array; sha256: string } | { ok: false; error: ReadErrorCode }> {
    const r = this.resolve(this.acl(actor), noteId, ver);
    if (r.kind !== "found") return { ok: false, error: r.kind };
    if (r.row.status === "withdrawn") return { ok: false, error: "withdrawn" };
    if (r.row.custody === "received") return { ok: false, error: "not-indexed-yet" };
    const bytes = await this.blobs.get(r.row.sha256);
    if (!bytes) return { ok: false, error: "unavailable-storage" };
    if (sha256Hex(bytes) !== r.row.sha256) return { ok: false, error: "corrupt-object" };
    this.recordRead(actor, opts.grant, r.row.noteId, r.row.ver, r.row.privacy_class);
    return { ok: true, bytes, sha256: r.row.sha256 };
  }

  rename(actor: Actor, noteId: string, newPath: string) {
    const note = this.db.get<{ collectionId: string }>("SELECT collectionId FROM notes WHERE noteId = ?", [noteId]);
    if (!note) throw new ApplyRefused("not-found");
    if (this.resolve(this.acl(actor), noteId, null).kind !== "found") throw new ApplyRefused("not-found");
    // The new path is a stored string: it goes through the guard like every other one (S1c A9).
    const g = admit(this.denyRules, { requestId: mintId(this.random), content: "", path: newPath, decisions: [] });
    if (g.outcome !== "admitted") throw new ApplyRefused(`rejected:${g.ruleCodes.join(",")}`);
    return this.apply(actor, { kind: "principal" }, { kind: "alias.move", noteId, collectionId: note.collectionId, newPath });
  }

  championPlaybook(scopeId = "global", privacy = "team"): RetrievalPlaybook {
    const row = this.db.get<{ body: string }>("SELECT p.body FROM champions ch JOIN playbooks p ON p.hash = ch.playbookHash WHERE ch.capability = 'retrieval' AND ch.scopeId = ? AND ch.privacy = ? AND ch.revokedAt IS NULL ORDER BY ch.id DESC LIMIT 1", [scopeId, privacy]);
    return row ? (JSON.parse(row.body) as RetrievalPlaybook) : BASELINE_V0;
  }

  search(actor: Actor, q: string, opts: SearchOptions = {}, playbook?: RetrievalPlaybook): SearchResult & { queryId: string; generation: number } {
    const acl = this.acl(actor);
    // Global learned expansions may contain information from a sibling collection.
    const pb = playbook ?? (acl.collectionIds === undefined ? this.championPlaybook("global", acl.allowedClasses.includes("team") ? "team" : acl.allowedClasses[0] ?? "team") : BASELINE_V0);
    const result = search(this.db, acl, q, opts, pb, this.clock.now());
    for (const hit of result.hits) if (hit.supersededBy && this.resolve(acl, hit.supersededBy, null).kind !== "found") hit.supersededBy = null;
    const queryId = mintId(this.random);
    const generation = ledgerHead(this.db).seq;
    // Every returned hit discloses title, path and a snippet: each one is a read for this grant (S1c A4).
    for (const h of result.hits) this.recordRead(actor, opts.grant, h.noteId, h.ver, h.privacyClass, queryId);
    this.db.run("INSERT INTO query_log(queryId, principal, client, q_h, top, generation, ts, interactive) VALUES (?,?,?,?,?,?,?,?)", [queryId, actor.principal, actor.clientClass, queryHash(q), JSON.stringify(result.hits.slice(0, 10).map((h) => `${h.noteId}@${h.ver}`)), generation, this.clock.now(), actor.interactive === false ? 0 : 1]);
    return { ...result, queryId, generation };
  }

  async feedback(actor: Actor, input: { kind: "correct" | "missed" | "useful" | "pin" | "unpin"; target: string; topic?: string; detail: string; queryId?: string }): Promise<FeedbackResult> {
    const cite = parseCitation(input.target);
    const noteId = cite?.noteId ?? input.target;
    const target = this.resolve(this.acl(actor), noteId, cite?.ver ?? null);
    if (target.kind !== "found") return { ok: false, status: "refused", reason: "not-found" };
    // Feedback text is stored (values_), so it is scanned like any other stored string. No decision row applies: feedback
    // never lands in a client's collection, so ANY client match is rejected (S1c A9).
    const g = admit(this.denyRules, { requestId: mintId(this.random), content: "", fields: { topic: input.topic, detail: input.detail }, decisions: [] });
    for (const h of g.revokeTokenHashes) { try { const r = this.applySystem({ kind: "token.revoke", tokenHash: h, reason: "guard-hit" }); await this.acknowledge((r.result as { authzSeq: number }).authzSeq); } catch { /* best effort */ } }
    if (g.outcome === "rejected") return { ok: false, status: "rejected", ruleCodes: g.ruleCodes };
    try {
      const r = this.apply(actor, { kind: "principal" }, { kind: "feedback.record", feedbackKind: input.kind, targetNoteId: noteId, targetVer: target.row.ver, queryId: input.queryId, topic: input.topic, detail: input.detail, interactive: actor.interactive !== false }).result;
      return { ok: true, ...(r as Omit<Extract<FeedbackResult, { ok: true }>, "ok">) };
    } catch (e) { if (e instanceof ApplyRefused) return { ok: false, status: "refused", reason: e.code }; throw e; }
  }

  /** Audit rows carry ids and status only, never content (DESIGN §9.3). */
  audit(actor: Actor, tool: string, ids: string[], status: string, ms: number): void {
    this.db.run("INSERT INTO audit(ts, principal, client, tool, ids, status, ms) VALUES (?,?,?,?,?,?,?)", [this.clock.now(), actor.principal, actor.clientClass, tool, JSON.stringify(ids), status, Math.round(ms)]);
  }

  dispatchOutbox(opts?: DispatchOptions) { return dispatchOutbox({ db: this.db, blobs: this.blobs, mirror: this.mirror, now: () => this.clock.now(), applySystem: (op) => this.applySystem(op) }, opts); }
  /** Drain the outbox, ignoring backoff (tests and the weekly reconciler). */
  async drainOutbox(maxRounds = 20): Promise<void> { for (let i = 0; i < maxRounds && this.outbox().pending > 0; i++) { const r = await this.dispatchOutbox({ ignoreBackoff: true }); if (r.done === 0) break; } }

  /** A narrowing event or policy acceptance is acknowledged only after its authz/<seq>.json checkpoint is written. */
  async acknowledge(authzSeq: number): Promise<void> {
    const row = this.db.get<{ id: number; state: string }>("SELECT id, state FROM outbox WHERE idempotencyKey = ? AND step='authz.checkpoint' AND target=?", [`authz:${authzSeq}`, String(authzSeq)]);
    if (!Number.isSafeInteger(authzSeq) || authzSeq < 1 || !row) throw new Error('authz checkpoint missing; the operation is not acknowledged');
    if (row.state !== "done") {
      const r = await this.dispatchOutbox({ only: row.id });
      if (r.done !== 1) throw new Error(`authz checkpoint ${authzSeq} could not be written; the operation is not acknowledged`);
    }
    const ev = this.db.get<Record<string,unknown>>('SELECT * FROM authz_events WHERE seq=?',[authzSeq]);
    try {
      const actual = await this.mirror.get(`authz/${String(authzSeq).padStart(12,'0')}.json`);
      if (!ev || !actual || sha256Hex(actual) !== sha256Hex(canonicalJson({...ev,minPolicyEpoch:ev.epoch}))) throw Error();
    } catch { throw new Error('authz checkpoint readback failed; the operation is not acknowledged'); }
  }
  outbox() { return outboxSummary(this.db); }
  head() { return ledgerHead(this.db); }
  verifyChain() { return verifyChain(this.db); }
}

function titleFrom(input: SaveInput): string | undefined {
  if (input.title) return input.title;
  if (typeof input.content === "string") { const m = /^#\s+(.+)$/m.exec(input.content); if (m) return m[1]!.trim(); }
  if (input.path) return input.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  return undefined;
}
