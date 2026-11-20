// InventorySource: the read-only port the reference inventory (DESIGN §6.3) reads through. The Fs port has no directory
// listing and its only read is an exclusive open; an inventory must list, and must read shared (in-use files included)
// while reporting what it could not read. Paths are virtual, '/'-separated and root-relative. A Windows source is later work.
export type EntryKind = "file" | "directory" | "reparse";
export type SourceReadError = "not-found" | "in-use" | "unreadable" | "oversize" | "not-file";

export interface EntryIdentity { readonly volumeSerial: string; readonly fileId: string }
/** Times as ISO-8601 strings; null means unknown (unknown is not unchanged: an incremental read must not trust it). */
export interface EntryTimes { readonly modified: string | null; readonly changed: string | null; readonly created: string | null }

export interface DirEntry {
  readonly name: string;
  readonly kind: EntryKind;
  readonly identity: EntryIdentity | null;
  readonly size: number | null;
  readonly times: EntryTimes;
  /** A per-entry stat failure; the entry is still listed so the generation can name it. */
  readonly readError: SourceReadError | null;
}
export type ListResult = { readonly ok: true; readonly entries: readonly DirEntry[] } | { readonly ok: false; readonly code: SourceReadError };
export type SharedRead = { readonly ok: true; readonly bytes: Uint8Array; readonly size: number } | { readonly ok: false; readonly code: SourceReadError; readonly size: number | null };

export interface InventorySource {
  readonly implementation: "memory" | "windows-native";
  /** List one directory. The inventory finds files only this way, never through a path list a caller passes in. */
  list(dir: string): Promise<ListResult>;
  /** Read without an exclusive lock. In-use, unreadable and oversize (> maxBytes) files come back as read errors, with the size when known. */
  readShared(path: string, maxBytes: number): Promise<SharedRead>;
}

/** Join virtual path segments with '/', collapsing duplicates; never a host path. */
export function joinPath(...parts: string[]): string {
  const out = parts.filter((p) => p.length > 0).join("/").replace(/\/+/g, "/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}
/** Resolve '.' and '..' segments of a virtual path (never a host path). */
export function normalizePath(path: string): string {
  const abs = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") { out.pop(); continue; } out.push(seg); }
  return (abs ? "/" : "") + out.join("/");
}
export function basename(path: string): string { return path.split("/").filter(Boolean).pop() ?? ""; }
export function dirname(path: string): string { const i = path.lastIndexOf("/"); return i <= 0 ? (path.startsWith("/") ? "/" : "") : path.slice(0, i); }
export function extname(path: string): string { const b = basename(path); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i).toLowerCase(); }
export function stem(path: string): string { const b = basename(path); const i = b.lastIndexOf("."); return i <= 0 ? b : b.slice(0, i); }
