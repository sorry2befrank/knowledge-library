import { expect, it } from 'vitest';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mintToken } from '../packages/core/src/auth/tokens.ts';
import { makeValidator as nodeValidator } from '@kl/contracts';
import { makeValidator as workerValidator } from '@kl/contracts/worker';
import { TOOL_DEFINITIONS } from '../packages/core/src/tools/definitions.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';
import { blobKey } from '../packages/core/src/catalog/blobs.ts';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ArchiveReceipt } from '../cli/kl/src/archive/workflow.ts';
import { DatabaseSync } from 'node:sqlite';
import { sliceLines } from '../packages/core/src/primitives/citation.ts';

it('standalone tool validators preserve rejection behavior without an eval-capable runtime', () => {
  const samples = [null, true, [], {}, { unknownField: 1 }, { content: 'accepted synthetic note' },
    { q: 'query', k: 21 }, { q: 'query', scope: { unexpected: true } }, { ref: 'id', maxChars: 0 }];
  for (const tool of TOOL_DEFINITIONS) {
    const ordinary = nodeValidator(tool.inputSchema), portable = workerValidator(tool.inputSchema);
    for (const sample of samples) expect(portable(sample)).toEqual(ordinary(sample));
  }
  expect(() => workerValidator({ type: 'string' })).toThrow('Missing compiled input schema');
});

