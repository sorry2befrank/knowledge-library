// Durable correction projections. Writes remain exclusively in apply.ts. No receipt issuance.
import type { SqlDriver } from "./driver.ts";
import { aclPredicate, loadAcl, type Actor } from "./acl.ts";
import type { ApprovalReceipt, ReceiptVerifier, CorrectionReceiptCheck } from "./receipts.ts";
import { getValue } from "./ledger.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import { versionCitation } from "../primitives/citation.ts";
import { foldCorrectionLedger, type CorrectionRow } from "../understudy/reference-corrections.ts";

export interface StoredCorrection {
  id: string; eventSeq: number; author: string; client: string; scopeId: string;
  targetNoteId: string; targetVer: number; targetSha256: string;
  topic_h: string; topicKey_h: string; statement_h: string; evidenceCite_h: string;
  supersedes: string | null; caseId: string | null; createdAt: string;
  state: "proposed" | "applied" | "reverted"; stateSeq: number; receiptId: string | null;
}
export interface CorrectionViewRow extends CorrectionRow {
  evidenceCite: string; supersedes: string | null;
  publication: "issuer-only" | "receipt";
}
export interface CorrectionProjection {
  live: CorrectionViewRow[]; heldUnderNext: CorrectionViewRow[]; disputedIds: string[];
}
export interface CorrectionReadDeps {
  db: SqlDriver; receipts: ReceiptVerifier; now: string; ownerPrincipal?: string;
}

const SELECT = `SELECT c.*, COALESCE(s.state,'proposed') AS state,
  COALESCE(s.seq,c.eventSeq) AS stateSeq, s.receiptId
  FROM corrections c LEFT JOIN correction_states s ON s.seq =
    (SELECT max(s2.seq) FROM correction_states s2 WHERE s2.correctionId=c.id)`;

export function storedCorrection(db: SqlDriver, id: string): StoredCorrection | undefined {
  const row = db.get<StoredCorrection>(`${SELECT} WHERE c.id=?`, [id]);
  return row && validCorrectionRecord(db, row) ? row : undefined;
}

export function correctionRecordHash(row: Pick<StoredCorrection, "id" | "author" | "client" | "scopeId" | "targetNoteId" | "targetVer" | "targetSha256" | "topic_h" | "topicKey_h" | "statement_h" | "evidenceCite_h" | "supersedes" | "caseId" | "createdAt">): string {
  return sha256Hex(canonicalJson({ id: row.id, author: row.author, client: row.client, scopeId: row.scopeId,
    targetNoteId: row.targetNoteId, targetVer: row.targetVer, targetSha256: row.targetSha256,
    topic_h: row.topic_h, topicKey_h: row.topicKey_h, statement_h: row.statement_h,
    evidenceCite_h: row.evidenceCite_h, supersedes: row.supersedes, caseId: row.caseId, createdAt: row.createdAt }));
}

function validCorrectionRecord(db: SqlDriver, row: StoredCorrection): boolean {
  const event = db.get<{ principal: string; client: string; kind: string; payload: string }>("SELECT principal,client,kind,payload FROM events WHERE seq=?", [row.eventSeq]);
  try { return !!event && event.kind === "feedback.record" && event.principal === row.author && event.client === row.client
    && JSON.parse(event.payload).correction_h === correctionRecordHash(row); } catch { return false; }
}

export function isCurrentCorrection(db: SqlDriver, row: StoredCorrection): boolean {
  const current = db.get<{ id: string }>(`${SELECT} WHERE c.author=? AND c.scopeId=?
    AND c.targetNoteId=? AND c.targetVer=? AND c.topicKey_h=?
    AND COALESCE(s.state,'proposed')!='reverted' ORDER BY c.eventSeq DESC LIMIT 1`,
    [row.author, row.scopeId, row.targetNoteId, row.targetVer, row.topicKey_h]);
  return current?.id === row.id;
}

/** Version, collection and active principal are checked before any correction text is read. */
export function correctionTarget(db: SqlDriver, actor: Actor, noteId: string, ver: number) {
  const access = aclPredicate(loadAcl(db, actor));
  return db.get<{ collectionId: string; sha256: string; class: string; privacy_class: string }>(
    `SELECT n.collectionId,v.sha256,col.class,v.privacy_class FROM versions v
     JOIN notes n ON n.noteId=v.noteId JOIN collections col ON col.collectionId=n.collectionId
     WHERE v.noteId=? AND v.ver=? AND n.status NOT IN ('withdrawn','purge-pending')
     AND v.custody IN ('verified','indexed') AND ${access.sql}`, [noteId, ver, ...access.params]);
}

