import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';

const HEALTH = { phase: 'bootstrap', ready: false, archiveAvailable: false };
const REFUSAL = { error: 'archive-unavailable', ...HEALTH };
const privateMarker = 'synthetic-bootstrap-binding-must-not-escape';
const blockedRoutes = [
  '/', '/healthz', '/health?token=synthetic-query', '/health/', '/Health',
  '/setup', '/admin/setup', '/v1/setup', '/v1/enroll', '/v1/tokens', '/v1/manifest/diff',
  '/v1/batch', '/v1/commit', '/v1/version/synthetic@1/bytes', '/v1/multipart/start',
  '/v1/multipart/part', '/v1/multipart/complete', '/mcp', '/sse', '/oauth/authorize',
  '/oauth/token', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
  '/__test/setup', '/__fixture', '/outbox/drain', '/status',
];
let runtime: Miniflare;
let root: string;
let options: MiniflareOptions;

beforeAll(async () => {
  const parent = resolve('.review', 'cloud-bootstrap');
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, 'run-'));
  if (!resolve(root).startsWith(parent + sep)) throw new Error('Fixture escaped its root');
  const bundle = await build({ entryPoints: ['apps/api/src/cloudflare/worker.ts'], bundle: true,
    write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'] });
  const script = bundle.outputFiles![0]!.text;
  // This closed bootstrap must not bundle catalog/enrollment code or request logging.
  expect(script).not.toMatch(/test\/helpers|SYNTHETIC_FIXTURE|enableSetup|createApiHandler|node:|eval\(|new Function\(|console\./);
  options = { name: 'cloud-bootstrap-test', modules: true, script, compatibilityDate: '2026-07-30',
    unsafeInspectDurableObjects: true,
    durableObjects: { LIBRARY: { className: 'LibraryDO', useSQLite: true } },
    r2Buckets: ['ARCHIVE'], durableObjectsPersist: join(root, 'do'), r2Persist: join(root, 'r2'),
    bindings: { SYNTHETIC_FIXTURE: 'archive-workflow-tests-only', DEVICE_TOKEN: privateMarker,
      CONNECTOR_TOKEN: privateMarker, SETUP_ENABLED: 'true', BOOTSTRAP_SECRET: privateMarker,
      CLOUD_ENVIRONMENT: privateMarker } };
  runtime = new Miniflare(options);
  await runtime.ready;
});

afterAll(async () => {
  await runtime?.dispose();
  if (root) {
    const parent = resolve('.review', 'cloud-bootstrap');
    if (!resolve(root).startsWith(parent + sep)) throw new Error('Fixture cleanup escaped its root');
    await rm(root, { recursive: true, force: true });
  }
});

function privacyHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('www-authenticate')).toBeNull();
}

