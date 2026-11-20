import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapGit, readArguments, verifyPackage } from '../scripts/cloud-bootstrap.ts';
import { makeBootstrapConfig } from '../scripts/lib/cloud-bootstrap-config.ts';

const input = { environment: 'staging', accountIsolation: 'separate-accounts', stagingAccountId: '1'.repeat(32), productionAccountId: '2'.repeat(32) } as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const parent = resolve('.review', 'bootstrap-package-tests');
const dirs: { root: string; parent: string }[] = [];
function scratch(base = parent): string {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'kl-bootstrap-test-'));
  dirs.push({ root, parent: resolve(base) });
  return root;
}
function fixture(): string {
  const root = scratch();
  const files = { 'worker.mjs': 'export default {};\n', 'wrangler.jsonc': JSON.stringify(makeBootstrapConfig(input)), 'README.txt': 'synthetic closed bootstrap\n' };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(root, file), bytes);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 1, phase: 'bootstrap', archiveAvailable: false, environment: 'staging',
    stagingAccountId: input.stagingAccountId, productionAccountId: input.productionAccountId, accountIsolation: input.accountIsolation, commit: 'a'.repeat(40),
    wrangler: '4.150.0', lockfileSha256: 'c'.repeat(64), files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, digest(b)])) }));
  return root;
}
function pins(root: string) {
  return { commit: 'a'.repeat(40), manifestSha256: digest(readFileSync(join(root, 'manifest.json'), 'utf8')) };
}
function rewriteManifest(root: string, mutate: (manifest: Record<string, any>) => void): void {
  const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); mutate(m);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(m));
}
afterEach(() => {
  for (const { root, parent: base } of dirs.splice(0)) {
    // Only our exact newly allocated fixture directory may be removed, including the tiny Git fixture in TEMP.
    if (!resolve(root).startsWith(base + sep) || !root.split(sep).at(-1)?.startsWith('kl-bootstrap-test-')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local bootstrap packaging boundary', () => {
  it('requires both account IDs and an explicit new output path, without accepting a deployment action', () => {
    const args = ['--staging-account', input.stagingAccountId, '--production-account', input.productionAccountId, '--account-layout', input.accountIsolation, '--out', '.review/example'];
    expect(readArguments(args)).toEqual({ input, out: resolve('.review/example') });
    for (const bad of [[], args.slice(0, 4), [...args, '--deploy', 'true'], [...args, '--staging-account', input.stagingAccountId], ['--staging-account']]) {
      expect(() => readArguments(bad)).toThrow();
    }
  });
  it('accepts an intact package only against separately supplied commit and manifest pins', () => {
    const root = fixture();
    expect(verifyPackage(root, input, pins(root))).toEqual(pins(root));
    // These synthetic executable bytes are not the real Worker; the reviewer's independent pin is essential.
  });
  it.each(['worker.mjs', 'wrangler.jsonc', 'README.txt'])('detects modified %s', (file) => {
    const root = fixture(); const expected = pins(root); writeFileSync(join(root, file), 'changed');
    expect(() => verifyPackage(root, input, expected)).toThrow(/integrity/);
  });
  it('rejects unexpected files instead of silently adding them to an owner upload', () => {
    const root = fixture(); writeFileSync(join(root, 'unexpected.env'), 'synthetic');
    expect(() => verifyPackage(root, input, pins(root))).toThrow(/contents/);
  });
  it.each([
    ['different account', (m: any) => { m.stagingAccountId = input.productionAccountId; }],
    ['production environment', (m: any) => { m.environment = 'production'; }],
    ['archive readiness', (m: any) => { m.archiveAvailable = true; }],
    ['wrong Wrangler', (m: any) => { m.wrangler = '0.0.0'; }],
    ['wrong format', (m: any) => { m.format = 99; }],
    ['missing format', (m: any) => { delete m.format; }],
    ['missing lock hash', (m: any) => { delete m.lockfileSha256; }],
    ['invalid lock hash', (m: any) => { m.lockfileSha256 = 'not-a-sha256'; }],
    ['wrong lock hash type', (m: any) => { m.lockfileSha256 = 123; }],
    ['invented ready field', (m: any) => { m.ready = true; }],
    ['invented approval field', (m: any) => { m.approved = true; }],
    ['invented hosted proof', (m: any) => { m.hostedProven = true; }],
    ['invented rollback proof', (m: any) => { m.rollbackEligible = true; }],
  ] as const)('refuses %s even with an updated manifest digest', (_name, mutation) => {
    const root = fixture(); rewriteManifest(root, mutation);
    expect(() => verifyPackage(root, input, pins(root))).toThrow();
  });
  it('rejects binding/account drift even when member and manifest digests were recomputed', () => {
    const root = fixture(); const config = { ...makeBootstrapConfig(input), r2_buckets: [{ binding: 'ARCHIVE', bucket_name: 'unreviewed' }] };
    const bytes = JSON.stringify(config); writeFileSync(join(root, 'wrangler.jsonc'), bytes);
    rewriteManifest(root, (m) => { m.files['wrangler.jsonc'] = digest(bytes); });
    expect(() => verifyPackage(root, input, pins(root))).toThrow();
  });
  it('refuses a valid different commit even when its manifest hash is supplied', () => {
    const root = fixture(); rewriteManifest(root, (m) => { m.commit = 'b'.repeat(40); });
    expect(() => verifyPackage(root, input, pins(root))).toThrow();
  });
  it('requires the separately reviewed manifest digest rather than recomputing its own approval', () => {
    const root = fixture(); const expected = pins(root);
    writeFileSync(join(root, 'README.txt'), 'changed synthetic instructions\n');
    rewriteManifest(root, (m) => { m.files['README.txt'] = digest('changed synthetic instructions\n'); });
    expect(() => verifyPackage(root, input, expected)).toThrow();
  });
  it.each([
    undefined,
    { commit: 'a'.repeat(40) },
    { manifestSha256: 'c'.repeat(64) },
    { commit: '', manifestSha256: 'c'.repeat(64) },
    { commit: 'a'.repeat(40), manifestSha256: 'not-a-sha256' },
  ])('refuses absent or malformed external pins: %j', (expected) => {
    const root = fixture();
    expect(() => verifyPackage(root, input, expected as any)).toThrow();
  });
  it('does not run a repository fsmonitor or inherit environment Git configuration', () => {
    // Git process startup on the removable D: drive is variable. This fixture is only a tiny throwaway repository.
    const root = scratch(tmpdir()); const marker = join(root, 'helper-ran'); const helper = join(root, 'helper.cjs');
    writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
    writeFileSync(join(root, 'synthetic.txt'), 'synthetic');
    bootstrapGit(['init', '--quiet'], root, { timeoutMs: 30000 });
    bootstrapGit(['config', 'core.fsmonitor', `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`], root, { timeoutMs: 30000 });
    const before = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = 'not-a-number';
    try {
      expect(bootstrapGit(['status', '--porcelain'], root, { timeoutMs: 30000 })).toContain('synthetic.txt');
      expect(existsSync(marker)).toBe(false);
    } finally { if (before === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = before; }
  });
  it('sanitizes child-process failure text', () => {
    const marker = 'synthetic-untrusted-git-error-marker';
    try {
      bootstrapGit([marker]);
      expect.fail('Invalid Git command must fail');
    } catch (error) {
      const message = String(error);
      expect(message).toContain('Local Git verification failed');
      expect(message).not.toContain(marker);
      expect(message).not.toContain(process.cwd());
    }
  });
});
