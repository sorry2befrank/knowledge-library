// Owner approval receipts (DESIGN §9.2). S1 has no approval channel: the verifier always refuses,
// so every consequential action is impossible until the passkey page exists (a later session).
export interface ApprovalReceipt {
  receiptId: string; actionKind: string; actionHash: string; evidenceHash: string; principal: string;
  credentialId: string; issuedAt: string; expiresAt: string; serverSig: string;
}
export type ReceiptCheck = { ok: true } | { ok: false; reason: "no-approval-channel" | "bad-signature" | "expired" | "used" | "action-mismatch" };
/** Result from the trusted approval service, never accepted from request JSON.
 * verifyCorrection must verify the signature/key, current non-revoked grant and exact action,
 * evidence, collection and named target/case. Human evidence is a separately verified review
 * attestation; a delegated signature cannot supply it. No production implementation exists yet.
 */
export type CorrectionReceiptCheck = { ok: false; reason: string } | {
  ok: true; authority: "owner" | "partner" | "delegated"; confirmer: string;
  humanEvidence: null | { principal: string; caseId: string; evidenceHash: string };
};
export interface CorrectionReceiptExpectation {
  actionKind: "correction.confirm"; actionHash: string; evidenceHash: string; scopeId: string;
  target: string; correctionId: string; caseId: string | null; expectedSeq: number;
  now: string; phase: "consume" | "project"; consumedAt: string | null;
}
export interface ReceiptVerifier {
  verify(receipt: ApprovalReceipt | undefined, expect: { actionKind: string; actionHash: string }): ReceiptCheck;
  // Optional extension of the same receipt channel; absence/unavailability refuses corrections.
  // Projection rechecks current grant/key revocation, with expiry bound to consumedAt.
  verifyCorrection?(receipt: ApprovalReceipt, expect: CorrectionReceiptExpectation): CorrectionReceiptCheck;
}

export const noApprovalChannel: ReceiptVerifier = { verify: () => ({ ok: false, reason: "no-approval-channel" }) };
