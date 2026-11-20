// Owner-side artifact composition and first-install publication. No network, bearer tokens,
// key generation, trust discovery, or source modification belongs in this module.
import { lstat, mkdir, mkdtemp, open, link, unlink, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { toBase64Url } from '../../../../packages/core/src/primitives/base64url.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { bundleHash, type AcceptanceRecord, type PolicyBundle } from '../../../../packages/core/src/policy/acceptance.ts';
import { validateEnrollmentClaims, type EnrollmentClaims } from '../../../../packages/core/src/auth/enrollment.ts';
import { inspectArchiveRoot } from './source.ts';
import { ArchiveSourceError, archiveRegistrationFile, archiveRootKey, isAuthenticatedArchiveRegistration, loadArchiveRegistration, registrationSigningBytes,
  type ArchiveRegistration, type ArchiveRegistrationDescriptor, type ArchiveRootIdentity, type ArchiveTrustConfig, type SignedArchiveRegistration } from './registration.ts';

export interface ArchiveEnrollmentArtifact {
  schema: 'kl-archive-enrollment/v1';
  registration: SignedArchiveRegistration;
  censusUtf8: string;
  policyBundle: PolicyBundle;
  policyAcceptance: AcceptanceRecord;
}
const DESCRIPTOR_KEYS = ['schema', 'identityScheme', 'root', 'identity', 'folderId', 'device', 'collectionId', 'privacyClass',
  'apiOrigin', 'libraryRepo', 'privacyCensusHash', 'approvalReceiptId', 'policyHash', 'policyEpoch', 'registrationEpoch', 'issuedAt', 'expiresAt'];
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function json(value: unknown, limit: number): string {
  let result: string;
  try { result = canonicalJson(value) + '\n'; } catch { throw new ArchiveSourceError('enrollment-artifact-invalid'); }
  if (Buffer.byteLength(result, 'utf8') > limit) throw new ArchiveSourceError('enrollment-artifact-too-large');
  return result;
}
function snapshotArtifact(input: unknown): ArchiveEnrollmentArtifact {
  const a: unknown = JSON.parse(json(input, 12 * 1024 * 1024));
  if (!exactKeys(a, ['schema', 'registration', 'censusUtf8', 'policyBundle', 'policyAcceptance']) || a.schema !== 'kl-archive-enrollment/v1' ||
      !exactKeys(a.registration, ['descriptor', 'keyId', 'sig']) || !exactKeys(a.registration.descriptor, DESCRIPTOR_KEYS) ||
      !exactKeys(a.registration.descriptor.identity, ['volumeSerial', 'fileId']) || typeof a.censusUtf8 !== 'string' ||
      Buffer.byteLength(a.censusUtf8, 'utf8') > 4 * 1024 * 1024 ||
      !exactKeys(a.policyBundle, ['files']) || !exactKeys(a.policyAcceptance, ['policyHash', 'epoch', 'receiptId', 'sig', 'keyId'])) {
    throw new ArchiveSourceError('enrollment-artifact-invalid');
  }
  return a as unknown as ArchiveEnrollmentArtifact;
}

/** The caller has already obtained the owner approval receipt. Signing is not approval or enrollment. */
export async function issueArchiveEnrollmentArtifact(input: {
  descriptor: ArchiveRegistrationDescriptor; censusUtf8: string; policyBundle: PolicyBundle; policyAcceptance: AcceptanceRecord;
  enrollmentKey: { privateKey: CryptoKey; keyId: string };
}): Promise<ArchiveEnrollmentArtifact> {
  // Snapshot all caller-controlled data before the asynchronous signature operation.
  const a = snapshotArtifact({ schema: 'kl-archive-enrollment/v1', registration: { descriptor: input.descriptor, keyId: input.enrollmentKey.keyId, sig: '' },
    censusUtf8: input.censusUtf8, policyBundle: input.policyBundle, policyAcceptance: input.policyAcceptance });
  const sig = await crypto.subtle.sign('Ed25519', input.enrollmentKey.privateKey,
    registrationSigningBytes(a.registration.descriptor, a.registration.keyId) as BufferSource);
  a.registration.sig = toBase64Url(new Uint8Array(sig));
  return a;
}

/** Bind a separately approved server grant to the exact locally authenticated registration. */
export function buildEnrollmentClaims(artifact: unknown, input: {
  registration: ArchiveRegistration; audience: EnrollmentClaims['audience']; principal: string; receiptId: string; nonce: string;
  tokens: EnrollmentClaims['tokens']; issuedAt: string; expiresAt: string;
}): EnrollmentClaims {
  if (!isAuthenticatedArchiveRegistration(input.registration)) throw new ArchiveSourceError('registration-untrusted');
  const a = snapshotArtifact(artifact);
  const descriptor = Object.fromEntries(DESCRIPTOR_KEYS.map(key => [key, (input.registration as unknown as Record<string, unknown>)[key]])) as unknown as ArchiveRegistrationDescriptor;
  if (canonicalJson(a.registration.descriptor) !== canonicalJson(descriptor)) throw new ArchiveSourceError('enrollment-registration-mismatch');
  if (input.audience.origin !== descriptor.apiOrigin) throw new ArchiveSourceError('endpoint-mismatch');
  if (sha256Hex(a.censusUtf8) !== descriptor.privacyCensusHash) throw new ArchiveSourceError('census-mismatch');
  const census=JSON.parse(a.censusUtf8) as Record<string,unknown>;
  if(Object.hasOwn(census,'orreryRegistered') && typeof census.orreryRegistered!=='boolean')throw new ArchiveSourceError('census-mismatch');
  if (input.receiptId !== descriptor.approvalReceiptId || a.policyAcceptance.policyHash !== descriptor.policyHash ||
      a.policyAcceptance.epoch !== descriptor.policyEpoch || bundleHash(a.policyBundle) !== descriptor.policyHash) throw new ArchiveSourceError('enrollment-policy-mismatch');
  if (Date.parse(input.issuedAt) < Date.parse(descriptor.issuedAt) || Date.parse(input.expiresAt) > Date.parse(descriptor.expiresAt)) throw new ArchiveSourceError('enrollment-registration-expiry');
  const claims: EnrollmentClaims = JSON.parse(canonicalJson({ schema: 'kl-enrollment/v1', receiptId: input.receiptId, nonce: input.nonce,
    principal: input.principal, audience: input.audience, registrationHash: sha256Hex(canonicalJson(descriptor)),
    privacyCensusHash: descriptor.privacyCensusHash,
    folder: { folderId: descriptor.folderId, device: descriptor.device, volumeSerial: descriptor.identity.volumeSerial,
      rootFileId: descriptor.identity.fileId, displayPathHash: sha256Hex(archiveRootKey(descriptor.root)),
      collectionId: descriptor.collectionId, privacyClass: descriptor.privacyClass,
      ...(Object.hasOwn(census,'orreryRegistered')?{orreryRegistered:census.orreryRegistered}:{}) },
    policy: { policyHash: descriptor.policyHash, epoch: descriptor.policyEpoch, receiptId: a.policyAcceptance.receiptId },
    tokens: input.tokens, issuedAt: input.issuedAt, expiresAt: input.expiresAt }));
  validateEnrollmentClaims(claims);
  return claims;
}

function overlaps(a: string, b: string): boolean {
  const delta = relative(archiveRootKey(a), archiveRootKey(b));
  return !delta || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('..\\') && !delta.startsWith('../'));
}
function sameIdentity(a: ArchiveRootIdentity, b: ArchiveRootIdentity): boolean {
  return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new ArchiveSourceError('enrollment-state-exists');
}
async function writeExclusive(path: string, bytes: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
async function filesAt(stateDir: string, a: ArchiveEnrollmentArtifact, trust: ArchiveTrustConfig): Promise<void> {
  await Promise.all(['registrations', 'policy', 'census'].map(dir => mkdir(join(stateDir, dir), { mode: 0o700 })));
  await writeExclusive(archiveRegistrationFile(stateDir, a.registration.descriptor.root), json(a.registration, 32_768));
  await writeExclusive(join(stateDir, 'census', a.registration.descriptor.privacyCensusHash + '.json'), a.censusUtf8);
  await writeExclusive(join(stateDir, 'policy', 'bundle.json'), json(a.policyBundle, 4 * 1024 * 1024));
  await writeExclusive(join(stateDir, 'policy', 'acceptance.json'), json(a.policyAcceptance, 32_768));
  await writeExclusive(join(stateDir, 'archive-trust.json'), json(trust, 16_384));
}

/**
 * First enrollment only. Pins are separately provisioned owner input, never taken from the
 * artifact or a server response. A fresh directory is reserved exclusively after validation;
 * trust is published last, with a no-replace hard-link. Interrupted installs remain fail closed
 * and require explicit recovery to a fresh directory. This does not rotate/update old state.
 *
 * The parent directory must already exist and be controlled by this OS user. Node permissions
 * are not a Windows ACL proof; this is an integrity boundary, not a same-user sandbox.
 */
export async function installArchiveEnrollment(input: {
  artifact: unknown; trustedPins: ArchiveTrustConfig; stateDir: string; root: string; device: string; apiOrigin: string; now?: string;
}): Promise<ArchiveRegistration> {
  let stage: string | undefined;
  let parent: string | undefined;
  try {
    const a = snapshotArtifact(input.artifact);
    const trust: ArchiveTrustConfig = JSON.parse(json(input.trustedPins, 16_384));
    if (!trust.enrollment || !trust.policy || trust.enrollment.publicKeyB64 === trust.policy.publicKeyB64 ||
        trust.enrollment.keyId === trust.policy.keyId) throw new ArchiveSourceError('enrollment-distinct-pins-required');
    if (!isAbsolute(input.stateDir) || !isAbsolute(input.root) || input.stateDir.startsWith('\\\\')) throw new ArchiveSourceError('absolute-path-required');
    const stateDir = resolve(input.stateDir), root = resolve(input.root);
    if (overlaps(stateDir, root) || overlaps(root, stateDir) || overlaps(a.registration.descriptor.libraryRepo, stateDir) ||
        overlaps(stateDir, a.registration.descriptor.libraryRepo)) throw new ArchiveSourceError('state-source-overlap');
    // An untrusted digest may not become part of a filesystem path before validation.
    if (!/^[a-f0-9]{64}$/.test(a.registration.descriptor.privacyCensusHash)) throw new ArchiveSourceError('enrollment-artifact-invalid');
    parent = dirname(stateDir);
    const parentIdentity = await inspectArchiveRoot(parent);
    await absent(stateDir);
    stage = await mkdtemp(join(parent, '.kl-enrollment-'));
    await filesAt(stage, a, trust);
    const validation = { root, device: input.device, apiOrigin: input.apiOrigin, now: input.now };
    const verified = await loadArchiveRegistration({ ...validation, stateDir: stage });
    if (!sameIdentity(await inspectArchiveRoot(root), verified.identity)) throw new ArchiveSourceError('source-identity-mismatch');
    if (!sameIdentity(await inspectArchiveRoot(parent), parentIdentity)) throw new ArchiveSourceError('enrollment-parent-changed');
    await absent(stateDir);
    // mkdir is the no-overwrite publication reservation, including concurrent first installs.
    try { await mkdir(stateDir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArchiveSourceError('enrollment-state-exists');
      throw error;
    }
    // All configuration bytes come from the already validated detached snapshot.
    await Promise.all(['registrations', 'policy', 'census'].map(dir => mkdir(join(stateDir, dir), { mode: 0o700 })));
    await writeExclusive(archiveRegistrationFile(stateDir, root), json(a.registration, 32_768));
    await writeExclusive(join(stateDir, 'census', verified.privacyCensusHash + '.json'), a.censusUtf8);
    await writeExclusive(join(stateDir, 'policy', 'bundle.json'), json(a.policyBundle, 4 * 1024 * 1024));
    await writeExclusive(join(stateDir, 'policy', 'acceptance.json'), json(a.policyAcceptance, 32_768));
    const pendingTrust = join(stateDir, '.archive-trust.pending');
    await writeExclusive(pendingTrust, json(trust, 16_384));
    // Link creation is atomic and refuses an existing target on Windows and POSIX. While both
    // links exist, the loader's nlink=1 rule refuses access. A crash there remains fail closed.
    await link(pendingTrust, join(stateDir, 'archive-trust.json'));
    await unlink(pendingTrust);
    return await loadArchiveRegistration({ ...validation, stateDir });
  } catch (error) {
    if (error instanceof ArchiveSourceError) throw error;
    throw new ArchiveSourceError('enrollment-install-failed');
  } finally {
    // Only the mkdtemp-created staging directory is removed; source and final state are never removed.
    if (stage && parent && dirname(stage) === parent && basename(stage).startsWith('.kl-enrollment-')) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
