import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import type { SqlDriver } from '../packages/core/src/catalog/driver.ts';
import { AdmissionJournal, type JournalView } from '../packages/core/src/focus/admission-journal.ts';
import { createAdmissionJournal, openAdmissionJournal, openFullAdmissionSqlite } from '../packages/core/src/focus/node-admission-journal.ts';
import { digest } from '../packages/core/src/focus/plan-data.ts';
import { canonicalJson } from '../packages/core/src/primitives/canonical.ts';
import type { AdmissionCommand } from '../packages/core/src/focus/global-admission.ts';
import { NOW, H, initial, binding, quiet, fixture } from './helpers/admission-journal-fixture.ts';

function created(path = fixture()) {
  const opened = createAdmissionJournal(path, initial(), NOW); expect(opened.status).toBe('opened');
  if (opened.status !== 'opened') throw Error('create-held');
  return { path, journal: opened.journal };
}
function view(journal: AdmissionJournal, at = NOW): JournalView {
  const read = journal.read(at); expect(read.status).toBe('read'); if (read.status !== 'read') throw Error('read-held'); return read;
}
function advance(journal: AdmissionJournal, command: AdmissionCommand, at = NOW + 1) {
  const before = view(journal, at); return journal.transition({ nowMs: at, expectedJournalId: before.journalId,
    expectedRevision: before.snapshot.revision, expectedStateHash: before.stateHash, command });
}
function edit(path: string, fn: (db: DatabaseSync) => void) { const db = new DatabaseSync(path); try { fn(db); } finally { db.close(); } }
function reopen(path: string, at = NOW + 100) { const o = openAdmissionJournal(path, at); expect(o.status).toBe('opened'); if (o.status !== 'opened') throw Error('reopen-held'); return o.journal; }