export function correctionAction(row: StoredCorrection) {
  return { kind: "correction.confirm" as const, correctionId: row.id, expectedSeq: row.stateSeq };
}

/** Hashes bind all immutable content, including its exact target version and selected case. */
export function correctionEvidenceHash(row: StoredCorrection): string {
  return sha256Hex(canonicalJson({ id: row.id, eventSeq: row.eventSeq, expectedSeq: row.stateSeq,
    author: row.author, client: row.client, scopeId: row.scopeId, targetNoteId: row.targetNoteId,
    targetVer: row.targetVer, targetSha256: row.targetSha256, topic_h: row.topic_h,
    topicKey_h: row.topicKey_h, statement_h: row.statement_h, evidenceCite_h: row.evidenceCite_h,
    supersedes: row.supersedes, caseId: row.caseId, recordHash: correctionRecordHash(row) }));
}

export function correctionReceiptCheck(deps: CorrectionReadDeps, row: StoredCorrection,
  receipt: ApprovalReceipt | undefined, phase: "consume" | "project", usedAt?: string): CorrectionReceiptCheck {
  const refused = { ok: false as const, reason: "correction-receipt-invalid" };
  if (!receipt || !deps.receipts.verifyCorrection || !deps.ownerPrincipal) return refused;
  const useTime = Date.parse(phase === "consume" ? deps.now : usedAt ?? "");
  const issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt);
  if (![useTime, issued, expires, Date.parse(deps.now)].every(Number.isFinite)
    || issued > useTime || useTime >= expires || useTime > Date.parse(deps.now)) return refused;
  const actionHash = sha256Hex(canonicalJson(correctionAction(row)));
  const evidenceHash = correctionEvidenceHash(row);
  if (receipt.actionKind !== "correction.confirm" || receipt.actionHash !== actionHash
    || receipt.evidenceHash !== evidenceHash
    || !deps.db.get("SELECT 1 FROM principals WHERE id=? AND status='active'", [receipt.principal])) return refused;
  try {
    // Same trusted verifier service, specialized evidence/provenance contract; no fallback to verify().
    const checked = deps.receipts.verifyCorrection(receipt, {
      actionKind: "correction.confirm", actionHash, evidenceHash, scopeId: row.scopeId,
      target: `${row.targetNoteId}@${row.targetVer}`, correctionId: row.id, caseId: row.caseId,
      expectedSeq: row.stateSeq, now: deps.now, phase, consumedAt: usedAt ?? null,
    });
    if (!checked.ok) return checked;
    const collection = deps.db.get<{ class: string }>("SELECT class FROM collections WHERE collectionId=?", [row.scopeId]);
    if (!["owner", "partner", "delegated"].includes(checked.authority)
      || checked.confirmer !== receipt.principal
      || (checked.authority === "owner" && checked.confirmer !== deps.ownerPrincipal)
      || (checked.authority === "partner" && collection?.class !== "team")) return refused;
    // A signed delegate action is never independent human truth.
    if (checked.humanEvidence && (checked.authority === "delegated"
      || checked.humanEvidence.principal !== checked.confirmer
      || !row.caseId || checked.humanEvidence.caseId !== row.caseId
      || checked.humanEvidence.evidenceHash !== evidenceHash)) return refused;
    return checked;
  } catch { return refused; }
}

/** Recheck the receipt's current authority, while expiry binds its original atomic consumption. */
export function currentCorrectionReceipt(deps: CorrectionReadDeps, row: StoredCorrection): CorrectionReceiptCheck {
  const refused = { ok: false as const, reason: "correction-unconfirmed" };
  if (row.state !== "applied" || !row.receiptId) return refused;
  const state = deps.db.get<{ priorSeq: number; appliedAt: string; verification_h: string }>(
    "SELECT priorSeq,createdAt AS appliedAt,verification_h FROM correction_states WHERE seq=? AND correctionId=? AND state='applied'", [row.stateSeq, row.id]);
  const receipt = deps.db.get<ApprovalReceipt & { usedAt: string | null }>("SELECT * FROM approvals WHERE receiptId=?", [row.receiptId]);
  if (!state || !receipt?.usedAt || receipt.usedAt !== state.appliedAt) return refused;
  const checked = correctionReceiptCheck(deps, { ...row, stateSeq: state.priorSeq }, receipt, "project", receipt.usedAt);
  return checked.ok && sha256Hex(canonicalJson(checked)) === state.verification_h ? checked : refused;
}

