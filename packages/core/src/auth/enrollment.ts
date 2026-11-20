// One-shot owner approval: public claims only, never bearer tokens or signing keys.
// Trust comes from deployment configuration, not from the submitted envelope.
import { canonicalJson } from '../primitives/canonical.ts';
import { sha256Hex } from '../primitives/sha256.ts';
import { fromBase64Url, toBase64Url } from '../primitives/base64url.ts';
import { importPublicKey, verifyAcceptance, type AcceptanceRecord, type Trust } from '../policy/acceptance.ts';
import { TOKEN_KINDS, type TokenKind } from './tokens.ts';

export interface EnrollmentClaims {
  schema: 'kl-enrollment/v1';
  receiptId: string; nonce: string; principal: string;
  audience: { origin: string; environment: 'staging' | 'production'; libraryId: string };
  folder: { folderId: string; device: string; volumeSerial: string; rootFileId: string;
    displayPathHash: string; collectionId: string; privacyClass: 'team' | 'frank-private'; orreryRegistered?: boolean };
  registrationHash: string; privacyCensusHash: string;
  policy: { policyHash: string; epoch: number; receiptId: string };
  tokens: { kind: TokenKind; hash: string; expiresAt: string }[];
  issuedAt: string; expiresAt: string;
}
export interface SignedEnrollment { claims: EnrollmentClaims; keyId: string; sig: string }
export interface EnrollmentTrust {
  approval: { keyId: string; publicKeyB64: string };
  policy: Trust & { policyHash: string };
  audience: EnrollmentClaims['audience'];
  now(): string;
}
export interface VerifiedEnrollment {
  readonly claims: EnrollmentClaims; readonly hash: string;
  readonly keyId: string; readonly sig: string; readonly acceptance: AcceptanceRecord;
}
const verified = new WeakSet<object>();
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: string[]) => plain(v) && Object.keys(v).sort().join('|') === [...expected].sort().join('|');
const id = (v: unknown) => typeof v === 'string' && ID.test(v);
const hash = (v: unknown) => typeof v === 'string' && HASH.test(v);
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export class EnrollmentRefused extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
function refuse(code: string): never { throw new EnrollmentRefused(code); }
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
export function enrollmentSigningBytes(claims: EnrollmentClaims, keyId: string): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ purpose: 'kl-enrollment-approval/v1', claims, keyId }));
}
export async function signEnrollment(claims: EnrollmentClaims, keyId: string, privateKey: CryptoKey): Promise<SignedEnrollment> {
  const copy = JSON.parse(canonicalJson(claims)) as EnrollmentClaims;
  validateClaims(copy);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, enrollmentSigningBytes(copy, keyId) as BufferSource);
  return { claims: copy, keyId, sig: toBase64Url(new Uint8Array(sig)) };
}
function validateClaims(c: unknown): asserts c is EnrollmentClaims {
  if (!keys(c, ['schema','receiptId','nonce','principal','audience','folder','registrationHash','privacyCensusHash','policy','tokens','issuedAt','expiresAt'])) refuse('enrollment-invalid');
  const r = c as EnrollmentClaims;
  if (r.schema !== 'kl-enrollment/v1' || !id(r.receiptId) || !id(r.principal) || !hash(r.nonce) ||
      !hash(r.registrationHash) || !hash(r.privacyCensusHash) || !iso(r.issuedAt) || !iso(r.expiresAt) ||
      Date.parse(r.expiresAt) <= Date.parse(r.issuedAt) || Date.parse(r.expiresAt) - Date.parse(r.issuedAt) > 900_000) refuse('enrollment-invalid');
  if (!keys(r.audience, ['origin','environment','libraryId']) || !id(r.audience.libraryId) ||
      !['staging','production'].includes(r.audience.environment)) refuse('enrollment-audience-invalid');
  try {
    const u = new URL(r.audience.origin);
    if (u.origin !== r.audience.origin || u.username || u.password ||
        (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) refuse('enrollment-audience-invalid');
  } catch { refuse('enrollment-audience-invalid'); }
  const folderKeys=['folderId','device','volumeSerial','rootFileId','displayPathHash','collectionId','privacyClass'];
  if (!(keys(r.folder,folderKeys)||keys(r.folder,[...folderKeys,'orreryRegistered'])) ||
      (Object.hasOwn(r.folder,'orreryRegistered') && typeof r.folder.orreryRegistered!=='boolean') ||
      !/^folder:[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(r.folder.folderId) || !id(r.folder.device) || !id(r.folder.collectionId) ||
      !/^node-dev:[0-9]+$/.test(r.folder.volumeSerial) || !/^node-ino:[1-9][0-9]*$/.test(r.folder.rootFileId) ||
      !hash(r.folder.displayPathHash) || !['team','frank-private'].includes(r.folder.privacyClass)) refuse('enrollment-folder-invalid');
  if (!keys(r.policy, ['policyHash','epoch','receiptId']) || !hash(r.policy.policyHash) || !id(r.policy.receiptId) ||
      !Number.isSafeInteger(r.policy.epoch) || r.policy.epoch < 1) refuse('enrollment-policy-invalid');
  if (!Array.isArray(r.tokens) || r.tokens.length !== 3 || new Set(r.tokens.map(t => t?.kind)).size !== 3 ||
      new Set(r.tokens.map(t => t?.hash)).size !== 3) refuse('enrollment-tokens-invalid');
  for (const t of r.tokens) {
    if (!keys(t, ['kind','hash','expiresAt']) || !Object.hasOwn(TOKEN_KINDS, t.kind) || !hash(t.hash) || !iso(t.expiresAt) ||
        Date.parse(t.expiresAt) <= Date.parse(r.expiresAt) ||
        Date.parse(t.expiresAt) > Date.parse(r.issuedAt) + TOKEN_KINDS[t.kind].ttlDays * 86_400_000) refuse('enrollment-tokens-invalid');
  }
}
export { validateClaims as validateEnrollmentClaims };
function live(c: EnrollmentClaims, now: string) {
  if (!iso(now) || Date.parse(c.issuedAt) > Date.parse(now) || Date.parse(c.expiresAt) <= Date.parse(now)) refuse('enrollment-expired');
}
/** Detach all request input before asynchronous verification; no request object gains authority. */
export async function verifyEnrollment(input: unknown, acceptance: unknown, trust: EnrollmentTrust): Promise<VerifiedEnrollment> {
  let packet: SignedEnrollment, policy: AcceptanceRecord;
  try {
    const bytes = canonicalJson({ input, acceptance });
    if (new TextEncoder().encode(bytes).length > 32_768) refuse('enrollment-too-large');
    const copy = JSON.parse(bytes); packet = copy.input; policy = copy.acceptance;
  } catch { refuse('enrollment-invalid'); }
  const audience = canonicalJson(trust.audience), approval = { ...trust.approval };
  const policyTrust = { ...trust.policy }, now = trust.now;
  if (!keys(packet, ['claims','keyId','sig']) || packet.keyId !== approval.keyId || !id(packet.keyId) ||
      typeof packet.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(packet.sig)) refuse('enrollment-signature-invalid');
  validateClaims(packet.claims); live(packet.claims, now());
  if (canonicalJson(packet.claims.audience) !== audience) refuse('enrollment-audience-mismatch');
  if (!keys(policy, ['policyHash','epoch','receiptId','sig','keyId']) ||
      policy.policyHash !== policyTrust.policyHash || policy.policyHash !== packet.claims.policy.policyHash ||
      policy.epoch !== packet.claims.policy.epoch || policy.receiptId !== packet.claims.policy.receiptId) refuse('enrollment-policy-invalid');
  let good = false;
  try { good = await crypto.subtle.verify('Ed25519', await importPublicKey(approval.publicKeyB64),
    fromBase64Url(packet.sig) as BufferSource, enrollmentSigningBytes(packet.claims, packet.keyId) as BufferSource); }
  catch { refuse('enrollment-signature-invalid'); }
  if (!good) refuse('enrollment-signature-invalid');
  if (!(await verifyAcceptance(policy, policyTrust.policyHash, policyTrust)).ok) refuse('enrollment-policy-invalid');
  live(packet.claims, now());
  const result = freeze({ claims: packet.claims, hash: sha256Hex(canonicalJson(packet.claims)), keyId: packet.keyId, sig: packet.sig, acceptance: policy });
  verified.add(result); return result;
}
/** Recheck expiry inside the catalog transaction; structural copies cannot impersonate verification. */
export function verifiedEnrollment(value: VerifiedEnrollment, now: string): VerifiedEnrollment {
  if (!value || !verified.has(value)) refuse('enrollment-unverified');
  live(value.claims, now); return value;
}