test('explicit disk genesis reopens with unchanged identity, revision, membership and hash', () => {
  const { path, journal } = created(); const a = view(journal); journal.close();
  const other = reopen(path); const b = view(other, NOW + 100);
  expect(b.journalId).toBe(a.journalId); expect(b.stateHash).toBe(a.stateHash); expect(b.snapshot.closedRunIds).toEqual([]); expect(b.snapshot.revision).toBe(0); other.close();
});
test('missing file is held without creating it', () => {
  const path = fixture(); expect(openAdmissionJournal(path, NOW).status).toBe('held'); expect(existsSync(path)).toBe(false);
});
test('memory, relative and UNC/device names refuse before local filesystem lookup', () => {
  for (const path of [':memory:', 'relative.sqlite', '\\\\invalid.invalid\\share\\journal.sqlite', '\\\\?\\C:\\journal.sqlite', '//invalid.invalid/share/journal.sqlite']) {
    expect(openAdmissionJournal(path, NOW).status).toBe('held'); expect(createAdmissionJournal(path, initial(), NOW).status).toBe('held');
  }
});
test('empty preexisting file never initializes and explicit create never overwrites it', () => {
  const path = fixture(); writeFileSync(path, ''); expect(openAdmissionJournal(path, NOW).status).toBe('held');
  expect(createAdmissionJournal(path, initial(), NOW).status).toBe('held');
  edit(path, db => expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.n).toBe(0));
});
test('file removed after lstat is held without recreating a blank database', () => {
  const { path, journal } = created(); journal.close(); const original = fs.lstatSync; const descriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync')!; let swapped = false;
  const retained = path + '.retained-original';
  try {
    const hooked = ((...args: Parameters<typeof original>) => {
      const stat = original(...args);
      if (args[0] === path && !swapped) { fs.renameSync(path, retained); swapped = true; }
      return stat;
    }) as typeof original;
    Object.defineProperty(fs, 'lstatSync', { ...descriptor, value: hooked });
    syncBuiltinESMExports(); expect(openAdmissionJournal(path, NOW).status).toBe('held');
    expect(swapped).toBe(true); expect(existsSync(retained)).toBe(true); expect(existsSync(path)).toBe(false);
  } finally { Object.defineProperty(fs, 'lstatSync', descriptor); syncBuiltinESMExports(); }
});
test('arbitrary non-SQLite bytes are preserved on failed open', () => {
  const path = fixture(); writeFileSync(path, 'synthetic-corrupt'); expect(openAdmissionJournal(path, NOW).status).toBe('held'); expect(readFileSync(path, 'utf8')).toBe('synthetic-corrupt');
});
test('second explicit initialization preserves committed pending state', () => {
  const { path, journal } = created(); expect(advance(journal, { type: 'admit', binding: binding() }).status).toBe('committed'); journal.close();
  expect(createAdmissionJournal(path, initial(), NOW).status).toBe('held'); const other = reopen(path); expect(view(other, NOW + 100).snapshot.pending?.binding.runId).toBe('run'); other.close();
});
test('nonempty initial snapshot is refused before file creation', () => {
  const path = fixture(), s = initial(); s.closedRunIds = ['old']; expect(createAdmissionJournal(path, s, NOW).status).toBe('held'); expect(existsSync(path)).toBe(false);
});
test('WAL and FULL are actual connection settings, and weakening refuses the next transaction', () => {
  const { path, journal } = created(); journal.close(); const db = openFullAdmissionSqlite(path);
  expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal'); expect(db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous).toBe(2);
  db.exec('PRAGMA synchronous = NORMAL'); const wrapped = new AdmissionJournal(db); expect(wrapped.read(NOW).status).toBe('held'); wrapped.close();
});
test('read keeps fresh observation outside stable durable state hash', () => {
  const { journal } = created(); const before = view(journal); const later = view(journal, NOW + 999);
  expect(later.snapshot.observedAtMs).toBe(NOW + 999); expect(later.stateHash).toBe(before.stateHash); expect(later.headHash).toBe(before.headHash); journal.close();
});
test('revision, hash and journal identity CAS each refuse without an event', () => {
  const { path, journal } = created(); const a = view(journal);
  for (const bad of [{ expectedRevision: 1 }, { expectedStateHash: 'f'.repeat(64) }, { expectedJournalId: 'another' }]) {
    expect(journal.transition({ nowMs: NOW, expectedRevision: 0, expectedStateHash: a.stateHash, expectedJournalId: a.journalId,
      command: { type: 'admit', binding: binding() }, ...bad }).status).toBe('held');
  }
  journal.close(); edit(path, db => expect(db.prepare('SELECT count(*) AS n FROM admission_events').get()?.n).toBe(1));
});
test('two connection stale writers serialize and only one expected revision commits', () => {
  const { path, journal } = created(); const second = reopen(path), a = view(journal);
  const c = { nowMs: NOW + 1, expectedJournalId: a.journalId, expectedRevision: 0, expectedStateHash: a.stateHash };
  expect(journal.transition({ ...c, command: { type: 'admit', binding: binding('one') } }).status).toBe('committed');
  expect(second.transition({ ...c, command: { type: 'admit', binding: binding('two') } }).status).toBe('held'); expect(view(second, NOW + 2).snapshot.pending?.binding.runId).toBe('one'); journal.close(); second.close();
});
test('intent survives reopen and blocks every later effect kind and completion', () => {
  const { path, journal } = created(); advance(journal, { type: 'admit', binding: binding() });
  expect(advance(journal, { type: 'begin-effect', binding: binding(), effectId: 'effect', kind: 'movement', itemId: 'item' }, NOW + 2).status).toBe('committed'); journal.close();
  const other = reopen(path);
  for (const kind of ['movement', 'pointer', 'veil', 'restore', 'recovery'] as const) expect(advance(other,
    { type: 'begin-effect', binding: binding(), effectId: `next-${kind}`, kind, itemId: kind === 'movement' ? 'item' : null }, NOW + 100).status).toBe('held');
  expect(advance(other, { type: 'complete', binding: binding() }, NOW + 100).status).toBe('held'); expect(view(other, NOW + 100).snapshot.pending?.effects[0]?.state).toBe('intent'); other.close();
});
test('unknown observation remains pending across reopen until matching settled observation', () => {
  const { path, journal } = created(); advance(journal, { type: 'admit', binding: binding() }); advance(journal, { type: 'begin-effect', binding: binding(), effectId: 'effect', kind: 'pointer', itemId: null }, NOW + 2);
  advance(journal, { type: 'observe-effect', binding: binding(), effectId: 'effect', state: 'unknown', observationHash: H }, NOW + 3); journal.close();
  const other = reopen(path); expect(view(other, NOW + 100).snapshot.pending?.effects[0]?.state).toBe('unknown');
  expect(advance(other, { type: 'observe-effect', binding: binding(), effectId: 'wrong', state: 'settled', observationHash: H }, NOW + 100).status).toBe('held');
  expect(advance(other, { type: 'observe-effect', binding: binding(), effectId: 'effect', state: 'settled', observationHash: H }, NOW + 100).status).toBe('committed'); other.close();
});
test('released zero-effect run membership survives restart and run reuse refuses', () => {
  const { path, journal } = created(); advance(journal, { type: 'admit', binding: binding() }); advance(journal, { type: 'complete', binding: binding() }, NOW + 2);
  const s = view(journal, NOW + 10).snapshot; expect(advance(journal, { type: 'release', binding: binding(), quiet: quiet(s, NOW + 10) }, NOW + 10).status).toBe('committed'); journal.close();
  const other = reopen(path); expect(view(other, NOW + 100).snapshot.closedRunIds).toEqual(['run']); expect(advance(other, { type: 'admit', binding: binding() }, NOW + 100).status).toBe('held'); other.close();
});
test('later recovery invalidates quiet evidence and never reopens movement capacity', () => {
  const { journal } = created(); advance(journal, { type: 'admit', binding: binding() }); advance(journal, { type: 'complete', binding: binding() }, NOW + 2);
  const oldQuiet = quiet(view(journal, NOW + 10).snapshot, NOW + 10);
  expect(advance(journal, { type: 'begin-effect', binding: binding(), effectId: 'late', kind: 'recovery', itemId: null }, NOW + 10).status).toBe('committed');
  expect(advance(journal, { type: 'release', binding: binding(), quiet: oldQuiet }, NOW + 10).status).toBe('held');
  advance(journal, { type: 'observe-effect', binding: binding(), effectId: 'late', state: 'settled', observationHash: H }, NOW + 11);
  expect(advance(journal, { type: 'begin-effect', binding: binding(), effectId: 'remove', kind: 'movement', itemId: 'item' }, NOW + 12).status).toBe('held'); journal.close();
});
test('transaction rollback leaves neither appended event nor new checkpoint', () => {
  const { path, journal } = created(); const old = view(journal); journal.close(); const db = openFullAdmissionSqlite(path);
  const faulty: SqlDriver = { ...db, run(sql, args) { if (sql.startsWith('UPDATE admission_state')) throw Error('injected-after-event-before-state'); return db.run(sql, args); } };
  const j = new AdmissionJournal(faulty); const result = j.transition({ nowMs: NOW + 1, expectedJournalId: old.journalId, expectedRevision: 0, expectedStateHash: old.stateHash, command: { type: 'admit', binding: binding() } });
  expect(result).toMatchObject({ status: 'held', commit: 'unknown' }); expect(j.read(NOW + 1).status).toBe('held'); j.close();
  const other = reopen(path); expect(view(other, NOW + 100).snapshot.revision).toBe(0); other.close(); edit(path, d => expect(d.prepare('SELECT count(*) AS n FROM admission_events').get()?.n).toBe(1));
});
test('lost commit acknowledgement poisons writer but fresh read establishes exact committed checkpoint', () => {
  const { path, journal } = created(); const old = view(journal); journal.close(); const db = openFullAdmissionSqlite(path);
  const lost: SqlDriver = { ...db, transaction<T>(fn: () => T): T { db.transaction(fn); throw Error('injected-ack-loss'); } };
  const j = new AdmissionJournal(lost); expect(j.transition({ nowMs: NOW + 1, expectedJournalId: old.journalId, expectedRevision: 0,
    expectedStateHash: old.stateHash, command: { type: 'admit', binding: binding() } })).toMatchObject({ status: 'held', commit: 'unknown', authorizesEffects: false });
  expect(j.read(NOW + 1).status).toBe('held'); j.close(); const other = reopen(path); expect(view(other, NOW + 100).snapshot.pending?.binding.runId).toBe('run'); other.close();
});
test('BEGIN failure also poisons instance and never acknowledges a commit', () => {
  const { path, journal } = created(); journal.close(); const db = openFullAdmissionSqlite(path);
  const faulty: SqlDriver = { ...db, transaction() { throw Error('injected-begin-failure'); } }; const j = new AdmissionJournal(faulty);
  expect(j.read(NOW)).toMatchObject({ status: 'held', commit: 'unknown' }); expect(j.read(NOW)).toMatchObject({ status: 'held', reason: 'journal-unavailable' }); j.close();
});
test.each(['missing-state', 'missing-event', 'bad-state', 'bad-hash', 'extra-schema', 'wildcard-table', 'wildcard-trigger'] as const)('corrupt durable %s never resets', kind => {
  const { path, journal } = created(); advance(journal, { type: 'admit', binding: binding() }); journal.close();
  edit(path, db => {
    if (kind === 'missing-state') db.exec('DELETE FROM admission_state');
    if (kind === 'missing-event') db.exec('DELETE FROM admission_events WHERE revision = 0');
    if (kind === 'bad-state') db.exec("UPDATE admission_state SET state_json = '{}'");
    if (kind === 'bad-hash') db.exec("UPDATE admission_events SET event_hash = 'broken' WHERE revision = 1");
    if (kind === 'extra-schema') db.exec('CREATE TABLE surprise (value TEXT)');
    if (kind === 'wildcard-table') db.exec('CREATE TABLE sqliteXunexpected (value TEXT)');
    if (kind === 'wildcard-trigger') db.exec('CREATE TRIGGER sqliteXunexpected AFTER INSERT ON admission_events BEGIN SELECT 1; END');
  });
  expect(openAdmissionJournal(path, NOW + 100).status).toBe('held'); expect(createAdmissionJournal(path, initial(), NOW).status).toBe('held');
});
test('rehashed semantically invalid command fails replay, not just hash validation', () => {
  const { path, journal } = created(); advance(journal, { type: 'admit', binding: binding() }); journal.close();
  edit(path, db => {
    const row = db.prepare('SELECT event_json FROM admission_events WHERE revision = 1').get() as { event_json: string };
    const event = JSON.parse(row.event_json); event.command.type = 'resume'; const newHash = digest(event);
    db.prepare('UPDATE admission_events SET event_json = ?, event_hash = ? WHERE revision = 1').run(canonicalJson(event), newHash);
    db.prepare('UPDATE admission_state SET head_hash = ? WHERE singleton = 1').run(newHash);
  }); expect(openAdmissionJournal(path, NOW + 100).status).toBe('held');
});
test('caller mutation cannot rewrite returned or persisted snapshot', () => {
  const { path, journal } = created(); const b = binding(); const result = advance(journal, { type: 'admit', binding: b }); b.runId = 'changed';
  expect(result.status).toBe('committed'); if (result.status === 'committed') expect(Object.isFrozen(result.snapshot.pending?.binding)).toBe(true);
  journal.close(); const other = reopen(path); expect(view(other, NOW + 100).snapshot.pending?.binding.runId).toBe('run'); other.close();
});
test('nested SQL transaction refuses rather than bypassing outer acknowledgement', () => {
  const { path, journal } = created(); journal.close(); const db = openFullAdmissionSqlite(path); expect(() => db.transaction(() => db.transaction(() => 1))).toThrow(); expect(db.inTransaction()).toBe(false); db.close();
});
test('all successful and refused public results stay non-authorizing', () => {
  const { journal } = created(); const r = advance(journal, { type: 'admit', binding: binding() }); const bad = advance(journal, { type: 'admit', binding: binding('another') });
  for (const value of [r, bad, journal.read(NOW + 2)]) expect(value).toMatchObject({ effect: 'none', authorizesEffects: false }); journal.close();
});

