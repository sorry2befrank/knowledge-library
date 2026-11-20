import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, link, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { generateServiceKey, signAcceptance } from '../packages/core/src/policy/acceptance.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';
import { issueArchiveEnrollmentArtifact, installArchiveEnrollment, buildEnrollmentClaims, type ArchiveEnrollmentArtifact } from '../cli/kl/src/archive/enrollment.ts';
import { loadArchiveRegistration, type ArchiveTrustConfig } from '../cli/kl/src/archive/registration.ts';
import { scanArchiveSource } from '../cli/kl/src/archive/source.ts';
import { main, type Io } from '../cli/kl/src/kl.ts';
import { canonicalJson } from '../packages/core/src/primitives/canonical.ts';

const interruptions = vi.hoisted(() => ({ link: false, unlink: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    link: (...args: Parameters<typeof actual.link>) => {
      if (interruptions.link) { interruptions.link = false; throw Error('synthetic publication interruption'); }
      return actual.link(...args);
    },
    unlink: (...args: Parameters<typeof actual.unlink>) => {
      if (interruptions.unlink) { interruptions.unlink = false; throw Error('synthetic interruption after link'); }
      return actual.unlink(...args);
    },
  };
});

const fixtures: Awaited<ReturnType<typeof createArchiveFixture>>[] = [];
async function fixture() {
  const f = await createArchiveFixture({ apiOrigin: 'https://archive.example.invalid', files: { 'summary.md': 'Synthetic enrollment note.\n' } });
  fixtures.push(f);
  const artifact = await issueArchiveEnrollmentArtifact({ descriptor: f.descriptor,
    censusUtf8: await readFile(join(f.stateDir, 'census', f.descriptor.privacyCensusHash + '.json'), 'utf8'),
    policyBundle: f.bundle, policyAcceptance: f.acceptance, enrollmentKey: f.keys.enrollment });
  const stateDir = join(f.baseDir, 'installed');
  const install = (patch: Partial<Parameters<typeof installArchiveEnrollment>[0]> = {}) => installArchiveEnrollment({
    artifact, trustedPins: f.trust, stateDir, root: f.root, device: f.trust.device, apiOrigin: f.descriptor.apiOrigin, ...patch });
  return { ...f, artifact, install, installed: stateDir };
}
afterEach(async () => { interruptions.link = false; interruptions.unlink = false; for (const f of fixtures.splice(0)) await f.cleanup(); });
async function missing(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
describe('first-install signed archive enrollment', () => {
  it('issues an artifact without trust pins or bearer credentials, installs and scans without source mutation', async () => {
    const f = await fixture();
    expect(Object.keys(f.artifact).sort()).toEqual(['censusUtf8', 'policyAcceptance', 'policyBundle', 'registration', 'schema']);
    expect(JSON.stringify(f.artifact)).not.toContain(f.trust.enrollment.publicKeyB64);
    expect(JSON.stringify(f.artifact)).not.toContain(f.trust.policy.publicKeyB64);
    const before = await readFile(join(f.root, 'summary.md'));
    const registration = await f.install();
    expect(registration.collectionId).toBe(f.descriptor.collectionId);
    expect(registration.policyHash).toBe(f.descriptor.policyHash);
    expect((await scanArchiveSource(registration)).files.map(file => file.relPath)).toEqual(['summary.md']);
    expect(await readFile(join(f.root, 'summary.md'))).toEqual(before);
    expect((await lstat(join(f.installed, 'archive-trust.json'))).nlink).toBe(1);
    expect((await readdir(f.baseDir)).some(name => name.startsWith('.kl-enrollment-'))).toBe(false);
  });
  it.each(['enrollment', 'policy'] as const)('refuses the wrong external %s key before creating target state', async which => {
    const f = await fixture(), wrong = await generateServiceKey();
    const trustedPins: ArchiveTrustConfig = { ...f.trust, [which]: { ...f.trust[which], publicKeyB64: wrong.publicKeyB64 } };
    await expect(f.install({ trustedPins })).rejects.toThrow(which === 'enrollment' ? 'registration-signature-invalid' : 'policy-unavailable');
    await missing(f.installed);
  });
  it('requires independent enrollment and policy keys', async () => {
    const f = await fixture();
    const policyAcceptance = await signAcceptance(f.keys.enrollment.privateKey, { policyHash: f.descriptor.policyHash,
      epoch: f.descriptor.policyEpoch, receiptId: f.acceptance.receiptId, keyId: f.keys.enrollment.keyId });
    // Both signatures are otherwise valid: separation is an actual admission requirement.
    await expect(f.install({ artifact: { ...f.artifact, policyAcceptance }, trustedPins: { ...f.trust, policy: f.trust.enrollment } }))
      .rejects.toThrow('enrollment-distinct-pins-required');
    await missing(f.installed);
  });
  it.each(['root', 'device', 'apiOrigin'] as const)('refuses an unexpected %s scope before creating target state', async which => {
    const f = await fixture();
    const value = which === 'root' ? f.libraryRepo : which === 'device' ? 'different-device' : 'https://elsewhere.example.invalid';
    await expect(f.install({ [which]: value })).rejects.toThrow();
    await missing(f.installed);
  });
  it.each(['signature', 'census', 'policy', 'expiry', 'epoch'] as const)('refuses changed %s before creating target state', async which => {
    const f = await fixture(), artifact: ArchiveEnrollmentArtifact = structuredClone(f.artifact);
    const patch: Partial<Parameters<typeof installArchiveEnrollment>[0]> = { artifact };
    if (which === 'signature') artifact.registration.descriptor.folderId = 'folder:changed';
    if (which === 'census') artifact.censusUtf8 += ' ';
    if (which === 'policy') artifact.policyBundle.files = {};
    if (which === 'expiry') patch.now = new Date(Date.parse(f.descriptor.expiresAt) + 1).toISOString();
    if (which === 'epoch') patch.trustedPins = { ...f.trust, enrollment: { ...f.trust.enrollment, minEpoch: 2 } };
    await expect(f.install(patch)).rejects.toThrow();
    await missing(f.installed);
  });
  it('rejects replaced local roots even when the artifact signature is valid', async () => {
    const f = await fixture();
    await rename(f.root, join(f.baseDir, 'original-root')); await mkdir(f.root);
    await expect(f.install()).rejects.toThrow('source-identity-mismatch');
    await missing(f.installed);
  });
  it('never overwrites an existing complete or partial target, including its pinned trust', async () => {
    const f = await fixture(); await f.install();
    const before = await readFile(join(f.installed, 'archive-trust.json'));
    await expect(f.install()).rejects.toThrow('enrollment-state-exists');
    expect(await readFile(join(f.installed, 'archive-trust.json'))).toEqual(before);
    const partial = join(f.baseDir, 'interrupted'); await mkdir(partial); await writeFile(join(partial, '.archive-trust.pending'), 'partial');
    await expect(f.install({ stateDir: partial })).rejects.toThrow('enrollment-state-exists');
    await expect(loadArchiveRegistration({ stateDir: partial, root: f.root })).rejects.toThrow('registration-unavailable');
    expect(await readFile(join(partial, '.archive-trust.pending'), 'utf8')).toBe('partial');
  });
  it('concurrent installers publish exactly one complete state and do not replace each other', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.install(), f.install()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await loadArchiveRegistration({ stateDir: f.installed, root: f.root })).folderId).toBe(f.descriptor.folderId);
  });
  it('a failed trust publication leaves a partial target unusable and never retries over it', async () => {
    const f = await fixture();
    interruptions.link = true;
    await expect(f.install()).rejects.toThrow('enrollment-install-failed');
    await missing(join(f.installed, 'archive-trust.json'));
    expect(await readFile(join(f.installed, '.archive-trust.pending'), 'utf8')).toContain('kl-archive-trust/v1');
    await expect(loadArchiveRegistration({ stateDir: f.installed, root: f.root })).rejects.toThrow('registration-unavailable');
    await expect(f.install()).rejects.toThrow('enrollment-state-exists');
  });
  it('a crash with both trust links still present remains fail closed', async () => {
    const f = await fixture();
    interruptions.unlink = true;
    await expect(f.install()).rejects.toThrow('enrollment-install-failed');
    expect((await lstat(join(f.installed, 'archive-trust.json'))).nlink).toBe(2);
    await expect(loadArchiveRegistration({ stateDir: f.installed, root: f.root })).rejects.toThrow('configuration-invalid');
    await expect(f.install()).rejects.toThrow('enrollment-state-exists');
  });
  it('refuses state inside source or library repo, and refuses symlinked state parents', async () => {
    const f = await fixture();
    for (const stateDir of [join(f.root, 'state'), join(f.libraryRepo, 'state')]) {
      await expect(f.install({ stateDir })).rejects.toThrow('state-source-overlap'); await missing(stateDir);
    }
    const target = join(f.baseDir, 'target'), alias = join(f.baseDir, 'alias'); await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.install({ stateDir: join(alias, 'state') })).rejects.toThrow('source-reparse-or-not-directory');
    expect(await readdir(target)).toEqual([]);
  });
  it('rejects extra trust/token fields and path-like digest fields before any target write', async () => {
    const f = await fixture();
    for (const artifact of [
      { ...f.artifact, trustedPins: f.trust },
      { ...f.artifact, token: 'not-a-real-token' },
      { ...f.artifact, registration: { ...f.artifact.registration, descriptor: { ...f.descriptor, extra: 'unexpected' } } },
      { ...f.artifact, registration: { ...f.artifact.registration, descriptor: { ...f.descriptor, privacyCensusHash: '../escape' } } },
    ]) { await expect(f.install({ artifact })).rejects.toThrow('enrollment-artifact-invalid'); await missing(f.installed); }
  });
  it('signs a detached descriptor snapshot before the caller can mutate it', async () => {
    const f = await fixture(), descriptor = structuredClone(f.descriptor);
    const issued = issueArchiveEnrollmentArtifact({ descriptor, censusUtf8: f.artifact.censusUtf8,
      policyBundle: f.bundle, policyAcceptance: f.acceptance, enrollmentKey: f.keys.enrollment });
    descriptor.folderId = 'folder:mutation'; descriptor.identity.fileId = 'node-ino:123';
    const artifact = await issued;
    expect(artifact.registration.descriptor.folderId).toBe(f.descriptor.folderId);
    expect(artifact.registration.descriptor.identity).toEqual(f.descriptor.identity);
    expect((await f.install({ artifact })).folderId).toBe(f.descriptor.folderId);
    expect(sha256Hex(artifact.censusUtf8)).toBe(f.descriptor.privacyCensusHash);
  });
  it('binds one-shot server approval claims to authenticated local registration and policy', async () => {
    const f = await fixture(), now = new Date().toISOString();
    const input: Parameters<typeof buildEnrollmentClaims>[1] = { registration: f.registration,
      audience: { origin: f.descriptor.apiOrigin, environment: 'staging', libraryId: 'synthetic-library' },
      principal: 'synthetic-owner', receiptId: f.descriptor.approvalReceiptId, nonce: 'a'.repeat(64), issuedAt: now,
      expiresAt: new Date(Date.parse(now) + 600_000).toISOString(),
      tokens: (['kl-device', 'cc-bearer', 'cx-bearer'] as const).map((kind, i) => ({ kind, hash: String(i + 1).repeat(64),
        expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString() })) };
    const claims = buildEnrollmentClaims(f.artifact, input);
    expect(claims.registrationHash).toBe(sha256Hex(canonicalJson(f.descriptor)));
    expect(claims.folder.collectionId).toBe(f.descriptor.collectionId);
    expect(claims.folder.rootFileId).toBe(f.descriptor.identity.fileId);
    expect(claims.policy.receiptId).toBe(f.acceptance.receiptId);
    expect(claims.privacyCensusHash).toBe(f.descriptor.privacyCensusHash);
    input.tokens[0]!.hash = 'f'.repeat(64);
    expect(claims.tokens[0]!.hash).toBe('1'.repeat(64));
    expect(() => buildEnrollmentClaims(f.artifact, { ...input, registration: { ...f.registration } })).toThrow('registration-untrusted');
    expect(() => buildEnrollmentClaims(f.artifact, { ...input, audience: { ...input.audience, origin: 'https://elsewhere.example.invalid' } })).toThrow('endpoint-mismatch');
    expect(() => buildEnrollmentClaims(f.artifact, { ...input, receiptId: 'different-owner-receipt' })).toThrow('enrollment-policy-mismatch');
    expect(() => buildEnrollmentClaims({ ...f.artifact, censusUtf8: f.artifact.censusUtf8 + ' ' }, input)).toThrow('census-mismatch');
    expect(() => buildEnrollmentClaims({ ...f.artifact, registration: { ...f.artifact.registration,
      descriptor: { ...f.descriptor, collectionId: 'col:elsewhere' } } }, input)).toThrow('enrollment-registration-mismatch');
    expect(() => buildEnrollmentClaims(f.artifact, { ...input, expiresAt: new Date(Date.parse(now) + 1_000_000).toISOString() })).toThrow('enrollment-invalid');
  });
});

