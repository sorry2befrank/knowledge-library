import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as source from '../cli/kl/src/archive/source.ts';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { archiveCommand } from '../cli/kl/src/archive/command.ts';
import { archiveChildEnv, archiveProgramOnPath } from '../cli/kl/src/archive/source.ts';
import { archiveRegistrationFile } from '../cli/kl/src/archive/registration.ts';
import type { Io } from '../cli/kl/src/kl.ts';

const exec = promisify(execFile);
function commandIo(stateDir: string) {
  const output: string[] = [], errors: string[] = [];
  let requests = 0;
  const io: Io = { env: { KL_STATE_DIR: stateDir }, stdout: text => output.push(text), stderr: text => errors.push(text),
    fetch: async () => { requests++; throw Error('unexpected-network-effect'); } };
  return { io, output, errors, get requests() { return requests; } };
}

describe('attended archive command boundaries', () => {
  it.each(['incomplete scan','held local note'])('%s alone exits partial and records completed admitted work', async reason => {
    const fixture = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:8787' });
    const scanner = vi.spyOn(source, 'scanArchiveSource').mockResolvedValue({ files: [], readErrors: [], skipped: [],
      complete: reason !== 'incomplete scan', heldLocal: reason === 'held local note' ? [{ relPath: 'withheld.md', ruleCodes: ['student.content'] }] : [] });
    try {
      const state = commandIo(fixture.stateDir);
      state.io.fetch = async input => new URL(String(input)).pathname === '/v1/manifest/diff' ?
        Response.json({ pushId: 'synthetic-push', missing: [] }) : Response.json({ pushId: 'synthetic-push', partial: false, results: [] });
      const code = await archiveCommand('sync', [fixture.root, '--json'], state.io, async () => 'synthetic-device-token',
        { cwd: fixture.libraryRepo, parentCommand: 'synthetic-attended-console' });
      expect(code).toBe(1); expect(state.errors).toEqual([]);
      expect(JSON.parse(state.output.join(''))).toMatchObject({ partial: true, removalAuthorized: false });
      const db = new DatabaseSync(join(fixture.stateDir, 'kl.sqlite'), { readOnly: true }); try {
        expect(db.prepare('SELECT state FROM archive_runs').all()).toEqual([{ state: 'complete' }]);
        expect(db.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);
      } finally { db.close(); }
    } finally { scanner.mockRestore(); await fixture.cleanup(); }
  }, 45_000);
  it('does not run a configured Git fsmonitor during the persona tripwire', async () => {
    const fixture = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1' });
    try {
      const git = await archiveProgramOnPath('git');
      expect(git).not.toBeNull();
      const probe = join(fixture.baseDir, 'synthetic-fsmonitor.cjs');
      const marker = join(fixture.baseDir, 'fsmonitor-invocations.txt');
      await writeFile(probe, "require('node:fs').appendFileSync(process.argv[2], 'invoked\\n'); process.stdout.write('fixture-cookie\\0');\n");
      const quote = (path: string) => '"' + path.replaceAll('\\', '/') + '"';
      const hook = `${quote(process.execPath)} ${quote(probe)} ${quote(marker)}`;
      const runGit = (args: string[]) => exec(git!, ['-C', fixture.libraryRepo, ...args], { env: archiveChildEnv(), windowsHide: true, timeout: 15_000 });
      await runGit(['config', '--local', 'core.fsmonitor', hook]);
      // Positive control: this fixture really would execute its fsmonitor with ordinary git status.
      await runGit(['status', '--porcelain', '--', 'persona/']);
      expect(await readFile(marker, 'utf8')).toContain('invoked');
      await writeFile(marker, '');
      const state = commandIo(fixture.stateDir);
      let tokenReads = 0;
      const code = await archiveCommand('push', [fixture.root, '--json'], state.io,
        async () => { tokenReads++; return undefined; }, { cwd: fixture.libraryRepo, parentCommand: 'synthetic-attended-console' });
      expect(code).toBe(1);
      expect(state.errors.join('')).toContain('device-token-required'); // Tripwire passed; command stopped before scan/upload.
      expect(tokenReads).toBe(1);
      expect(await readFile(marker, 'utf8')).toBe('');
      expect(state.requests).toBe(0);
      expect(state.output).toEqual([]);
      await expect(access(join(fixture.stateDir, 'kl.sqlite'))).rejects.toThrow();
    } finally { await fixture.cleanup(); }
  }, 45_000);

  it('child helpers receive runtime settings without archive, cloud or Node injection credentials', async () => {
    const injected = { ...process.env, KL_TOKEN_DEVICE: 'synthetic-device-value', CLOUDFLARE_API_TOKEN: 'synthetic-cloud-value',
      AWS_SECRET_ACCESS_KEY: 'synthetic-object-value', GIT_CONFIG_COUNT: 'synthetic-git-value',
      NODE_OPTIONS: '--require=nonexistent-synthetic-hook' };
    const env = archiveChildEnv(injected);
    const result = await exec(process.execPath, ['-e',
      "console.log(JSON.stringify({keys:Object.keys(process.env).filter(k=>/^(KL_|CLOUDFLARE_|AWS_|GIT_|NODE_OPTIONS$)/i.test(k)),path:!!Object.keys(process.env).find(k=>k.toLowerCase()==='path')}))"],
    { env, windowsHide: true, timeout: 10_000 });
    expect(JSON.parse(result.stdout)).toEqual({ keys: [], path: true });
    expect(result.stderr).toBe('');
  });

  it('refuses a modified signed registration before reading a token or launching an upload', async () => {
    const fixture = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1' });
    try {
      const file = archiveRegistrationFile(fixture.stateDir, fixture.root);
      const signed = JSON.parse(await readFile(file, 'utf8'));
      signed.descriptor.apiOrigin = 'http://127.0.0.1:2'; // Signature is deliberately not renewed.
      await writeFile(file, JSON.stringify(signed));
      const state = commandIo(fixture.stateDir);
      let tokenReads = 0;
      const code = await archiveCommand('push', [fixture.root], state.io,
        async () => { tokenReads++; return 'must-not-be-read'; }, { cwd: fixture.libraryRepo, parentCommand: 'synthetic-attended-console' });
      expect(code).toBe(1);
      expect(state.errors.join('')).toContain('registration-signature-invalid');
      expect(tokenReads).toBe(0);
      expect(state.requests).toBe(0);
      expect(state.output).toEqual([]);
      await expect(access(join(fixture.stateDir, 'kl.sqlite'))).rejects.toThrow();
    } finally { await fixture.cleanup(); }
  }, 30_000);
});
