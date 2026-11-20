// Signed policy acceptance with anti-rollback epochs (DESIGN §2.7). A policy file in the repo is a
// proposal. It takes effect only through a service-signed acceptance {policyHash, epoch, receiptId}
// made after Frank's passkey receipt. Unsigned, wrongly signed, hash-mismatched or older-epoch
// acceptances fail closed: everything becomes a proposal, nothing is removed, no new team class.
import { sha256Hex } from "../primitives/sha256.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { fromBase64Url, toBase64Url } from "../primitives/base64url.ts";

export interface PolicyBundle { files: Record<string, unknown> }
export interface AcceptanceRecord { policyHash: string; epoch: number; receiptId: string; sig: string; keyId: string }

export function bundleHash(bundle: PolicyBundle): string { return sha256Hex(canonicalJson(bundle)); }

function asBuffer(u8: Uint8Array): ArrayBuffer { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer; }

function signedBytes(r: Omit<AcceptanceRecord, "sig">): ArrayBuffer {
  return asBuffer(new TextEncoder().encode(canonicalJson({ policyHash: r.policyHash, epoch: r.epoch, receiptId: r.receiptId, keyId: r.keyId, purpose: "kl-policy-acceptance/v1" })));
}

export async function generateServiceKey(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicKeyB64: string; keyId: string }> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyB64: toBase64Url(raw), keyId: `k-${sha256Hex(raw).slice(0, 16)}` };
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBuffer(fromBase64Url(publicKeyB64)), "Ed25519", true, ["verify"]);
}

/** Service side (production Worker secret; tests only here). */
export async function signAcceptance(privateKey: CryptoKey, r: Omit<AcceptanceRecord, "sig">): Promise<AcceptanceRecord> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, signedBytes(r)));
  return { ...r, sig: toBase64Url(sig) };
}

export type AcceptanceFailure = "unsigned" | "malformed" | "bad-signature" | "hash-mismatch" | "epoch-rollback" | "unknown-key";
export type AcceptanceCheck = { ok: true; epoch: number } | { ok: false; reason: AcceptanceFailure };

export interface Trust { publicKey: CryptoKey; keyId: string; minEpoch: number }

export async function verifyAcceptance(record: unknown, expectedPolicyHash: string, trust: Trust): Promise<AcceptanceCheck> {
  if (!record || typeof record !== "object") return { ok: false, reason: "unsigned" };
  const r = record as Partial<AcceptanceRecord>;
  if (typeof r.sig !== "string" || r.sig.length === 0) return { ok: false, reason: "unsigned" };
  if (typeof r.policyHash !== "string" || !Number.isInteger(r.epoch) || typeof r.receiptId !== "string" || typeof r.keyId !== "string") return { ok: false, reason: "malformed" };
  if (r.keyId !== trust.keyId) return { ok: false, reason: "unknown-key" };
  let sigBytes: Uint8Array;
  try { sigBytes = fromBase64Url(r.sig); } catch { return { ok: false, reason: "malformed" }; }
  const good = await crypto.subtle.verify("Ed25519", trust.publicKey, asBuffer(sigBytes), signedBytes({ policyHash: r.policyHash, epoch: r.epoch!, receiptId: r.receiptId, keyId: r.keyId }));
  if (!good) return { ok: false, reason: "bad-signature" };
  if (r.policyHash !== expectedPolicyHash) return { ok: false, reason: "hash-mismatch" };
  // Anti-rollback at load: an epoch BELOW the last accepted or seen epoch is refused even with a valid signature.
  // (The current epoch loads; only apply()'s policy.accept requires a strictly newer epoch.)
  if (r.epoch! < trust.minEpoch) return { ok: false, reason: "epoch-rollback" };
  return { ok: true, epoch: r.epoch! };
}

export interface FailClosedPolicy { mode: "fail-closed"; reason: AcceptanceFailure; removals: false; proposalsOnly: true; acceptNewTeamClass: false; files: Record<string, never> }
export interface AcceptedPolicy { mode: "accepted"; epoch: number; policyHash: string; files: Record<string, unknown>; removals: boolean; proposalsOnly: false; acceptNewTeamClass: true }
export type LoadedPolicy = AcceptedPolicy | FailClosedPolicy;

export async function loadPolicy(bundle: PolicyBundle | undefined, acceptance: unknown, trust: Trust): Promise<LoadedPolicy> {
  const failClosed = (reason: AcceptanceFailure): FailClosedPolicy => ({ mode: "fail-closed", reason, removals: false, proposalsOnly: true, acceptNewTeamClass: false, files: {} });
  if (!bundle) return failClosed("malformed");
  const hash = bundleHash(bundle);
  const check = await verifyAcceptance(acceptance, hash, trust);
  if (!check.ok) return failClosed(check.reason);
  const focus = bundle.files["focus.json"] as { enabled?: boolean } | undefined;
  return { mode: "accepted", epoch: check.epoch, policyHash: hash, files: bundle.files, removals: focus?.enabled === true, proposalsOnly: false, acceptNewTeamClass: true };
}
