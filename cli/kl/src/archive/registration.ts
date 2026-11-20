// Local pre-enrollment only: a pinned owner/service public key authenticates the exact root,
// endpoint, census and policy. This loader creates no enrollment, approval, key or collection.
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { fromBase64Url } from '../../../../packages/core/src/primitives/base64url.ts';
import { importPublicKey, type PolicyBundle } from '../../../../packages/core/src/policy/acceptance.ts';
import { loadReferenceAdmissionRules, referenceProfile } from '../../../../packages/core/src/admission/reference-policy.ts';
import type { DenyRules } from '../../../../packages/core/src/admission/guard.ts';

export class ArchiveSourceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface ArchiveRootIdentity { volumeSerial: string; fileId: string }
export interface ArchiveRegistrationDescriptor {
  schema: 'kl-archive-registration/v1';
  identityScheme: 'node-stat-v1';
  root: string;
  identity: ArchiveRootIdentity;
  folderId: string;
  device: string;
  collectionId: string;
  privacyClass: 'team' | 'frank-private';
  apiOrigin: string;
  libraryRepo: string;
  privacyCensusHash: string;
  approvalReceiptId: string;
  policyHash: string;
  policyEpoch: number;
  registrationEpoch: number;
  issuedAt: string;
  expiresAt: string;
}
export interface ArchiveRegistration extends ArchiveRegistrationDescriptor { denyRules: DenyRules }
export interface ArchiveTrustPin { publicKeyB64: string; keyId: string; minEpoch: number }
export interface ArchiveTrustConfig {
  schema: 'kl-archive-trust/v1';
  device: string;
  enrollment: ArchiveTrustPin;
  policy: ArchiveTrustPin;
}
export interface SignedArchiveRegistration { descriptor: ArchiveRegistrationDescriptor; keyId: string; sig: string }

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const authentic = new WeakSet<object>();
export function isAuthenticatedArchiveRegistration(value: object): value is ArchiveRegistration { return authentic.has(value); }
export function archiveRootKey(root: string): string {
  const full = resolve(root);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}
export function archiveRegistrationFile(stateDir: string, root: string): string {
  return join(stateDir, 'registrations', sha256Hex(archiveRootKey(root)) + '.json');
}
export function registrationSigningBytes(descriptor: ArchiveRegistrationDescriptor, keyId: string): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ purpose: 'kl-archive-registration/v1', descriptor, keyId }));
}
export function canonicalArchiveOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ArchiveSourceError('endpoint-invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new ArchiveSourceError('endpoint-invalid');
  return url.origin;
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function epoch(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }
function pin(value: unknown): value is ArchiveTrustPin {
  return plain(value) && typeof value.publicKeyB64 === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.publicKeyB64) &&
    typeof value.keyId === 'string' && ID.test(value.keyId) && epoch(value.minEpoch);
}
function descriptor(value: unknown): value is ArchiveRegistrationDescriptor {
  if (!plain(value) || value.schema !== 'kl-archive-registration/v1' || value.identityScheme !== 'node-stat-v1' ||
      typeof value.root !== 'string' || !isAbsolute(value.root) || value.root.length > 32767 || /[\x00-\x1f]/.test(value.root) ||
      !plain(value.identity) || typeof value.identity.volumeSerial !== 'string' || !/^node-dev:[0-9]+$/.test(value.identity.volumeSerial) ||
      typeof value.identity.fileId !== 'string' || !/^node-ino:[1-9][0-9]*$/.test(value.identity.fileId) ||
      typeof value.folderId !== 'string' || !/^folder:[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value.folderId) ||
      typeof value.device !== 'string' || !ID.test(value.device) || typeof value.collectionId !== 'string' || !ID.test(value.collectionId) ||
      (value.privacyClass !== 'team' && value.privacyClass !== 'frank-private') || typeof value.apiOrigin !== 'string' ||
      typeof value.libraryRepo !== 'string' || !isAbsolute(value.libraryRepo) || value.libraryRepo.length > 32767 || /[\x00-\x1f]/.test(value.libraryRepo) ||
      typeof value.privacyCensusHash !== 'string' || !HASH.test(value.privacyCensusHash) ||
      typeof value.policyHash !== 'string' || !HASH.test(value.policyHash) || typeof value.approvalReceiptId !== 'string' || !ID.test(value.approvalReceiptId) ||
      !epoch(value.policyEpoch) || !epoch(value.registrationEpoch) || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.issuedAt)) || !Number.isFinite(Date.parse(value.expiresAt))) return false;
  return true;
}
async function boundedJson(path: string, maxBytes: number): Promise<{ value: unknown; bytes: Uint8Array }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new ArchiveSourceError('configuration-invalid');
  const handle = await open(path, 'r');
  let bytes: Uint8Array;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size) throw new ArchiveSourceError('configuration-changed');
    const output = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < output.length) {
      const result = await handle.read(output, length, output.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const held = await handle.stat({ bigint: true }), after = await lstat(path, { bigint: true });
    if (length > maxBytes || BigInt(length) !== before.size || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || held.mtimeNs !== before.mtimeNs || held.ctimeNs !== before.ctimeNs) throw new ArchiveSourceError('configuration-changed');
    bytes = output.subarray(0, length);
  } finally { await handle.close(); }
  try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes }; }
  catch { throw new ArchiveSourceError('configuration-invalid'); }
}

