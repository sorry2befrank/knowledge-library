// library-evidence/v1 producer (DESIGN §8.3). Content-free: ids, hashes, counts, enums, timestamps.
// Published through apply(evidence.publish) and the outbox to outbox/orrery/; duplicates are no-ops.
import type { Catalog } from "../catalog/catalog.ts";
import { mintId } from "../primitives/ids.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { validateEvidence } from "@kl/contracts/worker";
import { toBase64Url } from "../primitives/base64url.ts";
import { BUILD_DESIGN_SPEC } from "./design-spec.generated.ts";

/** The evidence-producer signing key: a production Worker secret; a generated key in tests. */
export interface EvidenceSigner { keyId: string; sign(bytes: Uint8Array): Promise<Uint8Array> }

export async function ed25519Signer(privateKey: CryptoKey, keyId: string): Promise<EvidenceSigner> {
  return { keyId, sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) };
}

export interface ProducerConfig {
  producerVersion: string; keyId: string; specRevision?: string; specHash?: string; policyRevision: string; mappingRevision: string;
  integrationProjectId: string; collectionId: string; folderId: string | null; authorizedCollections: string[]; milestonesEnabled: ("ingest-custody" | "retrieval-index" | "recovery" | "focus")[];
  staleAfterSeconds?: number; maxOperations?: number;
}

export function countUnknowns(v: unknown): number {
  if (v === "unknown") return 1;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + countUnknowns(x), 0);
  if (v && typeof v === "object") return Object.values(v as object).reduce((n: number, x) => n + countUnknowns(x), 0);
  return 0;
}

