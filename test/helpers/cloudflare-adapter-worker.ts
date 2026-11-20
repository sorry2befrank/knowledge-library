// Synthetic Worker used only by the local runtime conformance tests. No enrollment endpoint.
import { R2ObjectStore, type ArchiveBucket } from '../../apps/api/src/cloudflare/r2-store.ts';
import { openDurableSql, type DurableSqlStorage } from '../../apps/api/src/cloudflare/sql-driver.ts';
import { migrate } from '../../packages/core/src/catalog/schema.ts';

interface Env {
  ARCHIVE: ArchiveBucket;
  LIBRARY: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}

export class AdapterHarness {
  private readonly db: ReturnType<typeof openDurableSql>;
  private readonly objects: R2ObjectStore;
  constructor(ctx: { storage: DurableSqlStorage }, env: Env) {
    this.db = openDurableSql(ctx.storage);
    migrate(this.db);
    this.db.exec('CREATE TABLE IF NOT EXISTS adapter_probe (id INTEGER PRIMARY KEY, bytes BLOB)');
    this.objects = new R2ObjectStore(env.ARCHIVE);
  }
  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === '/write') {
      const inserted = this.db.transaction(() => this.db.run('INSERT INTO adapter_probe VALUES (?, ?)',
        [1, new Uint8Array([99, 11, 12, 99]).subarray(1, 3)]));
      const first = await this.objects.put('blobs/probe', new Uint8Array([11, 12]), { onlyIfAbsent: true });
      const duplicate = await this.objects.put('blobs/probe', new Uint8Array([13]), { onlyIfAbsent: true });
      try {
        this.db.transaction(() => { this.db.run('DELETE FROM adapter_probe'); throw new Error('synthetic interruption'); });
      } catch (e) { if (!(e instanceof Error) || e.message !== 'synthetic interruption') throw e; }
      return Response.json({ inserted, first, duplicate });
    }
    if (route === '/read') {
      const row = this.db.get<{ bytes: Uint8Array }>('SELECT bytes FROM adapter_probe WHERE id=1');
      return Response.json({ row: [...(row?.bytes ?? [])], object: [...(await this.objects.get('blobs/probe') ?? [])],
        keys: await this.objects.list('blobs/'), inTransaction: this.db.inTransaction() });
    }
    if (route === '/cas') {
      const miss = this.db.run('UPDATE adapter_probe SET bytes=? WHERE id=?', [new Uint8Array([14]), 2]);
      const hit = this.db.run('UPDATE adapter_probe SET bytes=? WHERE id=?', [new Uint8Array([14]), 1]);
      return Response.json({ miss, hit });
    }
    return new Response('not-found', { status: 404 });
  }
}

export default {
  fetch(request: Request, env: Env) { return env.LIBRARY.get(env.LIBRARY.idFromName('adapter-fixture')).fetch(request); },
};
