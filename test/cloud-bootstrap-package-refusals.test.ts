import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  status: '',
  commit: 'a'.repeat(40),
  configNames: '',
  statusCalls: 0,
  indexTags: {} as Record<string, string>,
  overrides: new Map<string, string>(),
  readCommitted: undefined as undefined | ((path: string) => string),
  wranglerVersion: '4.150.0',
  imports: ['apps/api/src/cloudflare/worker.ts'],
  buildCalls: 0,
  afterBuild: undefined as undefined | (() => void),
  gitFailure: undefined as undefined | Record<string, unknown>,
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_executable: string, args: string[], options: { cwd: string }) => {
    if (state.gitFailure) throw state.gitFailure;
    let cursor = 0;
    while (args[cursor] === '-c') cursor += 2;
    const command = args[cursor];
    if (command === 'config') return state.configNames;
    if (command === 'status') { state.statusCalls++; return state.status; }
    if (command === 'rev-parse') return state.commit;
    if (command === 'show' && /^(?:HEAD|[a-f0-9]{40}):/.test(args[cursor + 1] ?? '')) {
      const ref = args[cursor + 1]!;
      return state.readCommitted!(options.cwd + '/' + ref.slice(ref.indexOf(':') + 1));
    }
    if (command === 'ls-files') {
      const delimiter = args.includes('-z') ? '\0' : '\n';
      return ['apps/api/src/cloudflare/worker.ts', 'tsconfig.json', 'package-lock.json']
        .map((file) => `${state.indexTags[file] ?? 'H'} ${file}`).join(delimiter) + delimiter;
    }
    throw new Error('Unsupported synthetic Git operation');
  }),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  state.readCommitted = (path: string) => actual.readFileSync(path, 'utf8');
  return { ...actual, readFileSync: vi.fn((path: any, encoding?: any) => {
    const normalized = String(path).replaceAll('\\', '/');
    let content: string | undefined;
    if (normalized.endsWith('/node_modules/wrangler/package.json')) content = JSON.stringify({ version: state.wranglerVersion });
    else for (const [suffix, bytes] of state.overrides) if (normalized.endsWith('/' + suffix)) { content = bytes; break; }
    if (content !== undefined) return encoding ? content : Buffer.from(content);
    return actual.readFileSync(path, encoding);
  }) };
});
vi.mock('esbuild', () => ({
  build: vi.fn(async () => {
    state.buildCalls++;
    await Promise.resolve();
    state.afterBuild?.();
    return { metafile: { inputs: Object.fromEntries(state.imports.map((path) => [path, {}])) },
      outputFiles: [{ contents: new TextEncoder().encode('export default {};\n') }] };
  }),
}));
import { bootstrapGit, packageBootstrap, verifyPackage } from '../scripts/cloud-bootstrap.ts';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(checkout, '..', '.review', 'bootstrap-refusal-tests');
const dirs: { root: string; parent: string }[] = [];
const input = { environment: 'staging', accountIsolation: 'separate-accounts', stagingAccountId: '1'.repeat(32), productionAccountId: '2'.repeat(32) } as const;
function output(base = parent): string {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'kl-bootstrap-refusal-'));
  dirs.push({ root, parent: resolve(base) });
  return join(root, 'package');
}
beforeEach(() => {
  state.status = ''; state.commit = 'a'.repeat(40); state.configNames = ''; state.statusCalls = 0; state.indexTags = {}; state.overrides.clear(); state.wranglerVersion = '4.150.0';
  state.imports = ['apps/api/src/cloudflare/worker.ts']; state.buildCalls = 0; state.afterBuild = undefined; state.gitFailure = undefined;
});
afterEach(() => {
  for (const { root, parent: base } of dirs.splice(0)) {
    if (!resolve(root).startsWith(base + sep) || !root.split(sep).at(-1)?.startsWith('kl-bootstrap-refusal-')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bootstrap packaging refuses unreviewed inputs before publication', () => {
  it('packages a clean synthetic checkout to a new external folder as the refusal controls baseline', async () => {
    const out = output();
    const pin = await packageBootstrap(input, out);
    expect(pin.commit).toBe('a'.repeat(40));
    expect(state.buildCalls).toBe(1);
    expect(verifyPackage(out, input, pin)).toEqual(pin);
    expect(readFileSync(join(out, 'worker.mjs'), 'utf8')).toBe('export default {};\n');
  });
  it('refuses output inside the source checkout before any build', async () => {
    const out = output(join(checkout, '.review'));
    await expect(packageBootstrap(input, out)).rejects.toThrow(/outside the source checkout/);
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it('refuses an existing output directory without changing its contents', async () => {
    const out = output(); mkdirSync(out); writeFileSync(join(out, 'keep.txt'), 'unchanged');
    await expect(packageBootstrap(input, out)).rejects.toThrow(/overwrite/);
    expect(state.buildCalls).toBe(0); expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('unchanged');
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
  });
  it('refuses an ordinarily dirty tree before any build', async () => {
    const out = output(); state.status = ' M apps/api/src/cloudflare/worker.ts';
    await expect(packageBootstrap(input, out)).rejects.toThrow(/Commit and review/);
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it('refuses loaded Git filters before trusting a clean status or building', async () => {
    const out = output(); state.configNames = 'core.bare\nfilter.synthetic.clean\n';
    await expect(packageBootstrap(input, out)).rejects.toThrow();
    expect(state.statusCalls).toBe(0);
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it('refuses working bytes that differ from HEAD despite a clean status and ordinary index flags', async () => {
    const out = output(); state.overrides.set('apps/api/src/cloudflare/worker.ts', 'export default { ready: true };\n');
    await expect(packageBootstrap(input, out)).rejects.toThrow();
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it('refuses a different installed Wrangler version before any build', async () => {
    const out = output(); state.wranglerVersion = '0.0.0';
    await expect(packageBootstrap(input, out)).rejects.toThrow(/Wrangler/);
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it('refuses an extra bundled source before creating an output directory', async () => {
    const out = output(); state.imports.push('unreviewed.ts');
    await expect(packageBootstrap(input, out)).rejects.toThrow(/unreviewed dependencies/);
    expect(state.buildCalls).toBe(1); expect(existsSync(out)).toBe(false);
  });
  it('refuses a changed HEAD across the asynchronous build before publication', async () => {
    const out = output(); state.afterBuild = () => { state.commit = 'b'.repeat(40); };
    await expect(packageBootstrap(input, out)).rejects.toThrow(/Source changed/);
    expect(state.buildCalls).toBe(1); expect(existsSync(out)).toBe(false);
  });
  it('refuses a newly dirty tree across the asynchronous build before publication', async () => {
    const out = output(); state.afterBuild = () => { state.status = ' M tsconfig.json'; };
    await expect(packageBootstrap(input, out)).rejects.toThrow(/Source changed/);
    expect(state.buildCalls).toBe(1); expect(existsSync(out)).toBe(false);
  });
  it.each([
    ['assume-unchanged worker', 'apps/api/src/cloudflare/worker.ts', 'h'],
    ['skip-worktree worker', 'apps/api/src/cloudflare/worker.ts', 'S'],
    ['assume-unchanged TypeScript configuration', 'tsconfig.json', 'h'],
    ['skip-worktree lockfile', 'package-lock.json', 'S'],
  ])('refuses %s despite a clean status and unchanged HEAD', async (_name, file, tag) => {
    const out = output(); state.indexTags[file!] = tag!;
    state.overrides.set(file!, 'synthetic hidden uncommitted bytes');
    await expect(packageBootstrap(input, out)).rejects.toThrow();
    expect(state.buildCalls).toBe(0); expect(existsSync(out)).toBe(false);
  });
  it.each(['apps/api/src/cloudflare/worker.ts', 'tsconfig.json', 'package-lock.json'])('refuses hidden changes to %s during the asynchronous build', async (file) => {
    const out = output();
    state.afterBuild = () => { state.overrides.set(file, 'synthetic changed during build'); };
    await expect(packageBootstrap(input, out)).rejects.toThrow(/Source changed/);
    expect(state.buildCalls).toBe(1); expect(existsSync(out)).toBe(false);
  });
  it('refuses index flag changes across the asynchronous build even when status and HEAD stay unchanged', async () => {
    const out = output(); state.afterBuild = () => { state.indexTags['apps/api/src/cloudflare/worker.ts'] = 'h'; };
    await expect(packageBootstrap(input, out)).rejects.toThrow();
    expect(state.buildCalls).toBe(1); expect(existsSync(out)).toBe(false);
  });
  it('reports only a bounded timeout code, never Git stderr, paths, or arbitrary error fields', () => {
    state.gitFailure = { code: 'ETIMEDOUT', stderr: 'synthetic-secret-marker', message: 'synthetic-secret-marker', path: 'synthetic-private-path' };
    let message = '';
    try { bootstrapGit(['status', '--porcelain']); } catch (error) { message = (error as Error).message; }
    expect(message).toBe('Local Git verification failed (ETIMEDOUT)');
  });
  it('does not include an unrecognized child error code in the diagnostic', () => {
    state.gitFailure = { code: 'synthetic-secret-marker', stderr: 'synthetic-secret-marker' };
    let message = '';
    try { bootstrapGit(['status', '--porcelain']); } catch (error) { message = String(error); }
    expect(message).toContain('Local Git verification failed');
    expect(message).not.toContain('synthetic-secret-marker');
  });
});
