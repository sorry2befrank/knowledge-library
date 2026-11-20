// refs.sqlite (DESIGN §6.3): the local store for generations, files and references, in ref_* tables only. This is the
// one file that writes them (scripts/lint-mutating-sql.ts allows ref_* here and nowhere else). Never catalog tables.
import type { SqlDriver } from "../catalog/driver.ts";
import type { GenerationRecord, InventoryFile, InventoryReference, InventoryResult } from "./inventory.ts";

export const REF_SCHEMA_VERSION = 2;

export function migrateRefStore(db: SqlDriver): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS ref_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_generations(id TEXT PRIMARY KEY, mode TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL, lastFullReadAt TEXT, extractionConfigKey TEXT, filesRead INTEGER NOT NULL, bytesRead INTEGER NOT NULL, flags TEXT NOT NULL, complete INTEGER NOT NULL, incompleteRoots TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_roots(generationId TEXT NOT NULL, rootId TEXT NOT NULL, path TEXT NOT NULL, sets TEXT NOT NULL, complete INTEGER NOT NULL, readErrors INTEGER NOT NULL, PRIMARY KEY(generationId, rootId));
CREATE TABLE IF NOT EXISTS ref_declared_exclusions(generationId TEXT NOT NULL, rootId TEXT NOT NULL, path TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_read_errors(generationId TEXT NOT NULL, rootId TEXT NOT NULL, path TEXT NOT NULL, code TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_oversize(generationId TEXT NOT NULL, rootId TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ref_files(generationId TEXT NOT NULL, path TEXT NOT NULL, rootId TEXT NOT NULL, sets TEXT NOT NULL, volumeSerial TEXT, fileId TEXT, size INTEGER, modified TEXT, changed TEXT, created TEXT, historical INTEGER NOT NULL, read TEXT NOT NULL, PRIMARY KEY(generationId, path));
CREATE TABLE IF NOT EXISTS ref_references(generationId TEXT NOT NULL, refId TEXT NOT NULL, source TEXT NOT NULL, target TEXT, kind TEXT NOT NULL, candidates TEXT, detail TEXT, token TEXT NOT NULL, PRIMARY KEY(generationId, refId));
CREATE INDEX IF NOT EXISTS ref_references_target ON ref_references(generationId, target);
`);
  // Existing generations have no proven settings context: leave their new key NULL, which disables reuse.
  if (!db.all<{ name: string }>("PRAGMA table_info(ref_generations)").some((column) => column.name === "extractionConfigKey")) {
    db.exec("ALTER TABLE ref_generations ADD COLUMN extractionConfigKey TEXT");
  }
  db.run("INSERT OR REPLACE INTO ref_meta(key, value) VALUES ('schema_version', ?)", [String(REF_SCHEMA_VERSION)]);
}

export function saveGeneration(db: SqlDriver, result: InventoryResult): void {
  const g = result.generation;
  db.transaction(() => {
    db.run("INSERT INTO ref_generations(id, mode, startedAt, finishedAt, lastFullReadAt, extractionConfigKey, filesRead, bytesRead, flags, complete, incompleteRoots) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [g.id, g.mode, g.startedAt, g.finishedAt, g.lastFullReadAt, g.extractionConfigKey ?? null, g.filesRead, g.bytesRead, JSON.stringify(g.flags), g.complete ? 1 : 0, JSON.stringify(g.incompleteRoots)]);
    for (const r of g.roots) db.run("INSERT INTO ref_roots(generationId, rootId, path, sets, complete, readErrors) VALUES (?,?,?,?,?,?)", [g.id, r.id, r.path, JSON.stringify(r.sets), r.complete ? 1 : 0, r.readErrors]);
    for (const e of g.declaredExclusions) db.run("INSERT INTO ref_declared_exclusions(generationId, rootId, path, reason) VALUES (?,?,?,?)", [g.id, e.root, e.path, e.reason]);
    for (const e of g.readErrors) db.run("INSERT INTO ref_read_errors(generationId, rootId, path, code) VALUES (?,?,?,?)", [g.id, e.root, e.path, e.code]);
    for (const o of g.oversizeListed) db.run("INSERT INTO ref_oversize(generationId, rootId, path, size) VALUES (?,?,?,?)", [g.id, o.root, o.path, o.size]);
    for (const f of result.files) db.run("INSERT INTO ref_files(generationId, path, rootId, sets, volumeSerial, fileId, size, modified, changed, created, historical, read) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [g.id, f.path, f.root, JSON.stringify(f.sets), f.identity?.volumeSerial ?? null, f.identity?.fileId ?? null, f.size, f.times.modified, f.times.changed, f.times.created, f.historical ? 1 : 0, f.read]);
    for (const r of result.references) db.run("INSERT INTO ref_references(generationId, refId, source, target, kind, candidates, detail, token) VALUES (?,?,?,?,?,?,?,?)", [g.id, r.id, r.source, r.target, r.kind, r.candidates ? JSON.stringify(r.candidates) : null, r.detail ?? null, r.token]);
  });
}

export function loadGeneration(db: SqlDriver, id: string): InventoryResult | undefined {
  const g = db.get<{ id: string; mode: "full" | "incremental"; startedAt: string; finishedAt: string; lastFullReadAt: string | null; extractionConfigKey: string | null; filesRead: number; bytesRead: number; flags: string; complete: number; incompleteRoots: string }>("SELECT * FROM ref_generations WHERE id = ?", [id]);
  if (!g) return undefined;
  const generation: GenerationRecord = {
    id: g.id, mode: g.mode, startedAt: g.startedAt, finishedAt: g.finishedAt, lastFullReadAt: g.lastFullReadAt, filesRead: g.filesRead, bytesRead: g.bytesRead, flags: JSON.parse(g.flags), complete: g.complete === 1, incompleteRoots: JSON.parse(g.incompleteRoots),
    ...(g.extractionConfigKey ? { extractionConfigKey: g.extractionConfigKey } : {}),
    roots: db.all<{ rootId: string; path: string; sets: string; complete: number; readErrors: number }>("SELECT rootId, path, sets, complete, readErrors FROM ref_roots WHERE generationId = ? ORDER BY rowid", [id]).map((r) => ({ id: r.rootId, path: r.path, sets: JSON.parse(r.sets), complete: r.complete === 1, readErrors: r.readErrors })),
    declaredExclusions: db.all<{ rootId: string; path: string; reason: string }>("SELECT rootId, path, reason FROM ref_declared_exclusions WHERE generationId = ? ORDER BY rowid", [id]).map((e) => ({ root: e.rootId, path: e.path, reason: e.reason as GenerationRecord["declaredExclusions"][number]["reason"] })),
    readErrors: db.all<{ rootId: string; path: string; code: string }>("SELECT rootId, path, code FROM ref_read_errors WHERE generationId = ? ORDER BY rowid", [id]).map((e) => ({ root: e.rootId, path: e.path, code: e.code as GenerationRecord["readErrors"][number]["code"] })),
    oversizeListed: db.all<{ rootId: string; path: string; size: number }>("SELECT rootId, path, size FROM ref_oversize WHERE generationId = ? ORDER BY rowid", [id]).map((o) => ({ root: o.rootId, path: o.path, size: o.size })),
  };
  const files: InventoryFile[] = db.all<{ path: string; rootId: string; sets: string; volumeSerial: string | null; fileId: string | null; size: number | null; modified: string | null; changed: string | null; created: string | null; historical: number; read: InventoryFile["read"] }>("SELECT * FROM ref_files WHERE generationId = ? ORDER BY path", [id])
    .map((f) => ({ path: f.path, root: f.rootId, sets: JSON.parse(f.sets), identity: f.volumeSerial && f.fileId ? { volumeSerial: f.volumeSerial, fileId: f.fileId } : null, size: f.size, times: { modified: f.modified, changed: f.changed, created: f.created }, historical: f.historical === 1, read: f.read }));
  const references: InventoryReference[] = db.all<{ refId: string; source: string; target: string | null; kind: InventoryReference["kind"]; candidates: string | null; detail: InventoryReference["detail"] | null; token: string }>("SELECT * FROM ref_references WHERE generationId = ? ORDER BY refId", [id])
    .map((r) => ({ id: r.refId, source: r.source, target: r.target, kind: r.kind, ...(r.candidates ? { candidates: JSON.parse(r.candidates) as string[] } : {}), ...(r.detail ? { detail: r.detail } : {}), token: r.token }));
  const candidates = files.filter((f) => f.sets.includes("vault") && f.read !== "error").map((f) => ({ path: f.path, coverage: generation.complete ? "complete" as const : "coverage-incomplete" as const }));
  return { generation, files, references, candidates };
}

/** The latest COMPLETE generation whose last full read is at most maxAgeDays old (DESIGN §6.3: 7 days), or undefined. */
export function latestCompleteGeneration(db: SqlDriver, now: string, maxAgeDays = 7): InventoryResult | undefined {
  const rows = db.all<{ id: string; lastFullReadAt: string | null }>("SELECT id, lastFullReadAt FROM ref_generations WHERE complete = 1 ORDER BY finishedAt DESC");
  const cutoff = Date.parse(now) - maxAgeDays * 86_400_000;
  const hit = rows.find((r) => r.lastFullReadAt !== null && Date.parse(r.lastFullReadAt) >= cutoff);
  return hit ? loadGeneration(db, hit.id) : undefined;
}
