import type { ObjectStore } from '../../../../packages/core/src/catalog/blobs.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';

/** Structural subset of the R2 binding. Authentication belongs to the API, not this adapter. */
export interface ArchiveBucket {
  put(key: string, value: ArrayBuffer, options: {
    sha256: string; onlyIf?: { etagDoesNotMatch: string };
  }): Promise<unknown | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: { key: string }[]; truncated: boolean; cursor?: string;
  }>;
}

/** Reads always reach R2. No HEAD/cache result substitutes for byte-exact read-back. */
export class R2ObjectStore implements ObjectStore {
  private readonly bucket: ArchiveBucket;
  private readonly maxListPages: number;
  constructor(bucket: ArchiveBucket, maxListPages = 1000) {
    if (!Number.isSafeInteger(maxListPages) || maxListPages < 1) throw new Error('invalid listing bound');
    this.bucket = bucket;
    this.maxListPages = maxListPages;
  }
  async put(key: string, bytes: Uint8Array, opts?: { onlyIfAbsent?: boolean }): Promise<{ written: boolean }> {
    // Copy exactly the supplied view, so unrelated bytes in a larger backing buffer cannot leak.
    const body = new Uint8Array(bytes).buffer;
    const result = await this.bucket.put(key, body, {
      sha256: sha256Hex(new Uint8Array(body)),
      ...(opts?.onlyIfAbsent ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
    });
    if (result === null) {
      if (opts?.onlyIfAbsent) return { written: false };
      throw new Error('unconditional R2 write did not complete');
    }
    return { written: true };
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(key);
    return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
  }
  async delete(key: string): Promise<void> { await this.bucket.delete(key); }
  async list(prefix: string): Promise<string[]> {
    const keys = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxListPages; page++) {
      const result = await this.bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of result.objects) {
        if (!object.key.startsWith(prefix)) throw new Error('R2 listing returned an unexpected prefix');
        keys.add(object.key);
      }
      if (!result.truncated) return [...keys].sort();
      if (!result.cursor || seen.has(result.cursor)) throw new Error('R2 listing did not advance');
      cursor = result.cursor;
      seen.add(cursor);
    }
    // A truncated inventory must never look like a complete orphan reconciliation.
    throw new Error('R2 listing exceeded its page bound');
  }
}
