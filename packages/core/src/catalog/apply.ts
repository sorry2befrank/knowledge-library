// apply(): the ONE write path for the catalog (DESIGN §2.1 principle 4). Policy gate, state check,
// CAS on the version and the undo record in one transaction; external effects go to the outbox.
// The mutating-SQL lint (scripts/lint-mutating-sql.ts) allows row mutation only in this file,
// ledger.ts (inside this transaction), outbox.ts (step completion) and search-index.ts (projection step).
import { sha256Hex } from "../primitives/sha256.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { versionCitation } from "../primitives/citation.ts";
import { mintNoteId } from "../primitives/base32.ts";
import { mintId, type RandomBytes } from "../primitives/ids.ts";
import type { SqlDriver } from "./driver.ts";
import { appendEvent, getValue, putValue } from "./ledger.ts";
import { loadAcl, aclPredicate, aclAllowsClass, aclAllowsCollection, type Actor } from "./acl.ts";
import type { PushManifest } from "./push.ts";
import type { ReceiptVerifier } from "./receipts.ts";
import { RECEIPT_ONLY, SETUP_OR_RECEIPT, SYSTEM_ONLY, type Authority, type Op, type PushDisposition } from "./ops.ts";
import { computeLineageKey, splitFor } from "../understudy/lineage.ts";
import { BASELINE_V0, BASELINE_V0_HASH } from "../understudy/baseline.ts";
import { constantTimeEqual, hasScope, SCOPE_FOR, validCollectionIds } from "../auth/tokens.ts";
import { splitClassSet } from "./privacy.ts";
import { correctionTarget, storedCorrection, isCurrentCorrection, correctionReceiptCheck, evidenceCitation, correctionRecordHash } from "./corrections.ts";
import { normalizeCorrectionTopic } from "../understudy/reference-corrections.ts";
import { verifiedEnrollment } from "../auth/enrollment.ts";
import { clientClassFor, tokenScopes } from "../auth/tokens.ts";
import { referenceProfile } from "../admission/reference-policy.ts";
import type { DenyRules } from "../admission/guard.ts";

export interface Clock { now(): string }
export interface ApplyDeps { db: SqlDriver; clock: Clock; random: RandomBytes; receipts: ReceiptVerifier; correctionOwner?: string; moveEligibility?: (noteId: string, ver: number) => boolean; admissionPolicy?: DenyRules }

export class ApplyRefused extends Error {
  readonly code: string;
  constructor(code: string, message?: string) { super(message ? `${code}: ${message}` : code); this.code = code; }
}
export interface ApplyResult { seq: number; hash: string; result: Record<string, unknown> }
export function opHash(op: Op): string { return sha256Hex(canonicalJson(op)); }

function meta(db: SqlDriver, key: string): string | undefined { return db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key])?.value; }
function setupMode(db: SqlDriver): boolean { return meta(db, "setup_mode") === "1"; }

export function policyGate(deps: ApplyDeps, actor: Actor, authority: Authority, op: Op): void {
  const { db } = deps;
  if (actor.collectionIds !== undefined) {
    const acl = loadAcl(db, actor), access = aclPredicate(acl);
    const visible = (noteId: string, ver?: number) => !!db.get(`SELECT 1 FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE v.noteId=? AND ${ver === undefined ? "v.ver=n.currentVer" : "v.ver=?"} AND ${access.sql}`, [noteId, ...(ver === undefined ? [] : [ver]), ...access.params]);
    if ((op.kind === "version.create" || op.kind === "alias.move") && !aclAllowsCollection(acl, op.collectionId)) throw new ApplyRefused("not-found");
    if (op.kind === "version.create") {
      if (op.noteId && !visible(op.noteId, op.baseVer)) throw new ApplyRefused("not-found");
      if (op.supersedes && !visible(op.supersedes)) throw new ApplyRefused("not-found");
      if (op.idempotencyKey) {
        const prior = db.get<{ noteId: string; ver: number }>("SELECT noteId,ver FROM idempotency WHERE key_h=? AND principal=?", [sha256Hex(op.idempotencyKey), actor.principal]);
        if (prior && !visible(prior.noteId, prior.ver)) throw new ApplyRefused("not-found");
      }
    }
    if (op.kind === "alias.move" && !visible(op.noteId)) throw new ApplyRefused("not-found");
    if ((op.kind === "feedback.record" || op.kind === "signal.record") && !visible(op.targetNoteId, op.targetVer)) throw new ApplyRefused("not-found");
  }
  if (op.kind === "enrollment.initialize") {
    if (authority.kind !== "enrollment") throw new ApplyRefused("enrollment-required");
    const grant = verifiedEnrollment(op.grant, deps.clock.now());
    const profile = deps.admissionPolicy && referenceProfile(deps.admissionPolicy);
    if (!profile?.ready || profile.policyHash !== grant.claims.policy.policyHash || profile.epoch !== grant.claims.policy.epoch)
      throw new ApplyRefused("enrollment-policy-unavailable");
    if (actor.principal !== grant.claims.principal || actor.clientClass !== "kl-device") throw new ApplyRefused("enrollment-scope-mismatch");
    return;
  }
  if (op.kind === "enrollment.activate") {
    if (authority.kind !== "system") throw new ApplyRefused("system-only");
    return;
  }
  if (op.kind === "correction.confirm" || op.kind === "correction.revert") {
    if (!db.get("SELECT 1 FROM principals WHERE id=? AND status='active'", [actor.principal])) throw new ApplyRefused("principal-not-active");
    if (op.kind === "correction.confirm" && authority.kind !== "receipt") throw new ApplyRefused("receipt-required");
    if (op.kind === "correction.revert" && authority.kind !== "principal") throw new ApplyRefused("principal-required");
    return; // Exact current event, ACL, evidence and receipt consumption checked in the transaction below.
  }
  if (RECEIPT_ONLY.has(op.kind)) {
    if (authority.kind !== "receipt") throw new ApplyRefused("receipt-required", `${op.kind} needs an owner approval receipt`);
    const check = deps.receipts.verify(authority.receipt, { actionKind: op.kind, actionHash: opHash(op) });
    if (!check.ok) throw new ApplyRefused(`receipt-refused:${check.reason}`, `${op.kind} refused: ${check.reason}`);
    return;
  }
  if (SETUP_OR_RECEIPT.has(op.kind)) {
    if (authority.kind === "setup" && setupMode(db)) {
      if (op.kind === "token.issue") {
        // Token minting in setup mode needs the bootstrap secret, compared in constant time.
        const want = meta(db, "setup_secret_h");
        if (!want || !authority.bootstrapSecret || !constantTimeEqual(sha256Hex(authority.bootstrapSecret), want)) throw new ApplyRefused("bootstrap-secret-required");
      }
      return;
    }
    if (authority.kind === "receipt") {
      const check = deps.receipts.verify(authority.receipt, { actionKind: op.kind, actionHash: opHash(op) });
      if (!check.ok) throw new ApplyRefused(`receipt-refused:${check.reason}`);
      return;
    }
    throw new ApplyRefused("receipt-required", `${op.kind} needs setup mode or an owner approval receipt`);
  }
  if (SYSTEM_ONLY.has(op.kind)) {
    if (authority.kind !== "system" && authority.kind !== "setup") throw new ApplyRefused("system-only", `${op.kind} is not callable by a principal`);
    return;
  }
  // principal ops (version.create, alias.move, feedback.record, signal.record): the principal must be active NOW.
  if (authority.kind === "principal") {
    const p = db.get<{ status: string }>("SELECT status FROM principals WHERE id = ?", [actor.principal]);
    if (!p || p.status !== "active") throw new ApplyRefused("principal-not-active");
  }
}

