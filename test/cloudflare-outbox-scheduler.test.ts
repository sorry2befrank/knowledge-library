import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxScheduler, type AlarmPort } from '../apps/api/src/cloudflare/outbox-scheduler.ts';
import { newCatalog, FRANK_CONNECTOR } from './helpers/load.ts';

class Alarms implements AlarmPort {
  next: number | null = null;
  writes: number[] = [];
  failSet = false;
  async getAlarm() { return this.next; }
  async setAlarm(at: number) {
    if (this.failSet) throw new Error('synthetic-alarm-unavailable');
    this.next = at; this.writes.push(at);
  }
  async deleteAlarm() { this.next = null; }
}

const open: ReturnType<typeof newCatalog>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const item of open.splice(0)) item.catalog.db.close(); });

function fixture(options: { batchSize?: number; minDelayMs?: number; retryDelayMs?: number } = {}) {
  const item = newCatalog(); open.push(item);
  let now = Date.parse('2026-10-18T12:00:00.000Z');
  item.catalog.clock.now = () => new Date(now).toISOString();
  const alarms = new Alarms();
  const create = () => new OutboxScheduler({ catalog: item.catalog, alarms, now: () => now, ...options });
  const scheduler = create();
  return { ...item, alarms, scheduler, create, now: () => now, advance: (ms: number) => { now += ms; },
    fire: async (target = scheduler) => { alarms.next = null; return target.alarm(); },
    save: (text = '# Archive\nshared project notes') => item.catalog.save(FRANK_CONNECTOR, { content: text }) };
}

