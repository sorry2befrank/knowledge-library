import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile, rename, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { archiveRegistrationFile, loadArchiveRegistration, canonicalArchiveOrigin } from '../cli/kl/src/archive/registration.ts';
import { scanArchiveSource, inspectArchiveRoot, ARCHIVE_MAX_TEXT_BYTES, archiveChildEnv } from '../cli/kl/src/archive/source.ts';

const run = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof createArchiveFixture>>[] = [];
async function fixture(files?: Record<string, string | Uint8Array>) {
  const f = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:8787', files }); fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

describe('signed archive pre-enrollment', () => {
  it('requires descriptor signature, root scope, and pinned endpoint before scanning', async () => {
    const f = await fixture();
    expect((await loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).folderId).toBe('folder:archive-fixture');
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root, apiOrigin: 'https://elsewhere.example' })).rejects.toThrow('endpoint-mismatch');
    const path = archiveRegistrationFile(f.stateDir, f.root), signed = JSON.parse(await readFile(path, 'utf8'));
    signed.descriptor.folderId = 'folder:tampered';
    await writeFile(path, JSON.stringify(signed));
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('registration-signature-invalid');
    await expect(scanArchiveSource({ ...f.registration })).rejects.toThrow('registration-untrusted');
  });
  it('refuses missing enrollment, changed census, expiry, and registration rollback', async () => {
    const f = await fixture();
    await expect(loadArchiveRegistration({ stateDir: join(f.baseDir, 'missing-state'), root: f.root })).rejects.toThrow('registration-unavailable');
    await f.writeDescriptor({ ...f.descriptor, expiresAt: '2020-01-01T00:00:00.000Z' });
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('registration-expired');
    await f.writeDescriptor();
    await writeFile(join(f.stateDir, 'archive-trust.json'), JSON.stringify({ ...f.trust, enrollment: { ...f.trust.enrollment, minEpoch: 2 } }));
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('registration-rollback');
    await writeFile(join(f.stateDir, 'archive-trust.json'), JSON.stringify(f.trust));
    await writeFile(join(f.stateDir, 'census', f.descriptor.privacyCensusHash + '.json'), '{}');
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('census-mismatch');
  });
  it('refuses tampered and rollback policy instead of using unaccepted rules', async () => {
    const f = await fixture();
    await writeFile(join(f.stateDir, 'policy', 'bundle.json'), JSON.stringify({ files: {} }));
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('policy-unavailable');
    await writeFile(join(f.stateDir, 'policy', 'bundle.json'), JSON.stringify(f.bundle));
    await writeFile(join(f.stateDir, 'archive-trust.json'), JSON.stringify({ ...f.trust, policy: { ...f.trust.policy, minEpoch: 2 } }));
    await expect(loadArchiveRegistration({ stateDir: f.stateDir, root: f.root })).rejects.toThrow('policy-unavailable');
  });
  it('accepts only origin endpoints, loopback plaintext, and independent state paths', async () => {
    for (const endpoint of ['http://example.invalid', 'https://name:password@example.invalid', 'https://example.invalid/subpath', 'https://example.invalid/?token=x']) {
      expect(() => canonicalArchiveOrigin(endpoint)).toThrow('endpoint-invalid');
    }
    expect(canonicalArchiveOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    const f = await fixture();
    await expect(loadArchiveRegistration({ stateDir: join(f.root, 'local-state'), root: f.root })).rejects.toThrow('state-source-overlap');
  });
});