async function cliFixture() {
  const f = await fixture();
  const artifactPath = join(f.baseDir, 'artifact.json'), trustPath = join(f.baseDir, 'owner-pins.json');
  await writeFile(artifactPath, JSON.stringify(f.artifact)); await writeFile(trustPath, JSON.stringify(f.trust));
  const argv = ['enroll-install', artifactPath, '--trust', trustPath, '--root', f.root, '--state', f.installed,
    '--device', f.descriptor.device, '--api', f.descriptor.apiOrigin];
  async function run(args: string[] = argv) {
    let out = '', err = '';
    const fetch = vi.fn(async () => { throw Error('network must not be used'); });
    const io: Io = { stdout: s => { out += s; }, stderr: s => { err += s; }, fetch,
      env: { KL_TOKEN_DEVICE: 'synthetic-device-value', KL_TOKEN_CC: 'synthetic-claude-value', KL_TOKEN_CX: 'synthetic-codex-value' } };
    const code = await main(args, io);
    expect(fetch).not.toHaveBeenCalled();
    for (const value of [...Object.values(io.env), f.root, f.artifact.censusUtf8]) expect(out + err).not.toContain(value);
    return { code, out, err };
  }
  return { ...f, artifactPath, trustPath, argv, run };
}
describe('enrollment install CLI', () => {
  it('loads independent owner inputs, installs locally and emits only a fixed success message', async () => {
    const f = await cliFixture();
    const result = await f.run(); expect(result.code).toBe(0); expect(result.err).toBe('');
    expect(result.out).toContain('Local enrollment installed');
    expect((await loadArchiveRegistration({ stateDir: f.installed, root: f.root })).collectionId).toBe(f.descriptor.collectionId);
    const repeated = await f.run(); expect(repeated.code).toBe(1); expect(repeated.out).toBe(''); expect(repeated.err).toContain('enrollment-state-exists');
  });
  it('refuses same input paths, missing/duplicate flags and relative paths before installation', async () => {
    const f = await cliFixture();
    const same = [...f.argv]; same[3] = f.artifactPath;
    expect((await f.run(same)).err).toContain('enrollment-independent-trust-required');
    expect((await f.run(f.argv.slice(0, -2))).code).toBe(2);
    const duplicate = [...f.argv]; duplicate[4] = '--trust'; expect((await f.run(duplicate)).code).toBe(2);
    const relative = [...f.argv]; relative[1] = 'relative-artifact.json'; expect((await f.run(relative)).err).toContain('absolute-path-required');
    await missing(f.installed);
  });
  it('refuses oversized and hard-linked input files without printing their bytes', async () => {
    const f = await cliFixture();
    await writeFile(f.trustPath, 'x'.repeat(16_385)); expect((await f.run()).err).toContain('enrollment-input-invalid');
    await writeFile(f.trustPath, JSON.stringify(f.trust)); await link(f.trustPath, join(f.baseDir, 'pin-alias.json'));
    expect((await f.run()).err).toContain('enrollment-input-invalid');
    await missing(f.installed);
  });
  it('refuses malformed JSON, source-linked inputs and wrong signatures with fixed diagnostics', async () => {
    const f = await cliFixture();
    const privateMarker = 'synthetic-sensitive-input-never-echo';
    await writeFile(f.artifactPath, privateMarker);
    const bad = await f.run(); expect(bad.err).toContain('enrollment-input-invalid'); expect(bad.out + bad.err).not.toContain(privateMarker);
    await writeFile(f.artifactPath, JSON.stringify({ ...f.artifact, registration: { ...f.artifact.registration, sig: 'z'.repeat(86) } }));
    expect((await f.run()).err).toContain('registration-signature-invalid');
    const target = join(f.baseDir, 'inputs'), alias = join(f.baseDir, 'input-alias'); await mkdir(target);
    await writeFile(join(target, 'artifact.json'), JSON.stringify(f.artifact));
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = [...f.argv]; linked[1] = join(alias, 'artifact.json');
    expect((await f.run(linked)).err).toContain('source-reparse-or-not-directory');
    await missing(f.installed);
  });
});
