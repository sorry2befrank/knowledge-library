import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, writeFile, symlink, stat } from 'node:fs/promises';
import { delimiter, join, resolve, relative } from 'node:path';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { scanArchiveSource } from '../cli/kl/src/archive/source.ts';

const detector = vi.hoisted(() => ({ calls: [] as { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; empty?: boolean }[] }));
// Model Gitleaks' upstream stdin behavior: a missing isolated cwd allows an
// inherited ignore file to suppress a hit. No installed detector or runtime bypass.
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const { EventEmitter } = await import('node:events');
  const { Writable } = await import('node:stream');
  const { readdir } = await import('node:fs/promises');
  const isDetector = (program: string) => /(?:^|[\\/])gitleaks(?:\.exe)?$/.test(program);
  const execFile = (...args: any[]) => Reflect.apply(real.execFile, undefined, args);
  Object.defineProperty(execFile, promisify.custom, { value: async (program: string, args: string[], options: any) => {
    if (!isDetector(program)) return promisify(real.execFile)(program, args, options);
    detector.calls.push({ args, cwd: options?.cwd, env: options?.env });
    return { stdout: 'synthetic-detector-1', stderr: '' };
  } });
  const spawn = (...args: any[]) => {
    if (!isDetector(args[0])) return Reflect.apply(real.spawn, undefined, args);
    const options = args[2];
    const call = { args: args[1] as string[], cwd: options?.cwd as string | undefined, env: options?.env, empty: false };
    detector.calls.push(call);
    const child = new EventEmitter() as any;
    child.kill = () => { child.emit('close', 1); return true; };
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
      void (async () => {
        call.empty = !!call.cwd && (await readdir(call.cwd)).length === 0;
        done();
        // Hit exists unless inherited or local ignore state is available.
        child.emit('close', call.empty ? 10 : 0);
      })().catch(error => child.emit('error', error));
    } });
    return child;
  };
  return { ...real, execFile, spawn };
});

const fixtures: Awaited<ReturnType<typeof createArchiveFixture>>[] = [];
async function fixture() {
  const f = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:8787', files: {
    'note.md': 'Synthetic detector finding, with no real secret.',
    '.gitleaksignore': 'synthetic-note-fingerprint',
  } });
  fixtures.push(f);
  const bin = join(f.baseDir, 'bin'); await mkdir(bin);
  await writeFile(join(bin, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'), 'test double, never executed', { mode: 0o700 });
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  vi.stubEnv(pathKey, bin + delimiter + (process.env[pathKey] ?? ''));
  return f;
}
afterEach(async () => { vi.unstubAllEnvs(); detector.calls.length = 0; for (const f of fixtures.splice(0)) await f.cleanup(); });

describe('optional detector working-directory isolation', () => {
  it('uses an empty disposable cwd outside sources, so inherited ignores cannot hide a finding', async () => {
    const f = await fixture();
    await writeFile(join(f.libraryRepo, '.gitleaksignore'), 'synthetic-note-fingerprint');
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files).toEqual([]);
    expect(scan.heldLocal).toContainEqual({ relPath: 'note.md', ruleCodes: ['secret.gitleaks'] });
    const stdin = detector.calls.find(call => call.args[0] === 'stdin')!;
    expect(stdin.empty).toBe(true);
    expect(resolve(stdin.cwd!, '..')).toBe(join(f.libraryRepo, '.review'));
    expect(relative(f.root, stdin.cwd!).startsWith('..')).toBe(true);
    expect(detector.calls.every(call => call.cwd === stdin.cwd)).toBe(true);
    expect(stdin.env?.GITLEAKS_CONFIG_TOML).toContain('useDefault = true');
    await expect(stat(stdin.cwd!)).rejects.toThrow();
    expect(await readdir(join(f.libraryRepo, '.review'))).toEqual([]);
  });

  it('refuses a reparse scratch parent without launching the detector or following the link', async () => {
    const f = await fixture(), outside = join(f.baseDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.libraryRepo, '.review'), process.platform === 'win32' ? 'junction' : 'dir');
    const scan = await scanArchiveSource(f.registration);
    expect(scan.files).toEqual([]); expect(scan.complete).toBe(false);
    expect(scan.readErrors).toContainEqual({ relPath: 'note.md', code: 'gitleaks-unavailable' });
    expect(detector.calls).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });
});
