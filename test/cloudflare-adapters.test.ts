import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { R2ObjectStore, type ArchiveBucket } from '../apps/api/src/cloudflare/r2-store.ts';
import { openDurableSql, type DurableSqlStorage } from '../apps/api/src/cloudflare/sql-driver.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';

function bucketFixture() {
  const data = new Map<string, ArrayBuffer>();
  const writes: { key: string; options: Parameters<ArchiveBucket['put']>[2] }[] = [];
  let gets = 0;
  const bucket: ArchiveBucket = {
    async put(key, bytes, options) {
      writes.push({ key, options });
      expect(options.sha256).toBe(sha256Hex(new Uint8Array(bytes)));
      if (options.onlyIf?.etagDoesNotMatch === '*' && data.has(key)) return null;
      data.set(key, bytes.slice(0)); return { key };
    },
    async get(key) { gets++; const bytes = data.get(key); return bytes ? { async arrayBuffer() { return bytes.slice(0); } } : null; },
    async delete(key) { data.delete(key); },
    async list({ prefix }) { return { objects: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
  };
  return { bucket, data, writes, getCount: () => gets };
}

describe('R2 object adapter (binding-contract tests, not provider evidence)', () => {
  it('uses atomic put-if-absent; duplicate bytes never overwrite custody', async () => {
    const f = bucketFixture(); const store = new R2ObjectStore(f.bucket);
    expect(await store.put('blobs/a', new Uint8Array([1]), { onlyIfAbsent: true })).toEqual({ written: true });
    expect(await store.put('blobs/a', new Uint8Array([2]), { onlyIfAbsent: true })).toEqual({ written: false });
    expect(await store.get('blobs/a')).toEqual(new Uint8Array([1]));
    expect(f.writes[0]?.options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
  });
  it('uploads exactly the view and snapshots caller bytes before awaiting', async () => {
    const f = bucketFixture(); const store = new R2ObjectStore(f.bucket);
    const backing = new Uint8Array([99, 1, 2, 99]);
    const promise = store.put('blobs/a', backing.subarray(1, 3)); backing.fill(42);
    await promise;
    expect(await store.get('blobs/a')).toEqual(new Uint8Array([1, 2]));
  });
  it('reads fresh bytes each time and distinguishes empty from absent', async () => {
    const f = bucketFixture(); const store = new R2ObjectStore(f.bucket);
    await store.put('blobs/a', new Uint8Array());
    expect(await store.get('blobs/a')).toEqual(new Uint8Array());
    f.data.set('blobs/a', new Uint8Array([7]).buffer);
    expect(await store.get('blobs/a')).toEqual(new Uint8Array([7]));
    expect(await store.get('absent')).toBeUndefined();
    expect(f.getCount()).toBe(3);
  });
  it('never reports success after write/read/delete failures', async () => {
    const f = bucketFixture(); const store = new R2ObjectStore(f.bucket);
    f.bucket.put = async () => null;
    await expect(store.put('blobs/a', new Uint8Array())).rejects.toThrow('did not complete');
    f.bucket.get = async () => { throw new Error('storage offline'); };
    await expect(store.get('blobs/a')).rejects.toThrow('storage offline');
    f.bucket.delete = async () => { throw new Error('locked'); };
    await expect(store.delete('anchors/a')).rejects.toThrow('locked');
  });
  it('paginates the complete listing and carries the requested prefix forward', async () => {
    const f = bucketFixture(); const requests: Parameters<ArchiveBucket['list']>[0][] = [];
    f.bucket.list = async options => {
      requests.push(options);
      return options.cursor ? { objects: [{ key: 'm/b' }], truncated: false }
        : { objects: [{ key: 'm/c' }, { key: 'm/a' }], truncated: true, cursor: 'next-page' };
    };
    expect(await new R2ObjectStore(f.bucket).list('m/')).toEqual(['m/a', 'm/b', 'm/c']);
    expect(requests).toEqual([{ prefix: 'm/', limit: 1000 }, { prefix: 'm/', limit: 1000, cursor: 'next-page' }]);
  });
  it('refuses missing/repeated cursors, unexpected prefixes and exhausted bounds', async () => {
    const f = bucketFixture();
    f.bucket.list = async () => ({ objects: [], truncated: true });
    await expect(new R2ObjectStore(f.bucket).list('m/')).rejects.toThrow('did not advance');
    f.bucket.list = async () => ({ objects: [], truncated: true, cursor: 'same' });
    await expect(new R2ObjectStore(f.bucket).list('m/')).rejects.toThrow('did not advance');
    await expect(new R2ObjectStore(f.bucket, 1).list('m/')).rejects.toThrow('page bound');
    f.bucket.list = async () => ({ objects: [{ key: 'other/a' }], truncated: false });
    await expect(new R2ObjectStore(f.bucket).list('m/')).rejects.toThrow('unexpected prefix');
  });
});

function sqlFixture() {
  const db = new DatabaseSync(':memory:');
  let transactions = 0;
  const queries: string[] = [];
  const storage: DurableSqlStorage = {
    sql: { exec(sql, ...bindings) {
      queries.push(sql);
      if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(sql)) throw new Error('DO rejects transaction SQL');
      const values = bindings.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
      const stmt = db.prepare(sql);
      const result = stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []);
      return { toArray: () => result.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
        [k, v instanceof Uint8Array ? new Uint8Array(v).buffer : v]))) };
    } },
    transactionSync<T>(callback: () => T): T {
      transactions++; db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage, queries, transactions: () => transactions };
}

