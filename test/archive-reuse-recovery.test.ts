import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { mintToken } from '../packages/core/src/auth/tokens.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';
import { blobKey } from '../packages/core/src/catalog/blobs.ts';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import type { ArchiveReceipt } from '../cli/kl/src/archive/workflow.ts';

it('real CLI retries a failed reuse by uploading lost bytes while preserving a completed neighbor', async () => {
  const bytes = new TextEncoder().encode('# Synthetic recovery source\r\nAn intact device copy.\r\n');
  const neighbor = new TextEncoder().encode('# Unrelated synthetic progress\n');
  const source = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1', files: { 'source.md': bytes } });
  const destination = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1', files: { 'copy.md': bytes, 'neighbor.md': neighbor } });
  let runtime: Miniflare | undefined;
  const traffic: string[][] = [];
  const replies: Record<string, any>[] = [];
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const part of incoming) chunks.push(new Uint8Array(part));
      const body = Buffer.concat(chunks);
      if (incoming.url === '/v1/batch') traffic.push(JSON.parse(body.toString()).items.map((item: { n: number }) => String(item.n)));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && name !== 'host') headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const response = await runtime!.dispatchFetch('http://fixture' + incoming.url, {
        method: incoming.method, headers: Object.fromEntries(headers), ...(body.length ? { body } : {}),
      });
      const result = new Uint8Array(await response.arrayBuffer());
      if (incoming.url === '/v1/manifest/diff' && response.ok) replies.push(JSON.parse(Buffer.from(result).toString()));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(result);
    } catch { outgoing.writeHead(500); outgoing.end('synthetic proxy failure'); }
  });
  try {
    const bundle = await build({ entryPoints: ['test/helpers/archive-workflow-worker.ts'], bundle: true, write: false,
      platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'] });
    const device = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const connector = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const options = { modules: true as const, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-30',
      durableObjects: { LIBRARY: { className: 'ArchiveWorkflowHarness', useSQLite: true } }, r2Buckets: ['ARCHIVE', 'MIRROR'],
      durableObjectsPersist: join(source.baseDir, 'do'), r2Persist: join(source.baseDir, 'r2'),
      bindings: { SYNTHETIC_FIXTURE: 'archive-workflow-tests-only', DEVICE_TOKEN: device, CONNECTOR_TOKEN: connector,
        FIXTURE_VOLUME: source.descriptor.identity.volumeSerial, FIXTURE_ROOT_ID: source.descriptor.identity.fileId,
        COPY_FIXTURE_VOLUME: destination.descriptor.identity.volumeSerial, COPY_FIXTURE_ROOT_ID: destination.descriptor.identity.fileId } };
    runtime = new Miniflare(options); await runtime.ready;
    await new Promise<void>(resolveReady => proxy.listen(0, '127.0.0.1', resolveReady));
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await source.writeDescriptor({ ...source.descriptor, apiOrigin: origin });
    await destination.writeDescriptor({ ...destination.descriptor, folderId: 'folder:archive-copy-fixture', apiOrigin: origin });
    const invoke = (fixture: typeof source) => new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|pathext|comspec|psmodulepath)$/i.test(key)));
      execFile(process.execPath, [resolve('cli/kl/src/kl.ts'), 'push', fixture.root, '--json'], {
        cwd: fixture.libraryRepo, windowsHide: true, timeout: 90_000, maxBuffer: 1 << 20,
        env: { ...env, NODE_NO_WARNINGS: '1', KL_STATE_DIR: fixture.stateDir, KL_TOKEN_DEVICE: device,
          KL_TOKEN_STORE: join(fixture.baseDir, 'missing-synthetic-token-store.dpapi') },
      }, (error, stdout, stderr) => resolveRun({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr }));
    });
    const original = await invoke(source); expect(original.code, original.stderr).toBe(0);
    // The test binding alone deletes storage. The library exposes no fault-injection route.
    const bucket = await runtime.getR2Bucket('ARCHIVE');
    await bucket.delete(blobKey(sha256Hex(bytes)));
    traffic.length = 0; replies.length = 0;
    const first = await invoke(destination);
    const initialTraffic = [...traffic]; const initialDiff = replies[0]!;
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    traffic.length = 0; replies.length = 0;
    const second = await invoke(destination);
    // Run both attempts before asserting recovery: the old implementation fails
    // this assertion because it offers the lost object again and never uploads.
    expect(second.code, second.stderr).toBe(0);
    expect(first.code).toBe(1);
    const partial = JSON.parse(first.stdout) as ArchiveReceipt;
    const recovered = JSON.parse(second.stdout) as ArchiveReceipt;
    expect(partial.partial).toBe(true);
    expect(partial.items.find(item => item.relPath === 'neighbor.md')).toMatchObject({ status: 'current', stage: 'READBACK_OK' });
    expect(partial.items.find(item => item.relPath === 'copy.md')?.stage).toBe('UNPROVEN');
    expect(initialDiff.reusable).toMatchObject([{ n: 0, relPath: 'copy.md' }]);
    expect(initialTraffic).toEqual([['1']]);
    expect(replies[0]!.missing).toMatchObject([{ n: 0, relPath: 'copy.md' }]);
    expect(replies[0]!.reusable).toEqual([]);
    expect(traffic).toEqual([['0']]);
    expect(recovered).toMatchObject({ snapshotId: partial.snapshotId, partial: false, removalAuthorized: false,
      counts: { reused: 0, reusedBytes: 0, readbackVerified: 2 } });
    expect(recovered.items.find(item => item.relPath === 'neighbor.md')).toMatchObject({
      noteId: partial.items.find(item => item.relPath === 'neighbor.md')!.noteId, ver: 1 });
    const restored = await (await runtime.getR2Bucket('ARCHIVE')).get(blobKey(sha256Hex(bytes)));
    expect(restored).not.toBeNull();
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await readFile(join(source.root, 'source.md')))).toEqual(bytes);
    expect(new Uint8Array(await readFile(join(destination.root, 'copy.md')))).toEqual(bytes);
    expect(new Uint8Array(await readFile(join(destination.root, 'neighbor.md')))).toEqual(neighbor);
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolveClosed => proxy.close(() => resolveClosed()));
    await runtime?.dispose(); await source.cleanup(); await destination.cleanup();
  }
}, 180_000);