describe('scoped read-only archive source', () => {
  it('keeps exact BOM/CRLF/Unicode bytes, sees ignored files, and measures git tracking', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Café\r\nSynthetic context.\r\n')]);
    const f = await fixture({ 'unicode/épic.md': bytes, 'ignored.md': 'Present despite ignores.\n', '.gitignore': 'ignored.md\n', '.ignore': 'unicode/\n', 'tracked.txt': 'Tracked fixture.\n' });
    await run('git', ['-C', f.root, 'add', '--', 'tracked.txt'], { windowsHide: true });
    // A source-local executable name must never be considered an installed Git command.
    await writeFile(join(f.root, process.platform === 'win32' ? 'git.exe' : 'git'), 'not an executable');
    const scan = await scanArchiveSource(f.registration);
    expect(scan.readErrors).toEqual([]); expect(scan.complete).toBe(true);
    expect(scan.files.find(x => x.relPath === 'unicode/épic.md')?.bytes).toEqual(bytes);
    expect(scan.files.find(x => x.relPath === 'ignored.md')?.gitTracked).toBe(false);
    expect(scan.files.find(x => x.relPath === 'tracked.txt')?.gitTracked).toBe(true);
    expect(await readFile(join(f.root, 'unicode', 'épic.md'))).toEqual(Buffer.from(bytes));
  });
  it('reports held names/content and excluded trees without sending their bytes as files', async () => {
    const f = await fixture({ 'good.md': 'Harmless synthetic context.', 'bad.md': 'Authorization: Bearer ' + 'a'.repeat(32),
      '.env.md': 'Private fixture.', 'PIPELINE.md': 'Synthetic private ledger.', 'fixture-private/private.md': 'Never uploaded.',
      '.remember/hidden.md': 'Never traversed.', 'picture.png': new Uint8Array([1, 2]), 'invalid.md': new Uint8Array([0xff, 0xfe]) });
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files.map(f => f.relPath)).toEqual(['good.md']);
    expect(scan.heldLocal.map(f => f.relPath).sort()).toEqual(['.env.md', 'PIPELINE.md', 'bad.md', 'fixture-private/private.md'].sort());
    expect(scan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: '.remember', kind: 'directory' }), expect.objectContaining({ relPath: 'picture.png', reason: 'unsupported-type' })]));
    expect(scan.readErrors).toEqual([expect.objectContaining({ relPath: 'invalid.md' })]);
    expect(scan.complete).toBe(false);
  });
  it('keeps oversized text local, bounds total enumeration and reports partial coverage', async () => {
    const f = await fixture({ 'large.txt': new Uint8Array(ARCHIVE_MAX_TEXT_BYTES + 1), 'small.md': 'Small.' });
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files.map(f => f.relPath)).toEqual(['small.md']);
    expect(scan.readErrors).toEqual([expect.objectContaining({ relPath: 'large.txt', code: 'text-too-large' })]);
    expect(scan.complete).toBe(false);
    const capped = await scanArchiveSource(f.registration, { maxEntries: 1 });
    expect(capped.complete).toBe(false); expect(capped.readErrors.some(f => f.code === 'entry-limit')).toBe(true);
  });
  it('reports files beyond the aggregate byte budget as incomplete instead of dropping them', async () => {
    const text = new Uint8Array(2 * 1024 * 1024).fill(65);
    const f = await fixture({ 'a.txt': text, 'b.txt': text });
    const scan = await scanArchiveSource(f.registration, { maxSnapshotBytes: 3 * 1024 * 1024 });
    expect(scan.files.map(f => f.relPath)).toEqual(['a.txt']);
    expect(scan.readErrors).toEqual([{ relPath: 'b.txt', code: 'snapshot-byte-limit' }]);
    expect(scan.complete).toBe(false);
  });
  it('reports admitted-file limits and keeps credentials out of child detector environments', async () => {
    const f = await fixture({ 'a.md': 'First fixture.', 'b.md': 'Second fixture.' });
    const scan = await scanArchiveSource(f.registration, { maxFiles: 1 });
    expect(scan.files.map(f => f.relPath)).toEqual(['a.md']);
    expect(scan.readErrors).toEqual([{ relPath: 'b.md', code: 'manifest-entry-limit' }]);
    expect(scan.complete).toBe(false);
    const env = archiveChildEnv({ PATH: 'fixture-path', HOME: 'fixture-home', TEMP: 'fixture-temp', KL_TOKEN_DEVICE: 'fixture-value', CLOUDFLARE_API_TOKEN: 'fixture-value', GIT_DIR: 'fixture-value' });
    expect(env).toEqual({ PATH: 'fixture-path', HOME: 'fixture-home', TEMP: 'fixture-temp' });
  });
  it('requires explicit nested repository entry and measures its own tracked files', async () => {
    const f = await fixture({ 'top.md': 'Top-level fixture.', 'nested/child.md': 'Nested fixture.' });
    await run('git', ['-C', join(f.root, 'nested'), 'init', '-q'], { windowsHide: true });
    await run('git', ['-C', join(f.root, 'nested'), 'add', '--', 'child.md'], { windowsHide: true });
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files.map(f => f.relPath)).toEqual(['top.md']);
    expect(scan.skipped).toContainEqual({ relPath: 'nested', kind: 'directory', reason: 'nested-repository' });
    const entered = await scanArchiveSource(f.registration, { intoRepos: true });
    expect(entered.files.find(f => f.relPath === 'nested/child.md')?.gitTracked).toBe(true);
    expect(entered.readErrors).toEqual([]);
  });
  it('refuses replaced roots, symlink roots, escaping directory links and hard-linked files', async () => {
    const f = await fixture({ 'original.md': 'Original synthetic bytes.' });
    await mkdir(join(f.baseDir, 'outside'));
    await writeFile(join(f.baseDir, 'outside', 'other.md'), 'Outside the enrolled root.');
    await symlink(join(f.baseDir, 'outside'), join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(join(f.root, 'original.md'), join(f.root, 'hard.md'));
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files).toEqual([]);
    expect(scan.skipped).toContainEqual({ relPath: 'escape', kind: 'other', reason: 'reparse' });
    expect(scan.readErrors.map(x => x.code)).toEqual(['source-not-regular', 'source-not-regular']);
    await expect(inspectArchiveRoot(join(f.root, 'escape'))).rejects.toThrow('source-reparse-or-not-directory');
    await rename(f.root, join(f.baseDir, 'old-source')); await mkdir(f.root);
    await expect(scanArchiveSource(f.registration)).rejects.toThrow('source-identity-mismatch');
  });
});
