// In-memory InventorySource for tests: seeded trees with per-file identity, times, read errors and in-use holders.
import { basename, dirname, joinPath, type DirEntry, type EntryIdentity, type EntryTimes, type InventorySource, type ListResult, type SourceReadError, type SharedRead } from "./source.ts";

interface Node { kind: "file" | "directory" | "reparse"; bytes: Uint8Array; identity: EntryIdentity; times: EntryTimes; readError: SourceReadError | null; sizeOverride: number | null }
export interface SeedOptions { identity?: EntryIdentity; times?: Partial<EntryTimes>; /** make the file report this read error (in-use, unreadable...) */ readError?: SourceReadError; /** report this size instead of the byte length (an oversize listing without allocating the bytes) */ size?: number }

const T0 = "2026-10-06T00:00:00.000Z";

export class MemoryInventorySource implements InventorySource {
  readonly implementation = "memory" as const;
  private readonly nodes = new Map<string, Node>();
  private readonly unlistable = new Set<string>();
  private nextId = 1;
  reads = 0;

  private mint(): EntryIdentity { return { volumeSerial: "SYNTH-VOL", fileId: String(this.nextId++).padStart(8, "0") }; }
  private ensureDir(path: string): void {
    if (path === "" || path === "/") return;
    if (!this.nodes.has(path)) { this.ensureDir(dirname(path)); this.nodes.set(path, { kind: "directory", bytes: new Uint8Array(), identity: this.mint(), times: { modified: T0, changed: T0, created: T0 }, readError: null, sizeOverride: null }); }
  }
  /** Seed a text (or binary) file; parents are created. */
  seedFile(path: string, content: string | Uint8Array, opts: SeedOptions = {}): this {
    this.ensureDir(dirname(path));
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.nodes.set(path, { kind: "file", bytes, identity: opts.identity ?? this.mint(), times: { modified: T0, changed: T0, created: T0, ...opts.times }, readError: opts.readError ?? null, sizeOverride: opts.size ?? null });
    return this;
  }
  seedDir(path: string): this { this.ensureDir(path); return this; }
  /** A reparse point (junction or symlink) at this path: listed with kind "reparse", never descended. */
  seedReparse(path: string): this { this.ensureDir(dirname(path)); this.nodes.set(path, { kind: "reparse", bytes: new Uint8Array(), identity: this.mint(), times: { modified: T0, changed: T0, created: T0 }, readError: null, sizeOverride: null }); return this; }
  /** Make a file in use (shared read refused) or unreadable; null clears it. */
  setReadError(path: string, code: SourceReadError | null): this { const n = this.nodes.get(path); if (!n) throw new Error(`no such seeded path: ${path}`); n.readError = code; return this; }
  /** Make a whole directory unlistable. */
  setUnlistable(dir: string, on = true): this { if (on) this.unlistable.add(dir); else this.unlistable.delete(dir); return this; }
  remove(path: string): this { for (const k of [...this.nodes.keys()]) if (k === path || k.startsWith(path + "/")) this.nodes.delete(k); return this; }
  has(path: string): boolean { return this.nodes.has(path); }
  paths(): string[] { return [...this.nodes.keys()].sort(); }

  async list(dir: string): Promise<ListResult> {
    const d = dir === "/" ? "" : dir.replace(/\/$/, "");
    if (this.unlistable.has(dir) || this.unlistable.has(d)) return { ok: false, code: "unreadable" };
    if (d !== "" && this.nodes.get(d)?.kind !== "directory") return { ok: false, code: this.nodes.has(d) ? "not-file" : "not-found" };
    const entries: DirEntry[] = [];
    for (const [p, n] of this.nodes) {
      if (dirname(p) !== (d === "" ? "" : d) || p === d) continue;
      if (d === "" && p.includes("/")) continue;
      entries.push({ name: basename(p), kind: n.kind, identity: n.identity, size: n.kind === "file" ? (n.sizeOverride ?? n.bytes.length) : null, times: n.times, readError: n.kind === "file" && n.readError === "unreadable" ? "unreadable" : null });
    }
    return { ok: true, entries: entries.sort((a, b) => (a.name < b.name ? -1 : 1)) };
  }
  async readShared(path: string, maxBytes: number): Promise<SharedRead> {
    this.reads++;
    const n = this.nodes.get(path);
    if (!n) return { ok: false, code: "not-found", size: null };
    if (n.kind !== "file") return { ok: false, code: "not-file", size: null };
    const size = n.sizeOverride ?? n.bytes.length;
    if (n.readError) return { ok: false, code: n.readError, size };
    if (size > maxBytes) return { ok: false, code: "oversize", size };
    return { ok: true, bytes: new Uint8Array(n.bytes), size };
  }
}

export { joinPath };