describe('owner-provisioning Worker in workerd', () => {
  it('reports bootstrap health without claiming archive readiness', async () => {
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/health');
    expect(response.status).toBe(200);
    privacyHeaders(response as unknown as Response);
    expect(await response.json()).toEqual(HEALTH);
    const head = await runtime.dispatchFetch('https://bootstrap.invalid/health', { method: 'HEAD' });
    expect(head.status).toBe(200);
    privacyHeaders(head as unknown as Response);
    expect(await head.text()).toBe('');
  });

  it.each(blockedRoutes)('refuses unsupported route %s regardless of authorization', async route => {
    const response = await runtime.dispatchFetch('https://bootstrap.invalid' + route, {
      headers: { authorization: `Bearer ${privateMarker}`, origin: 'https://untrusted.invalid' },
    });
    expect(response.status).toBe(503);
    privacyHeaders(response as unknown as Response);
    expect(await response.json()).toEqual(REFUSAL);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s even at the health URL', async method => {
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/health', { method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${privateMarker}` },
      body: '{malformed synthetic enrollment body' });
    expect(response.status).toBe(503);
    privacyHeaders(response as unknown as Response);
    expect(await response.json()).toEqual(REFUSAL);
  });

  it('returns the same refusal status with an empty body for protected HEAD requests', async () => {
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/mcp', { method: 'HEAD' });
    expect(response.status).toBe(503);
    privacyHeaders(response as unknown as Response);
    expect(await response.text()).toBe('');
  });

  it('bounds route parsing and refuses oversized URLs without echoing them', async () => {
    for (const url of [
      'https://bootstrap.invalid/' + 'a'.repeat(4400),
      // A health path on a long host would return 200 if the length guard vanished.
      'https://' + 'a'.repeat(4200) + '.invalid/health',
    ]) {
      expect(url.length).toBeGreaterThan(4096);
      const response = await runtime.dispatchFetch(url);
      expect(response.status).toBe(503);
      privacyHeaders(response as unknown as Response);
      expect(await response.json()).toEqual(REFUSAL);
    }
  });

  it('does not read request bodies, including a body that never completes', async () => {
    const body = new NodeReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{unfinished synthetic body'));
    } });
    // A body-reading implementation hangs instead of returning the fixed refusal.
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/v1/batch', {
      method: 'POST', body, duplex: 'half', headers: { authorization: `Bearer ${privateMarker}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(REFUSAL);
  }, 10_000);

  it('does not initialize catalog or write R2 through public requests, even with setup-like bindings', async () => {
    expect(await runtime.listDurableObjectIds('LIBRARY')).toEqual([]);
    const bucket = await runtime.getR2Bucket('ARCHIVE');
    expect((await bucket.list()).objects).toEqual([]);
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/setup', {
      method: 'POST', body: JSON.stringify({ setup: true, bootstrapSecret: privateMarker }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(REFUSAL);
    expect(await runtime.listDurableObjectIds('LIBRARY')).toEqual([]);
    expect((await bucket.list()).objects).toEqual([]);
  });

  it('direct DO bindings cannot open the archive or persist a catalog, including after restart', async () => {
    const namespace = await runtime.getDurableObjectNamespace('LIBRARY');
    const stub = namespace.get(namespace.idFromName('library-v1'));
    for (const path of ['/health', '/setup', '/mcp', '/v1/batch']) {
      const response = await stub.fetch('https://bootstrap.invalid' + path, { method: 'POST', body: '{}' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(REFUSAL);
    }
    // Out-of-band test inspection is deliberately not an application route.
    const storage = await runtime.unsafeGetDurableObjectStorage('cloud-bootstrap-test', 'LibraryDO', { name: 'library-v1' });
    expect(await storage.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name <> '__miniflare_do_name'")).toEqual([]);
    await runtime.dispose();
    runtime = new Miniflare(options);
    await runtime.ready;
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/setup', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(REFUSAL);
    const after = await runtime.unsafeGetDurableObjectStorage('cloud-bootstrap-test', 'LibraryDO', { name: 'library-v1' });
    expect(await after.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name <> '__miniflare_do_name'")).toEqual([]);
    expect((await (await runtime.getR2Bucket('ARCHIVE')).list()).objects).toEqual([]);
  });

  it('also leaves preexisting synthetic storage untouched when used as a rollback artifact', async () => {
    const storage = await runtime.unsafeGetDurableObjectStorage('cloud-bootstrap-test', 'LibraryDO', { name: 'library-v1' });
    await storage.exec('CREATE TABLE rollback_canary (value TEXT NOT NULL)');
    await storage.exec('INSERT INTO rollback_canary (value) VALUES (?)', 'synthetic existing state');
    const bucket = await runtime.getR2Bucket('ARCHIVE');
    await bucket.put('synthetic-rollback-canary', 'synthetic existing bytes');
    const namespace = await runtime.getDurableObjectNamespace('LIBRARY');
    const stub = namespace.get(namespace.idFromName('library-v1'));
    const direct = await stub.fetch('https://bootstrap.invalid/setup', { method: 'POST', body: '{}' });
    expect(direct.status).toBe(503);
    const response = await runtime.dispatchFetch('https://bootstrap.invalid/v1/commit', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
    expect(await storage.exec('SELECT value FROM rollback_canary')).toEqual([{ value: 'synthetic existing state' }]);
    expect(await (await bucket.get('synthetic-rollback-canary'))?.text()).toBe('synthetic existing bytes');
    expect((await bucket.list()).objects).toHaveLength(1);
  });
});
