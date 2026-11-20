// Device-local upload journal. No source bytes or bearer secrets are stored here.
// FULL synchronous WAL commits bracket every network effect; a failed/unknown effect is replayed
// using the same snapshot identity. These records are not authority to remove a source file.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';

export interface JournalRun { id: string; snapshotId: string; pushId: string | null; manifestDigest: string; binding: string }
export interface VersionCheckpoint { relPath: string; noteId: string; ver: number; sha256: string }

export class PushJournal {
  private readonly db: DatabaseSync;
  private readonly locks = new Set<DatabaseSync>();
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS archive_runs(
        id TEXT PRIMARY KEY, snapshotId TEXT NOT NULL UNIQUE, pushId TEXT,
        binding TEXT NOT NULL, manifestDigest TEXT NOT NULL, manifest TEXT NOT NULL,
        state TEXT NOT NULL, createdAt TEXT NOT NULL, completedAt TEXT, receipt TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS archive_run_pending ON archive_runs(binding,manifestDigest) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS archive_steps(
        id INTEGER PRIMARY KEY, runId TEXT NOT NULL, phase TEXT NOT NULL, item INTEGER,
        state TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS archive_versions(
        binding TEXT NOT NULL, relPath TEXT NOT NULL, noteId TEXT NOT NULL,
        ver INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(binding,relPath));`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** An OS-backed lock across local journal connections. Process exit releases it; no stale PID takeover. */
  lockFolder(key: string): () => void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('invalid-folder-lock-key');
    const file = `${this.path}.${key}.lock`;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { const stat = lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('unsafe-journal-lock-file'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const lock = new DatabaseSync(file);
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) { lock.close(); if ((error as { errcode?: number }).errcode === 5) throw Error('archive-folder-busy'); throw error; }
    this.locks.add(lock);
    return () => { if (this.locks.delete(lock)) { try { lock.exec('ROLLBACK'); } finally { lock.close(); } } };
  }
  versions(binding: string, legacyBinding?: string): Map<string, VersionCheckpoint> {
    // Adopt an old grant+policy checkpoint only when the caller reconstructs that exact binding.
    // Unknown old grants are preserved, never guessed into a new source/endpoint identity.
    if (legacyBinding && legacyBinding !== binding) this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO archive_versions(binding,relPath,noteId,ver,sha256) SELECT ?,relPath,noteId,ver,sha256 FROM archive_versions WHERE binding=?').run(binding, legacyBinding);
      this.db.prepare('DELETE FROM archive_versions WHERE binding=?').run(legacyBinding);
    });
    const rows = this.db.prepare('SELECT relPath,noteId,ver,sha256 FROM archive_versions WHERE binding=?').all(binding) as unknown as VersionCheckpoint[];
    return new Map(rows.map(row => [row.relPath, row]));
  }
  begin(binding: string, manifestDigest: string, manifest: string, now: string): JournalRun {
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT id,snapshotId,pushId,binding,manifestDigest FROM archive_runs WHERE binding=? AND manifestDigest=? AND state='pending'").get(binding, manifestDigest) as unknown as JournalRun | undefined;
      if (prior) return prior;
      const id = randomUUID(); const snapshotId = randomUUID();
      this.db.prepare("INSERT INTO archive_runs(id,snapshotId,binding,manifestDigest,manifest,state,createdAt) VALUES(?,?,?,?,?,'pending',?)").run(id, snapshotId, binding, manifestDigest, manifest, now);
      return { id, snapshotId, pushId: null, binding, manifestDigest };
    });
  }
  bindPush(run: JournalRun, pushId: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT pushId FROM archive_runs WHERE id=?').get(run.id);
      if (!row || (row.pushId !== null && row.pushId !== pushId)) throw new Error('journal-push-identity-conflict');
      this.db.prepare('UPDATE archive_runs SET pushId=? WHERE id=?').run(pushId, run.id);
    });
    run.pushId = pushId;
  }
  /** Record the complete validated transfer plan atomically before any payload I/O.
   * An interrupted attempt can overstate possible transfer, never byte savings. */
  planUploads(run: JournalRun, items: number[], now: string): void {
    if(items.some(item=>!Number.isSafeInteger(item)||item<0)) throw Error('invalid-upload-plan');
    this.transaction(()=>{
      const insert=this.db.prepare("INSERT INTO archive_steps(runId,phase,item,state,startedAt) SELECT ?,'upload-plan',?,'intent',? WHERE NOT EXISTS (SELECT 1 FROM archive_steps WHERE runId=? AND phase='upload-plan' AND item=?)");
      for(const item of items)insert.run(run.id,item,now,run.id,item);
    });
  }
  /** Recover transfer accounting from this snapshot, including older journals.
   * Legacy raw requests identify their item; legacy batches do not. If a batch
   * predates the first per-item plan, every batch-sized entry may have been sent. */
  possibleUploads(run: JournalRun, smallItems: number[]): Set<number> {
    const rows=this.db.prepare("SELECT item FROM archive_steps WHERE runId=? AND phase IN ('upload-plan','upload') AND item IS NOT NULL").all(run.id) as unknown as {item:number}[];
    const items=new Set(rows.map(row=>row.item));
    const legacyBatch=this.db.prepare("SELECT 1 FROM archive_steps b WHERE b.runId=? AND b.phase='batch' AND NOT EXISTS (SELECT 1 FROM archive_steps p WHERE p.runId=b.runId AND p.phase='upload-plan' AND p.id<b.id) LIMIT 1").get(run.id);
    if(legacyBatch)for(const item of smallItems)items.add(item);
    return items;
  }
  intent(run: JournalRun, phase: string, item: number | null, now: string): number {
    return Number(this.db.prepare("INSERT INTO archive_steps(runId,phase,item,state,startedAt) VALUES(?,?,?,'intent',?)").run(run.id, phase, item, now).lastInsertRowid);
  }
  outcome(step: number, state: 'ok' | 'failed', detail: unknown, now: string): void {
    this.db.prepare('UPDATE archive_steps SET state=?,detail=?,finishedAt=? WHERE id=?').run(state, JSON.stringify(detail), now, step);
  }
  /** Advance only a currently verified head, never an unresolved sibling/proposal or failed readback. */
  checkpoint(binding: string, row: VersionCheckpoint): void {
    this.db.prepare('INSERT OR REPLACE INTO archive_versions(binding,relPath,noteId,ver,sha256) VALUES(?,?,?,?,?)').run(binding,row.relPath,row.noteId,row.ver,row.sha256);
  }
  complete(run: JournalRun, receipt: unknown, now: string, checkpoints: VersionCheckpoint[] = [], checkpointBinding = run.binding): void {
    this.transaction(() => {
      for (const row of checkpoints) this.checkpoint(checkpointBinding,row);
      this.db.prepare("UPDATE archive_runs SET state='complete',completedAt=?,receipt=? WHERE id=?").run(now, JSON.stringify(receipt), run.id);
    });
  }
  abandonExpired(run: JournalRun, now: string): void {
    this.db.prepare("UPDATE archive_runs SET state='expired',completedAt=? WHERE id=?").run(now,run.id);
  }
  close(): void { for (const lock of this.locks) lock.close(); this.locks.clear(); this.db.close(); }
}
