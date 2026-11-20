// Projection written by the outbox step index.version: chunks + FTS rows for one exact version.
// One FTS index per privacy class, so BM25 statistics never depend on notes a caller cannot see.
// Idempotent: a version already indexed is left alone. Rebuildable from blobs.
import type { SqlDriver } from "./driver.ts";
import { sha256Hex } from "../primitives/sha256.ts";

export interface ParsedNote { title: string; headings: string[]; tags: string[]; lines: string[] }

export function parseNote(text: string, fallbackTitle: string): ParsedNote {
  const lines = text.split("\n");
  let title = fallbackTitle; const tags: string[] = []; const headings: string[] = [];
  let i = 0;
  if (lines[0] === "---") {
    for (i = 1; i < lines.length && lines[i] !== "---"; i++) {
      const m = /^(\w+):\s*(.*)$/.exec(lines[i]!);
      if (!m) continue;
      if (m[1] === "title") title = m[2]!.trim();
      if (m[1] === "tags") tags.push(...m[2]!.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  for (const l of lines) { const h = /^#{1,6}\s+(.*)$/.exec(l); if (h) { headings.push(h[1]!); if (title === fallbackTitle && headings.length === 1) title = h[1]!; } }
  return { title, headings, tags, lines };
}

export const CHUNK_MAX_CHARS = 1500; // well under the 2 MB row limit

export function chunkLines(lines: string[]): { from: number; to: number; text: string }[] {
  const out: { from: number; to: number; text: string }[] = [];
  let start = 0, size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size >= CHUNK_MAX_CHARS || i === lines.length - 1) { out.push({ from: start + 1, to: i + 1, text: lines.slice(start, i + 1).join("\n") }); start = i + 1; size = 0; }
  }
  if (out.length === 0) out.push({ from: 1, to: 1, text: "" });
  return out;
}

/** The FTS5 table that holds one privacy-class set. Injective: a readable prefix plus a hash suffix, so classes that differ only in punctuation or case never share a table (S1c A10). */
export function ftsTableFor(privacyClass: string): string { return `fts_${privacyClass.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24)}_${sha256Hex(privacyClass).slice(0, 16)}`; }

export function ensureFtsTable(db: SqlDriver, privacyClass: string): string {
  const t = ftsTableFor(privacyClass);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${t} USING fts5(title, headings, tags, body, path, chunk_rowid UNINDEXED, tokenize="porter unicode61 remove_diacritics 2")`);
  return t;
}

/** Scoped grants use physically distinct statistics/candidate windows, including
 * when an excluded collection has the very same privacy class. */
export function collectionFtsTableFor(collectionId: string, privacyClass: string): string {
  return `fts_collection_${sha256Hex(JSON.stringify([collectionId, privacyClass])).slice(0, 32)}`;
}

function ensureCollectionFtsTable(db: SqlDriver, collectionId: string, privacyClass: string): string {
  const table = collectionFtsTableFor(collectionId, privacyClass);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(title, headings, tags, body, path, chunk_rowid UNINDEXED, tokenize="porter unicode61 remove_diacritics 2")`);
  return table;
}

/** Additive projection migration, atomic per partition. Existing class indexes
 * remain available to legacy grants. No source objects or note versions change. */
export function migrateCollectionIndexes(db: SqlDriver): void {
  const existing = existingFtsTables(db);
  for (const row of db.all<{ collectionId: string; privacy_class: string }>("SELECT DISTINCT n.collectionId,c.privacy_class FROM chunks c JOIN notes n ON n.noteId=c.noteId")) {
    if (existing.has(collectionFtsTableFor(row.collectionId, row.privacy_class))) continue;
    db.transaction(() => {
      const table = ensureCollectionFtsTable(db, row.collectionId, row.privacy_class);
      db.run(`INSERT INTO ${table}(title, headings, tags, body, path, chunk_rowid) SELECT c.title,c.headings,c.tags,c.body,c.path,c.rowid FROM chunks c JOIN notes n ON n.noteId=c.noteId WHERE n.collectionId=? AND c.privacy_class=?`, [row.collectionId, row.privacy_class]);
    });
  }
}

export function existingFtsTables(db: SqlDriver): Set<string> {
  return new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fts\\_%' ESCAPE '\\'").map((r) => r.name));
}

/** Write the projection rows for one version. Promotion to custody=indexed is the caller's apply() op. */
export function indexVersion(db: SqlDriver, noteId: string, ver: number, privacyClass: string, text: string, path: string, fallbackTitle: string): { indexed: boolean; chunks: number } {
  const table = ensureFtsTable(db, privacyClass);
  return db.transaction(() => {
    const collectionId = db.get<{ collectionId: string }>("SELECT collectionId FROM notes WHERE noteId=?", [noteId])?.collectionId;
    if (!collectionId) throw new Error("index-note-not-found");
    const collectionTable = ensureCollectionFtsTable(db, collectionId, privacyClass);
    const existing = db.get<{ c: number }>("SELECT count(*) AS c FROM chunks WHERE noteId = ? AND ver = ?", [noteId, ver])!.c;
    if (existing > 0) return { indexed: false, chunks: existing };
    const p = parseNote(text, fallbackTitle);
    const chunks = chunkLines(p.lines);
    chunks.forEach((c, n) => {
      db.run("INSERT INTO chunks(noteId, ver, n, privacy_class, title, headings, tags, body, path, lineFrom, lineTo) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [noteId, ver, n, privacyClass, p.title, p.headings.join(" | "), p.tags.join(" "), c.text, path, c.from, c.to]);
      const rowid = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
      db.run(`INSERT INTO ${table}(title, headings, tags, body, path, chunk_rowid) VALUES (?,?,?,?,?,?)`, [p.title, p.headings.join(" | "), p.tags.join(" "), c.text, path, rowid]);
      // Keep the same projection write spelling for the SQL-mutation allow-list.
      const insertScoped = (table: string) => db.run(`INSERT INTO ${table}(title, headings, tags, body, path, chunk_rowid) VALUES (?,?,?,?,?,?)`, [p.title, p.headings.join(" | "), p.tags.join(" "), c.text, path, rowid]);
      insertScoped(collectionTable);
    });
    return { indexed: true, chunks: chunks.length };
  });
}
