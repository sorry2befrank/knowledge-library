import { validate } from "./validation.ts";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]); return o; }
  return v;
}

// ---------------- library-evidence-signed/v1: the wrapper the adapter reads from outbox/orrery ----------------
/** The wrapper Orrery's adapter reads: the signed envelope bytes verbatim, their SHA-256 digest, the signature and the producer key id. */
export interface SignedEvidence { schemaVersion: "library-evidence-signed/v1"; envelopeBytes: string; digest: string; sig: string; keyId: string }
function b64urlToBytes(s: string): Uint8Array { const pad = "=".repeat((4 - (s.length % 4)) % 4); const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
async function sha256HexAsync(bytes: Uint8Array): Promise<string> { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)); return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join(""); }
export type SignatureCheck = "ok" | "unknown-key" | "bad-signature" | "bad-digest" | "key-mismatch" | "malformed";
/** Verify the wrapper (schema), the producer key id, the digest of exactly the signed bytes, the signature, that the envelope names the same key, then run validateEvidence on the parsed envelope. */
export async function verifySignedEvidence(wrapper: unknown, trust: { keyId: string; publicKey: CryptoKey }, opts: EvidenceOptions = {}): Promise<EvidenceCheck & { signature: SignatureCheck; envelope?: Record<string, unknown> }> {
  const fail = (signature: Exclude<SignatureCheck, "ok">, errors: string[] = []): EvidenceCheck & { signature: typeof signature } => ({ valid: false, errors: [`signature: ${signature}`, ...errors], operationErrors: [], verdicts: {}, stale: true, freshness: "unknown", sizeBytes: 0, duplicate: false, signature });
  const w = validate("library-evidence-signed/v1", wrapper);
  if (!w.valid) return fail("malformed", w.errors);
  const sw = wrapper as SignedEvidence;
  if (sw.keyId !== trust.keyId) return fail("unknown-key");
  const bytes = new TextEncoder().encode(sw.envelopeBytes);
  if ((await sha256HexAsync(bytes)) !== sw.digest) return fail("bad-digest");
  let ok = false;
  try { const sig = b64urlToBytes(sw.sig); ok = await crypto.subtle.verify("Ed25519", trust.publicKey, sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); } catch { return fail("malformed"); }
  if (!ok) return fail("bad-signature");
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(sw.envelopeBytes) as Record<string, unknown>; } catch { return fail("malformed", ["envelopeBytes is not JSON"]); }
  if ((envelope.producer as { keyId?: string } | undefined)?.keyId !== sw.keyId) return fail("key-mismatch");
  // The accepted checkpoint's digest is the WRAPPER digest (SHA-256 of the signed bytes): compared here, where those bytes are.
  const dupByDigest = opts.accepted?.digest !== undefined && opts.accepted.digest === sw.digest;
  const check = validateEvidence(envelope, { ...opts, accepted: dupByDigest ? { snapshotId: envelope.snapshotId as string } : { snapshotId: opts.accepted?.snapshotId } });
  return { ...check, duplicate: check.duplicate || dupByDigest, signature: "ok", envelope };
}

// ---------------- library-evidence/v1 semantic validation and reference verdicts ----------------
export type Milestone = "ingest-custody" | "retrieval-index" | "recovery" | "focus";
export type Verdict = "verified" | "unproven" | "blocked";
export type FreshnessVerdict = "fresh" | "stale" | "unknown";
export interface OperationError { index: number; operationId: string; error: string }
export interface EvidenceCheck { valid: boolean; errors: string[]; operationErrors: OperationError[]; verdicts: Record<string, Verdict>; stale: boolean; freshness: FreshnessVerdict; sizeBytes: number; /** the snapshot equals the consumer's accepted checkpoint: a no-op, reported before the sequence check (ruling 8) */ duplicate: boolean }
/** The consumer's side of a check: its clock, the last accepted sequence, when it accepted, and the accepted checkpoint (digest and snapshotId). */
export interface EvidenceOptions { now?: string; previousSequence?: number; acceptedAt?: string; accepted?: { digest?: string; snapshotId?: string } }

export const EVIDENCE_MAX_BYTES = 1 << 20;
/** A selected freshness basis or observation this far ahead of the consumer clock makes freshness unknown. */
export const FRESHNESS_CLOCK_SKEW_MS = 2 * 60 * 1000;

interface Op { operationId: string; runId: string | null; milestone: Milestone; stage: string; result: string; sourceVersion: string; timestamps: Record<string, string>; proof: Record<string, string | undefined> }

