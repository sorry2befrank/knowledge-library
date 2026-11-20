import type { PushManifest } from "./push.ts";
import type { ApprovalReceipt } from "./receipts.ts";
import type { VerifiedEnrollment } from "../auth/enrollment.ts";

export type Authority = { kind: "principal" } | { kind: "enrollment" } | { kind: "setup"; bootstrapSecret?: string } | { kind: "system" } | { kind: "receipt"; receipt: ApprovalReceipt | undefined };

export type NoteKind = "decision" | "implementation" | "handoff" | "status" | "log" | "turnover" | "note" | "binary";
export type VersionRole = "note" | "brief" | "handoff" | "decision" | "log" | "derivative";
export interface PushDisposition { ok: false; status: "held" | "refused" | "rerouted"; reason: string; ruleCodes?: string[] }

export type Op =
  | { kind: "enrollment.initialize"; grant: VerifiedEnrollment }
  | { kind: "enrollment.activate"; hash: string; authzSeq: number }
  | { kind: "push.open"; pushId: string; grant: string; snapshotHash: string; manifest: PushManifest; expiresAt: string }
  | { kind: "push.reserve" | "push.stage"; pushId: string; grant: string; n: number }
  | { kind: "push.disposition"; pushId: string; grant: string; n: number; disposition: PushDisposition }
  | { kind: "push.expire"; pushId: string }
  | { kind: "push.commit"; pushId: string; grant: string; expectedGeneration: number; items: { n: number; reused?: boolean; reuseFailed?: true; reuseSource?: { noteId: string; ver: number; privacyClass: string }; reason?: string; version?: Extract<Op, { kind: "version.create" }>; result?: Record<string, unknown>; disposition?: PushDisposition }[]; absent: { noteId: string; ver: number }[]; moves: { noteId: string; ver: number; from: string; to: string }[] }
  | { kind: "collection.create"; collectionId: string; class: string; store_ok?: boolean; clients_ok?: string[]; model_processing?: boolean; binary?: boolean; decision_row?: Record<string, unknown> }
  | { kind: "principal.create"; id: string; email: string; allowedClasses: string[] }
  | { kind: "principal.revoke"; id: string }
  | { kind: "token.issue"; tokenHash: string; principal: string; tokenKind: "kl-device" | "cc-bearer" | "cx-bearer"; scopes: string[]; clientClass: string; expiresAt: string; collectionIds?: string[] }
  | { kind: "token.revoke"; tokenHash: string; reason: "guard-hit" | "owner" | "rotation" }
  | { kind: "blob.reserve"; sha256: string; refId: string }
  | { kind: "blob.release"; sha256: string; refId: string }
  | { kind: "version.custody"; noteId: string; ver: number; custody: "received" | "verified" | "indexed"; reason: "post-commit-check-passed" | "post-commit-check-failed" | "indexed" }
  | { kind: "version.create"; noteId?: string; aliasBlocked?: boolean; collectionId: string; folderId?: string; path?: string; title?: string; noteKind: NoteKind; privacyClass: string; role: VersionRole;
      sha256: string; bytes: number; baseVer?: number; supersedes?: string; derivedFrom?: string[]; origin: string; capturedAt: string; observedMtime?: string; idempotencyKey?: string; held?: boolean; pendingRefId?: string }
  | { kind: "idempotency.bind"; idempotencyKey: string; noteId: string; ver: number; sha256: string }
  | { kind: "alias.move"; noteId: string; collectionId: string; newPath: string }
  | { kind: "feedback.record"; feedbackKind: "correct" | "missed" | "useful" | "pin" | "unpin"; targetNoteId: string; targetVer?: number; queryId?: string; topic?: string; detail: string; interactive: boolean }
  | { kind: "correction.confirm"; correctionId: string; expectedSeq: number }
  | { kind: "correction.revert"; correctionId: string; expectedSeq: number }
  | { kind: "signal.record"; signalId?: string; signalKind: string; scopeId: string; targetNoteId: string; targetVer?: number; queryId?: string; query?: string; strength: string; interactive: boolean }
  | { kind: "case.create"; caseId?: string; capability: string; scopeId: string; privacy: string; groupKey: string; lineageKey: string; inputRef: string; frozenFeatures: Record<string, unknown>; expected: Record<string, unknown>; sourceSignals: string[]; author: string }
  | { kind: "playbook.put"; capability: string; body: Record<string, unknown> }
  | { kind: "champion.baseline"; capability: "retrieval"; scopeId: string; privacy: string }
  | { kind: "candidate.create"; candidateId?: string; capability: string; scopeId: string; privacy: string; playbookHash: string; parentHash: string; generator: string; targetGroups: string[] }
  | { kind: "candidate.grade"; candidateId: string; report: { verdict: "tested" | "tested-insufficient" | "vetoed"; generation: number; heldoutLook: true } & object }
  | { kind: "replay.record"; capability: "retrieval"; scopeId: string; privacy: string; playbookHash: string; reportHash: string; generation: number; lookSpent: boolean }
  | { kind: "edge.confirm"; src: string; dst: string; type: "supersedes" | "duplicate_of" }
  | { kind: "champion.promote"; candidateId: string }
  | { kind: "note.withdraw"; noteId: string }
  | { kind: "policy.accept"; epoch: number; policyHash: string; receiptId: string; sig: string }
  | { kind: "evidence.publish"; snapshotId: string; sequence: number; digest: string; contentDigest: string; body: string; sig: string; keyId: string };

export const RECEIPT_ONLY: ReadonlySet<Op["kind"]> = new Set<Op["kind"]>(["champion.promote", "note.withdraw", "policy.accept", "principal.revoke", "edge.confirm", "correction.confirm"]);
export const SETUP_OR_RECEIPT: ReadonlySet<Op["kind"]> = new Set<Op["kind"]>(["collection.create", "principal.create", "token.issue"]);
export const SYSTEM_ONLY: ReadonlySet<Op["kind"]> = new Set<Op["kind"]>(["push.expire", "version.custody", "blob.reserve", "blob.release", "idempotency.bind", "case.create", "playbook.put", "champion.baseline", "candidate.create", "candidate.grade", "replay.record", "evidence.publish", "token.revoke"]);