/** Both pins are local trusted configuration; no pin or public key is accepted from the descriptor. */
export async function loadArchiveRegistration(input: { stateDir: string; root: string; device?: string; now?: string; apiOrigin?: string }): Promise<ArchiveRegistration> {
  try {
    if (!isAbsolute(input.stateDir) || !isAbsolute(input.root)) throw new ArchiveSourceError('absolute-path-required');
    const stateKey = archiveRootKey(input.stateDir), rootKey = archiveRootKey(input.root);
    if (stateKey === rootKey || stateKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep) ||
        rootKey.startsWith(stateKey.endsWith(sep) ? stateKey : stateKey + sep)) throw new ArchiveSourceError('state-source-overlap');
    const trust = (await boundedJson(join(input.stateDir, 'archive-trust.json'), 16_384)).value;
    if (!plain(trust) || trust.schema !== 'kl-archive-trust/v1' || typeof trust.device !== 'string' || !ID.test(trust.device) ||
        !pin(trust.enrollment) || !pin(trust.policy)) throw new ArchiveSourceError('trust-invalid');
    const signed = (await boundedJson(archiveRegistrationFile(input.stateDir, input.root), 32_768)).value;
    if (!plain(signed) || !descriptor(signed.descriptor) || typeof signed.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signed.sig) ||
        signed.keyId !== trust.enrollment.keyId) throw new ArchiveSourceError('registration-invalid');
    const d = signed.descriptor;
    if (archiveRootKey(d.root) !== rootKey || d.device !== trust.device || (input.device !== undefined && d.device !== input.device)) throw new ArchiveSourceError('registration-scope-mismatch');
    const origin = canonicalArchiveOrigin(d.apiOrigin);
    if (origin !== d.apiOrigin || (input.apiOrigin !== undefined && canonicalArchiveOrigin(input.apiOrigin) !== origin)) throw new ArchiveSourceError('endpoint-mismatch');
    const now = Date.parse(input.now ?? new Date().toISOString());
    if (!Number.isFinite(now) || Date.parse(d.issuedAt) > now || Date.parse(d.expiresAt) <= now || Date.parse(d.expiresAt) <= Date.parse(d.issuedAt)) throw new ArchiveSourceError('registration-expired');
    if (d.registrationEpoch < trust.enrollment.minEpoch) throw new ArchiveSourceError('registration-rollback');
    const key = await importPublicKey(trust.enrollment.publicKeyB64);
    const good = await crypto.subtle.verify('Ed25519', key, fromBase64Url(signed.sig) as BufferSource,
      registrationSigningBytes(d, signed.keyId as string) as BufferSource);
    if (!good) throw new ArchiveSourceError('registration-signature-invalid');
    const census = await boundedJson(join(input.stateDir, 'census', d.privacyCensusHash + '.json'), 4 * 1024 * 1024);
    if (sha256Hex(census.bytes) !== d.privacyCensusHash || !plain(census.value) || census.value.schema !== 'kl-privacy-census/v1' ||
        census.value.root !== d.root || census.value.collectionId !== d.collectionId || census.value.privacyClass !== d.privacyClass ||
        census.value.device !== d.device || canonicalJson(census.value.identity) !== canonicalJson(d.identity)) throw new ArchiveSourceError('census-mismatch');
    const bundle = (await boundedJson(join(input.stateDir, 'policy', 'bundle.json'), 4 * 1024 * 1024)).value;
    const acceptance = (await boundedJson(join(input.stateDir, 'policy', 'acceptance.json'), 32_768)).value;
    if (!plain(bundle) || !plain(bundle.files)) throw new ArchiveSourceError('policy-unavailable');
    const denyRules = await loadReferenceAdmissionRules(bundle as unknown as PolicyBundle, acceptance, {
      publicKey: await importPublicKey(trust.policy.publicKeyB64), keyId: trust.policy.keyId, minEpoch: trust.policy.minEpoch,
    });
    const profile = referenceProfile(denyRules);
    if (!profile?.ready || profile.policyHash !== d.policyHash || profile.epoch !== d.policyEpoch) throw new ArchiveSourceError('policy-unavailable');
    const result = Object.freeze({ ...d, identity: Object.freeze({ ...d.identity }), denyRules });
    authentic.add(result);
    return result;
  } catch (error) {
    if (error instanceof ArchiveSourceError) throw error;
    throw new ArchiveSourceError('registration-unavailable');
  }
}
