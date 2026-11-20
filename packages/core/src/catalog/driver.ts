// SqlDriver: the small port the catalog runs on. Adapters: node:sqlite (S1), Durable Object SQL or D1 (later).
export type SqlParam = string | number | bigint | Uint8Array | null;
export interface RunResult { changes: number }

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: SqlParam[]): RunResult;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | undefined;
  transaction<T>(fn: () => T): T;
  inTransaction(): boolean;
  close(): void;
}
