// Local admission bookkeeping only. A durable record never authorizes an external effect.
import type { SqlDriver } from '../catalog/driver.ts';
import { canonicalJson } from '../primitives/canonical.ts';
import { dataCopy, digest, freeze, hash, id, insist, keys, time } from './plan-data.ts';
import { admissionStateHash, proposeAdmissionTransition, validateAdmissionSnapshot,
  type AdmissionSnapshot, type AdmissionCommand } from './global-admission.ts';

const MAX_EVENTS = 20_000, MAX_BYTES = 32 * 1024 * 1024, MAX_RECORD_BYTES = 2 * 1024 * 1024;
const ZERO = '0'.repeat(64);
export const ADMISSION_JOURNAL_LIMITS = Object.freeze({ maxEvents: MAX_EVENTS, maxBytes: MAX_BYTES, maxRecordBytes: MAX_RECORD_BYTES });
export const ADMISSION_SCHEMA = [
  'CREATE TABLE admission_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), journal_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), state_hash TEXT NOT NULL, head_hash TEXT NOT NULL, state_json TEXT NOT NULL) STRICT',
  'CREATE TABLE admission_events (revision INTEGER PRIMARY KEY CHECK (revision >= 0), event_hash TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL) STRICT',
] as const;
interface StateRow { singleton: number; journal_id: string; revision: number; state_hash: string; head_hash: string; state_json: string }
interface EventRow { revision: number; event_hash: string; event_json: string }
interface EventData { format: 1; journalId: string; revision: number; atMs: number; previousEventHash: string;
  beforeStateHash: string | null; afterStateHash: string; command: AdmissionCommand | null; state: AdmissionSnapshot }