const BLOCKING_STAGES = new Set(["GUARD_REFUSED", "CONFLICT_HELD_CHANGED", "RECREATED"]);
/** Ruling 4: the stages that PROVE a milestone, with the receipt each needs. Every other completed stage is progress, not proof. */
const PROVING: Record<Milestone, (op: Op) => boolean> = {
  "ingest-custody": (op) => op.stage === "CUSTODY_OK" || (op.stage === "COMMITTED" && !!op.proof.custodyReceipt),
  "retrieval-index": (op) => op.stage === "INDEXED",
  recovery: (op) => op.stage === "RESTORED" && !!op.proof.restoreReceipt,
  focus: (op) => op.stage === "RECEIPTED" || op.stage === "HELD_PURGED" || (op.stage === "VEIL_WRITTEN" && !!op.proof.veilReceipt),
};
const RANK: Record<Verdict, number> = { verified: 0, unproven: 1, blocked: 2 }; // higher is worse

/** One attempt's outcome under ruling 4. A cross-version proof (per-operation error) never proves anything. */
export function attemptOutcome(op: Op, faulty: boolean): Verdict {
  if (op.result === "failed" || BLOCKING_STAGES.has(op.stage)) return "blocked";
  if (op.result === "completed" && !faulty && PROVING[op.milestone]?.(op)) return "verified";
  return "unproven";
}

/**
 * Validate a snapshot. Snapshot-level errors (schema, size, sequence, truncation flags, count consistency) make it invalid.
 * A receipt for a different version is a per-operation error: the snapshot stays valid and that attempt is unproven.
 * Within each milestone the key is sourceVersion (runId is NOT part of the key, ruling 3): the attempt with the newest
 * timestamp wins and ties go to the worse outcome. A milestone is blocked if any latest attempt is blocked, verified if
 * every one is verified, otherwise unproven. Only proving stages verify (ruling 4). Freshness is sync-first (ruling 5)
 * and never changes a verdict. A truncated snapshot must list blocked and unproven attempts before verified ones
 * (ruling 6). A snapshot equal to the accepted checkpoint is a duplicate, reported before the sequence check (ruling 8).
 */