export function produceEvidence(catalog: Catalog, cfg: ProducerConfig): Record<string, unknown> {
  if ((cfg.specRevision === undefined) !== (cfg.specHash === undefined)) throw new Error("specRevision and specHash must be supplied together");
  const t0 = performance.now();
  const { db } = catalog;
  const now = catalog.clock.now();
  const maxOps = Math.min(cfg.maxOperations ?? 100, 100);
  const cols = cfg.authorizedCollections;
  const colMarks = cols.length ? cols.map(() => "?").join(",") : "''";
  const inScope = (sql: string, params: (string | number)[] = []) => db.get<{ c: number }>(sql, params)!.c;
  // Everything below is filtered to the authorized collections: counts, operations and conflicts alike.
  const custody = {
    receivedOnly: inScope(`SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.custody = 'received'`, cols),
    verifiedNotIndexed: inScope(`SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.custody = 'verified'`, cols),
    indexed: inScope(`SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.custody = 'indexed'`, cols),
  };
  // Preserved means VERIFIED custody only (ruling 7): received-only versions are not preserved.
  const preserved = custody.verifiedNotIndexed + custody.indexed;
  // Operations: per version in scope an ingest-custody attempt and a retrieval-index attempt. Proofs cite the version.custody
  // ledger event (verified / indexed), never version.create. Blocked and unproven attempts are listed BEFORE verified ones
  // and only the tail is truncated (ruling 6), so a truncated snapshot still shows every pending version first.
  type VRow = { noteId: string; ver: number; sha256: string; custody: string; lastVerifiedAt: string; publishedAt: string; createSeq: number };
  const versionsIn = (where: string, limit: number) => db.all<VRow>(`SELECT v.noteId, v.ver, v.sha256, v.custody, v.lastVerifiedAt, v.publishedAt, (SELECT e.seq FROM events e WHERE e.kind = 'version.create' AND json_extract(e.payload, '$.noteId') = v.noteId AND json_extract(e.payload, '$.ver') = v.ver) AS createSeq FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND ${where} ORDER BY v.publishedAt DESC, v.noteId, v.ver DESC LIMIT ?`, [...cols, limit]);
  const custodyEvent = (noteId: string, ver: number, custodyState: string) => db.get<{ seq: number; ts: string }>("SELECT seq, ts FROM events WHERE kind = 'version.custody' AND json_extract(payload, '$.noteId') = ? AND json_extract(payload, '$.ver') = ? AND json_extract(payload, '$.custody') = ? ORDER BY seq LIMIT 1", [noteId, ver, custodyState]);
  const opBase = (seq: number | null, tag: string, milestone: string, sv: string) => ({ operationId: sha256Hex(`op:${seq ?? sv}:${tag}`).slice(0, 32), runId: null, planId: null, goalHash: null, policyHash: null, milestone, reasonCode: null, sourceVersion: sv });
  const opsFor = (v: VRow): Record<string, unknown>[] => {
    const sv = `${v.noteId}@${v.ver}`;
    const verifiedEv = v.custody !== "received" ? custodyEvent(v.noteId, v.ver, "verified") : undefined;
    const indexedEv = v.custody === "indexed" ? custodyEvent(v.noteId, v.ver, "indexed") : undefined;
    const bare = { sourceVersion: sv, sourceHash: v.sha256 };
    const proof = verifiedEv ? { ...bare, custodyReceipt: `ev-${verifiedEv.seq}` } : bare;
    const custodyOp = verifiedEv
      ? { ...opBase(v.createSeq, "custody", "ingest-custody", sv), stage: "COMMITTED", result: "completed", timestamps: { RECEIVED: v.publishedAt, COMMITTED: verifiedEv.ts }, proof }
      : { ...opBase(v.createSeq, "custody", "ingest-custody", sv), stage: "RECEIVED", result: "pending", timestamps: { RECEIVED: v.publishedAt }, proof: bare };
    const indexOp = indexedEv
      ? { ...opBase(v.createSeq, "index", "retrieval-index", sv), stage: "INDEXED", result: "completed", timestamps: { COMMITTED: verifiedEv!.ts, INDEXED: indexedEv.ts }, proof }
      : { ...opBase(v.createSeq, "index", "retrieval-index", sv), stage: verifiedEv ? "COMMITTED" : "RECEIVED", result: "pending", timestamps: verifiedEv ? { RECEIVED: v.publishedAt, COMMITTED: verifiedEv.ts } : { RECEIVED: v.publishedAt }, proof: bare };
    return [custodyOp, indexOp];
  };
  let ops: Record<string, unknown>[] = [];
  // Every non-indexed version contributes at least one pending operation. Read up to maxOps
  // versions before sorting operations: limiting to half the operation budget can omit an older
  // pending custody attempt while retaining newer verified custody attempts. If more versions
  // remain unseen here, the selected pending operations alone already fill the whole budget.
  for (const v of versionsIn("v.custody != 'indexed'", maxOps)) ops.push(...opsFor(v));
  for (const v of versionsIn("v.custody = 'indexed'", Math.ceil(maxOps / 2))) { if (ops.length + 2 > maxOps) break; ops.push(...opsFor(v)); }
  // Ruling 6: every blocked or unproven attempt before any verified one (a verified-not-indexed version has one of each).
  ops.sort((a, b) => Number(a.result === "completed") - Number(b.result === "completed"));
  ops = ops.slice(0, maxOps);
  const totalVersions = custody.receivedOnly + custody.verifiedNotIndexed + custody.indexed;
  const totalOps = 2 * totalVersions;
  const omitted = Math.max(0, totalOps - ops.length);
  // Freshness: the server's record of the latest successful kl-device push in scope, or null when there has been none.
  const lastSync = db.get<{ t: string | null }>(`SELECT max(v.publishedAt) AS t FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.origin LIKE '%@kl-device'`, cols)?.t ?? null;
  const holds = inScope(`SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.held = 1`, cols);
  // Learning needs collection scope as well as privacy class: two collections may share a class.
  // A global learner is included only when the snapshot covers every collection in its class.
  // Folder learners inherit their recorded collection; unknown scopes are excluded.
  const scopeClasses = [...new Set(db.all<{ class: string }>(`SELECT class FROM collections WHERE collectionId IN (${colMarks})`, cols).map((r) => r.class))];
  const classMarks = scopeClasses.length ? scopeClasses.map(() => "?").join(",") : "''";
  const learningScope = (alias: string) => `${alias}.privacy IN (${classMarks}) AND (${alias}.scopeId IN (${colMarks}) OR ${alias}.scopeId IN (SELECT folderId FROM folders WHERE collectionId IN (${colMarks})) OR (${alias}.scopeId = 'global' AND NOT EXISTS (SELECT 1 FROM collections scoped WHERE scoped.class = ${alias}.privacy AND scoped.collectionId NOT IN (${colMarks}))))`;
  const learningParams = [...scopeClasses, ...cols, ...cols, ...cols];
  const candidateCount = (extra = "1 = 1") => inScope(`SELECT count(*) AS c FROM candidates ca WHERE ${extra} AND ${learningScope("ca")}`, learningParams);
  const championCount = (extra: string) => inScope(`SELECT count(*) AS c FROM champions ch WHERE ${extra} AND ${learningScope("ch")}`, learningParams);
  const promotions = championCount("ch.frozenBaseline = 0 AND ch.revokedAt IS NULL");
  const lastSeq = db.get<{ s: number | null }>("SELECT max(sequence) AS s FROM evidence_snapshots")?.s ?? 0;
  const obs = Object.fromEntries(db.all<{ kind: string; c: number }>(`SELECT s.kind, count(*) AS c FROM signals s JOIN notes n ON n.noteId = substr(s.target, 1, 10) WHERE n.collectionId IN (${colMarks}) GROUP BY s.kind`, cols).map((r) => [r.kind, r.c]));
  const doc: Record<string, unknown> = {
    schemaVersion: "library-evidence/v1", producer: { id: "knowledge-library", version: cfg.producerVersion, keyId: cfg.keyId },
    snapshotId: mintId(catalog.random), sequence: lastSeq + 1, generatedAt: now, observedAt: now,
    spec: { revision: cfg.specRevision ?? BUILD_DESIGN_SPEC.revision, hash: cfg.specHash ?? BUILD_DESIGN_SPEC.hash }, policyRevision: cfg.policyRevision, mappingRevision: cfg.mappingRevision,
    scope: { authorizedCollections: cols, milestonesEnabled: cfg.milestonesEnabled }, traceId: mintId(catalog.random), terminalReceiptId: `ev-${catalog.head().seq}`,
    identity: { integrationProjectId: cfg.integrationProjectId, collectionId: cfg.collectionId, folderId: cfg.folderId },
    operations: ops,
    state: { custody, indexing: { preserved, extracted: custody.indexed, indexed: custody.indexed, accessible: "unknown", unsupported: 0, pending: custody.receivedOnly + custody.verifiedNotIndexed }, localPresence: { present: "unknown", focusHeld: 0, absentLocally: 0, unknown: preserved }, availability: "online", backupAgeHours: "unknown", lastRestoreDrill: null,
      conflicts: inScope(`SELECT count(*) AS c FROM notes WHERE status = 'conflict' AND collectionId IN (${colMarks})`, cols), holds },
    learning: { proposals: candidateCount(), evaluations: candidateCount("ca.state IN ('tested','graded','vetoed','deployed')"), promotions, reversions: championCount("ch.revokedAt IS NOT NULL"), trustRevision: { scopeId: "global", revision: "ladder-v0" }, confirmingReceiptId: promotions > 0 ? (db.get<{ r: string }>(`SELECT ch.receiptId AS r FROM champions ch WHERE ch.frozenBaseline = 0 AND ch.revokedAt IS NULL AND ${learningScope("ch")} ORDER BY ch.id DESC LIMIT 1`, learningParams)?.r ?? null) : null, observationCounts: obs },
    measurement: { notesRemovedFromWorkingFolders: 0, notesHeld: 0, notesVeiled: 0, bytesLogicallyPreserved: inScope(`SELECT coalesce(sum(v.bytes),0) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId IN (${colMarks}) AND v.custody != 'received'`, cols), bytesReclaimedMeasured: 0, incompleteCount: custody.receivedOnly + custody.verifiedNotIndexed, unknownCount: 0, durationMs: 0, adapterCostMs: "unknown" },
    freshness: { lastSuccessfulSync: lastSync, staleAfterSeconds: cfg.staleAfterSeconds ?? 900, lastKnownSnapshotId: db.get<{ s: string }>("SELECT snapshotId AS s FROM evidence_snapshots ORDER BY sequence DESC LIMIT 1")?.s ?? null },
    truncated: { operations: omitted > 0, ...(omitted > 0 ? { omittedOperations: omitted } : {}) },
  };
  const m = doc.measurement as Record<string, unknown>;
  m.unknownCount = countUnknowns(doc);           // counted from the fields that actually say "unknown"
  m.durationMs = Math.max(0, Math.round(performance.now() - t0)); // measured, not asserted
  return doc;
}