it('runs the full API catalog and authentication inside workerd with SQLite and R2 bindings', async () => {
  const parent = resolve('.review', 'archive-runtime');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  if (!resolve(root).startsWith(parent + sep)) throw new Error('Fixture escaped its root');
  let runtime: Miniflare | undefined;
  try {
    const bundle = await build({ entryPoints: ['test/helpers/archive-workflow-worker.ts'],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'] });
    const script = bundle.outputFiles![0]!.text;
    expect(script).not.toMatch(/new Function\(|eval\(|node:sqlite|node:fs/);
    const device = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const connector = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const options: MiniflareOptions = {
      modules: true, script, compatibilityDate: '2026-07-30',
      durableObjects: { LIBRARY: { className: 'ArchiveWorkflowHarness', useSQLite: true } },
      r2Buckets: ['ARCHIVE', 'MIRROR'], durableObjectsPersist: join(root, 'do'), r2Persist: join(root, 'r2'),
      bindings: { SYNTHETIC_FIXTURE: 'archive-workflow-tests-only', DEVICE_TOKEN: device, CONNECTOR_TOKEN: connector },
    };
    runtime = new Miniflare(options);
    const health = await runtime.dispatchFetch('http://fixture/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const noAuth = await runtime.dispatchFetch('http://fixture/mcp', { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    const list = await runtime.dispatchFetch('http://fixture/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${connector}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'library_read' })]) } });
    const invalid = await runtime.dispatchFetch('http://fixture/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${connector}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'library_read', arguments: { ref: 10 } } }) });
    expect(await invalid.json()).toMatchObject({ result: { isError: true, structuredContent: { error: 'invalid-args' } } });
    const headers = { authorization: `Bearer ${device}`, 'content-type': 'application/json' };
    const post = async (path: string, body: unknown) => {
      const response = await runtime!.dispatchFetch('http://fixture' + path, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return await response.json() as Record<string, any>;
    };
    const bytes = new TextEncoder().encode('\ufeff# Synthetic archive\r\nByte exact: café, 雲.\r\n');
    const manifest = { snapshotId: 'synthetic-workerd-initial', folderId: 'folder:archive-fixture', device: 'fixture-device',
      collection: 'col:archive-fixture', identity: { volumeSerial: 'fixture-volume', rootFileId: 'fixture-root' },
      scanComplete: true, heldLocal: {}, entries: [{ relPath: 'handoff.md', sha256: sha256Hex(bytes), size: bytes.length,
        mtime: '2026-10-01T00:00:00.000Z', gitTracked: false }] };
    const diff = await post('/v1/manifest/diff', manifest);
    expect(diff.missing).toHaveLength(1);
    const bad = await post('/v1/batch', { pushId: diff.pushId, items: [{ n: 0, content: 'wrong bytes' }] });
    expect(bad.results).toMatchObject([{ ok: false, ruleCodes: ['digest-mismatch'] }]);
    const staged = await post('/v1/batch', { pushId: diff.pushId, items: [{ n: 0, contentBase64: Buffer.from(bytes).toString('base64') }] });
    expect(staged.results).toMatchObject([{ ok: true, status: 'staged' }]);
    // Recreate the actual Worker isolate/DO instance between staging and commit.
    await runtime.dispose(); runtime = new Miniflare(options);
    const committed = await post('/v1/commit', { pushId: diff.pushId });
    expect(committed).toMatchObject({ partial: false, missing: [], results: [{ ok: true, custody: 'verified' }] });
    const item = committed.results[0];
    const retry = await post('/v1/commit', { pushId: diff.pushId });
    expect(retry.results[0]).toMatchObject({ noteId: item.noteId, ver: item.ver, sha256: item.sha256 });
    const read = await runtime.dispatchFetch(`http://fixture/v1/version/${item.noteId}@${item.ver}/bytes`, { headers });
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    const same = await post('/v1/manifest/diff', { ...manifest, snapshotId: 'synthetic-workerd-same' });
    expect(same.missing).toEqual([]);
    expect(same.unchanged).toMatchObject([{ noteId: item.noteId, ver: item.ver, custody: 'verified' }]);
    // Corruption introduced only through Miniflare's test binding, never through an application route.
    const bucket = await runtime.getR2Bucket('ARCHIVE');
    await bucket.put(blobKey(item.sha256), new Uint8Array([1, 2, 3]));
    const corrupt = await runtime.dispatchFetch(`http://fixture/v1/version/${item.noteId}@${item.ver}/bytes`, { headers });
    expect(corrupt.status).toBe(409);
    expect(await corrupt.json()).toMatchObject({ error: 'corrupt-object' });
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('real kl push/sync reuses historical and same-collection bytes with zero payload requests across resume and workerd restart', async () => {
  const original = new TextEncoder().encode('\ufeff# Synthetic project\r\nProgress: café and 雲.\r\n');
  const large = new TextEncoder().encode('# Larger synthetic note\n' + 'Line of fixture material.\n'.repeat(44_000));
  const files = { 'handoff.md': original, 'empty.txt': new Uint8Array(), 'large.md': large };
  const fixture = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1', files });
  const copyFixture = await createArchiveFixture({ apiOrigin: 'http://127.0.0.1:1', files: { 'copied.md': original, 'copied-large.md': large } });
  let runtime: Miniflare | undefined;
  let lostCommitResponses = 3;
  let corruptReadback = false;
  const payloadTraffic: { path: string; requestBytes: number; fileBytes: number }[] = [];
  const manifestReplies: Record<string, any>[] = [];
  const snapshots: string[] = [];
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const part of incoming) chunks.push(new Uint8Array(part));
      const body = Buffer.concat(chunks);
      if (incoming.url === '/v1/manifest/diff') snapshots.push(JSON.parse(body.toString()).snapshotId);
      if (incoming.url === '/v1/batch') payloadTraffic.push({ path: incoming.url, requestBytes: body.length,
        fileBytes: JSON.parse(body.toString()).items.reduce((total: number, item: { contentBase64: string }) => total + Buffer.from(item.contentBase64, 'base64').length, 0) });
      if (incoming.url?.startsWith('/v1/upload/')) payloadTraffic.push({ path: incoming.url, requestBytes: body.length, fileBytes: body.length });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && name !== 'host') headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const response = await runtime!.dispatchFetch('http://fixture' + incoming.url, {
        method: incoming.method, headers: Object.fromEntries(headers), ...(body.length ? { body } : {}),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (incoming.url === '/v1/manifest/diff' && response.ok) manifestReplies.push(JSON.parse(Buffer.from(bytes).toString()));
      if (incoming.url === '/v1/commit' && lostCommitResponses > 0) {
        lostCommitResponses--; outgoing.destroy(); return; // The server committed; the client cannot know that.
      }
      if (corruptReadback && incoming.url?.startsWith('/v1/version/') && response.ok) {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(new Uint8Array(bytes.length)); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(bytes);
    } catch { outgoing.writeHead(500); outgoing.end('synthetic proxy failure'); }
  });
  try {
    const bundle = await build({ entryPoints: ['test/helpers/archive-workflow-worker.ts'],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'] });
    const device = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const connector = mintToken(n => new Uint8Array(randomBytes(n))).token;
    const options: MiniflareOptions = { modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-30',
      durableObjects: { LIBRARY: { className: 'ArchiveWorkflowHarness', useSQLite: true } }, r2Buckets: ['ARCHIVE', 'MIRROR'],
      durableObjectsPersist: join(fixture.baseDir, 'do'), r2Persist: join(fixture.baseDir, 'r2'),
      bindings: { SYNTHETIC_FIXTURE: 'archive-workflow-tests-only', DEVICE_TOKEN: device, CONNECTOR_TOKEN: connector,
        FIXTURE_VOLUME: fixture.descriptor.identity.volumeSerial, FIXTURE_ROOT_ID: fixture.descriptor.identity.fileId,
        COPY_FIXTURE_VOLUME: copyFixture.descriptor.identity.volumeSerial, COPY_FIXTURE_ROOT_ID: copyFixture.descriptor.identity.fileId } };
    runtime = new Miniflare(options);
    await runtime.ready;
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await fixture.writeDescriptor({ ...fixture.descriptor, apiOrigin: origin });
    await copyFixture.writeDescriptor({ ...copyFixture.descriptor, folderId: 'folder:archive-copy-fixture', apiOrigin: origin });
    const invoke = (mode: 'push' | 'sync', source = fixture) => new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
      // Whitelist system runtime variables. The child never inherits real cloud credentials or agent tokens.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|pathext|comspec|psmodulepath)$/i.test(key)));
      execFile(process.execPath, [resolve('cli/kl/src/kl.ts'), mode, source.root, '--json'], {
        cwd: source.libraryRepo, windowsHide: true, timeout: 90_000, maxBuffer: 1 << 20,
        env: { ...env, NODE_NO_WARNINGS: '1', KL_STATE_DIR: source.stateDir, KL_TOKEN_DEVICE: device,
          KL_TOKEN_STORE: join(source.baseDir, 'missing-synthetic-token-store.dpapi') },
      }, (error, stdout, stderr) => resolveRun({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr }));
    });
    const interrupted = await invoke('push');
    expect(interrupted.code, interrupted.stderr).toBe(1);
    expect(lostCommitResponses).toBe(0);
    expect(interrupted.stderr).toContain('archive-transport-or-response-failed');
    expect(interrupted.stdout).toBe('');
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    const resumed = await invoke('push');
    expect(resumed.code, resumed.stderr).toBe(0);
    const first = JSON.parse(resumed.stdout) as ArchiveReceipt;
    expect(first).toMatchObject({ partial: false, removalAuthorized: false, counts: { readbackVerified: 3, custodyVerified: 3 } });
    expect(new Set(snapshots).size).toBe(1); // A fresh process reused the durable snapshot after the uncertain commit.
    for (const [path, bytes] of Object.entries(files)) expect(new Uint8Array(await readFile(join(fixture.root, path)))).toEqual(bytes);
    const unchanged = await invoke('sync');
    expect(unchanged.code, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ partial: false, counts: { deduplicated: 3, readbackVerified: 3 } });
    const changed = new TextEncoder().encode('# Synthetic project\r\nA new verified revision.\r\n');
    await writeFile(join(fixture.root, 'handoff.md'), changed);
    const synced = await invoke('sync');
    expect(synced.code, synced.stderr).toBe(0);
    const second = JSON.parse(synced.stdout) as ArchiveReceipt;
    const before = first.items.find(item => item.relPath === 'handoff.md')!;
    const after = second.items.find(item => item.relPath === 'handoff.md')!;
    expect(after).toMatchObject({ noteId: before.noteId, ver: before.ver! + 1, stage: 'READBACK_OK' });
    // Revert bytes exist only in the older version of this destination. The response loss occurs
    // after the server commit, then both the CLI process and workerd are restarted for recovery.
    await writeFile(join(fixture.root, 'handoff.md'), original);
    payloadTraffic.length = 0; manifestReplies.length = 0; snapshots.length = 0; lostCommitResponses = 3;
    const revertInterrupted = await invoke('sync');
    expect(revertInterrupted.code).toBe(1); expect(revertInterrupted.stdout).toBe(''); expect(lostCommitResponses).toBe(0);
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    const revertResult = await invoke('sync');
    expect(revertResult.code, revertResult.stderr).toBe(0);
    const reverted = JSON.parse(revertResult.stdout) as ArchiveReceipt;
    const revertTraffic = [...payloadTraffic], revertDiff = manifestReplies[0]!;
    const restored = reverted.items.find(item => item.relPath === 'handoff.md')!;
    expect(new Set(snapshots).size).toBe(1);
    const sameHistoricalSnapshot = new Set(snapshots).size === 1;
    expect(restored).toMatchObject({ noteId: before.noteId, ver: after.ver! + 1, stage: 'READBACK_OK' });
    // A new registered folder must receive its own identity and aliases. Exercise both the small
    // batch threshold and the large raw-upload threshold, with a deliberately bad readback first.
    payloadTraffic.length = 0; manifestReplies.length = 0;
    corruptReadback = true;
    const failedCopyResult = await invoke('push', copyFixture);
    expect(failedCopyResult.code).toBe(1);
    const failedCopy = JSON.parse(failedCopyResult.stdout) as ArchiveReceipt;
    expect(failedCopy).toMatchObject({ partial: true, counts: { readbackVerified: 0 }, items: [
      { stage: 'CUSTODY_OK', reason: 'readback-failed' }, { stage: 'CUSTODY_OK', reason: 'readback-failed' }] });
    const pendingDb = new DatabaseSync(join(copyFixture.stateDir, 'kl.sqlite'), { readOnly: true });
    try {
      expect(pendingDb.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);
      expect(pendingDb.prepare("SELECT count(*) AS n FROM archive_runs WHERE state='complete'").get()!.n).toBe(0);
    } finally { pendingDb.close(); }
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready; corruptReadback = false;
    const copyResult = await invoke('push', copyFixture);
    expect(copyResult.code, copyResult.stderr).toBe(0);
    const copied = JSON.parse(copyResult.stdout) as ArchiveReceipt;
    const copyTraffic = [...payloadTraffic], copyDiff = manifestReplies[0]!;
    expect(copied.snapshotId).toBe(failedCopy.snapshotId);
    const copiedSmall = copied.items.find(item => item.relPath === 'copied.md')!;
    const copiedLarge = copied.items.find(item => item.relPath === 'copied-large.md')!;
    expect(copiedSmall.noteId).not.toBe(before.noteId);
    expect(copiedLarge.noteId).not.toBe(first.items.find(item => item.relPath === 'large.md')!.noteId);
    expect(copied.items.every(item => item.ver === 1 && item.stage === 'READBACK_OK')).toBe(true);
    const unchangedCopy = await invoke('sync', copyFixture);
    expect(unchangedCopy.code, unchangedCopy.stderr).toBe(0);
    expect(JSON.parse(unchangedCopy.stdout)).toMatchObject({ counts: { deduplicated: 2, readbackVerified: 2 }, items: [
      { noteId: copiedLarge.noteId, ver: 1 }, { noteId: copiedSmall.noteId, ver: 1 }] });
    // A separate read-only connector can read both immutable citations after sync.
    for (const [item, expected] of [[before, original], [after, changed], [restored, original], [copiedSmall, original], [copiedLarge, large]] as const) {
      const response = await runtime.dispatchFetch(`http://fixture/v1/version/${item.noteId}@${item.ver}/bytes`, {
        headers: { authorization: `Bearer ${connector}` } });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
      const mcp = await runtime.dispatchFetch('http://fixture/mcp', { method: 'POST',
        headers: { authorization: `Bearer ${connector}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: item.ver, method: 'tools/call', params: { name: 'library_read', arguments: {
          ref: item.cite, maxChars: 200_000, ...(expected.length > 200_000 ? { lines: { from: 1, to: 5 } } : {}) } } }) });
      const answer = await mcp.json() as { result: { isError: boolean; structuredContent: { cite: string; sha256: string; text: string } } };
      expect(answer.result.isError).toBe(false);
      expect(answer.result.structuredContent).toMatchObject({ cite: item.cite, sha256: sha256Hex(expected) });
      const expectedText = new TextDecoder().decode(expected);
      expect(answer.result.structuredContent.text).toContain(expected.length > 200_000 ? sliceLines(expectedText, 1, 5) : expectedText);
    }
    for (const [path, bytes] of Object.entries(files)) expect(new Uint8Array(await readFile(join(fixture.root, path)))).toEqual(bytes);
    expect(new Uint8Array(await readFile(join(copyFixture.root, 'copied.md')))).toEqual(original);
    expect(new Uint8Array(await readFile(join(copyFixture.root, 'copied-large.md')))).toEqual(large);
    // Detailed receipts contain minted citations. Persist them only when explicitly requested,
    // using a caller-selected path so ordinary test runs leave no citation-bearing artifacts.
    if (process.env.HISTORY_REUSE_EVIDENCE) await writeFile(resolve(process.env.HISTORY_REUSE_EVIDENCE), JSON.stringify({
      historical: { traffic: revertTraffic, receipt: reverted, diff: revertDiff },
      sameCollectionCopy: { traffic: copyTraffic, receipt: copied, diff: copyDiff },
      recovery: { lostCommitResponses: 3, sameHistoricalSnapshot,
        copySnapshot: copied.snapshotId, failedCopySnapshot: failedCopy.snapshotId, noCheckpointBeforeReadback: true },
      independentReadback: { exactByteVersions: 5, mcpVersions: 5, largeMcpLineRange: [1, 5] }, sourcePreserved: true,
    }, null, 2) + '\n');
    // These are observed HTTP requests, not inferred from a deduplication or receipt flag.
    expect(revertTraffic, 'historical revert payload requests and bytes').toEqual([]);
    expect(copyTraffic, 'same-collection copy payload requests and bytes').toEqual([]);
    expect(revertDiff.missing).toEqual([]);
    expect(revertDiff.reusable).toEqual([{ n: 1, relPath: 'handoff.md', sha256: sha256Hex(original), size: original.length }]);
    expect(copyDiff.missing).toEqual([]); expect(copyDiff.reusable).toHaveLength(2);
    for (const item of copyDiff.reusable) expect(Object.keys(item).sort()).toEqual(['n', 'relPath', 'sha256', 'size']);
    expect(reverted).toMatchObject({ partial: false, removalAuthorized: false, counts: { pushed: 1, deduplicated: 2, reused: 1, reusedBytes: original.length },
      items: [expect.anything(), { reused: true, deduped: false }, expect.anything()] });
    expect(copied).toMatchObject({ partial: false, removalAuthorized: false, counts: { pushed: 2, deduplicated: 0, reused: 2, reusedBytes: original.length + large.length },
      items: [{ reused: true, deduped: false }, { reused: true, deduped: false }] });
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await runtime?.dispose();
    await fixture.cleanup();
    await copyFixture.cleanup();
  }
}, 240_000);
