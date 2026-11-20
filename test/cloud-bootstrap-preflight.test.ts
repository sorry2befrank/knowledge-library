import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOwnerEnvironment, prepareBootstrapRun } from '../scripts/cloud-bootstrap-preflight.ts';
import { verifyPackage } from '../scripts/cloud-bootstrap.ts';
import { makeBootstrapConfig } from '../scripts/lib/cloud-bootstrap-config.ts';

const input = { environment: 'staging', accountIsolation: 'shared-account', stagingAccountId: '1'.repeat(32), productionAccountId: '1'.repeat(32) } as const;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
const files = ['README.txt', 'manifest.json', 'worker.mjs', 'wrangler.jsonc'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kl-bootstrap-preflight-'));
  roots.push(root);
  const source = join(root, 'frozen'); mkdirSync(source);
  const members = { 'worker.mjs': 'export default {};\n', 'wrangler.jsonc': JSON.stringify(makeBootstrapConfig(input)), 'README.txt': 'synthetic closed bootstrap\n' };
  for (const [name, bytes] of Object.entries(members)) writeFileSync(join(source, name), bytes);
  const manifest = { format: 1, phase: 'bootstrap', archiveAvailable: false, environment: 'staging',
    stagingAccountId: input.stagingAccountId, productionAccountId: input.productionAccountId, accountIsolation: input.accountIsolation,
    commit: 'a'.repeat(40), wrangler: '4.150.0', lockfileSha256: 'c'.repeat(64),
    files: Object.fromEntries(Object.entries(members).map(([name, bytes]) => [name, digest(bytes)])) };
  const bytes = JSON.stringify(manifest); writeFileSync(join(source, 'manifest.json'), bytes);
  return { root, source, out: join(root, 'run'), pins: { commit: manifest.commit, manifestSha256: digest(bytes) } };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = resolve(root);
    if (dirname(resolved) !== resolve(tmpdir()) || !resolved.split(sep).at(-1)?.startsWith('kl-bootstrap-preflight-')) throw new Error('Unsafe fixture cleanup');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('attended owner run preparation', () => {
  it('makes two byte-identical independent copies with an empty environment file, leaving the source unchanged', () => {
    const f = fixture();
    const before = Object.fromEntries(files.map(name => [name, digest(readFileSync(join(f.source, name)))]));
    const result = prepareBootstrapRun(f.source, f.out, input, f.pins, { WRANGLER_SEND_METRICS: 'false' });
    expect(result).toEqual({ dryRunDirectory: join(f.out, 'dry-run'), deployDirectory: join(f.out, 'deploy'), envFile: join(f.out, 'empty.env') });
    expect(readFileSync(result.envFile).byteLength).toBe(0);
    for (const directory of [result.dryRunDirectory, result.deployDirectory]) {
      expect(readdirSync(directory).sort()).toEqual(files);
      expect(verifyPackage(directory, input, f.pins)).toEqual(f.pins);
      for (const name of files) {
        expect(digest(readFileSync(join(directory, name)))).toBe(before[name]);
        expect(lstatSync(join(directory, name)).nlink).toBe(1);
      }
    }
    writeFileSync(join(result.dryRunDirectory, 'worker.mjs'), 'changed scratch only');
    mkdirSync(join(result.dryRunDirectory, '.wrangler'));
    expect(verifyPackage(result.deployDirectory, input, f.pins)).toEqual(f.pins);
    for (const name of files) expect(digest(readFileSync(join(f.source, name)))).toBe(before[name]);
  });
  it('refuses an existing run directory without nesting, replacing or removing prior evidence', () => {
    const f = fixture(); mkdirSync(f.out); writeFileSync(join(f.out, 'evidence.txt'), 'preserve this');
    expect(() => prepareBootstrapRun(f.source, f.out, input, f.pins, {})).toThrow();
    expect(readdirSync(f.out)).toEqual(['evidence.txt']);
    expect(readFileSync(join(f.out, 'evidence.txt'), 'utf8')).toBe('preserve this');
  });
  it('does not prepare an unapproved manifest or a different commit', () => {
    for (const mutate of [(p: {commit:string;manifestSha256:string}) => { p.manifestSha256 = 'f'.repeat(64); }, (p: {commit:string;manifestSha256:string}) => { p.commit = 'b'.repeat(40); }]) {
      const f = fixture(); mutate(f.pins);
      expect(() => prepareBootstrapRun(f.source, f.out, input, f.pins, {})).toThrow();
      expect(existsSync(f.out)).toBe(false);
    }
  });
  it('refuses changed package bytes before creating the run directory', () => {
    const f = fixture(); writeFileSync(join(f.source, 'worker.mjs'), 'unreviewed bytes');
    expect(() => prepareBootstrapRun(f.source, f.out, input, f.pins, {})).toThrow();
    expect(existsSync(f.out)).toBe(false);
  });
  it('refuses unexpected dotenv files in the frozen package', () => {
    const f = fixture(); writeFileSync(join(f.source, '.env'), 'CLOUDFLARE_ENV=unreviewed');
    expect(() => prepareBootstrapRun(f.source, f.out, input, f.pins, {})).toThrow();
    expect(existsSync(f.out)).toBe(false);
  });
  it('refuses output inside either the source package or the checkout without creating it', () => {
    const f = fixture();
    mkdirSync(resolve('.review'), { recursive: true });
    const destinations = [join(f.source, 'run'), resolve('.review', 'preflight-must-not-create-' + f.root.split(sep).at(-1))];
    for (const out of destinations) {
      expect(existsSync(out)).toBe(false);
      expect(() => prepareBootstrapRun(f.source, out, input, f.pins, {})).toThrow();
      expect(existsSync(out)).toBe(false);
    }
  });
  it('refuses an absent destination parent instead of implicitly creating an unreviewed directory tree', () => {
    const f = fixture(); const out = join(f.root, 'absent', 'run');
    expect(() => prepareBootstrapRun(f.source, out, input, f.pins, {})).toThrow();
    expect(existsSync(dirname(out))).toBe(false);
  });
  it('rejects inherited deployment overrides before preparing any files', () => {
    const f = fixture();
    expect(() => prepareBootstrapRun(f.source, f.out, input, f.pins, { CLOUDFLARE_ENV: 'unreviewed' })).toThrow();
    expect(existsSync(f.out)).toBe(false);
  });
});

describe('owner environment override boundary', () => {
  it.each([
    ['CLOUDFLARE_ENV', 'unexpected'], ['CLOUDFLARE_API_BASE_URL', 'https://example.invalid'], ['CLOUDFLARE_API_TOKEN', 'synthetic'],
    ['CF_API_KEY', 'synthetic'], ['CF_ACCOUNT_ID', '2'.repeat(32)], ['WRANGLER_API_ENVIRONMENT', 'staging'],
    ['WRANGLER_LOG', 'debug'], ['WRANGLER_LOG_PATH', 'unexpected'], ['WRANGLER_REVOKE_URL', 'https://example.invalid'],
    ['WRANGLER_CI_OVERRIDE_NAME', 'wrong-worker'], ['WRANGLER_SEND_METRICS', 'true'], ['cf_api_token', 'synthetic'],
    ['wrangler_send_metrics', 'true'], ['NODE_OPTIONS', '--require=unreviewed'], ['NODE_PATH', 'unreviewed'],
  ])('blocks %s without echoing its value', (key, value) => {
    expect(() => assertOwnerEnvironment({ [key]: value })).toThrow();
    try { assertOwnerEnvironment({ [key]: value }); }
    catch (error) { expect(String(error)).not.toContain(value); }
  });
  it('permits ordinary operating-system values and explicitly disabled metrics', () => {
    expect(() => assertOwnerEnvironment({ PATH: 'synthetic path', SYSTEMROOT: 'synthetic system', WRANGLER_SEND_METRICS: 'false' })).not.toThrow();
  });
});
