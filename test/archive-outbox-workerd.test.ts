import { expect, it } from 'vitest';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mintToken } from '../packages/core/src/auth/tokens.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';
import { blobKey } from '../packages/core/src/catalog/blobs.ts';

it('automatically indexes after restart, holds corrupt bytes, and serves verified MCP citations to both clients', async () => {
  const parent = resolve('.review', 'archive-outbox-runtime');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  const inside = relative(parent, root);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unsafe fixture root');
  let runtime: Miniflare | undefined;
  try {
    const bundle = await build({ entryPoints: ['test/helpers/archive-workflow-worker.ts'],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'] });
    const mint = () => mintToken(n => new Uint8Array(randomBytes(n))).token;
    const device = mint(), claude = mint(), codex = mint();
    const options: MiniflareOptions = { name: 'archive-outbox-test', modules: true, unsafeInspectDurableObjects: true,
      script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-30',
      durableObjects: { LIBRARY: { className: 'ArchiveWorkflowHarness', useSQLite: true } },
      r2Buckets: ['ARCHIVE', 'MIRROR'], durableObjectsPersist: join(root, 'do'), r2Persist: join(root, 'r2'),
      bindings: { SYNTHETIC_FIXTURE: 'archive-workflow-tests-only', DEVICE_TOKEN: device,
        CONNECTOR_TOKEN: claude, CODEX_TOKEN: codex, OUTBOX_SCHEDULER: 'enabled', OUTBOX_MIN_DELAY: '5000' } };
    runtime = new Miniflare(options);
    const headers = { authorization: `Bearer ${device}`, 'content-type': 'application/json' };
    const post = async (path: string, body: unknown) => {
      const response = await runtime!.dispatchFetch('https://fixture.invalid' + path, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, any>>;
    };
    const call = async (token: string, name: string, args: unknown) => {
      const response = await runtime!.dispatchFetch('https://fixture.invalid/mcp', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: { isError: boolean; structuredContent: Record<string, any> } }>;
    };
    const body = '# Synthetic observatory\nCobalt telescope plans survive a restart. Café and 雲.\n';
    const source = join(root, 'source.md');
    await writeFile(source, body);
    const bytes = new Uint8Array(await readFile(source)), digest = sha256Hex(bytes);
    const diff = await post('/v1/manifest/diff', { snapshotId: 'synthetic-alarm-push', folderId: 'folder:archive-fixture',
      device: 'fixture-device', collection: 'col:archive-fixture', identity: { volumeSerial: 'fixture-volume', rootFileId: 'fixture-root' },
      scanComplete: true, heldLocal: {}, entries: [{ relPath: 'observatory.md', sha256: digest, size: bytes.length,
        mtime: '2026-10-01T00:00:00.000Z', gitTracked: false }] });
    await post('/v1/batch', { pushId: diff.pushId, items: [{ n: 0, contentBase64: Buffer.from(bytes).toString('base64') }] });
    const committed = await post('/v1/commit', { pushId: diff.pushId });
    expect(committed).toMatchObject({ partial: false, results: [{ ok: true, custody: 'verified' }] });
    const item = committed.results[0];
    const before = await call(claude, 'library_search', { q: 'cobalt' });
    expect(before.result.structuredContent.hits).toEqual([]); // upload verification is not indexing
    await (await runtime.getR2Bucket('ARCHIVE')).put(blobKey(digest), 'violet tampered fixture');
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    let storage = await runtime.unsafeGetDurableObjectStorage('archive-outbox-test', 'ArchiveWorkflowHarness', { name: 'synthetic-archive-workflow' });
    // Inspect storage, never invoke a drain endpoint. Only the actual durable alarm runs the outbox.
    await expect.poll(async () => (await storage.exec("SELECT attempts FROM outbox WHERE step='index.version'"))[0]?.attempts,
      { timeout: 20_000, interval: 100 }).toBeGreaterThan(0);
    expect(await storage.exec("SELECT state, lastError FROM outbox WHERE step='index.version'"))
      .toEqual([{ state: 'pending', lastError: `corrupt-object: ${digest}` }]);
    expect(await storage.exec('SELECT count(*) AS c FROM chunks')).toEqual([{ c: 0 }]);
    expect((await call(codex, 'library_search', { q: 'violet' })).result.structuredContent.hits).toEqual([]);
    await (await runtime.getR2Bucket('ARCHIVE')).put(blobKey(digest), bytes);
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    storage = await runtime.unsafeGetDurableObjectStorage('archive-outbox-test', 'ArchiveWorkflowHarness', { name: 'synthetic-archive-workflow' });
    await expect.poll(async () => (await storage.exec("SELECT count(*) AS c FROM outbox WHERE state='pending'"))[0]?.c,
      { timeout: 20_000, interval: 100 }).toBe(0);
    for (const token of [claude, codex]) {
      const search = await call(token, 'library_search', { q: 'cobalt', scope: { collection: 'col:archive-fixture' } });
      expect(search.result.isError).toBe(false);
      expect(search.result.structuredContent.hits).toHaveLength(1);
      const cite = search.result.structuredContent.hits[0].cite;
      expect(cite).toBe(item.cite);
      const read = await call(token, 'library_read', { ref: cite });
      expect(read.result.isError).toBe(false);
      expect(read.result.structuredContent).toMatchObject({ cite, sha256: digest });
      expect(read.result.structuredContent.text).toContain(body);
      const save = await call(token, 'library_save', { content: 'read-only clients cannot write' });
      expect(save.result).toMatchObject({ isError: true, structuredContent: { error: 'insufficient-scope' } });
    }
    const unknown = await runtime.dispatchFetch('https://fixture.invalid/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${mint()}` }, body: '{}' });
    expect(unknown.status).toBe(401);
    const again = await post('/v1/commit', { pushId: diff.pushId });
    expect(again.results[0]).toMatchObject({ noteId: item.noteId, ver: item.ver, sha256: digest });
    expect(await storage.exec('SELECT count(*) AS c FROM versions')).toEqual([{ c: 1 }]);
    expect(await storage.exec('SELECT count(*) AS c FROM chunks')).toEqual([{ c: 1 }]);
    expect(new Uint8Array(await readFile(source))).toEqual(bytes);
    const raw = await runtime.dispatchFetch(`https://fixture.invalid/v1/version/${item.noteId}@${item.ver}/bytes`, { headers });
    expect(raw.status).toBe(200);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
  } finally {
    await runtime?.dispose();
    const check = relative(parent, resolve(root));
    if (!check || check.startsWith('..') || isAbsolute(check)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