describe('durable outbox scheduling', () => {
  it('awaits durable alarm persistence before any producer mutation', async () => {
    const f = fixture();
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const set = f.alarms.setAlarm.bind(f.alarms);
    vi.spyOn(f.alarms, 'setAlarm').mockImplementationOnce(async at => { await persisted; await set(at); });
    const producer = vi.fn(async () => { expect(f.alarms.next).not.toBeNull(); return f.save(); });
    const work = f.scheduler.run(producer);
    await Promise.resolve(); await Promise.resolve();
    expect(producer).not.toHaveBeenCalled();
    release();
    expect(await work).toMatchObject({ ok: true, custody: 'verified' });
    expect(f.catalog.outbox().pending).toBe(2);
    expect(f.alarms.next).toBe(f.now() + 1000);
  });

  it('refuses a producer when its recovery alarm cannot be persisted', async () => {
    const f = fixture(); f.alarms.failSet = true;
    const producer = vi.fn(f.save);
    await expect(f.scheduler.run(producer)).rejects.toThrow('synthetic-alarm-unavailable');
    expect(producer).not.toHaveBeenCalled();
    expect(f.catalog.outbox().pending).toBe(0);
  });

  it('indexes a bounded batch, rearms remaining work, and makes duplicate delivery harmless', async () => {
    const f = fixture({ batchSize: 1 });
    const saved = await f.scheduler.run(() => f.save());
    expect(saved.ok).toBe(true);
    const first = await f.fire();
    expect(first).toMatchObject({ ran: 1, done: 1 });
    expect(f.catalog.search(FRANK_CONNECTOR, 'shared project').hits).toHaveLength(1);
    expect(f.catalog.outbox().pending).toBe(1);
    expect(f.alarms.next).toBe(f.now() + 1000);
    expect(await f.fire()).toMatchObject({ ran: 1, done: 1 });
    expect(f.catalog.outbox().pending).toBe(0);
    expect(f.alarms.next).toBeNull();
    const writes = f.mirror.writes;
    expect(await f.fire()).toMatchObject({ ran: 0, done: 0 });
    expect(f.mirror.writes).toBe(writes);
  });

  it('respects step backoff and resumes on its earliest due time after restart', async () => {
    const f = fixture();
    await f.scheduler.run(() => f.save());
    f.mirror.failWhen = key => key.startsWith('m/');
    expect(await f.fire()).toMatchObject({ retried: 1 });
    const row = f.catalog.db.get<{ nextAttemptAt: string; attempts: number }>("SELECT nextAttemptAt, attempts FROM outbox WHERE state='pending'")!;
    const due = Date.parse(row.nextAttemptAt);
    expect(f.alarms.next).toBe(due);
    expect(await f.fire()).toMatchObject({ ran: 0 });
    expect(f.catalog.db.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE state='pending'")!.attempts).toBe(row.attempts);
    f.alarms.next = null;
    const restarted = f.create(); await restarted.recover();
    expect(f.alarms.next).toBe(due);
    f.mirror.failWhen = null; f.advance(due - f.now());
    expect(await f.fire(restarted)).toMatchObject({ ran: 1, done: 1 });
    expect(f.alarms.next).toBeNull();
  });

  it('recovers an unarmed durable backlog without a new producer', async () => {
    const f = fixture(); await f.save();
    expect(f.alarms.next).toBeNull();
    await f.create().recover();
    expect(f.alarms.next).toBe(f.now() + 1000);
    await f.fire(f.create());
    expect(f.catalog.search(FRANK_CONNECTOR, 'shared').hits).toHaveLength(1);
    expect(f.catalog.outbox().pending).toBe(0);
  });

  it('keeps an earlier existing alarm during constructor recovery and chooses the earliest row', async () => {
    const f = fixture(); await f.save();
    f.catalog.db.run("UPDATE outbox SET nextAttemptAt=? WHERE step='index.version'", [new Date(f.now() + 60_000).toISOString()]);
    f.catalog.db.run("UPDATE outbox SET nextAttemptAt=? WHERE step='mirror.meta'", [new Date(f.now() + 30_000).toISOString()]);
    f.alarms.next = f.now() + 10_000;
    await f.scheduler.recover();
    expect(f.alarms.next).toBe(f.now() + 10_000);
    f.alarms.next = null; await f.scheduler.recover();
    expect(f.alarms.next).toBe(f.now() + 30_000);
  });

  it('does not start periodic wakeups for an empty catalog', async () => {
    const f = fixture(); await f.scheduler.recover();
    expect(f.alarms.next).toBeNull(); expect(f.alarms.writes).toEqual([]);
  });

  it('does not postpone due work under a steady stream of read requests', async () => {
    const f = fixture(); await f.scheduler.run(() => f.save());
    const firstWakeup = f.alarms.next;
    for (let i = 0; i < 20; i++) {
      f.advance(100);
      await f.scheduler.run(() => f.catalog.search(FRANK_CONNECTOR, 'shared'));
      expect(f.alarms.next).toBe(firstWakeup);
    }
    await f.fire();
    expect(f.catalog.search(FRANK_CONNECTOR, 'shared').hits).toHaveLength(1);
  });

  it('retains committed work when the producer loses its response', async () => {
    const f = fixture();
    await expect(f.scheduler.run(async () => { await f.save(); throw new Error('synthetic-response-lost'); })).rejects.toThrow('synthetic-response-lost');
    expect(f.alarms.next).not.toBeNull();
    await f.fire(f.create());
    expect(f.catalog.search(FRANK_CONNECTOR, 'shared').hits).toHaveLength(1);
  });

  it('persists a future safety alarm before dispatch and retains it on an unexpected failure', async () => {
    const f = fixture(); await f.save();
    vi.spyOn(f.catalog, 'dispatchOutbox').mockImplementationOnce(async () => {
      expect(f.alarms.next).toBe(f.now() + 30_000);
      throw new Error('synthetic-dispatch-crash');
    });
    await expect(f.fire()).rejects.toThrow('synthetic-dispatch-crash');
    expect(f.alarms.next).toBe(f.now() + 30_000);
    await f.fire(f.create()); expect(f.catalog.outbox().pending).toBe(0);
  });

  it('retains its safety alarm if pending-row recovery itself fails', async () => {
    const f = fixture(); await f.save();
    vi.spyOn(f.catalog, 'dispatchOutbox').mockResolvedValueOnce({ ran: 0, done: 0, retried: 0, crashed: false });
    vi.spyOn(f.catalog.db, 'get').mockImplementationOnce(() => { throw new Error('synthetic-database-unavailable'); });
    await expect(f.fire()).rejects.toThrow();
    expect(f.alarms.next).toBe(f.now() + 30_000);
  });

  it('leaves a durable wakeup when scheduling the next batch fails after an effect', async () => {
    const f = fixture({ batchSize: 1 }); await f.save();
    const original = f.catalog.dispatchOutbox.bind(f.catalog);
    vi.spyOn(f.catalog, 'dispatchOutbox').mockImplementationOnce(async options => {
      const result = await original(options); f.alarms.failSet = true; return result;
    });
    await expect(f.fire()).rejects.toThrow('synthetic-alarm-unavailable');
    expect(f.alarms.next).toBe(f.now() + 30_000);
    expect(f.catalog.outbox().pending).toBe(1);
    f.alarms.failSet = false;
    await f.fire(f.create());
    expect(f.catalog.outbox().pending).toBe(0);
    expect(f.catalog.search(FRANK_CONNECTOR, 'shared').hits).toHaveLength(1);
  });

  it('continues explicit wakeups through repeated failures beyond the provider retry limit', async () => {
    const f = fixture(); await f.save(); f.mirror.failWhen = key => key.startsWith('m/');
    for (let attempt = 0; attempt < 9; attempt++) {
      await f.fire(f.create());
      expect(f.alarms.next).not.toBeNull();
      f.advance(f.alarms.next! - f.now());
    }
    expect(f.catalog.outbox().hardAlarms).toBe(1);
    expect(f.catalog.outbox().pending).toBe(1);
    f.mirror.failWhen = null;
    await f.fire(f.create()); expect(f.catalog.outbox().pending).toBe(0);
  });

  it('serializes producers and dispatch so draining cannot erase newly committed work', async () => {
    const f = fixture({ batchSize: 1 }); await f.scheduler.run(() => f.save('first uniquealpha'));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = f.catalog.dispatchOutbox.bind(f.catalog);
    const order: string[] = [];
    vi.spyOn(f.catalog, 'dispatchOutbox').mockImplementationOnce(async options => {
      order.push('dispatch-enter'); await blocked;
      const result = await original(options); order.push('dispatch-exit'); return result;
    });
    const alarm = f.fire();
    for (let i = 0; i < 8 && order.length === 0; i++) await Promise.resolve();
    const producer = f.scheduler.run(async () => { order.push('producer'); return f.save('second uniquebeta'); });
    await Promise.resolve(); expect(order).toEqual(['dispatch-enter']);
    release(); await alarm; await producer;
    expect(order).toEqual(['dispatch-enter', 'dispatch-exit', 'producer']);
    expect(f.catalog.outbox().pending).toBe(3); expect(f.alarms.next).not.toBeNull();
    await f.fire(); await f.fire(); await f.fire();
    expect(f.catalog.search(FRANK_CONNECTOR, 'uniquebeta').hits).toHaveLength(1);
    expect(f.alarms.next).toBeNull();
  });

  it('keeps the serialization queue usable after a failed producer', async () => {
    const f = fixture();
    await expect(f.scheduler.run(() => { throw new Error('synthetic-producer-failure'); })).rejects.toThrow();
    expect(await f.scheduler.run(() => f.save())).toMatchObject({ ok: true });
    await f.fire(); expect(f.catalog.outbox().pending).toBe(0);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects an unbounded/invalid batch size %s', value => {
    expect(() => fixture({ batchSize: value })).toThrow('invalid-outbox-scheduler-option');
  });

  it.each([0, -1, 60_001, 1.5, Number.NaN])('rejects an invalid minimum delay %s', value => {
    expect(() => fixture({ minDelayMs: value })).toThrow('invalid-outbox-scheduler-option');
  });

  it.each([0, 999, 3_600_001, 1.5, Number.NaN])('rejects an invalid retry delay %s', value => {
    expect(() => fixture({ retryDelayMs: value })).toThrow('invalid-outbox-scheduler-option');
  });
});