const worker = fileURLToPath(new URL('./helpers/admission-journal-child.ts', import.meta.url));
const childEnv = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]!]]));
test('actual process exit inside transaction rolls back; committed process exit reopens pending', () => {
  const { path, journal } = created(); const a = view(journal); journal.close();
  const args = { path, runId: 'process-run', journalId: a.journalId, stateHash: a.stateHash };
  for (const [mode, exit] of [['crash-transaction', 23], ['crash-after-commit', 24]] as const) {
    const child = spawnSync(process.execPath, [worker, JSON.stringify({ ...args, mode })], { cwd: dirname(path), env: childEnv(), timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(exit); const j = reopen(path); expect(view(j, NOW + 100).snapshot.revision).toBe(mode === 'crash-transaction' ? 0 : 1); j.close();
  }
}, 20000);
test('two actual processes contend on one revision: one commit, one held, one event', async () => {
  const { path, journal } = created(); const a = view(journal); journal.close();
  function child(runId: string) {
    const p = spawn(process.execPath, [worker, JSON.stringify({ path, mode: 'concurrent', runId, journalId: a.journalId, stateHash: a.stateHash })],
      { cwd: dirname(path), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = ''; let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => { readyResolve = resolve; });
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { p.kill(); reject(Error('bounded-child-timeout')); }, 8000);
      p.stdout.on('data', b => { output += String(b); if (output.length > 64 * 1024) { p.kill(); reject(Error('child-output-bound')); } if (output.startsWith('ready\n')) readyResolve(); });
      p.stderr.on('data', b => { errors += String(b); if (errors.length > 64 * 1024) { p.kill(); reject(Error('child-error-bound')); } });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => { clearTimeout(timer); if (code !== 0) reject(Error(`child-exit-${code}: ${errors}`)); else resolve(output); });
    });
    return { p, ready, done };
  }
  const one = child('one'), two = child('two');
  try {
    await Promise.race([Promise.all([one.ready, two.ready]), Promise.all([one.done, two.done]).then(() => { throw Error('child-ended-before-barrier'); })]);
    one.p.stdin.end('go\n'); two.p.stdin.end('go\n'); const output = await Promise.all([one.done, two.done]);
    const results = output.map(s => JSON.parse(s.split('\n')[1]!)); expect(results.map(r => r.status).sort()).toEqual(['committed', 'held']);
    const j = reopen(path); const final = view(j, NOW + 100); expect(final.snapshot.revision).toBe(1); expect(['one', 'two']).toContain(final.snapshot.pending?.binding.runId); j.close();
    edit(path, db => expect(db.prepare('SELECT count(*) AS n FROM admission_events').get()?.n).toBe(2));
  } finally { if (one.p.exitCode === null) one.p.kill(); if (two.p.exitCode === null) two.p.kill(); }
}, 20000);
