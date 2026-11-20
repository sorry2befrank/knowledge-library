import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlParam, RunResult } from "./driver.ts";

export function openNodeSqlite(path = ":memory:"): SqlDriver {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  let depth = 0;
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const prep = (sql: string) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []): RunResult => { const r = prep(sql).run(...(params as never[])); return { changes: Number(r.changes) }; },
    all: <T>(sql: string, params: SqlParam[] = []) => prep(sql).all(...(params as never[])) as T[],
    get: <T>(sql: string, params: SqlParam[] = []) => prep(sql).get(...(params as never[])) as T | undefined,
    transaction<T>(fn: () => T): T {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      db.exec("BEGIN IMMEDIATE"); depth++;
      try { const r = fn(); db.exec("COMMIT"); return r; }
      catch (e) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
      finally { depth--; }
    },
    inTransaction: () => depth > 0,
    close: () => db.close(),
  };
}
