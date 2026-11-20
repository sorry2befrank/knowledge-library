// Synthetic owner enrollment, test-only. No executable production bootstrap uses these keys.
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateServiceKey, signAcceptance, bundleHash } from '../../packages/core/src/policy/acceptance.ts';
import { toBase64Url } from '../../packages/core/src/primitives/base64url.ts';
import { sha256Hex } from '../../packages/core/src/primitives/sha256.ts';
import { inspectArchiveRoot, archiveProgramOnPath, archiveChildEnv } from '../../cli/kl/src/archive/source.ts';
import { archiveRegistrationFile, registrationSigningBytes, loadArchiveRegistration, type ArchiveRegistrationDescriptor, type ArchiveTrustConfig } from '../../cli/kl/src/archive/registration.ts';

const run = promisify(execFile);
const safeWrite = async (path: string, content: string | Uint8Array) => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, content); };
export async function createArchiveFixture(options: { apiOrigin: string; files?: Record<string, string | Uint8Array>; now?: string; baseDir?: string }) {
  const review = resolve('.review');
  await mkdir(review, { recursive: true });
  const baseDir = options.baseDir ? resolve(options.baseDir) : await mkdtemp(join(review, 'archive-source-'));
  const relation = relative(review, baseDir);
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw Error('fixture-outside-review');
  const root = join(baseDir, 'source'), stateDir = join(baseDir, 'state'), libraryRepo = join(baseDir, 'library-repo');
  const hooks = join(baseDir, 'empty-hooks');
  await Promise.all([mkdir(root, { recursive: true }), mkdir(stateDir, { recursive: true }), mkdir(libraryRepo, { recursive: true }), mkdir(hooks, { recursive: true })]);
  const gitEnv = archiveChildEnv();
  const gitProgram = await archiveProgramOnPath('git');
  if (!gitProgram) throw Error('fixture-git-unavailable');
  const git = (cwd: string, args: string[]) => run(gitProgram, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, windowsHide: true, env: gitEnv, timeout: 20_000 });
  await git(root, ['init', '-q']);
  await git(libraryRepo, ['init', '-q']);
  await safeWrite(join(libraryRepo, 'persona', 'NORTHSTAR.md'), '# Synthetic Library\n');
  await git(libraryRepo, ['add', '--', 'persona']);
  await git(libraryRepo, ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic persona baseline']);
  for (const [rel, bytes] of Object.entries(options.files ?? { 'overview.md': '# A synthetic archive project\n' })) {
    if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some(part => !part || part === '.' || part === '..')) throw Error('fixture-path-invalid');
    await safeWrite(join(root, ...rel.split('/')), bytes);
  }
  const keys = { enrollment: await generateServiceKey(), policy: await generateServiceKey() };
  const trust: ArchiveTrustConfig = { schema: 'kl-archive-trust/v1', device: 'fixture-device',
    enrollment: { keyId: keys.enrollment.keyId, publicKeyB64: keys.enrollment.publicKeyB64, minEpoch: 1 },
    policy: { keyId: keys.policy.keyId, publicKeyB64: keys.policy.publicKeyB64, minEpoch: 1 } };
  const template = JSON.parse(await readFile(new URL('../../policy/deny.template.json', import.meta.url), 'utf8'));
  const bundle = { files: {
    'deny.reference.json': template,
    'deny.private.json': { ownerApprovedRevision: 'synthetic-archive-v1', projectAndClientDeniedDirectorySegments: ['fixture-private'],
      projectAuditDirectoryPatterns: [{ source: '^fixture-audit-', flags: 'i' }], privateOperationalPathSignatures: ['/fixture-records/'],
      clientClassificationRules: ['Example Orchard'], privateLedgerPathRules: ['FIXTURE-LEDGER.md'] },
  } };
  const acceptance = await signAcceptance(keys.policy.privateKey, { policyHash: bundleHash(bundle), epoch: 1, receiptId: 'fixture-policy-receipt', keyId: keys.policy.keyId });
  const identity = await inspectArchiveRoot(root);
  const now = options.now ?? new Date().toISOString();
  const census = JSON.stringify({ schema: 'kl-privacy-census/v1', root, device: trust.device, identity,
    collectionId: 'col:archive-fixture', privacyClass: 'team', at: now, fixture: true }) + '\n';
  const descriptor: ArchiveRegistrationDescriptor = { schema: 'kl-archive-registration/v1', identityScheme: 'node-stat-v1',
    root, identity, folderId: 'folder:archive-fixture', device: trust.device, collectionId: 'col:archive-fixture', privacyClass: 'team',
    libraryRepo, apiOrigin: options.apiOrigin, privacyCensusHash: sha256Hex(census), approvalReceiptId: 'fixture-root-approval',
    policyHash: acceptance.policyHash, policyEpoch: 1, registrationEpoch: 1, issuedAt: new Date(Date.parse(now) - 60_000).toISOString(),
    expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString() };
  async function writeDescriptor(next: ArchiveRegistrationDescriptor = descriptor) {
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.enrollment.privateKey, registrationSigningBytes(next, keys.enrollment.keyId) as BufferSource));
    await safeWrite(archiveRegistrationFile(stateDir, root), JSON.stringify({ descriptor: next, keyId: keys.enrollment.keyId, sig: toBase64Url(sig) }) + '\n');
  }
  await safeWrite(join(stateDir, 'archive-trust.json'), JSON.stringify(trust) + '\n');
  await safeWrite(join(stateDir, 'census', descriptor.privacyCensusHash + '.json'), census);
  await safeWrite(join(stateDir, 'policy', 'bundle.json'), JSON.stringify(bundle) + '\n');
  await safeWrite(join(stateDir, 'policy', 'acceptance.json'), JSON.stringify(acceptance) + '\n');
  await writeDescriptor();
  const registration = await loadArchiveRegistration({ stateDir, root, now });
  return { baseDir, root, stateDir, libraryRepo, descriptor, registration, trust, bundle, acceptance, keys, writeDescriptor,
    async cleanup() {
      // Only the exact generated synthetic directory can be recursively removed.
      const underReview = relative(review, baseDir);
      if (!underReview || underReview.startsWith('..') || isAbsolute(underReview)) throw Error('fixture-cleanup-scope');
      await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } };
}
