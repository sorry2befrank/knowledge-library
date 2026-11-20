import { expect, it } from 'vitest';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

it('preserves R2 bytes and the migrated SQLite catalog across a local workerd restart', async () => {
  // Keep fixture state on the checkout volume, never under the default system temp directory.
  const parent = resolve('.review', 'cloudflare-runtime');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  if (!resolve(root).startsWith(parent + sep)) throw new Error('fixture escaped its root');
  let runtime: Miniflare | undefined;
  try {
    const bundle = await build({ entryPoints: ['test/helpers/cloudflare-adapter-worker.ts'],
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' });
    const options: MiniflareOptions = {
      modules: true, script: bundle.outputFiles![0]!.text, compatibilityDate: '2026-07-30',
      durableObjects: { LIBRARY: { className: 'AdapterHarness', useSQLite: true } },
      r2Buckets: ['ARCHIVE'], durableObjectsPersist: join(root, 'do'), r2Persist: join(root, 'r2'),
    };
    runtime = new Miniflare(options);
    const written = await runtime.dispatchFetch('http://fixture/write');
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ inserted: { changes: 1 }, first: { written: true }, duplicate: { written: false } });
    await runtime.dispose();
    runtime = new Miniflare(options);
    const restored = await runtime.dispatchFetch('http://fixture/read');
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ row: [11, 12], object: [11, 12], keys: ['blobs/probe'], inTransaction: false });
    const cas = await runtime.dispatchFetch('http://fixture/cas');
    expect(cas.status).toBe(200);
    expect(await cas.json()).toEqual({ miss: { changes: 0 }, hit: { changes: 1 } });
  } finally {
    await runtime?.dispose();
    // root was created by this test and verified to stay inside its explicit fixture parent.
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
