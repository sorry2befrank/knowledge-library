// Blob store port and the single BlobWriter. blobs/ is written only by BlobWriter.put(AdmittedBytes),
// after the admission guard and a digest check. Presigned URLs never target it.
import { AdmittedBytes } from "../admission/guard.ts";
import { sha256Hex } from "../primitives/sha256.ts";

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, opts?: { onlyIfAbsent?: boolean }): Promise<{ written: boolean }>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;
  /** Fault injection: throw on the nth write (1-based) or when the predicate matches. */
  failWhen: ((key: string) => boolean) | null = null;
  /** Fault injection for reads: simulates a crash or outage between a commit and the post-commit HEAD check. */
  failWhenGet: ((key: string) => boolean) | null = null;
  async put(key: string, bytes: Uint8Array, opts?: { onlyIfAbsent?: boolean }) {
    if (this.failWhen?.(key)) throw new Error(`injected storage failure: ${key}`);
    if (opts?.onlyIfAbsent && this.objects.has(key)) return { written: false };
    this.objects.set(key, new Uint8Array(bytes)); this.writes++;
    return { written: true };
  }
  async get(key: string) { if (this.failWhenGet?.(key)) throw new Error(`injected storage failure: ${key}`); const v = this.objects.get(key); return v ? new Uint8Array(v) : undefined; }
  async delete(key: string) { if (this.failWhen?.(key)) throw new Error(`injected storage failure: ${key}`); this.objects.delete(key); }
  async list(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

export function blobKey(sha256: string): string {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export class BlobWriter {
  private readonly store: ObjectStore;
  constructor(store: ObjectStore) { this.store = store; }
  /** Put-if-absent with a digest check. Idempotent. Only AdmittedBytes are accepted. */
  async put(admitted: AdmittedBytes): Promise<{ sha256: string; written: boolean }> {
    if (!(admitted instanceof AdmittedBytes)) throw new Error("BlobWriter.put requires AdmittedBytes from the admission guard");
    const sha = sha256Hex(admitted.bytes);
    if (sha !== admitted.sha256) throw new Error("digest mismatch");
    const r = await this.store.put(blobKey(sha), admitted.bytes, { onlyIfAbsent: true });
    return { sha256: sha, written: r.written };
  }
  async get(sha256: string): Promise<Uint8Array | undefined> { return this.store.get(blobKey(sha256)); }
  async has(sha256: string): Promise<boolean> { return (await this.store.get(blobKey(sha256))) !== undefined; }
}