export function isoWeek(iso: string): string {
  const d = new Date(Date.parse(iso)); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Emit = (kind: string, payload: Record<string, unknown>, inverse: Record<string, unknown>) => { seq: number; hash: string };
type Enqueue = (opId: string, step: string, target: string, idempotencyKey: string) => unknown;

/** The one case constructor, shared by feedback.record and case.create (DESIGN §7.4 shape). */
function insertCase(db: SqlDriver, ts: string, c: { caseId: string; capability: string; scopeId: string; privacy: string; groupKey: string; lineageKey: string; inputRef: string; frozenFeatures: Record<string, unknown>; expected: { noteId: string; label: string }; sourceSignals: string[]; author: string; client: string }): void {
  db.run("INSERT OR IGNORE INTO cases(caseId, capability, scopeId, privacy, groupKey, lineageKey, inputRef, frozenFeatures, expected, split, sourceSignals, author, client, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [c.caseId, c.capability, c.scopeId, c.privacy, c.groupKey, c.lineageKey, c.inputRef, canonicalJson(c.frozenFeatures), canonicalJson(c.expected), splitFor(c.groupKey), JSON.stringify(c.sourceSignals), c.author, c.client, "unconfirmed", ts]);
}

/** Scope ancestors, most specific first: folder → its collection → global; collection → global. */
function scopeAncestors(db: SqlDriver, scopeId: string): string[] {
  if (scopeId === "global") return [];
  if (scopeId.startsWith("folder:")) { const col = db.get<{ collectionId: string }>("SELECT collectionId FROM folders WHERE folderId = ?", [scopeId])?.collectionId; return [...(col ? [col] : []), "global"]; }
  return ["global"];
}

function refuseIfWithdrawn(db: SqlDriver, noteId: string): void {
  const n = db.get<{ status: string }>("SELECT status FROM notes WHERE noteId = ?", [noteId]);
  if (n && (n.status === "withdrawn" || n.status === "purge-pending")) throw new ApplyRefused("withdrawn");
}

function releasePending(db: SqlDriver, sha256: string, refId: string | undefined): void {
  if (!refId) return;
  const row = db.get<{ pendingRefs: string; refcount: number; state: string }>("SELECT pendingRefs, refcount, state FROM blob_refs WHERE sha256 = ?", [sha256]);
  if (!row) return;
  const remaining = (JSON.parse(row.pendingRefs) as string[]).filter((r) => r !== refId);
  // No counted reference and no pending reference left: gc-pending, unless a delete is already in flight or done (S1c B3).
  const state = row.refcount >= 1 ? "live" : remaining.length ? "pending" : (row.state === "deleting" || row.state === "deleted" ? row.state : "gc-pending");
  db.run("UPDATE blob_refs SET pendingRefs = ?, state = ? WHERE sha256 = ?", [JSON.stringify(remaining), state, sha256]);
}

function requirePushGrant(db: SqlDriver, actor: Actor, grant: string, ts: string) {
  const token=db.get<{principal:string;client_class:string;scopes:string;revokedAt:string|null;expiresAt:string}>("SELECT principal,client_class,scopes,revokedAt,expiresAt FROM tokens WHERE hash=?",[grant]);
  if (actor.clientClass!=="kl-device" || !token || token.principal!==actor.principal || token.client_class!=="kl-device" || token.revokedAt || token.expiresAt<=ts || loadAcl(db,actor).status!=="active" || !hasScope(JSON.parse(token.scopes),SCOPE_FOR.save) || !hasScope(JSON.parse(token.scopes),SCOPE_FOR.read)) throw new ApplyRefused("not-found");
}
function requirePushFolder(db: SqlDriver, actor: Actor, manifest: PushManifest, grant: string) {
  const token = db.get<{ collection_ids: string | null }>("SELECT collection_ids FROM tokens WHERE hash=?", [grant]);
  if (!token) throw new ApplyRefused("not-found");
  if (token.collection_ids !== null) {
    let ids: unknown; try { ids = JSON.parse(token.collection_ids); } catch { throw new ApplyRefused("not-found"); }
    if (!validCollectionIds(ids) || !ids.includes(manifest.collection)) throw new ApplyRefused("not-found");
  }
  const folder=db.get<{device:string;volumeSerial:string;rootFileId:string;owner_principal:string;collectionId:string}>("SELECT device,volumeSerial,rootFileId,owner_principal,collectionId FROM folders WHERE folderId=?",[manifest.folderId]);
  const col=db.get<{class:string;clients_ok:string;decision_row:string|null}>("SELECT class,clients_ok,decision_row FROM collections WHERE collectionId=?",[manifest.collection]);
  if (!folder || folder.device!==manifest.device || folder.volumeSerial!==manifest.identity.volumeSerial || folder.rootFileId!==manifest.identity.rootFileId || folder.owner_principal!==actor.principal || folder.collectionId!==manifest.collection || !col || !aclAllowsCollection(loadAcl(db,actor),manifest.collection) || !aclAllowsClass(loadAcl(db,actor),col.class,JSON.parse(col.clients_ok),col.decision_row!==null)) throw new ApplyRefused("not-found");
}
function requireOwnedPush(db: SqlDriver, actor: Actor, grant: string, pushId: string, ts: string) {
  requirePushGrant(db,actor,grant,ts);
  const row=db.get<{principal:string;grant_h:string;manifest_h:string;state:string;expiresAt:string}>("SELECT principal,grant_h,manifest_h,state,expiresAt FROM text_pushes WHERE pushId=?",[pushId]);
  if (!row || row.principal!==actor.principal || row.grant_h!==grant || row.state!=="open" || row.expiresAt<=ts) throw new ApplyRefused("not-found");
  const manifest=JSON.parse(db.get<{text:string}>("SELECT text FROM values_ WHERE hash=?",[row.manifest_h])!.text) as PushManifest;
  requirePushFolder(db,actor,manifest,grant);
  return {row,manifest};
}

// Only bounded, content-free outcomes enter the journal. No note, blob, alias or
// outbox mutation is made for an item that cannot stay in its registered folder.
function recordPushDisposition(db: SqlDriver, pushId: string, n: number, sha256: string, d: PushDisposition): void {
  const code = (s: unknown) => typeof s === "string" && /^[a-z][a-z0-9.-]{0,79}$/.test(s);
  if (d.ok !== false || !["held","refused","rerouted"].includes(d.status) || !code(d.reason) || (d.ruleCodes && (!Array.isArray(d.ruleCodes) || d.ruleCodes.length > 32 || !d.ruleCodes.every(code))) || Object.keys(d).some(k=>!["ok","status","reason","ruleCodes"].includes(k))) throw new ApplyRefused("push-item-conflict");
  const result_h = putValue(db, canonicalJson(d));
  releasePending(db,sha256,`push:${pushId}:${n}`);
  db.run("UPDATE text_push_items SET state='terminal',result_h=? WHERE pushId=? AND n=?",[result_h,pushId,n]);
}

// Reuse is an optimization, not a permanent refusal to accept the device's
// bytes. Retain the exact source internally so retrying with device bytes cannot
// erase its privacy ceiling. This metadata never enters a public push receipt.
function recordPushReuseFailure(db: SqlDriver, pushId: string, n: number, sha256: string, source: PushReuseSource): void {
  releasePending(db,sha256,`push:${pushId}:${n}`);
  const result_h=putValue(db,canonicalJson({reuseSource:source}));
  db.run("UPDATE text_push_items SET state='reuse-failed',result_h=? WHERE pushId=? AND n=?",[result_h,pushId,n]);
}

export interface PushReuseSource { noteId: string; ver: number; privacyClass: string }
export function pushFallbackSource(db: SqlDriver, resultHash: string | null): PushReuseSource | undefined {
  if(!resultHash) return undefined;
  const value=JSON.parse(getValue(db,resultHash) ?? "null") as {reuseSource?:PushReuseSource}|null;
  const source=value?.reuseSource;
  if(!source || typeof source.noteId!=="string" || !Number.isSafeInteger(source.ver) || source.ver<1 || typeof source.privacyClass!=="string") throw new ApplyRefused("push-item-conflict");
  return source;
}
/** Possession of a hash is not authority. Every transfer source is an exact,
 * currently readable version in the requested collection with counted custody. */
export function findPushReuseSource(db: SqlDriver, actor: Actor, collection: string, sha256: string, bytes: number, source?: Pick<PushReuseSource,"noteId"|"ver">): PushReuseSource | undefined {
  const acl=aclPredicate(loadAcl(db,actor));
  return db.get<PushReuseSource>(`SELECT v.noteId,v.ver,v.privacy_class AS privacyClass FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId JOIN blob_refs b ON b.sha256=v.sha256 WHERE n.collectionId=? AND v.sha256=? AND v.bytes=? AND n.status NOT IN ('withdrawn','purge-pending') AND v.custody IN ('verified','indexed') AND v.held=0 AND v.localState!='focus-held' AND v.vstatus!='proposed-edit' AND b.state='live' AND b.refcount>0 AND ${acl.sql}${source ? " AND v.noteId=? AND v.ver=?" : ""} ORDER BY v.noteId,v.ver DESC LIMIT 1`,[collection,sha256,bytes,...acl.params,...(source ? [source.noteId,source.ver] : [])]);
}

export function apply(deps: ApplyDeps, actor: Actor, authority: Authority, op: Op): ApplyResult {
  const { db } = deps;
  return db.transaction(() => {
    policyGate(deps, actor, authority, op);
    const ts = deps.clock.now();
    const emit: Emit = (kind, payload, inverse) => {
      const ev = appendEvent(db, { ts, principal: actor.principal, client: actor.clientClass, kind, payload });
      db.run("INSERT INTO undo(event_seq, inverse_op) VALUES (?,?)", [ev.seq, canonicalJson(inverse)]);
      return ev;
    };
    const enqueue: Enqueue = (opId, step, target, idempotencyKey) =>
      db.run("INSERT OR IGNORE INTO outbox(opId, step, target, idempotencyKey) VALUES (?,?,?,?)", [opId, step, target, idempotencyKey]);
    // Narrowing events and policy acceptances are checkpointed to locked storage as the operation's FIRST outbox
    // step; the caller acknowledges only after that step completes (Catalog.acknowledge). Grants are checkpointed hourly.
    const NARROWING = new Set(["revoke", "token.revoke", "withdraw", "purge", "principal.status", "policy.accept"]);
    const authz = (kind: string, principal: string | null, payload: Record<string, unknown>): number => {
      const epoch = Number(meta(db, "min_policy_epoch") ?? "0");
      db.run("INSERT INTO authz_events(ts, kind, principal, payload, epoch) VALUES (?,?,?,?,?)", [ts, kind, principal, canonicalJson(payload), epoch]);
      const seq = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
      if (NARROWING.has(kind)) db.run("INSERT OR IGNORE INTO outbox(opId, step, target, idempotencyKey) VALUES (?,?,?,?)", [mintId(deps.random), "authz.checkpoint", String(seq), `authz:${seq}`]);
      return seq;
    };

    switch (op.kind) {
      case "enrollment.initialize": {
        const grant = verifiedEnrollment(op.grant, ts), c = grant.claims;
        const prior = meta(db, "enrollment_hash");
        if (prior) {
          if (prior !== grant.hash) throw new ApplyRefused("enrollment-already-consumed");
          const seq = Number(meta(db, "enrollment_authz_seq"));
          const checkpoint = db.get("SELECT id FROM outbox WHERE step='enrollment.checkpoint' AND target=?", [String(seq)]);
          if (!Number.isSafeInteger(seq) || seq < 1 || !checkpoint) throw new ApplyRefused("enrollment-checkpoint-missing");
          return { seq: 0, hash: "", result: { enrollmentHash: prior, authzSeq: seq, state: meta(db, "enrollment_state"), replay: true } };
        }
        // Baseline search configuration may already exist. Trust-bearing rows may not.
        if (meta(db, "setup_consumed") === "1" || setupMode(db) ||
            db.get("SELECT 1 FROM principals LIMIT 1") || db.get("SELECT 1 FROM collections LIMIT 1") ||
            db.get("SELECT 1 FROM folders LIMIT 1") || db.get("SELECT 1 FROM tokens LIMIT 1") ||
            db.get("SELECT 1 FROM approvals LIMIT 1") || db.get("SELECT 1 FROM policy_acceptances LIMIT 1") ||
            Number(meta(db, "min_policy_epoch") ?? "0") > c.policy.epoch) throw new ApplyRefused("enrollment-not-virgin");
        const f = c.folder, p = grant.acceptance;
        db.run("INSERT INTO approvals(receiptId,actionKind,actionHash,evidenceHash,principal,credentialId,issuedAt,expiresAt,usedAt,serverSig) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [c.receiptId,"enrollment.initialize",grant.hash,c.privacyCensusHash,c.principal,grant.keyId,c.issuedAt,c.expiresAt,ts,grant.sig]);
        db.run("INSERT INTO principals(id,email,status,allowed_classes) VALUES(?,'','active',?)", [c.principal,JSON.stringify([f.privacyClass])]);
        db.run("INSERT INTO collections(collectionId,class,store_ok,clients_ok,model_processing,binary) VALUES(?,?,1,'[]',0,0)", [f.collectionId,f.privacyClass]);
        db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId,orrery_registered) VALUES(?,?,?,?,?,?,?,?)",
          [f.folderId,f.device,f.volumeSerial,f.rootFileId,f.displayPathHash,c.principal,f.collectionId,f.orreryRegistered===true?1:0]);
        for (const t of c.tokens) db.run("INSERT INTO tokens(hash,principal,kind,scopes,client_class,issuedAt,expiresAt,collection_ids) VALUES(?,?,?,?,?,?,?,?)",
          [t.hash,c.principal,t.kind,JSON.stringify(tokenScopes(t.kind)),clientClassFor(t.kind),ts,t.expiresAt,JSON.stringify([f.collectionId])]);
        db.run("INSERT INTO policy_acceptances(epoch,policyHash,receiptId,sig,acceptedAt) VALUES(?,?,?,?,?)", [p.epoch,p.policyHash,p.receiptId,p.sig,ts]);
        db.run("UPDATE meta SET value=? WHERE key='min_policy_epoch'", [String(p.epoch)]);
        // This content-free checkpoint contains every enrollment grant and consumed approval.
        const authzSeq = authz("enrollment.initialize", c.principal, { claims:c, acceptance:p, approval:{keyId:grant.keyId,sig:grant.sig}, enrollmentHash:grant.hash });
        enqueue(mintId(deps.random), "enrollment.checkpoint", String(authzSeq), `enrollment:${grant.hash}`);
        for (const [key,value] of Object.entries({ enrollment_hash:grant.hash, enrollment_nonce:c.nonce,
          enrollment_authz_seq:String(authzSeq), enrollment_state:"pending", setup_consumed:"1" })) {
          db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key,value]);
        }
        db.run("UPDATE meta SET value='0' WHERE key='setup_mode'");
        db.run("DELETE FROM meta WHERE key='setup_secret_h'");
        const ev = emit("enrollment.initialize", { enrollmentHash:grant.hash, receiptIdHash:sha256Hex(c.receiptId), authzSeq, registrationHash:c.registrationHash }, {kind:"noop"});
        return {...ev,result:{enrollmentHash:grant.hash,authzSeq,state:"pending",replay:false}};
      }
      case "enrollment.activate": {
        if (meta(db,"enrollment_hash") !== op.hash || meta(db,"enrollment_authz_seq") !== String(op.authzSeq) ||
            !db.get("SELECT 1 FROM outbox WHERE step='enrollment.checkpoint' AND target=?", [String(op.authzSeq)])) throw new ApplyRefused("enrollment-checkpoint-missing");
        if (meta(db,"enrollment_state") === "active") return {seq:0,hash:"",result:{active:true}};
        if (meta(db,"enrollment_state") !== "pending") throw new ApplyRefused("enrollment-state-invalid");
        db.run("UPDATE meta SET value='active' WHERE key='enrollment_state'");
        const ev = emit("enrollment.activate", {enrollmentHash:op.hash,authzSeq:op.authzSeq}, {kind:"noop"});
        return {...ev,result:{active:true}};
      }
      case "push.open": {
        requirePushGrant(db, actor, op.grant, ts);
        requirePushFolder(db, actor, op.manifest, op.grant);
        // Checked inside the write transaction, including sessions opened with a
        // different grant. An old snapshot can never commit behind a newer one.
        if (db.get("SELECT 1 FROM text_pushes WHERE principal=? AND folderId=? AND state='open'",[actor.principal,op.manifest.folderId])) throw new ApplyRefused("push-in-progress");
        const manifest_h = putValue(db, canonicalJson(op.manifest));
        db.run("INSERT INTO text_pushes(pushId,principal,grant_h,snapshot_h,manifest_h,folderId,collectionId,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?,?)", [op.pushId,actor.principal,op.grant,op.snapshotHash,manifest_h,op.manifest.folderId,op.manifest.collection,ts,op.expiresAt]);
        op.manifest.entries.forEach((e,n) => db.run("INSERT INTO text_push_items(pushId,n,sha256) VALUES (?,?,?)",[op.pushId,n,e.sha256]));
        const ev = emit("push.open",{pushId:op.pushId,manifest_h,count:op.manifest.entries.length},{kind:"noop"});
        return {...ev,result:{pushId:op.pushId}};
      }
      case "push.reserve":
      case "push.stage": {
        const {manifest} = requireOwnedPush(db,actor,op.grant,op.pushId,ts);
        const e = manifest.entries[op.n];
        const item = db.get<{state:string;result_h:string|null}>("SELECT state,result_h FROM text_push_items WHERE pushId=? AND n=?",[op.pushId,op.n]);
        if (!e || !item || item.state === "committed" || item.state === "terminal") throw new ApplyRefused("not-found");
        const fallback=pushFallbackSource(db,item.result_h);
        if(op.kind==='push.stage' && (fallback || item.state==='reuse-failed')) {
          const current=fallback && findPushReuseSource(db,actor,manifest.collection,e.sha256,e.size,fallback);
          if(!current || current.privacyClass!==fallback!.privacyClass){
            const disposition:PushDisposition={ok:false,status:"refused",reason:"review"};
            recordPushDisposition(db,op.pushId,op.n,e.sha256,disposition);
            const ev=emit("push.disposition",{pushId:op.pushId,n:op.n,status:disposition.status},{kind:"noop"});
            return {...ev,result:disposition as unknown as Record<string,unknown>};
          }
        }
        const refId = `push:${op.pushId}:${op.n}`;
        const row = db.get<{state:string;pendingRefs:string}>("SELECT state,pendingRefs FROM blob_refs WHERE sha256=?",[e.sha256]);
        if (row?.state === "deleting") throw new ApplyRefused("blob-deleting");
        const refs = row ? JSON.parse(row.pendingRefs) as string[] : [];
        if (op.kind === "push.reserve") {
          if (!refs.includes(refId)) refs.push(refId);
          if (row) db.run("UPDATE blob_refs SET pendingRefs=?,state=CASE WHEN state IN ('gc-pending','deleted') THEN 'pending' ELSE state END WHERE sha256=?",[JSON.stringify(refs),e.sha256]);
          else db.run("INSERT INTO blob_refs(sha256,refcount,state,pendingRefs) VALUES (?,0,'pending',?)",[e.sha256,JSON.stringify(refs)]);
          db.run("UPDATE text_push_items SET state='reserved' WHERE pushId=? AND n=? AND state NOT IN ('staged','reuse-failed')",[op.pushId,op.n]);
        } else {
          if (!refs.includes(refId)) throw new ApplyRefused("push-not-reserved");
          db.run("UPDATE text_push_items SET state='staged' WHERE pushId=? AND n=?",[op.pushId,op.n]);
        }
        const ev = emit(op.kind,{pushId:op.pushId,n:op.n,sha256:e.sha256},{kind:"noop"});
        return {...ev,result:{pushId:op.pushId,n:op.n}};
      }
      case "push.disposition": {
        const {manifest} = requireOwnedPush(db,actor,op.grant,op.pushId,ts);
        const e=manifest.entries[op.n], row=db.get<{state:string}>("SELECT state FROM text_push_items WHERE pushId=? AND n=?",[op.pushId,op.n]);
        if(!e || !row || row.state==='committed' || row.state==='terminal') throw new ApplyRefused("push-item-conflict");
        recordPushDisposition(db,op.pushId,op.n,e.sha256,op.disposition);
        const ev=emit("push.disposition",{pushId:op.pushId,n:op.n,status:op.disposition.status},{kind:"noop"});
        return {...ev,result:{pushId:op.pushId,n:op.n}};
      }
      case "push.expire": {
        const p = db.get<{state:string;expiresAt:string}>("SELECT state,expiresAt FROM text_pushes WHERE pushId=?",[op.pushId]);
        if (!p || p.state !== "open" || p.expiresAt > ts) throw new ApplyRefused("push-not-expired");
        for (const e of db.all<{n:number;sha256:string}>("SELECT n,sha256 FROM text_push_items WHERE pushId=?",[op.pushId])) releasePending(db,e.sha256,`push:${op.pushId}:${e.n}`);
        db.run("UPDATE text_pushes SET state='expired' WHERE pushId=?",[op.pushId]);
        const ev=emit("push.expire",{pushId:op.pushId},{kind:"noop"});
        return {...ev,result:{pushId:op.pushId}};
      }
      case "push.commit": {
        const {manifest} = requireOwnedPush(db,actor,op.grant,op.pushId,ts);
        if ((db.get<{seq:number}>("SELECT max(seq) AS seq FROM events")?.seq ?? 0)!==op.expectedGeneration) throw new ApplyRefused("push-catalog-changed");
        const acl = aclPredicate(loadAcl(db,actor));
        const visible = (noteId:string,ver:number) => db.get<{sha256:string;custody:string;held:number;localState:string;folderId:string;collectionId:string;status:string;currentVer:number}>(`SELECT v.sha256,v.custody,v.held,v.localState,n.folderId,n.collectionId,n.status,n.currentVer FROM versions v JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId WHERE v.noteId=? AND v.ver=? AND ${acl.sql}`,[noteId,ver,...acl.params]);
        const applied: Record<string,unknown>[]=[];
        for (const i of op.items) {
          const entry=manifest.entries[i.n];
          const row=db.get<{state:string;result_h:string|null}>("SELECT state,result_h FROM text_push_items WHERE pushId=? AND n=?",[op.pushId,i.n]);
          if (!entry || !row || row.state==='committed' || row.state==='terminal') throw new ApplyRefused("push-item-conflict");
          const retryReuse=() => {
            if(!i.reuseSource) throw new ApplyRefused("push-item-conflict");
            recordPushReuseFailure(db,op.pushId,i.n,entry.sha256,i.reuseSource);
          };
          const terminal=(d:PushDisposition) => {
            if(i.reuseSource && row.state!=='staged') retryReuse();
            else {recordPushDisposition(db,op.pushId,i.n,entry.sha256,d);applied.push(d as unknown as Record<string,unknown>);}
          };
          if(i.reuseFailed){
            if(i.version || i.result || i.disposition || i.reused || !i.reuseSource || row.state==='staged') throw new ApplyRefused("push-item-conflict");
            retryReuse();continue;
          }
          if(i.disposition){if(i.version || i.result) throw new ApplyRefused("push-item-conflict");terminal(i.disposition);continue;}
          if (i.reuseSource) {
            const source=findPushReuseSource(db,actor,manifest.collection,entry.sha256,entry.size,i.reuseSource);
            const fallback=pushFallbackSource(db,row.result_h);
            if(row.state==='staged') {
              if(i.reused || !fallback || canonicalJson(fallback)!==canonicalJson(i.reuseSource)) throw new ApplyRefused("push-item-conflict");
            } else if(row.state!=="reserved" || !i.reused) throw new ApplyRefused("push-item-conflict");
            if (!source || source.privacyClass!==i.reuseSource.privacyClass) {terminal({ok:false,status:"refused",reason:"review"});continue;}
          } else if (i.reused || row.result_h) throw new ApplyRefused("push-item-conflict");
          let result: Record<string,unknown>;
          if (i.version) {
            const v=i.version;
            const move=op.moves.find(m=>m.noteId===v.noteId && m.to===entry.relPath),path=move?.from ?? entry.relPath;
            if (v.sha256 !== entry.sha256 || v.bytes !== entry.size || v.path !== path || v.folderId !== manifest.folderId || v.baseVer !== (move?.ver ?? entry.lastKnownVer) || v.pendingRefId !== `push:${op.pushId}:${i.n}`) throw new ApplyRefused("push-item-conflict");
            if(v.held || v.collectionId!==manifest.collection){terminal({ok:false,status:v.held?"held":"rerouted",reason:v.held?"review":"destination-changed"});continue;}
            let unchanged=false;
            if (v.noteId) {
              const current=db.get<{currentVer:number}>("SELECT currentVer FROM notes WHERE noteId=?",[v.noteId]);
              const allowed=current && visible(v.noteId,current.currentVer);
              if (!allowed || allowed.folderId !== manifest.folderId || allowed.collectionId !== manifest.collection || allowed.status === "withdrawn" || allowed.status === "purge-pending") {terminal({ok:false,status:"refused",reason:"review"});continue;}
              // Every upload and in-place/move item gets the same exact twin gate
              // before createVersion can deduplicate or promote it.
              const twins=db.all<{ver:number;privacy_class:string;held:number}>("SELECT ver,privacy_class,held FROM versions WHERE noteId=? AND sha256=? AND (ver=? OR parentVer IS ?)",[v.noteId,v.sha256,current!.currentVer,v.baseVer ?? current!.currentVer]);
              if(twins.some(t=>!visible(v.noteId!,t.ver) || t.privacy_class!==v.privacyClass)){terminal({ok:false,status:"refused",reason:"review"});continue;}
              if(twins.some(t=>!!t.held!==!!v.held)){terminal({ok:false,status:"held",reason:"review"});continue;}
              if(twins.some(t=>visible(v.noteId!,t.ver)?.custody==='received')) continue;
              unchanged=allowed.sha256===entry.sha256 && allowed.custody!=='received';
              if(!db.get("SELECT 1 FROM aliases WHERE noteId=? AND path_h=? AND valid_to IS NULL AND (owner IS NULL OR owner=?)",[v.noteId,sha256Hex(path),actor.principal])) throw new ApplyRefused("push-item-conflict");
            }
            if(row.state!=="staged" && !i.reuseSource && !unchanged) throw new ApplyRefused("push-item-conflict");
            if(row.state==="staged" || i.reuseSource){
              const blob=db.get<{state:string;pendingRefs:string}>("SELECT state,pendingRefs FROM blob_refs WHERE sha256=?",[entry.sha256]);
              if(!blob || blob.state==='deleting' || blob.state==='deleted' || !(JSON.parse(blob.pendingRefs) as string[]).includes(v.pendingRefId!)) throw new ApplyRefused("push-item-conflict");
            }
            const dest=db.get<{class:string;clients_ok:string;decision_row:string|null}>("SELECT class,clients_ok,decision_row FROM collections WHERE collectionId=?",[v.collectionId]);
            if (!dest || !aclAllowsClass(loadAcl(db,actor),dest.class,JSON.parse(dest.clients_ok),dest.decision_row!==null)) throw new ApplyRefused("not-found");
            const created=createVersion(deps,actor,v,ts,emit,enqueue).result;
            result={ok:true,...created,sha256:v.sha256,collection:v.collectionId,status:v.held?"held":created.status,...(i.reason?{reason:i.reason}:{}),requestId:op.pushId,custody:"received",cite:versionCitation(String(created.noteId),Number(created.ver),v.sha256)};
          } else if (i.result) {
            const r=i.result;
            const allowed=visible(String(r.noteId),Number(r.ver));
            if (!allowed || allowed.sha256 !== entry.sha256 || allowed.custody === "received" || allowed.folderId !== manifest.folderId || allowed.collectionId !== manifest.collection || allowed.status === "withdrawn" || allowed.status === "purge-pending") throw new ApplyRefused("not-found");
            const path=op.moves.find(m=>m.noteId===r.noteId && m.ver===r.ver && m.to===entry.relPath)?.from ?? entry.relPath;
            if (!db.get("SELECT 1 FROM aliases a JOIN values_ pv ON pv.hash=a.path_h WHERE a.noteId=? AND a.collectionId=? AND a.valid_to IS NULL AND (a.owner IS NULL OR a.owner=?) AND pv.text=?",[String(r.noteId),manifest.collection,actor.principal,path])) throw new ApplyRefused("push-item-conflict");
            result=r;
            releasePending(db,entry.sha256,`push:${op.pushId}:${i.n}`);
          } else throw new ApplyRefused("push-item-conflict");
          result={...result,reused:i.reused};
          const result_h=putValue(db,canonicalJson(result));
          db.run("UPDATE text_push_items SET state='committed',result_h=? WHERE pushId=? AND n=?",[result_h,op.pushId,i.n]);
          const present=db.run("UPDATE versions SET localState='present' WHERE noteId=? AND ver=? AND localState='absent-locally'",[String(result.noteId),Number(result.ver)]);
          if(present.changes) emit("alias.observed-present",{noteId:String(result.noteId),ver:Number(result.ver)},{kind:"noop"});
          applied.push(result);
        }
        const pending=db.get<{n:number}>("SELECT count(*) AS n FROM text_push_items WHERE pushId=? AND state NOT IN ('committed','terminal')",[op.pushId])!.n;
        const refused=db.get<{n:number}>("SELECT count(*) AS n FROM text_push_items WHERE pushId=? AND state='terminal'",[op.pushId])!.n;
        // Move eligibility depends on the entire snapshot, including dispositions
        // discovered by the transactional twin gate after an earlier move item.
        // An exact-match dedup is not proof that its destination alias moved.
        // Suppress every withheld destination receipt before it can become a
        // client checkpoint; a later complete snapshot can retry the exact move.
        if(pending!==0 || refused!==0) for(const move of op.moves) {
          const n=manifest.entries.findIndex(e=>e.relPath===move.to);
          const row=db.get<{state:string}>("SELECT state FROM text_push_items WHERE pushId=? AND n=?",[op.pushId,n]);
          if(row?.state==='committed') recordPushDisposition(db,op.pushId,n,manifest.entries[n]!.sha256,{ok:false,status:"held",reason:"move-deferred"});
        }
        if (pending===0) {
          for (const move of refused===0 ? op.moves : []) {
            const allowed=visible(move.noteId,move.ver);
            if (!allowed || allowed.held || allowed.localState !== "present" || allowed.status !== "current" || allowed.currentVer !== move.ver || allowed.folderId !== manifest.folderId || allowed.collectionId !== manifest.collection || !deps.moveEligibility?.(move.noteId,move.ver)) throw new ApplyRefused("push-move-conflict");
            const from_h=putValue(db,move.from),to_h=putValue(db,move.to);
            if (db.get("SELECT 1 FROM aliases a JOIN notes n ON n.noteId=a.noteId WHERE a.collectionId=? AND a.path_h=? AND a.valid_to IS NULL AND n.folderId=?",[manifest.collection,to_h,manifest.folderId])) throw new ApplyRefused("push-move-conflict");
            const moved=db.run("UPDATE aliases SET valid_to=? WHERE noteId=? AND path_h=? AND valid_to IS NULL",[ts,move.noteId,from_h]);
            if (!moved.changes) throw new ApplyRefused("push-move-conflict");
            db.run("INSERT INTO aliases(collectionId,folderId,path_h,noteId,valid_from) VALUES (?,?,?,?,?)",[manifest.collection,manifest.folderId,to_h,move.noteId,ts]);
            emit("alias.move",{noteId:move.noteId,from_h,to_h},{kind:"noop"});
            enqueue(op.pushId,"mirror.meta",`${move.noteId}@${move.ver}`,`push-mirror:${op.pushId}:${move.noteId}`);
          }
          if (refused===0 && manifest.scanComplete && Object.values(manifest.heldLocal).every(n=>n===0)) for (const absent of op.absent) {
            const allowed=visible(absent.noteId,absent.ver);
            if (!allowed || allowed.currentVer !== absent.ver || allowed.folderId !== manifest.folderId || allowed.collectionId !== manifest.collection) throw new ApplyRefused("push-absence-conflict");
            const changed=db.run("UPDATE versions SET localState='absent-locally' WHERE noteId=? AND ver=? AND localState='present'",[absent.noteId,absent.ver]);
            if(changed.changes) emit("alias.observed-absent",{noteId:absent.noteId,ver:absent.ver},{kind:"noop"});
          }
          db.run("UPDATE text_pushes SET state='committed' WHERE pushId=?",[op.pushId]);
        }
        const ev=emit("push.commit",{pushId:op.pushId,count:applied.length,pending},{kind:"noop"});
        return {...ev,result:{pushId:op.pushId,count:applied.length,pending}};
      }
      case "collection.create": {
        if (db.get("SELECT 1 FROM collections WHERE collectionId = ?", [op.collectionId])) throw new ApplyRefused("exists");
        db.run("INSERT INTO collections(collectionId, class, store_ok, clients_ok, model_processing, decision_row, binary) VALUES (?,?,?,?,?,?,?)", [op.collectionId, op.class, op.store_ok === false ? 0 : 1, JSON.stringify(op.clients_ok ?? []), op.model_processing ? 1 : 0, op.decision_row ? canonicalJson(op.decision_row) : null, op.binary ? 1 : 0]);
        const ev = emit("collection.create", { collectionId: op.collectionId, class: op.class, binary: op.binary ? 1 : 0 }, { kind: "collection.remove", collectionId: op.collectionId });
        authz("collection.create", null, { collectionId: op.collectionId, class: op.class });
        return { ...ev, result: { collectionId: op.collectionId } };
      }
      case "principal.create": {
        if (db.get("SELECT 1 FROM principals WHERE id = ?", [op.id])) throw new ApplyRefused("exists");
        const email_h = putValue(db, op.email);
        db.run("INSERT INTO principals(id, email, status, allowed_classes) VALUES (?,?,?,?)", [op.id, op.email, "active", JSON.stringify(op.allowedClasses)]);
        const ev = emit("principal.create", { id: op.id, email_h, classes: op.allowedClasses }, { kind: "principal.remove", id: op.id });
        authz("grant", op.id, { classes: op.allowedClasses });
        return { ...ev, result: { id: op.id } };
      }
      case "principal.revoke": {
        db.run("UPDATE principals SET status = 'revoked' WHERE id = ?", [op.id]);
        db.run("UPDATE tokens SET revokedAt = ? WHERE principal = ? AND revokedAt IS NULL", [ts, op.id]);
        const ev = emit("principal.revoke", { id: op.id }, { kind: "noop" });
        const authzSeq = authz("revoke", op.id, {});
        return { ...ev, result: { id: op.id, authzSeq } };
      }
      case "token.issue": {
        if (op.collectionIds !== undefined) {
          if (!validCollectionIds(op.collectionIds) || !Number.isFinite(Date.parse(op.expiresAt)) || op.expiresAt <= ts) throw new ApplyRefused("invalid-collection-grant");
          const acl = loadAcl(db, { principal: op.principal, clientClass: op.clientClass as Actor["clientClass"] });
          for (const id of op.collectionIds) {
            const col = db.get<{ class: string; clients_ok: string; decision_row: string | null }>("SELECT class,clients_ok,decision_row FROM collections WHERE collectionId=?", [id]);
            if (!col || !aclAllowsClass(acl, col.class, JSON.parse(col.clients_ok), col.decision_row !== null)) throw new ApplyRefused("invalid-collection-grant");
          }
        }
        const scope = op.collectionIds === undefined ? {} : { collectionIds: op.collectionIds };
        db.run("INSERT INTO tokens(hash, principal, kind, scopes, client_class, issuedAt, expiresAt, collection_ids) VALUES (?,?,?,?,?,?,?,?)", [op.tokenHash, op.principal, op.tokenKind, JSON.stringify(op.scopes), op.clientClass, ts, op.expiresAt, op.collectionIds === undefined ? null : JSON.stringify(op.collectionIds)]);
        const ev = emit("token.issue", { tokenHash: op.tokenHash, principal: op.principal, tokenKind: op.tokenKind, clientClass: op.clientClass, ...scope }, { kind: "token.revoke", tokenHash: op.tokenHash });
        authz("token.issue", op.principal, { tokenHash: op.tokenHash, ...scope });
        // Setup seals itself after the first owner (device) token is issued.
        if (authority.kind === "setup" && op.tokenKind === "kl-device") {
          db.run("UPDATE meta SET value = '0' WHERE key = 'setup_mode'");
          db.run("INSERT OR REPLACE INTO meta(key,value) VALUES ('setup_consumed','1')");
        }
        return { ...ev, result: { tokenHash: op.tokenHash, sealed: op.tokenKind === "kl-device" } };
      }
      case "token.revoke": {
        const r = db.run("UPDATE tokens SET revokedAt = ? WHERE hash = ? AND revokedAt IS NULL", [ts, op.tokenHash]);
        const ev = emit("token.revoke", { tokenHash: op.tokenHash, reason: op.reason, revoked: r.changes }, { kind: "noop" });
        const authzSeq = authz("token.revoke", null, { tokenHash: op.tokenHash, reason: op.reason });
        return { ...ev, result: { revoked: r.changes > 0, authzSeq } };
      }
      case "blob.reserve": {
        // A pending reference recorded BEFORE BlobWriter.put: a blob with a pending reference is never an orphan.
        const row = db.get<{ state: string; pendingRefs: string }>("SELECT state, pendingRefs FROM blob_refs WHERE sha256 = ?", [op.sha256]);
        if (row?.state === "deleting") throw new ApplyRefused("blob-deleting", "a delete is in flight for these bytes; retry after it finishes");
        const refs = row ? (JSON.parse(row.pendingRefs) as string[]) : [];
        if (!refs.includes(op.refId)) refs.push(op.refId);
        // A reservation on a gc-pending row makes it pending again (never live: nothing counts it yet), S1c B3.
        if (row) db.run("UPDATE blob_refs SET pendingRefs = ?, state = CASE WHEN state = 'gc-pending' THEN 'pending' ELSE state END WHERE sha256 = ?", [JSON.stringify(refs), op.sha256]);
        else db.run("INSERT INTO blob_refs(sha256, refcount, state, pendingRefs) VALUES (?,0,'pending',?)", [op.sha256, JSON.stringify(refs)]);
        const ev = emit("blob.reserve", { sha256: op.sha256, refId: op.refId }, { kind: "blob.release", sha256: op.sha256, refId: op.refId });
        return { ...ev, result: { sha256: op.sha256 } };
      }
      case "blob.release": {
        releasePending(db, op.sha256, op.refId);
        const ev = emit("blob.release", { sha256: op.sha256, refId: op.refId }, { kind: "noop" });
        return { ...ev, result: { sha256: op.sha256 } };
      }
      case "version.custody": {
        // received → verified comes from the post-commit HEAD + SHA-256 check (an outbox step); verified → indexed from the indexer.
        const cur = db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ? AND ver = ?", [op.noteId, op.ver]);
        if (!cur) throw new ApplyRefused("not-found");
        const order = ["received", "verified", "indexed"];
        if (order.indexOf(op.custody) < order.indexOf(cur.custody)) throw new ApplyRefused("custody-cannot-regress");
        db.run("UPDATE versions SET custody = ?, lastVerifiedAt = CASE WHEN ? = 'verified' THEN ? ELSE lastVerifiedAt END WHERE noteId = ? AND ver = ?", [op.custody, op.custody, ts, op.noteId, op.ver]);
        const ev = emit("version.custody", { noteId: op.noteId, ver: op.ver, custody: op.custody, reason: op.reason }, { kind: "noop" });
        return { ...ev, result: { noteId: op.noteId, ver: op.ver, custody: op.custody } };
      }
      case "version.create": return createVersion(deps, actor, op, ts, emit, enqueue);
      case "idempotency.bind": {
        // A key is bound to its bytes even when its first use hit dedup (S1c A5): the same key with other bytes is a conflict.
        bindIdempotency(db, actor.principal, op.idempotencyKey, op.noteId, op.ver, op.sha256, ts);
        const ev = emit("idempotency.bind", { noteId: op.noteId, ver: op.ver, sha256: op.sha256, idem: sha256Hex(op.idempotencyKey) }, { kind: "noop" });
        return { ...ev, result: { noteId: op.noteId, ver: op.ver } };
      }
      case "alias.move": {
        const note = db.get<{ currentVer: number; folderId: string | null }>("SELECT currentVer,folderId FROM notes WHERE noteId = ?", [op.noteId]);
        if (!note) throw new ApplyRefused("not-found");
        refuseIfWithdrawn(db, op.noteId);
        const path_h = putValue(db, op.newPath);
        const taken = db.get<{ noteId: string }>("SELECT a.noteId FROM aliases a JOIN notes n ON n.noteId=a.noteId WHERE a.collectionId=? AND a.path_h=? AND a.valid_to IS NULL AND a.owner IS NULL AND n.folderId IS ?", [op.collectionId,path_h,note.folderId]);
        if (taken && taken.noteId !== op.noteId) throw new ApplyRefused("alias-path-taken");
        db.run("UPDATE aliases SET valid_to = ? WHERE noteId = ? AND valid_to IS NULL", [ts, op.noteId]);
        db.run("INSERT INTO aliases(collectionId,folderId,path_h,noteId,valid_from) VALUES (?,?,?,?,?)", [op.collectionId,note.folderId,path_h,op.noteId,ts]);
        const aliasId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
        const ev = emit("alias.move", { noteId: op.noteId, collectionId: op.collectionId, path_h, aliasId }, { kind: "alias.revert", aliasId });
        enqueue(mintId(deps.random), "mirror.meta", `${op.noteId}@${note.currentVer}`, `mirror:${op.noteId}@${note.currentVer}:alias:${aliasId}`);
        return { ...ev, result: { noteId: op.noteId, aliasId } };
      }
      case "feedback.record": {
        refuseIfWithdrawn(db, op.targetNoteId);
        const correctionTargetRow = op.feedbackKind === "correct"
          ? correctionTarget(db, actor, op.targetNoteId, op.targetVer ?? 0) : undefined;
        if (op.feedbackKind === "correct" && !correctionTargetRow) throw new ApplyRefused("not-found");
        const detail_h = putValue(db, op.detail);
        const topic_h = op.topic ? putValue(db, op.topic) : null;
        const overrideId = mintId(deps.random);
        let signalId: string | null = null, caseId: string | null = null;
        const target = `${op.targetNoteId}${op.targetVer ? "@" + op.targetVer : ""}`;
        if (op.feedbackKind === "correct" || op.feedbackKind === "missed" || op.feedbackKind === "pin" || op.feedbackKind === "unpin") {
          db.run("INSERT INTO overrides(id, kind, target, topic_h, scope, principal, client, state, createdAt) VALUES (?,?,?,?,?,?,?,?,?)", [overrideId, op.feedbackKind, target, topic_h, "principal", actor.principal, actor.clientClass, "unconfirmed", ts]);
        }
        // Only interactive sessions create signals and cases; headless feedback leaves only its (principal-scoped) override.
        if (op.interactive && (op.feedbackKind === "correct" || op.feedbackKind === "missed" || op.feedbackKind === "useful")) {
          signalId = mintId(deps.random);
          const sk = op.feedbackKind === "useful" ? "S5" : "S1";
          db.run("INSERT INTO signals(signalId, kind, principal, client, scopeId, target, queryId, q_h, strength, ts, interactive, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [signalId, sk, actor.principal, actor.clientClass, "global", target, op.queryId ?? null, topic_h, sk === "S1" ? "strong" : "medium", ts, 1, "unconfirmed"]);
          if (sk === "S1") {
            const privacy = db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [op.targetNoteId, op.targetVer ?? 0])?.privacy_class ?? "secret";
            const lineageKey = computeLineageKey(db, op.targetNoteId);
            caseId = mintId(deps.random);
            insertCase(db, ts, { caseId, capability: "retrieval", scopeId: "global", privacy, groupKey: lineageKey, lineageKey, inputRef: JSON.stringify({ q_h: topic_h, queryId: op.queryId ?? null, target }), frozenFeatures: { q_h: topic_h, kind: sk }, expected: { noteId: op.targetNoteId, label: "miss" }, sourceSignals: [signalId], author: actor.principal, client: actor.clientClass });
          }
        }
        let correction: Parameters<typeof correctionRecordHash>[0] | undefined;
        if (correctionTargetRow) {
          const topic = normalizeCorrectionTopic(op.topic ?? "correction");
          const statement = op.detail.replace(/\s+/g, " ").trim();
          if (!topic || !statement || topic.length > 200 || statement.length > 2000) throw new ApplyRefused("correction-invalid");
          const topicKey_h = sha256Hex(topic.toLowerCase());
          const prior = db.get<{ id: string }>(`SELECT c.id FROM corrections c WHERE c.author=? AND c.scopeId=?
            AND c.targetNoteId=? AND c.targetVer=? AND c.topicKey_h=?
            AND COALESCE((SELECT state FROM correction_states WHERE correctionId=c.id ORDER BY seq DESC LIMIT 1),'proposed')!='reverted'
            ORDER BY c.eventSeq DESC LIMIT 1`, [actor.principal, correctionTargetRow.collectionId, op.targetNoteId, op.targetVer!, topicKey_h]);
          const evidenceCite_h = putValue(db, evidenceCitation({ targetNoteId: op.targetNoteId, targetVer: op.targetVer!, targetSha256: correctionTargetRow.sha256 }));
          correction = { id: overrideId, author: actor.principal, client: actor.clientClass, scopeId: correctionTargetRow.collectionId,
            targetNoteId: op.targetNoteId, targetVer: op.targetVer!, targetSha256: correctionTargetRow.sha256,
            topic_h: putValue(db, topic), topicKey_h, statement_h: putValue(db, statement), evidenceCite_h,
            supersedes: prior?.id ?? null, caseId, createdAt: ts };
        }
        const ev = emit("feedback.record", { feedbackKind: op.feedbackKind, target: op.targetNoteId, detail_h, overrideId, signalId, caseId,
          ...(correction ? { correction_h: correctionRecordHash(correction) } : {}) },
          op.feedbackKind === "correct" ? { kind: "correction.revert", correctionId: overrideId } : { kind: "override.remove", overrideId });
        if (correction) db.run(`INSERT INTO corrections(id,eventSeq,author,client,scopeId,targetNoteId,targetVer,targetSha256,topic_h,topicKey_h,statement_h,evidenceCite_h,supersedes,caseId,createdAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [correction.id, ev.seq, correction.author, correction.client, correction.scopeId,
          correction.targetNoteId, correction.targetVer, correction.targetSha256, correction.topic_h, correction.topicKey_h,
          correction.statement_h, correction.evidenceCite_h, correction.supersedes, correction.caseId, correction.createdAt]);
        return { ...ev, result: { eventId: ev.seq, overrideId, overrideScope: "principal", caseCreated: caseId !== null, confirmed: false, signalId } };
      }
      case "correction.confirm":
      case "correction.revert": {
        const row = storedCorrection(db, op.correctionId);
        const target = row ? correctionTarget(db, actor, row.targetNoteId, row.targetVer) : undefined;
        if (!row || !target || target.collectionId !== row.scopeId || target.sha256 !== row.targetSha256) throw new ApplyRefused("not-found");
        if (row.stateSeq !== op.expectedSeq || row.state === "reverted") throw new ApplyRefused("correction-stale");
        if (op.kind === "correction.revert") {
          if (row.author !== actor.principal) throw new ApplyRefused("not-found");
          const ev = emit("correction.revert", { correctionId: row.id, priorSeq: row.stateSeq }, { kind: "noop" });
          db.run("INSERT INTO correction_states(seq,correctionId,state,priorSeq,receiptId,createdAt) VALUES (?,?,'reverted',?,NULL,?)", [ev.seq, row.id, row.stateSeq, ts]);
          return { ...ev, result: { correctionId: row.id, state: "reverted" } };
        }
        if (row.state !== "proposed" || !isCurrentCorrection(db, row)) throw new ApplyRefused("correction-stale");
        const receipt = authority.kind === "receipt" ? authority.receipt : undefined;
        const check = correctionReceiptCheck({ db, receipts: deps.receipts, now: ts, ownerPrincipal: deps.correctionOwner }, row, receipt, "consume");
        if (!receipt || !check.ok) throw new ApplyRefused("correction-receipt-refused");
        // No client-supplied confirmer or arbitrary bearer may redeem someone else's receipt.
        if (receipt.principal !== actor.principal) throw new ApplyRefused("correction-receipt-refused");
        const priorReceipt = db.get<Record<string, string | null>>("SELECT * FROM approvals WHERE receiptId=?", [receipt.receiptId]);
        if (priorReceipt) {
          if (priorReceipt.usedAt !== null || Object.entries(receipt).some(([key, value]) => priorReceipt[key] !== value)) throw new ApplyRefused("receipt-used-or-colliding");
          const consumed = db.run("UPDATE approvals SET usedAt=? WHERE receiptId=? AND usedAt IS NULL", [ts, receipt.receiptId]);
          if (consumed.changes !== 1) throw new ApplyRefused("receipt-used-or-colliding");
        } else {
          db.run("INSERT INTO approvals(receiptId,actionKind,actionHash,evidenceHash,principal,credentialId,issuedAt,expiresAt,usedAt,serverSig) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [receipt.receiptId, receipt.actionKind, receipt.actionHash, receipt.evidenceHash, receipt.principal, receipt.credentialId, receipt.issuedAt, receipt.expiresAt, ts, receipt.serverSig]);
        }
        const verification_h = sha256Hex(canonicalJson(check));
        const ev = emit("correction.confirm", { correctionId: row.id, priorSeq: row.stateSeq, receiptId: receipt.receiptId, verification_h, human: !!check.humanEvidence }, { kind: "correction.revert", correctionId: row.id });
        db.run("INSERT INTO correction_states(seq,correctionId,state,priorSeq,receiptId,verification_h,createdAt) VALUES (?,?,'applied',?,?,?,?)", [ev.seq, row.id, row.stateSeq, receipt.receiptId, verification_h, ts]);
        if (row.caseId && check.humanEvidence) db.run("UPDATE cases SET status='confirmed',receiptId=? WHERE caseId=? AND status='unconfirmed'", [receipt.receiptId, row.caseId]);
        return { ...ev, result: { correctionId: row.id, state: "applied", humanConfirmed: !!check.humanEvidence } };
      }
      case "signal.record": {
        const signalId = op.signalId ?? mintId(deps.random);
        const target = `${op.targetNoteId}${op.targetVer ? "@" + op.targetVer : ""}`;
        const q_h = op.query ? putValue(db, op.query) : null;
        db.run("INSERT OR IGNORE INTO signals(signalId, kind, principal, client, scopeId, target, queryId, q_h, strength, ts, interactive, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [signalId, op.signalKind, actor.principal, actor.clientClass, op.scopeId, target, op.queryId ?? null, q_h, op.strength, ts, op.interactive ? 1 : 0, "unconfirmed"]);
        const ev = emit("signal.record", { signalId, signalKind: op.signalKind, target: op.targetNoteId }, { kind: "signal.remove", signalId });
        return { ...ev, result: { signalId } };
      }
      case "case.create": {
        const caseId = op.caseId ?? mintId(deps.random);
        insertCase(db, ts, { caseId, capability: op.capability, scopeId: op.scopeId, privacy: op.privacy, groupKey: op.groupKey, lineageKey: op.lineageKey, inputRef: op.inputRef, frozenFeatures: op.frozenFeatures, expected: op.expected as { noteId: string; label: string }, sourceSignals: op.sourceSignals, author: op.author, client: actor.clientClass });
        const ev = emit("case.create", { caseId, capability: op.capability, scopeId: op.scopeId, privacy: op.privacy, group_h: sha256Hex(op.groupKey) }, { kind: "case.remove", caseId });
        return { ...ev, result: { caseId, split: splitFor(op.groupKey) } };
      }
      case "playbook.put": {
        const body = canonicalJson(op.body);
        const hash = sha256Hex(body);
        db.run("INSERT OR IGNORE INTO playbooks(hash, capability, body, createdAt) VALUES (?,?,?,?)", [hash, op.capability, body, ts]);
        const ev = emit("playbook.put", { capability: op.capability, playbookHash: hash }, { kind: "noop" });
        return { ...ev, result: { playbookHash: hash } };
      }
      case "champion.baseline": {
        // The frozen baseline v0 is the ONLY playbook this op can install, and only as the first row for its key. The
        // capability is checked at runtime (S1c C4); a smuggled hash is ignored because the op carries none.
        if ((op.capability as string) !== "retrieval") throw new ApplyRefused("capability-not-retrieval", "baseline v0 is a retrieval playbook");
        const existing = db.get("SELECT 1 FROM champions WHERE capability=? AND scopeId=? AND privacy=? AND revokedAt IS NULL", [op.capability, op.scopeId, op.privacy]);
        if (existing) throw new ApplyRefused("baseline-exists", "a champion already exists for this key; baseline v0 can only be the first row");
        // A baseline below a scope whose ancestor has a RECEIPTED champion would roll back an owner-approved lesson without a receipt.
        for (const anc of scopeAncestors(db, op.scopeId)) if (db.get("SELECT 1 FROM champions WHERE capability=? AND scopeId=? AND privacy=? AND revokedAt IS NULL AND receiptId IS NOT NULL", [op.capability, anc, op.privacy])) throw new ApplyRefused("ancestor-champion-receipted", `scope ${anc} has an owner-approved champion; a baseline at ${op.scopeId} needs a receipt`);
        db.run("INSERT OR IGNORE INTO playbooks(hash, capability, body, createdAt) VALUES (?,?,?,?)", [BASELINE_V0_HASH, "retrieval", canonicalJson(BASELINE_V0), ts]);
        db.run("INSERT INTO champions(capability, scopeId, privacy, playbookHash, promotedAt, frozenBaseline) VALUES (?,?,?,?,?,1)", [op.capability, op.scopeId, op.privacy, BASELINE_V0_HASH, ts]);
        const ev = emit("champion.baseline", { capability: op.capability, scopeId: op.scopeId, privacy: op.privacy, playbookHash: BASELINE_V0_HASH }, { kind: "noop" });
        return { ...ev, result: { playbookHash: BASELINE_V0_HASH } };
      }
      case "candidate.create": {
        const candidateId = op.candidateId ?? mintId(deps.random);
        db.run("INSERT INTO candidates(candidateId, capability, scopeId, privacy, playbookHash, parentHash, generator, targetGroups, state, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)", [candidateId, op.capability, op.scopeId, op.privacy, op.playbookHash, op.parentHash, op.generator, JSON.stringify(op.targetGroups), "saved", ts]);
        db.run("INSERT INTO evolution(kind, capability, scopeId, privacy, candidateId, playbookHash, ts) VALUES ('candidate',?,?,?,?,?,?)", [op.capability, op.scopeId, op.privacy, candidateId, op.playbookHash, ts]);
        const ev = emit("candidate.create", { candidateId, capability: op.capability, scopeId: op.scopeId, privacy: op.privacy, playbookHash: op.playbookHash, parentHash: op.parentHash }, { kind: "candidate.remove", candidateId });
        return { ...ev, result: { candidateId } };
      }
      case "replay.record": {
        // replay() ran: the look is spent HERE (S1c C1), under the 2-per-key-per-ISO-week budget, and the report is bound to the playbook and generation.
        const week = isoWeek(ts);
        if (op.lookSpent) {
          const looks = db.get<{ c: number }>("SELECT count(*) AS c FROM holdout_looks WHERE capability=? AND scopeId=? AND privacy=? AND isoWeek=?", [op.capability, op.scopeId, op.privacy, week])!.c;
          if (looks >= 2) throw new ApplyRefused("look-budget-exhausted", `2 held-out looks already spent for this key in ${week}`);
          db.run("INSERT INTO holdout_looks(capability, scopeId, privacy, candidateId, isoWeek, ts) VALUES (?,?,?,?,?,?)", [op.capability, op.scopeId, op.privacy, op.playbookHash, week, ts]);
        }
        const ev = emit("replay.record", { capability: op.capability, scopeId: op.scopeId, privacy: op.privacy, playbookHash: op.playbookHash, reportHash: op.reportHash, generation: op.generation, lookSpent: op.lookSpent }, { kind: "noop" });
        db.run("INSERT INTO replays(reportHash, playbookHash, capability, scopeId, privacy, generation, seq, lookSpent, ts) VALUES (?,?,?,?,?,?,?,?,?)", [op.reportHash, op.playbookHash, op.capability, op.scopeId, op.privacy, op.generation, ev.seq, op.lookSpent ? 1 : 0, ts]);
        return { ...ev, result: { reportHash: op.reportHash, seq: ev.seq } };
      }
      case "edge.confirm": {
        // Reached only with a verified owner receipt (policyGate): the edge becomes a label for lineage (S1c C2).
        const receiptId = authority.kind === "receipt" ? authority.receipt?.receiptId ?? null : null;
        const r = db.run("UPDATE edges SET state = 'confirmed', origin = 'receipt' WHERE src = ? AND dst = ? AND type = ?", [op.src, op.dst, op.type]);
        if (r.changes === 0) throw new ApplyRefused("not-found");
        const ev = emit("edge.confirm", { src: op.src, dst: op.dst, type: op.type, receiptId }, { kind: "edge.unconfirm", src: op.src, dst: op.dst, type: op.type });
        return { ...ev, result: { src: op.src, dst: op.dst } };
      }
      case "candidate.grade": {
        // The verdict comes from a REAL replay: the report's hash must match a stored replay record for this candidate's
        // playbook at the current generation (S1c C1). The look was spent by the replay.
        const cand = db.get<{ capability: string; scopeId: string; privacy: string; state: string; playbookHash: string }>("SELECT capability, scopeId, privacy, state, playbookHash FROM candidates WHERE candidateId = ?", [op.candidateId]);
        if (!cand) throw new ApplyRefused("not-found");
        if (cand.state === "deployed") throw new ApplyRefused("already-deployed");
        if (cand.state === "vetoed") throw new ApplyRefused("already-vetoed", "a vetoed candidate is never re-graded");
        const verdict = op.report.verdict;
        if (!["tested", "tested-insufficient", "vetoed"].includes(verdict) || typeof op.report.generation !== "number" || op.report.heldoutLook !== true) throw new ApplyRefused("report-malformed");
        const reportJsonEarly = canonicalJson(op.report);
        const rec = db.get<{ generation: number; seq: number }>("SELECT generation, seq FROM replays WHERE reportHash = ? AND playbookHash = ? AND capability = ? AND scopeId = ? AND privacy = ?", [sha256Hex(reportJsonEarly), cand.playbookHash, cand.capability, cand.scopeId, cand.privacy]);
        if (!rec) throw new ApplyRefused("report-not-replayed", "no replay record matches this report for this candidate's playbook");
        const head = db.get<{ s: number }>("SELECT max(seq) AS s FROM events")!.s;
        if (rec.generation !== head && rec.seq !== head) throw new ApplyRefused("report-not-replayed", `replay ran at generation ${rec.generation}; the ledger head is ${head}`);
        const state = verdict === "tested" ? "tested" : verdict === "vetoed" ? "vetoed" : "graded";
        const reportJson = canonicalJson(op.report);
        db.run("UPDATE candidates SET state = ?, verdict = ?, report = ? WHERE candidateId = ?", [state, verdict, reportJson, op.candidateId]);
        const ev = emit("candidate.grade", { candidateId: op.candidateId, verdict, state, report_h: sha256Hex(reportJson), generation: op.report.generation }, { kind: "noop" });
        return { ...ev, result: { candidateId: op.candidateId, verdict, state } };
      }
      case "champion.promote": {
        // Reached only with a verified receipt (policyGate). In S1 the verifier always refuses, so this is unreachable.
        const c = db.get<{ capability: string; scopeId: string; privacy: string; playbookHash: string }>("SELECT capability, scopeId, privacy, playbookHash FROM candidates WHERE candidateId = ?", [op.candidateId]);
        if (!c) throw new ApplyRefused("not-found");
        const receiptId = authority.kind === "receipt" ? authority.receipt?.receiptId ?? null : null;
        db.run("INSERT INTO champions(capability, scopeId, privacy, playbookHash, candidateId, receiptId, promotedAt) VALUES (?,?,?,?,?,?,?)", [c.capability, c.scopeId, c.privacy, c.playbookHash, op.candidateId, receiptId, ts]);
        db.run("UPDATE candidates SET state = 'deployed' WHERE candidateId = ?", [op.candidateId]);
        const ev = emit("champion.promote", { candidateId: op.candidateId, playbookHash: c.playbookHash, receiptId }, { kind: "champion.revoke", candidateId: op.candidateId });
        return { ...ev, result: { candidateId: op.candidateId } };
      }
      case "note.withdraw": {
        db.run("UPDATE notes SET status = 'withdrawn' WHERE noteId = ?", [op.noteId]);
        const ev = emit("note.withdraw", { noteId: op.noteId }, { kind: "note.unwithdraw", noteId: op.noteId });
        const authzSeq = authz("withdraw", null, { noteId: op.noteId });
        return { ...ev, result: { noteId: op.noteId, authzSeq } };
      }
      case "policy.accept": {
        const min = Number(meta(db, "min_policy_epoch") ?? "0");
        if (op.epoch <= min) throw new ApplyRefused("epoch-rollback"); // strictly newer than the last accepted epoch
        db.run("INSERT INTO policy_acceptances(epoch, policyHash, receiptId, sig, acceptedAt) VALUES (?,?,?,?,?)", [op.epoch, op.policyHash, op.receiptId, op.sig, ts]);
        db.run("UPDATE meta SET value = ? WHERE key = 'min_policy_epoch'", [String(op.epoch)]);
        const ev = emit("policy.accept", { epoch: op.epoch, policyHash: op.policyHash, receiptId: op.receiptId }, { kind: "noop" });
        const authzSeq = authz("policy.accept", null, { epoch: op.epoch, policyHash: op.policyHash });
        return { ...ev, result: { epoch: op.epoch, authzSeq } };
      }
      case "evidence.publish": {
        const head = db.get<{ sequence: number }>("SELECT max(sequence) AS sequence FROM evidence_snapshots");
        if (head?.sequence != null && op.sequence <= head.sequence) throw new ApplyRefused("sequence-not-monotonic");
        db.run("INSERT INTO evidence_snapshots(sequence, snapshotId, generatedAt, digest, contentDigest, body, sig, keyId) VALUES (?,?,?,?,?,?,?,?)", [op.sequence, op.snapshotId, ts, op.digest, op.contentDigest, op.body, op.sig, op.keyId]);
        const ev = emit("evidence.publish", { snapshotId: op.snapshotId, sequence: op.sequence, digest: op.digest, keyId: op.keyId }, { kind: "noop" });
        enqueue(mintId(deps.random), "evidence.publish", String(op.sequence), `evidence:${op.sequence}`);
        return { ...ev, result: { sequence: op.sequence } };
      }
      default: throw new ApplyRefused("unknown-op");
    }
  });
}

function bindIdempotency(db: SqlDriver, principal: string, key: string, noteId: string, ver: number, sha256: string, ts: string): void {
  const idem_h = sha256Hex(key);
  const prior = db.get<{ sha256: string }>("SELECT sha256 FROM idempotency WHERE key_h = ? AND principal = ?", [idem_h, principal]);
  if (prior && prior.sha256 !== sha256) throw new ApplyRefused("idempotency-key-conflict");
  if (!prior) db.run("INSERT INTO idempotency(key_h, principal, noteId, ver, sha256, createdAt) VALUES (?,?,?,?,?,?)", [idem_h, principal, noteId, ver, sha256, ts]);
}

function createVersion(deps: ApplyDeps, actor: Actor, op: Extract<Op, { kind: "version.create" }>, ts: string, emit: Emit, enqueue: Enqueue): ApplyResult {
  const { db } = deps;
  const done = (result: Record<string, unknown>, ev?: { seq: number; hash: string }) => {
    releasePending(db, op.sha256, op.pendingRefId);
    if (result.deduped && op.idempotencyKey) bindIdempotency(db, actor.principal, op.idempotencyKey, result.noteId as string, result.ver as number, op.sha256, ts);
    return { seq: ev?.seq ?? 0, hash: ev?.hash ?? "", result };
  };
  const col = db.get<{ class: string }>("SELECT class FROM collections WHERE collectionId = ?", [op.collectionId]);
  if (!col) throw new ApplyRefused("collection.not-found");
  // Idempotency keys are bound to their bytes: a reused key with different bytes is a conflict; a replay returns the stored version.
  const idem_h = op.idempotencyKey ? sha256Hex(op.idempotencyKey) : null;
  if (idem_h) {
    const prior = db.get<{ noteId: string; ver: number; sha256: string }>("SELECT noteId, ver, sha256 FROM idempotency WHERE key_h = ? AND principal = ?", [idem_h, actor.principal]);
    if (prior) {
      if (prior.sha256 !== op.sha256) throw new ApplyRefused("idempotency-key-conflict");
      const v = db.get<{ vstatus: string }>("SELECT vstatus FROM versions WHERE noteId = ? AND ver = ?", [prior.noteId, prior.ver])!;
      return done({ noteId: prior.noteId, ver: prior.ver, status: v.vstatus, deduped: true, idempotent: true, sha256: prior.sha256 });
    }
  }
  const path_h = op.path ? putValue(db, op.path) : null;
  const title_h = op.title ? putValue(db, op.title) : null;
  // The caller (Catalog.save) resolved the target note under the saver's ACL. apply() never looks up aliases by itself:
  // a note the caller cannot read must get exactly the answer a brand-new note would.
  let noteId = op.noteId;
  const note = noteId ? db.get<{ noteId: string; currentVer: number; status: string; folderId: string | null; collectionId: string }>("SELECT noteId, currentVer, status, folderId, collectionId FROM notes WHERE noteId = ?", [noteId]) : undefined;
  if (noteId && !note) throw new ApplyRefused("not-found");
  if (note && note.collectionId !== op.collectionId) throw new ApplyRefused("collection-mismatch");
  if (note) refuseIfWithdrawn(db, note.noteId);
  if (op.supersedes) refuseIfWithdrawn(db, op.supersedes);

  let ver = 1, parentVer: number | null = null, vstatus: "current" | "sibling" | "proposed-edit" = "current", noteStatus = "current";
  if (note) {
    if (op.baseVer !== undefined && !db.get("SELECT 1 FROM versions WHERE noteId = ? AND ver = ?", [note.noteId, op.baseVer])) throw new ApplyRefused("base-version-not-found");
    const cur = db.get<{ sha256: string }>("SELECT sha256 FROM versions WHERE noteId = ? AND ver = ?", [note.noteId, note.currentVer]);
    if (cur && cur.sha256 === op.sha256) return done({ noteId: note.noteId, ver: note.currentVer, status: "current", deduped: true, sha256: op.sha256 });
    const pushedFolder = note.folderId !== null;
    if (op.baseVer === undefined) { parentVer = note.currentVer; if (pushedFolder) vstatus = "proposed-edit"; }
    else if (op.baseVer !== note.currentVer) { vstatus = "sibling"; parentVer = op.baseVer; noteStatus = "conflict"; } // CAS failed: sibling, note marked conflict, currentVer unchanged
    else parentVer = note.currentVer;
    // Non-current saves are idempotent too: an existing version with the same bytes and parent is returned as deduped.
    const twin = db.get<{ ver: number; vstatus: string }>("SELECT ver, vstatus FROM versions WHERE noteId = ? AND sha256 = ? AND parentVer IS ? ", [note.noteId, op.sha256, parentVer]);
    if (twin && twin.vstatus === "proposed-edit" && vstatus === "current" && op.baseVer === note.currentVer) {
      // The proposal was applied in the vault and pushed back as the same bytes against the current version: promote it (S1c B1).
      db.run("UPDATE versions SET vstatus = 'current' WHERE noteId = ? AND ver = ?", [note.noteId, twin.ver]);
      db.run("UPDATE notes SET currentVer = ?, title_h = COALESCE(?, title_h) WHERE noteId = ?", [twin.ver, title_h, note.noteId]);
      const ev = emit("version.promote", { noteId: note.noteId, ver: twin.ver, parentVer, sha256: op.sha256 }, { kind: "version.demote", noteId: note.noteId, ver: twin.ver, previousCurrentVer: note.currentVer });
      enqueue(mintId(deps.random), "mirror.meta", `${note.noteId}@${twin.ver}`, `mirror:${note.noteId}@${twin.ver}:promote`);
      return done({ noteId: note.noteId, ver: twin.ver, status: "current", deduped: true, sha256: op.sha256 }, ev);
    }
    if (twin) return done({ noteId: note.noteId, ver: twin.ver, status: twin.vstatus, deduped: true, sha256: op.sha256 });
    ver = db.get<{ m: number }>("SELECT max(ver) AS m FROM versions WHERE noteId = ?", [note.noteId])!.m + 1;
  } else {
    noteId = mintNoteId(deps.random);
    while (db.get("SELECT 1 FROM notes WHERE noteId = ?", [noteId])) noteId = mintNoteId(deps.random);
    db.run("INSERT INTO notes(noteId, collectionId, folderId, currentVer, title_h, kind, status, privacy_class) VALUES (?,?,?,?,?,?,?,?)", [noteId, op.collectionId, op.folderId ?? null, 0, title_h, op.noteKind, "current", op.privacyClass]);
    // A live alias held by a note the caller cannot see is left untouched; the new note gets a SHADOW alias in the saver's own
    // namespace (owner = principal), so identical saves resolve to it and stay idempotent without revealing the holder (S1c B2).
    if (path_h && !op.aliasBlocked && !db.get("SELECT 1 FROM aliases WHERE collectionId = ? AND path_h = ? AND valid_to IS NULL AND owner IS NULL AND folderId IS ?", [op.collectionId, path_h, op.folderId ?? null])) db.run("INSERT INTO aliases(collectionId, folderId, path_h, noteId, valid_from) VALUES (?,?,?,?,?)", [op.collectionId, op.folderId ?? null, path_h, noteId, ts]);
    else if (path_h && op.aliasBlocked) db.run("INSERT OR IGNORE INTO aliases(collectionId, folderId, path_h, noteId, valid_from, owner) VALUES (?,?,?,?,?,?)", [op.collectionId, op.folderId ?? null, path_h, noteId, ts, actor.principal]);
  }
  // Custody follows the check: the row is inserted as received; the post-commit HEAD + SHA-256 step promotes it.
  db.run("INSERT INTO versions(noteId, ver, parentVer, sha256, bytes, origin, privacy_class, role, vstatus, observedMtime, capturedAt, publishedAt, lastVerifiedAt, custody, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [noteId!, ver, parentVer, op.sha256, op.bytes, op.origin, op.privacyClass, op.role, vstatus, op.observedMtime ?? null, op.capturedAt, ts, ts, "received", op.held ? 1 : 0]);
  // The class set: a reader needs every member (S1c A1/A2). A single class is a one-member set.
  for (const c of splitClassSet(op.privacyClass)) db.run("INSERT INTO version_classes(noteId, ver, class) VALUES (?,?,?)", [noteId!, ver, c]);
  // Fenced lifetime: the reference is counted and the row becomes live; this save's pending ref is released.
  const pend = db.get<{ pendingRefs: string }>("SELECT pendingRefs FROM blob_refs WHERE sha256 = ?", [op.sha256]);
  const remaining = pend ? (JSON.parse(pend.pendingRefs) as string[]).filter((r) => r !== op.pendingRefId) : [];
  db.run("INSERT INTO blob_refs(sha256, refcount, state, pendingRefs) VALUES (?,1,'live','[]') ON CONFLICT(sha256) DO UPDATE SET refcount = refcount + 1, state = 'live', pendingRefs = ?", [op.sha256, JSON.stringify(remaining)]);
  if (vstatus === "current") db.run("UPDATE notes SET currentVer = ?, title_h = COALESCE(?, title_h) WHERE noteId = ?", [ver, title_h, noteId!]); // status is never derived here
  else if (noteStatus === "conflict") db.run("UPDATE notes SET status = 'conflict' WHERE noteId = ? AND status = 'current'", [noteId!]);
  if (op.supersedes) {
    // Origins: receipt | mcp-proposal | rule | model. Only receipt counts as human-confirmed (DESIGN §4.1).
    db.run("INSERT OR IGNORE INTO edges(src, dst, type, origin, confidence, state) VALUES (?,?,?,?,?,?)", [noteId!, op.supersedes, "supersedes", actor.clientClass === "kl-device" ? "rule" : "mcp-proposal", 1.0, "proposed"]);
  }
  if (op.idempotencyKey) bindIdempotency(db, actor.principal, op.idempotencyKey, noteId!, ver, op.sha256, ts);
  const payload: Record<string, unknown> = { noteId: noteId!, ver, parentVer, sha256: op.sha256, bytes: op.bytes, collectionId: op.collectionId, classes: splitClassSet(op.privacyClass), role: op.role, status: vstatus, path_h, title_h, origin: op.origin, idem: idem_h };
  const ev = emit("version.create", payload, { kind: "version.remove", noteId: noteId!, ver });
  const opId = mintId(deps.random);
  enqueue(opId, "custody.verify", `${noteId}@${ver}`, `custody:${noteId}@${ver}`);
  enqueue(opId, "index.version", `${noteId}@${ver}`, `index:${noteId}@${ver}`);
  enqueue(opId, "mirror.meta", `${noteId}@${ver}`, `mirror:${noteId}@${ver}`);
  return { ...ev, result: { noteId: noteId!, ver, status: vstatus, deduped: false, noteStatus, custody: "received", sha256: op.sha256 } };
}