export function validateEvidence(doc: unknown, opts: EvidenceOptions = {}): EvidenceCheck {
  const base = validate("library-evidence/v1", doc);
  const errors = [...base.errors];
  const operationErrors: OperationError[] = [];
  const text = JSON.stringify(doc);
  const sizeBytes = new TextEncoder().encode(text).length;
  if (sizeBytes > EVIDENCE_MAX_BYTES) errors.push(`/ snapshot exceeds ${EVIDENCE_MAX_BYTES} bytes`);
  const verdicts: Record<string, Verdict> = {};
  let stale = false; let freshness: FreshnessVerdict = "unknown"; let duplicate = false;
  if (base.valid && doc && typeof doc === "object") {
    const d = doc as { snapshotId: string; sequence: number; observedAt: string; operations: Op[]; scope: { milestonesEnabled: Milestone[] }; freshness: { staleAfterSeconds: number; lastSuccessfulSync: string | null }; truncated: { operations: boolean; omittedOperations?: number }; state: { custody: { receivedOnly: number; verifiedNotIndexed: number; indexed: number }; indexing: { preserved: number; indexed: number; pending: number } } };
    // Ruling 8: a duplicate of the accepted checkpoint is a no-op, decided before the monotonic-sequence check.
    if (opts.accepted && ((opts.accepted.snapshotId !== undefined && opts.accepted.snapshotId === d.snapshotId) || (opts.accepted.digest !== undefined && opts.accepted.digest === sha256HexSync(text)))) duplicate = true;
    if (!duplicate && opts.previousSequence !== undefined && d.sequence <= opts.previousSequence) errors.push(`/sequence not monotonic: ${d.sequence} <= ${opts.previousSequence}`);
    if (d.truncated.operations && !(d.truncated.omittedOperations ?? 0)) errors.push("/truncated operations=true needs omittedOperations > 0");
    if (!d.truncated.operations && (d.truncated.omittedOperations ?? 0) > 0) errors.push("/truncated omittedOperations > 0 needs operations=true");
    // Consistency (ruling 7 and D6): preserved means verified custody only; the buckets are exclusive.
    const c = d.state.custody, ix = d.state.indexing;
    if (ix.indexed !== c.indexed) errors.push(`/state indexing.indexed ${ix.indexed} != custody.indexed ${c.indexed}`);
    if (ix.preserved !== c.verifiedNotIndexed + c.indexed) errors.push(`/state indexing.preserved ${ix.preserved} != verifiedNotIndexed + indexed ${c.verifiedNotIndexed + c.indexed}`);
    if (ix.pending !== c.receivedOnly + c.verifiedNotIndexed) errors.push(`/state indexing.pending ${ix.pending} != receivedOnly + verifiedNotIndexed ${c.receivedOnly + c.verifiedNotIndexed}`);
    d.operations.forEach((op, i) => {
      if (op.proof.sourceVersion !== undefined && op.proof.sourceVersion !== op.sourceVersion) operationErrors.push({ index: i, operationId: op.operationId, error: `cross-version proof: receipt covers ${op.proof.sourceVersion}, operation is ${op.sourceVersion}` });
      const times = Object.values(op.timestamps);
      if (times.length === 0 || times.some(t => !Number.isFinite(Date.parse(t)))) errors.push(`/operations/${i}/timestamps needs at least one usable timestamp and no unparseable values`);
    });
    // Without a finite ordering time, no latest-attempt verdict can be trusted.
    if (errors.some(e => e.startsWith("/operations/"))) return { valid: false, errors, operationErrors, verdicts, stale: true, freshness: "unknown", sizeBytes, duplicate };
    const faulty = new Set(operationErrors.map((e) => e.index));
    const latestTs = (op: Op) => Math.max(...Object.values(op.timestamps).map((t) => Date.parse(t)));
    const outcomeOf = (x: { op: Op; i: number }) => attemptOutcome(x.op, faulty.has(x.i));
    const latestAttempts: { op: Op; i: number; outcome: Verdict }[] = [];
    // Ordering is a whole-snapshot promise, including operations for disabled milestones.
    // Only enabled milestones get displayed verdicts.
    const representedMilestones = new Set([...d.scope.milestonesEnabled, ...d.operations.map(op => op.milestone)]);
    for (const m of representedMilestones) {
      const ops = d.operations.map((op, i) => ({ op, i })).filter((x) => x.op.milestone === m);
      // latest attempt per source version; a tie goes to the worse outcome
      const latest = new Map<string, { op: Op; i: number; outcome: Verdict }>();
      for (const x of ops) {
        const cur = latest.get(x.op.sourceVersion); const o = outcomeOf(x);
        if (!cur || latestTs(x.op) > latestTs(cur.op) || (latestTs(x.op) === latestTs(cur.op) && RANK[o] > RANK[cur.outcome])) latest.set(x.op.sourceVersion, { ...x, outcome: o });
      }
      const attempts = [...latest.values()];
      latestAttempts.push(...attempts);
      if (!d.scope.milestonesEnabled.includes(m)) continue;
      if (attempts.length === 0) verdicts[m] = "unproven";
      else if (attempts.some((x) => x.outcome === "blocked")) verdicts[m] = "blocked";
      else if (attempts.every((x) => x.outcome === "verified")) verdicts[m] = "verified";
      else verdicts[m] = "unproven";
    }
    // Ruling 6: a truncated list must put every blocked and unproven latest attempt before any verified one.
    if (d.truncated.operations) {
      const ordered = latestAttempts.sort((a, b) => a.i - b.i);
      const firstVerified = ordered.findIndex((x) => x.outcome === "verified");
      if (firstVerified >= 0 && ordered.slice(firstVerified).some((x) => x.outcome !== "verified")) for (const m of d.scope.milestonesEnabled) verdicts[m] = "unproven";
    }
    // Ruling 5: sync-first; acceptance only when sync is null; observedAt caps either basis.
    // An unusable or future selected time is unknown, never silently fresh.
    const now = opts.now === undefined ? Date.now() : Date.parse(opts.now);
    const observed = Date.parse(d.observedAt);
    const sync = d.freshness.lastSuccessfulSync === null ? null : Date.parse(d.freshness.lastSuccessfulSync);
    const basis = sync ?? (opts.acceptedAt === undefined ? null : Date.parse(opts.acceptedAt));
    if (basis === null || !Number.isFinite(now) || !Number.isFinite(observed) || !Number.isFinite(basis) || basis - now > FRESHNESS_CLOCK_SKEW_MS || observed - now > FRESHNESS_CLOCK_SKEW_MS) { freshness = "unknown"; stale = true; }
    else { const effective = Math.min(basis, observed); stale = now - effective > d.freshness.staleAfterSeconds * 1000; freshness = stale ? "stale" : "fresh"; }
  }
  return { valid: errors.length === 0, errors, operationErrors, verdicts, stale, freshness, sizeBytes, duplicate };
}

/** Synchronous SHA-256 hex over UTF-8 text, for the duplicate check (the wrapper digest is over the signed bytes, which equal JSON.stringify of the envelope as published). */
function sha256HexSync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const bitLen = bytes.length * 8, padLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen); buf.set(bytes); buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer); dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000)); dv.setUint32(padLen - 4, bitLen >>> 0);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) { const a = w[i - 15]!, b = w[i - 2]!; w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0; }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]!) >>> 0);
  }
  return h.map((v) => v.toString(16).padStart(8, "0")).join("");
}
