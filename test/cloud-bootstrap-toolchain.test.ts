import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  manifest: '', lock: 'synthetic locked dependencies\n', installed: '{"version":"4.150.0"}',
  head: 'a'.repeat(40), status: '', entries: 'H package-lock.json\0H scripts/cloud-verify.ts\0',
  configNames: '',
  readFailure: false, gitFailure: false,
}));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: unknown, encoding?: string) => {
    if (state.readFailure) throw new Error('synthetic-private-path and synthetic-secret-marker');
    const normalized = String(path).replaceAll('\\', '/');
    const content = normalized.endsWith('/manifest.json') ? state.manifest
      : normalized.endsWith('/node_modules/wrangler/package.json') ? state.installed
        : normalized.endsWith('/package-lock.json') ? state.lock : undefined;
    if (content === undefined) throw new Error('Unexpected fixture read');
    return encoding ? content : Buffer.from(content);
  }),
}));
vi.mock('../scripts/cloud-bootstrap.ts', () => ({
  bootstrapGit: vi.fn((args: string[]) => {
    if (state.gitFailure) throw new Error('synthetic-secret-marker from child stderr');
    if (args.join(' ') === 'rev-parse HEAD') return state.head;
    if (args.join(' ') === 'config --includes --list --name-only') return state.configNames;
    if (args.join(' ') === 'status --porcelain') return state.status;
    if (args.join(' ') === 'ls-files -v -z') return state.entries;
    throw new Error('Unexpected fixture Git call');
  }),
}));
import { bootstrapGit } from '../scripts/cloud-bootstrap.ts';
import { verifyBootstrapToolchain } from '../scripts/lib/cloud-bootstrap-toolchain.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directory = '/synthetic-reviewed-package';
function pins() { return { commit: 'a'.repeat(40), manifestSha256: hash(state.manifest) }; }
function changeManifest(change: (m: Record<string, unknown>) => void) {
  const manifest = JSON.parse(state.manifest) as Record<string, unknown>;
  change(manifest); state.manifest = JSON.stringify(manifest);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.lock = 'synthetic locked dependencies\n'; state.installed = '{"version":"4.150.0"}';
  state.head = 'a'.repeat(40); state.status = ''; state.entries = 'H package-lock.json\0H scripts/cloud-verify.ts\0';
  state.configNames = '';
  state.readFailure = false; state.gitFailure = false;
  state.manifest = JSON.stringify({ commit: state.head, wrangler: '4.150.0', lockfileSha256: hash(state.lock) });
});

describe('reviewed local bootstrap toolchain', () => {
  it('accepts only a clean checkout and local dependency identity matching the independently pinned package', () => {
    expect(verifyBootstrapToolchain(directory, pins())).toEqual({ commit: 'a'.repeat(40), wrangler: '4.150.0', lockfileSha256: hash(state.lock) });
    expect(vi.mocked(bootstrapGit).mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', 'HEAD'], ['config', '--includes', '--list', '--name-only'], ['status', '--porcelain'], ['ls-files', '-v', '-z'],
    ]);
  });
  it('refuses a different installed Wrangler even with an unchanged reviewed lockfile', () => {
    state.installed = '{"version":"4.149.0"}';
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow('Bootstrap local toolchain verification failed');
  });
  it('refuses a changed local lockfile even with the expected installed Wrangler and clean Git reports', () => {
    state.lock = 'synthetic different locked dependencies\n';
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
  it('refuses an otherwise clean checkout at a different commit', () => {
    state.head = 'b'.repeat(40);
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
  it('refuses an uncommitted local edit', () => {
    state.status = ' M scripts/cloud-verify.ts';
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
  it('refuses a loaded Git filter before asking Git to inspect the worktree', () => {
    state.configNames = 'core.bare\nfilter.synthetic.clean\n';
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
    expect(vi.mocked(bootstrapGit).mock.calls.some((call) => call[0][0] === 'status')).toBe(false);
  });
  it.each(['h package-lock.json\0', 'S scripts/cloud-verify.ts\0', 'M scripts/cloud-verify.ts\0', ''])('refuses hidden or absent index identity: %j', (entries) => {
    state.entries = entries;
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
  it('detects package replacement after the earlier package verification', () => {
    const expected = pins(); changeManifest((m) => { m.unreviewedClaim = true; });
    expect(() => verifyBootstrapToolchain(directory, expected)).toThrow();
    expect(bootstrapGit).not.toHaveBeenCalled();
  });
  it.each([
    ['commit', (m: Record<string, unknown>) => { m.commit = 'b'.repeat(40); }],
    ['Wrangler version', (m: Record<string, unknown>) => { m.wrangler = '0.0.0'; }],
    ['missing lock hash', (m: Record<string, unknown>) => { delete m.lockfileSha256; }],
    ['malformed lock hash', (m: Record<string, unknown>) => { m.lockfileSha256 = 'invalid'; }],
  ] as const)('refuses invalid manifest %s even if its digest is recomputed', (_name, mutation) => {
    changeManifest(mutation);
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
  it.each([undefined, { commit: 'a'.repeat(40) }, { commit: 'bad', manifestSha256: 'c'.repeat(64) }])('refuses invalid review pins: %j', (expected) => {
    expect(() => verifyBootstrapToolchain(directory, expected as any)).toThrow();
    expect(bootstrapGit).not.toHaveBeenCalled();
  });
  it('does not expose filesystem paths or arbitrary error text', () => {
    state.readFailure = true;
    let message = '';
    try { verifyBootstrapToolchain(directory, pins()); } catch (error) { message = (error as Error).message; }
    expect(message).toBe('Bootstrap local toolchain verification failed');
  });
  it('does not expose child-process output', () => {
    state.gitFailure = true;
    let message = '';
    try { verifyBootstrapToolchain(directory, pins()); } catch (error) { message = (error as Error).message; }
    expect(message).toBe('Bootstrap local toolchain verification failed');
  });
  it('refuses malformed installed package metadata', () => {
    state.installed = '{invalid-json';
    expect(() => verifyBootstrapToolchain(directory, pins())).toThrow();
  });
});