function authorizedRows(deps: CorrectionReadDeps, actor: Actor, scopeId?: string): StoredCorrection[] {
  const access = aclPredicate(loadAcl(deps.db, actor));
  const rows = deps.db.all<StoredCorrection>(`${SELECT}
    JOIN versions v ON v.noteId=c.targetNoteId AND v.ver=c.targetVer AND v.sha256=c.targetSha256
    JOIN notes n ON n.noteId=v.noteId AND n.collectionId=c.scopeId
    JOIN collections col ON col.collectionId=n.collectionId
    WHERE n.status NOT IN ('withdrawn','purge-pending') AND v.custody IN ('verified','indexed')
    AND ${access.sql} ${scopeId ? "AND c.scopeId=?" : ""} ORDER BY c.eventSeq`,
    [...access.params, ...(scopeId ? [scopeId] : [])]);
  // Broken persisted projections cannot silently fall back to an older correction.
  return rows.every(row => validCorrectionRecord(deps.db, row)) ? rows : [];
}

function latest(rows: StoredCorrection[]): StoredCorrection[] {
  const byAuthor = new Map<string, StoredCorrection>();
  for (const row of rows) {
    if (row.state === "reverted") continue;
    byAuthor.set(JSON.stringify([row.scopeId, row.targetNoteId, row.targetVer, row.author, row.topicKey_h]), row);
  }
  return [...byAuthor.values()];
}

export function projectStoredCorrections(deps: CorrectionReadDeps, actor: Actor, scopeId?: string): CorrectionProjection {
  const visible = authorizedRows(deps, actor, scopeId).map(row => ({ row, published: currentCorrectionReceipt(deps, row).ok }))
    .filter(({ row, published }) => row.author === actor.principal || published);
  // Visibility precedes both topic folding and text lookup; no hidden row can affect public counts.
  const rows: CorrectionViewRow[] = visible.map(({ row, published }) => ({
    id: row.id, author: row.author, client: row.client, scope: row.scopeId,
    target: `${row.targetNoteId}@${row.targetVer}`, topic: getValue(deps.db, row.topic_h) ?? "",
    statement: getValue(deps.db, row.statement_h) ?? "", state: row.state, ts: row.createdAt,
    evidenceCite: getValue(deps.db, row.evidenceCite_h) ?? "", supersedes: row.supersedes,
    publication: published ? "receipt" : "issuer-only",
  }));
  const fold = foldCorrectionLedger(rows, deps.ownerPrincipal ?? "");
  return { live: fold.live as CorrectionViewRow[], heldUnderNext: fold.heldUnderNext as CorrectionViewRow[], disputedIds: fold.disputedIds };
}

/** Internal label gate, not a public count/render API. Conflicts use hashes, never hidden text. */
export function correctionCaseEligible(deps: CorrectionReadDeps, caseId: string): boolean {
  const row = deps.db.get<{ id: string }>("SELECT id FROM corrections WHERE caseId=?", [caseId]);
  const current = row ? storedCorrection(deps.db, row.id) : undefined;
  if (!current) return false;
  const actor: Actor = { principal: current.author, clientClass: current.client as Actor["clientClass"] };
  const active = latest(authorizedRows(deps, actor, current.scopeId));
  if (!active.some(r => r.id === current.id)) return false;
  const check = currentCorrectionReceipt(deps, current);
  if (!check.ok || !check.humanEvidence) return false;
  const disputed = active.some(other => other.author !== current.author
    && other.targetNoteId === current.targetNoteId && other.targetVer === current.targetVer
    && other.topicKey_h === current.topicKey_h && other.statement_h !== current.statement_h);
  return !disputed;
}

export function evidenceCitation(row: { targetNoteId: string; targetVer: number; targetSha256: string }): string {
  return versionCitation(row.targetNoteId, row.targetVer, row.targetSha256);
}
