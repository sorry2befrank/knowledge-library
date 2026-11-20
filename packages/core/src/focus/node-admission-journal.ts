// Separate local journal adapter. Catalog SQLite's NORMAL connection is not a durability substitute.
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { SqlDriver, SqlParam } from '../catalog/driver.ts';
import { AdmissionJournal, type JournalHeld } from './admission-journal.ts';
import { validateAdmissionSnapshot, type AdmissionSnapshot } from './global-admission.ts';

const BUSY_MS = 1000;
const localPath = (path: string) => isAbsolute(path) && !path.startsWith('\\\\') && !path.startsWith('//') && resolve(path) === path;
function exactFile(path: string) {
  if (!localPath(path) || realpathSync(dirname(path)).toLowerCase() !== dirname(path).toLowerCase()) throw Error('journal-path');
  const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 128 * 1024 * 1024) throw Error('journal-path');
  return s;
}
/** Internal trusted port; standalone so tests can inject acknowledged/unknown transaction outcomes without a second SQL port. */
export function openFullAdmissionSqlite(path: string): SqlDriver {
  const identity = exactFile(path);
  // URI mode=rw omits CREATE, including if the checked file disappears before SQLite opens it.
  // Escape filenames so literal '?' and '#' characters cannot become SQLite options.
  const db = new DatabaseSync(pathToFileURL(path).href + '?mode=rw', { timeout: BUSY_MS, allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
  let active = false, closed = false;
  const check = () => {
    if (closed) throw Error('journal-closed');
    const current = exactFile(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw Error('journal-identity-changed');
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    if (mode.journal_mode !== 'wal' || sync.synchronous !== 2 || timeout.timeout !== BUSY_MS) throw Error('journal-durability-settings');
  };
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 1000;');
    check();
  } catch (error) { db.close(); throw error; }
  return {
    exec: sql => db.exec(sql),
    run: (sql, params = []) => ({ changes: Number(db.prepare(sql).run(...(params as never[])).changes) }),
    all: <T>(sql: string, params: SqlParam[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: SqlParam[] = []) => db.prepare(sql).get(...(params as never[])) as T | undefined,
    transaction<T>(fn: () => T): T {
      if (active) throw Error('journal-nested-transaction');
      check(); db.exec('BEGIN IMMEDIATE'); active = true;
      try { check(); const value = fn(); check(); db.exec('COMMIT'); return value; }
      catch (error) { try { db.exec('ROLLBACK'); } catch { /* outcome remains unknown to caller */ } throw error; }
      finally { active = false; }
    },
    inTransaction: () => active,
    close: () => { closed = true; db.close(); },
  };
}
export type OpenJournal = { status: 'opened'; journal: AdmissionJournal; effect: 'none'; authorizesEffects: false } | JournalHeld;
function unavailable(): JournalHeld { return { status: 'held', reason: 'journal-open-unconfirmed', commit: 'unknown', effect: 'none', authorizesEffects: false }; }
/** Existing state is mandatory. Missing, empty, corrupt or incomplete databases are never initialized here. */
export function openAdmissionJournal(path: string, nowMs: number): OpenJournal {
  let journal: AdmissionJournal | undefined;
  try {
    journal = new AdmissionJournal(openFullAdmissionSqlite(path));
    if (journal.read(nowMs).status !== 'read') { journal.close(); return unavailable(); }
    return { status: 'opened', journal, effect: 'none', authorizesEffects: false };
  } catch { try { journal?.close(); } catch { /* preserve held result */ } return unavailable(); }
}
/** Explicit one-time initialization. Exclusive file creation; failed/partial initialization stays on disk for investigation. */
export function createAdmissionJournal(path: string, initial: AdmissionSnapshot, nowMs: number): OpenJournal {
  let journal: AdmissionJournal | undefined;
  try {
    const valid = validateAdmissionSnapshot(initial, nowMs);
    if (valid.status !== 'valid' || valid.snapshot.revision !== 0 || valid.snapshot.pending !== null || valid.snapshot.closedRunIds.length !== 0) return unavailable();
    if (!localPath(path) || realpathSync(dirname(path)).toLowerCase() !== dirname(path).toLowerCase()) return unavailable();
    closeSync(openSync(path, 'wx', 0o600));
    journal = new AdmissionJournal(openFullAdmissionSqlite(path));
    if (journal.initialize(valid.snapshot, randomUUID(), nowMs).status !== 'committed') { journal.close(); return unavailable(); }
    return { status: 'opened', journal, effect: 'none', authorizesEffects: false };
  } catch { try { journal?.close(); } catch { /* preserve held result */ } return unavailable(); }
}
