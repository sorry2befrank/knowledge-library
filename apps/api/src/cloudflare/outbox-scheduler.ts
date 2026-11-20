// The outbox rows are durable intent; the DO alarm is a durable wakeup, not the queue.
// All catalog-producing entry points must use run(), including token/approval paths.
// A local promise queue serializes them with alarm dispatch across external awaits.
// This is deliberately not blockConcurrencyWhile() around network or R2 I/O.
import type { Catalog } from '../../../../packages/core/src/catalog/catalog.ts';
import type { DispatchReport } from '../../../../packages/core/src/catalog/outbox.ts';

export interface AlarmPort {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface OutboxSchedulerOptions {
  catalog: Pick<Catalog, 'db' | 'dispatchOutbox'>;
  alarms: AlarmPort;
  now?: () => number;
  batchSize?: number;
  minDelayMs?: number;
  retryDelayMs?: number;
}

export class OutboxScheduler {
  private readonly catalog: OutboxSchedulerOptions['catalog'];
  private readonly alarms: AlarmPort;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly minDelayMs: number;
  private readonly retryDelayMs: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: OutboxSchedulerOptions) {
    this.catalog = options.catalog; this.alarms = options.alarms;
    this.now = options.now ?? Date.now;
    this.batchSize = bounded(options.batchSize ?? 10, 1, 100);
    this.minDelayMs = bounded(options.minDelayMs ?? 1000, 1, 60_000);
    this.retryDelayMs = bounded(options.retryDelayMs ?? 30_000, this.minDelayMs, 3_600_000);
  }

  /** Call and await during DO initialization; recover pending rows without postponing an existing alarm. */
  recover(): Promise<void> {
    return this.serial(async () => {
      const next = this.pendingAt();
      if (next !== null) await this.ensureAlarmBy(next);
    });
  }

  /** Persist a safety wakeup BEFORE the callback can commit work, including work whose response is lost. */
  run<T>(producer: () => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.ensureAlarmBy(this.time() + this.retryDelayMs);
      try { return await producer(); }
      finally { await this.reschedule(); }
    });
  }

  /** One bounded dispatch. Normal nextAttemptAt backoff is never bypassed. */
  alarm(): Promise<DispatchReport> {
    return this.serial(async () => {
      // getAlarm() is null while an alarm is running unless this handler sets one.
      // A new durable wakeup survives a crash or exhausted provider retry attempts.
      await this.ensureAlarmBy(this.time() + this.retryDelayMs);
      // Expected per-step failures are retained by dispatchOutbox with their own
      // backoff. An unexpected throw leaves this safety alarm intact instead of
      // a tight immediate retry, while still rejecting for the provider's retry.
      const report = await this.catalog.dispatchOutbox({ limit: this.batchSize });
      await this.reschedule(true);
      return report;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000 - 3_600_000)
      throw new Error('invalid-outbox-clock');
    return value;
  }

  private pendingAt(): number | null {
    const now = this.time();
    const row = this.catalog.db.get<{ nextAttemptAt: string | null }>(
      "SELECT min(COALESCE(nextAttemptAt, ?)) AS nextAttemptAt FROM outbox WHERE state = 'pending'",
      [new Date(now).toISOString()]);
    if (!row) throw new Error('outbox-schedule-unavailable');
    if (row.nextAttemptAt === null) return null;
    const due = Date.parse(row.nextAttemptAt);
    if (!Number.isSafeInteger(due)) throw new Error('invalid-outbox-next-attempt');
    return Math.max(now + this.minDelayMs, due);
  }

  private async ensureAlarmBy(at: number): Promise<void> {
    const current = await this.alarms.getAlarm();
    if (current !== null && (!Number.isSafeInteger(current) || current < 0))
      throw new Error('invalid-outbox-alarm');
    if (current === null || current > at) await this.alarms.setAlarm(at);
  }

  private async reschedule(afterDispatch = false): Promise<void> {
    const next = this.pendingAt();
    // No other producer/dispatcher can enter until this storage operation finishes.
    // Do not clear the safety alarm before reading the authoritative pending rows.
    if (next === null) await this.alarms.deleteAlarm();
    // Requests must never postpone due work under traffic. After dispatch, replace
    // the temporary safety wakeup with the real backoff rather than polling it.
    else if (afterDispatch) await this.alarms.setAlarm(next);
    else await this.ensureAlarmBy(next);
  }
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid-outbox-scheduler-option');
  return value;
}