/** Digest over the evidential content only (not ids, times, sequence or the publish receipt), so an unchanged state coalesces to a no-op. */
export function evidenceDigest(doc: Record<string, unknown>): string {
  const pick = ["schemaVersion", "producer", "spec", "policyRevision", "mappingRevision", "scope", "identity", "operations", "state", "learning", "truncated"];
  const m = { ...(doc.measurement as Record<string, unknown>) }; delete m.durationMs; // measured each time; not evidence of change
  return sha256Hex(canonicalJson({ ...Object.fromEntries(pick.map((k) => [k, doc[k]])), measurement: m }));
}

export type PublishResult = { published: true; sequence: number; snapshotId: string } | { published: false; reason: "duplicate" | "invalid"; errors?: string[] };

export async function publishEvidence(catalog: Catalog, cfg: ProducerConfig, signer: EvidenceSigner): Promise<PublishResult> {
  const doc = produceEvidence(catalog, { ...cfg, keyId: signer.keyId });
  const check = validateEvidence(doc, { previousSequence: (doc.sequence as number) - 1 });
  if (!check.valid) return { published: false, reason: "invalid", errors: check.errors };
  const contentDigest = evidenceDigest(doc);
  const last = catalog.db.get<{ contentDigest: string }>("SELECT contentDigest FROM evidence_snapshots ORDER BY sequence DESC LIMIT 1");
  if (last && last.contentDigest === contentDigest) return { published: false, reason: "duplicate" };
  const body = JSON.stringify(doc);
  // The signature and the wrapper digest cover the exact bytes Orrery's adapter receives, so kl cannot alter a snapshot without failing the check.
  const bytes = new TextEncoder().encode(body);
  const sig = toBase64Url(await signer.sign(bytes));
  catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "evidence.publish", snapshotId: doc.snapshotId as string, sequence: doc.sequence as number, digest: sha256Hex(bytes), contentDigest, body, sig, keyId: signer.keyId });
  return { published: true, sequence: doc.sequence as number, snapshotId: doc.snapshotId as string };
}