describe('Durable Object SQL adapter (SQLite contract harness, not workerd)', () => {
  it('commits once, rolls back every write on failure and resets transaction state', () => {
    const f = sqlFixture(); const driver = openDurableSql(f.storage);
    try {
      driver.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)');
      driver.transaction(() => {
        expect(driver.inTransaction()).toBe(true);
        driver.run('INSERT INTO sample VALUES (?, ?)', [1, 'kept']);
        driver.transaction(() => driver.run('INSERT INTO sample VALUES (?, ?)', [2, 'nested']));
      });
      expect(f.transactions()).toBe(1);
      expect(() => driver.transaction(() => {
        driver.run('DELETE FROM sample'); throw new Error('interrupted');
      })).toThrow('interrupted');
      expect(driver.all('SELECT * FROM sample ORDER BY id')).toEqual([{ id: 1, value: 'kept' }, { id: 2, value: 'nested' }]);
      expect(driver.inTransaction()).toBe(false);
      expect(f.queries.some(q => /^(BEGIN|COMMIT|ROLLBACK)/.test(q))).toBe(false);
    } finally { f.db.close(); }
  });
  it('uses changed-row semantics for compare-and-swap, including trigger writes', () => {
    const f = sqlFixture(); const driver = openDurableSql(f.storage);
    try {
      driver.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)');
      driver.exec('CREATE TABLE audit(value TEXT)');
      // Trigger is installed directly in the harness, which refuses BEGIN sent by the adapter.
      f.db.exec('CREATE TRIGGER sample_audit AFTER UPDATE ON sample BEGIN INSERT INTO audit VALUES (NEW.value); END');
      expect(driver.run('INSERT INTO sample VALUES (1, ?)', ['old']).changes).toBe(1);
      expect(driver.run('UPDATE sample SET value = ? WHERE value = ?', ['new', 'old']).changes).toBe(1);
      expect(driver.run('UPDATE sample SET value = ? WHERE value = ?', ['bad', 'old']).changes).toBe(0);
      expect(driver.get('SELECT * FROM audit')).toEqual({ value: 'new' });
    } finally { f.db.close(); }
  });
  it('round-trips a byte view and refuses lossy integer bindings before SQL execution', () => {
    const f = sqlFixture(); const driver = openDurableSql(f.storage);
    try {
      driver.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value BLOB)');
      driver.run('INSERT INTO sample VALUES (?, ?)', [3n, new Uint8Array([99, 4, 99]).subarray(1, 2)]);
      expect(driver.get('SELECT * FROM sample')).toEqual({ id: 3, value: new Uint8Array([4]) });
      const before = f.queries.length;
      expect(() => driver.run('DELETE FROM sample WHERE id = ?', [9007199254740993n])).toThrow('exact numeric range');
      expect(f.queries.length).toBe(before);
      expect(driver.get('SELECT * FROM sample WHERE id = 9')).toBeUndefined();
    } finally { f.db.close(); }
  });
  it('rejects async transaction results, rolls back and closes the adapter', () => {
    const f = sqlFixture(); const driver = openDurableSql(f.storage);
    try {
      driver.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)');
      expect(() => driver.transaction(() => {
        driver.run('INSERT INTO sample VALUES (1)'); return Promise.resolve();
      })).toThrow('must be synchronous');
      expect(f.db.prepare('SELECT count(*) AS count FROM sample').get()?.count).toBe(0);
      expect(() => driver.run('INSERT INTO sample VALUES (2)')).toThrow('closed');
    } finally { f.db.close(); }
  });
});