export interface JournalView { journalId: string; snapshot: AdmissionSnapshot; stateHash: string; headHash: string }
export type JournalHeld = { status: 'held'; reason: string; commit: 'none' | 'unknown'; effect: 'none'; authorizesEffects: false };
export type JournalRead = (JournalView & { status: 'read'; effect: 'none'; authorizesEffects: false }) | JournalHeld;
export type JournalCommit = (JournalView & { status: 'committed'; effect: 'none'; authorizesEffects: false }) | JournalHeld;
export interface JournalCommand { nowMs: number; expectedJournalId: string; expectedRevision: number; expectedStateHash: string; command: AdmissionCommand }
const held = (reason: string, commit: 'none' | 'unknown' = 'none'): JournalHeld => freeze({ status: 'held', reason, commit, effect: 'none', authorizesEffects: false });
function encoded(value: unknown): string {
  const text = canonicalJson(value); insist(Buffer.byteLength(text) <= MAX_RECORD_BYTES, 'journal-capacity'); return text;
}
function parsed(text: unknown): unknown {
  insist(typeof text === 'string' && Buffer.byteLength(text) <= MAX_RECORD_BYTES, 'journal-corrupt');
  const value: unknown = JSON.parse(text); insist(encoded(value) === text, 'journal-corrupt'); return value;
}
function requireSnapshot(raw: unknown, nowMs: number): AdmissionSnapshot {
  const result = validateAdmissionSnapshot(raw, nowMs); insist(result.status === 'valid', 'journal-corrupt'); return result.snapshot;
}
function persisted(raw: unknown, atMs: number): AdmissionSnapshot {
  const state = requireSnapshot(raw, atMs); insist(state.observedAtMs === atMs, 'journal-corrupt'); return state;
}
function checkSchema(db: SqlDriver): void {
  const rows = db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE name != 'sqlite_autoindex_admission_events_1' ORDER BY name");
  insist(rows.length === 2, 'journal-schema');
  insist(rows[0]?.name === 'admission_events' && rows[0].sql === ADMISSION_SCHEMA[1]
    && rows[1]?.name === 'admission_state' && rows[1].sql === ADMISSION_SCHEMA[0], 'journal-schema');
}
/** Trusted port boundary. The Node factory supplies FULL SQLite; arbitrary SqlDriver implementations do not prove durability. */
export class AdmissionJournal {
  readonly #db: SqlDriver;
  #poisoned = false;
  #closed = false;
  #seen: { journalId: string; revision: number; stateHash: string; headHash: string } | null = null;
  constructor(db: SqlDriver) { this.#db = db; }

  /** Explicit genesis only. Never called by read/open recovery. Empty or half-initialized existing databases are held. */
  initialize(initial: AdmissionSnapshot, journalId: string, nowMs: number): JournalCommit {
    if (this.#closed || this.#poisoned) return held('journal-unavailable', 'unknown');
    let view: JournalView;
    try {
      const state = requireSnapshot(initial, nowMs);
      insist(id(journalId) && state.revision === 0 && state.pending === null && state.closedRunIds.length === 0, 'genesis-invalid');
      view = this.#db.transaction(() => {
        insist(this.#db.all("SELECT name FROM sqlite_master").length === 0, 'genesis-exists');
        for (const sql of ADMISSION_SCHEMA) this.#db.exec(sql);
        const stateHash = admissionStateHash(state);
        const event: EventData = { format: 1, journalId, revision: 0, atMs: nowMs, previousEventHash: ZERO,
          beforeStateHash: null, afterStateHash: stateHash, command: null, state };
        const eventHash = digest(event);
        this.#db.run('INSERT INTO admission_events (revision, event_hash, event_json) VALUES (?, ?, ?)', [0, eventHash, encoded(event)]);
        this.#db.run('INSERT INTO admission_state (singleton, journal_id, revision, state_hash, head_hash, state_json) VALUES (1, ?, ?, ?, ?, ?)',
          [journalId, 0, stateHash, eventHash, encoded(state)]);
        return this.#readLocked(nowMs);
      });
    } catch { this.#poisoned = true; return held('initialization-unconfirmed', 'unknown'); }
    this.#remember(view); return freeze({ status: 'committed', ...view, effect: 'none', authorizesEffects: false });
  }

  read(nowMs: number): JournalRead {
    if (this.#closed || this.#poisoned) return held('journal-unavailable', 'unknown');
    try {
      // One SQLite snapshot for schema, singleton, complete chain and replay.
      const view = this.#db.transaction(() => this.#readLocked(nowMs));
      this.#remember(view); return freeze({ status: 'read', ...view, effect: 'none', authorizesEffects: false });
    } catch { this.#poisoned = true; return held('journal-read-unconfirmed', 'unknown'); }
  }

  transition(raw: JournalCommand): JournalCommit {
    if (this.#closed || this.#poisoned) return held('journal-unavailable', 'unknown');
    let input: JournalCommand;
    try {
      input = dataCopy(raw); keys(input, 'nowMs expectedJournalId expectedRevision expectedStateHash command');
      insist(time(input.nowMs) && id(input.expectedJournalId) && hash(input.expectedStateHash)
        && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0);
    } catch { return held('command-invalid'); }
    try {
      const result = this.#db.transaction((): JournalView | JournalHeld => {
        const current = this.#readLocked(input.nowMs);
        if (current.journalId !== input.expectedJournalId || current.snapshot.revision !== input.expectedRevision
          || current.stateHash !== input.expectedStateHash) return held('revision-or-state-conflict');
        const proposal = proposeAdmissionTransition({ nowMs: input.nowMs, expectedRevision: input.expectedRevision,
          snapshot: current.snapshot, command: input.command });
        if (proposal.status === 'held') return held(proposal.reasons.join(','));
        const next = proposal.next;
        const event: EventData = { format: 1, journalId: current.journalId, revision: next.revision, atMs: input.nowMs,
          previousEventHash: current.headHash, beforeStateHash: current.stateHash, afterStateHash: proposal.nextStateHash,
          command: input.command, state: next };
        const eventText = encoded(event), stateText = encoded(next), eventHash = digest(event);
        const size = this.#db.get<{ n: number; bytes: number }>('SELECT count(*) AS n, coalesce(sum(length(CAST(event_json AS BLOB))), 0) AS bytes FROM admission_events');
        if (!size || size.n >= MAX_EVENTS || size.bytes + Buffer.byteLength(eventText) > MAX_BYTES) return held('journal-capacity');
        // Append and CAS are one transaction. Any failure/unknown commit poisons the instance, never retries the effect.
        this.#db.run('INSERT INTO admission_events (revision, event_hash, event_json) VALUES (?, ?, ?)', [next.revision, eventHash, eventText]);
        const changed = this.#db.run('UPDATE admission_state SET revision = ?, state_hash = ?, head_hash = ?, state_json = ? WHERE singleton = 1 AND journal_id = ? AND revision = ? AND state_hash = ? AND head_hash = ?',
          [next.revision, proposal.nextStateHash, eventHash, stateText, current.journalId, input.expectedRevision, input.expectedStateHash, current.headHash]);
        insist(changed.changes === 1, 'journal-cas');
        return this.#readLocked(input.nowMs);
      });
      if ('status' in result) return result;
      this.#remember(result); return freeze({ status: 'committed', ...result, effect: 'none', authorizesEffects: false });
    } catch { this.#poisoned = true; return held('commit-unconfirmed', 'unknown'); }
  }

  #readLocked(nowMs: number): JournalView {
    insist(this.#db.inTransaction() && time(nowMs), 'journal-transaction'); checkSchema(this.#db);
    const all = this.#db.all<StateRow>('SELECT * FROM admission_state'); insist(all.length === 1, 'journal-corrupt');
    const row = all[0]!; insist(row.singleton === 1 && id(row.journal_id) && hash(row.state_hash) && hash(row.head_hash), 'journal-corrupt');
    const size = this.#db.get<{ n: number; bytes: number }>('SELECT count(*) AS n, coalesce(sum(length(CAST(event_json AS BLOB))), 0) AS bytes FROM admission_events');
    insist(size && Number.isSafeInteger(size.n) && size.n > 0 && size.n <= MAX_EVENTS && size.bytes <= MAX_BYTES, 'journal-capacity');
    const events = this.#db.all<EventRow>('SELECT revision, event_hash, event_json FROM admission_events ORDER BY revision');
    insist(events.length === size.n && row.revision === events.length - 1, 'journal-corrupt');
    let state: AdmissionSnapshot | null = null, stateHash: string | null = null, headHash = ZERO, atMs = 0;
    for (let i = 0; i < events.length; i++) {
      const record = events[i]!; const event = parsed(record.event_json) as EventData;
      keys(event, 'format journalId revision atMs previousEventHash beforeStateHash afterStateHash command state');
      insist(event.format === 1 && event.journalId === row.journal_id && event.revision === i && record.revision === i
        && time(event.atMs) && event.atMs >= atMs && event.atMs <= nowMs && event.previousEventHash === headHash
        && event.beforeStateHash === stateHash && hash(event.afterStateHash) && hash(record.event_hash)
        && digest(event) === record.event_hash, 'journal-corrupt');
      if (this.#seen?.revision === i) insist(event.journalId === this.#seen.journalId
        && record.event_hash === this.#seen.headHash && event.afterStateHash === this.#seen.stateHash, 'journal-rollback');
      const next = persisted(event.state, event.atMs);
      insist(next.revision === i && admissionStateHash(next) === event.afterStateHash, 'journal-corrupt');
      if (i === 0) insist(event.command === null && next.pending === null && next.closedRunIds.length === 0, 'journal-corrupt');
      else {
        insist(state !== null && event.command !== null, 'journal-corrupt');
        const proposed = proposeAdmissionTransition({ nowMs: event.atMs, expectedRevision: i - 1,
          snapshot: { ...state, observedAtMs: event.atMs }, command: event.command });
        insist(proposed.status === 'proposed' && proposed.nextStateHash === event.afterStateHash
          && encoded(proposed.next) === encoded(next), 'journal-corrupt');
      }
      state = next; stateHash = event.afterStateHash; headHash = record.event_hash; atMs = event.atMs;
    }
    insist(state !== null && row.state_hash === stateHash && row.head_hash === headHash
      && encoded(state) === row.state_json, 'journal-corrupt');
    const snapshot = requireSnapshot({ ...state, observedAtMs: nowMs }, nowMs);
    const seen = this.#seen;
    if (seen) insist(seen.journalId === row.journal_id && snapshot.revision >= seen.revision
      && (snapshot.revision !== seen.revision || (stateHash === seen.stateHash && headHash === seen.headHash)), 'journal-rollback');
    return { journalId: row.journal_id, snapshot, stateHash: row.state_hash, headHash };
  }
  #remember(view: JournalView): void { this.#seen = { journalId: view.journalId, revision: view.snapshot.revision, stateHash: view.stateHash, headHash: view.headHash }; }
  close(): void { this.#closed = true; this.#db.close(); }
}
