import type { SqlDriver, SqlParam, RunResult } from '../../../../packages/core/src/catalog/driver.ts';

type Binding = string | number | ArrayBuffer | null;
type Row = Record<string, unknown>;
export interface DurableSqlStorage {
  sql: { exec(query: string, ...bindings: Binding[]): { toArray(): Row[] } };
  transactionSync<T>(callback: () => T): T;
}

function bind(value: SqlParam): Binding {
  if (value instanceof Uint8Array) return new Uint8Array(value).buffer;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('SQL integer exceeds exact numeric range');
    return number;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('SQL number must be finite');
  return value;
}

/** The DO owns its connection. Catalog transactions use transactionSync, never SQL BEGIN. */
export function openDurableSql(storage: DurableSqlStorage): SqlDriver {
  let depth = 0;
  let closed = false;
  const rows = (sql: string, params: SqlParam[] = []): Row[] => {
    if (closed) throw new Error('SQL adapter is closed');
    return storage.sql.exec(sql, ...params.map(bind)).toArray().map(row =>
      Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value])));
  };
  const call = <T>(fn: () => T): T => {
    depth++;
    try {
      const result = fn();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
        // No later continuation may write through this adapter outside the rejected transaction.
        closed = true;
        throw new Error('SQL transaction callback must be synchronous');
      }
      return result;
    } finally { depth--; }
  };
  return {
    exec(sql) { rows(sql); },
    run(sql, params = []): RunResult {
      rows(sql, params);
      // rowsWritten is a billing counter and may include trigger work. Match SQLite changes().
      const changes = rows('SELECT changes() AS changes')[0]?.changes;
      if (typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0)
        throw new Error('invalid SQL change count');
      return { changes };
    },
    all<T>(sql: string, params: SqlParam[] = []) { return rows(sql, params) as T[]; },
    get<T>(sql: string, params: SqlParam[] = []) { return rows(sql, params)[0] as T | undefined; },
    transaction<T>(fn: () => T): T {
      if (closed) throw new Error('SQL adapter is closed');
      return depth > 0 ? call(fn) : storage.transactionSync(() => call(fn));
    },
    inTransaction() { return depth > 0; },
    close() { closed = true; },
  };
}
