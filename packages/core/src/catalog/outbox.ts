// Durable outbox (DESIGN §3.8). Every external effect implied by apply() is a row here with an
// idempotency key. Steps are idempotent and reconciled, so a crash after any step converges on the next
// run. No step is ever lost: a failing row stays pending with exponential backoff and counts as a hard
// alarm once it has failed repeatedly. Crash injection is built in for the fixture matrix.
import type { SqlDriver } from "./driver.ts";
import type { BlobWriter, ObjectStore } from "./blobs.ts";
import { getValue } from "./ledger.ts";
import { indexVersion } from "./search-index.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import { sha256Hex } from "../primitives/sha256.ts";
import type { Op } from "./ops.ts";

export interface OutboxRow { id: number; opId: string; step: string; target: string; idempotencyKey: string; state: string; attempts: number; lastError: string | null; nextAttemptAt: string | null }

export interface OutboxDeps { db: SqlDriver; blobs: BlobWriter; mirror: ObjectStore; now(): string; applySystem(op: Op): unknown }

export class InjectedCrash extends Error { constructor(step: string) { super(`injected crash after effect: ${step}`); } }

export const HARD_ALARM_ATTEMPTS = 5;
export const STEP_KINDS = ["custody.verify", "index.version", "mirror.meta", "evidence.publish", "authz.checkpoint", "enrollment.checkpoint"] as const;

export interface DispatchOptions { limit?: number; crashAfterEffect?: (row: OutboxRow, nth: number) => boolean; only?: number; ignoreBackoff?: boolean }
export interface DispatchReport { ran: number; done: number; retried: number; crashed: boolean }

export async function performStep(deps: OutboxDeps, row: OutboxRow): Promise<void> {
  const { db } = deps;
  const [noteId, verS] = row.target.split("@"); const ver = Number(verS);
  switch (row.step) {
    case "enrollment.checkpoint": {
      const seq = Number(row.target);
      const ev = db.get<{seq:number;ts:string;kind:string;principal:string;payload:string;epoch:number}>("SELECT * FROM authz_events WHERE seq=? AND kind='enrollment.initialize'", [seq]);
      if (!ev) throw new Error('enrollment-checkpoint-missing');
      const hash = db.get<{value:string}>("SELECT value FROM meta WHERE key='enrollment_hash'")?.value;
      if (!hash || JSON.parse(ev.payload).enrollmentHash !== hash) throw new Error('enrollment-checkpoint-mismatch');
      const bytes = new TextEncoder().encode(canonicalJson({...ev,minPolicyEpoch:ev.epoch}));
      const key = `authz/${String(seq).padStart(12,"0")}.json`;
      await deps.mirror.put(key, bytes, {onlyIfAbsent:true});
      const actual = await deps.mirror.get(key);
      if (!actual || sha256Hex(actual) !== sha256Hex(bytes)) throw new Error('enrollment-checkpoint-readback-failed');
      deps.applySystem({kind:"enrollment.activate",hash,authzSeq:seq});
      return;
    }
    case "custody.verify": {
      // Post-commit check: the object is present and its bytes hash to the stored SHA-256; then received → verified through apply().
      const v = db.get<{ sha256: string; custody: string }>("SELECT sha256, custody FROM versions WHERE noteId = ? AND ver = ?", [noteId!, ver]);
      if (!v) throw new Error(`custody.verify: ${row.target} not found`);
      if (v.custody !== "received") return; // already promoted (deduped retry, crash after the apply)
      const bytes = await deps.blobs.get(v.sha256);
      if (!bytes) throw new Error(`unavailable-storage: ${v.sha256}`);
      if (sha256Hex(bytes) !== v.sha256) throw new Error(`corrupt-object: ${v.sha256}`);
      const ref = db.get<{ state: string; refcount: number }>("SELECT state, refcount FROM blob_refs WHERE sha256 = ?", [v.sha256]);
      if (!ref || ref.state !== "live" || ref.refcount < 1) throw new Error(`blob row not live: ${v.sha256}`);
      deps.applySystem({ kind: "version.custody", noteId: noteId!, ver, custody: "verified", reason: "post-commit-check-passed" });
      return;
    }
    case "index.version": {
      const v = db.get<{ sha256: string; custody: string; privacy_class: string; title_h: string | null; path_h: string | null }>(
        "SELECT v.sha256, v.custody, v.privacy_class, n.title_h, (SELECT path_h FROM aliases a WHERE a.noteId = n.noteId AND a.valid_to IS NULL ORDER BY a.id DESC LIMIT 1) AS path_h FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE v.noteId = ? AND v.ver = ?", [noteId!, ver]);
      if (!v) throw new Error(`index.version: ${row.target} not found`);
      if (v.custody === "received") throw new Error("not-verified-yet"); // the indexer promotes only from verified; retried after custody.verify
      if (v.custody === "indexed") return;
      const bytes = await deps.blobs.get(v.sha256);
      if (!bytes) throw new Error(`unavailable-storage: ${v.sha256}`);
      // Custody was checked at commit, but these are a fresh read's bytes. Never
      // publish search text that no longer matches the immutable version digest.
      if (sha256Hex(bytes) !== v.sha256) throw new Error(`corrupt-object: ${v.sha256}`);
      indexVersion(db, noteId!, ver, v.privacy_class, new TextDecoder().decode(bytes), getValue(db, v.path_h) ?? "", getValue(db, v.title_h) ?? noteId!);
      deps.applySystem({ kind: "version.custody", noteId: noteId!, ver, custody: "indexed", reason: "indexed" });
      return;
    }
    case "mirror.meta": {
      const v = db.get<Record<string, unknown>>("SELECT noteId, ver, parentVer, sha256, bytes, privacy_class, role, vstatus, capturedAt, publishedAt FROM versions WHERE noteId = ? AND ver = ?", [noteId!, ver]);
      if (!v) throw new Error(`mirror.meta: ${row.target} not found`);
      const alias = db.get<{ path_h: string }>("SELECT path_h FROM aliases WHERE noteId = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1", [noteId!]);
      const key = `m/${noteId}@${ver}.json`;
      const existing = await deps.mirror.get(key);
      if (existing && row.idempotencyKey === `mirror:${row.target}`) return; // a rename or a promotion rewrites the mirror; a plain re-run leaves it alone
      await deps.mirror.put(key, new TextEncoder().encode(canonicalJson({ ...v, path_h: alias?.path_h ?? null, mirroredAt: deps.now() })));
      return;
    }
    case "evidence.publish": {
      const seq = Number(row.target);
      const snap = db.get<{ body: string; snapshotId: string; digest: string; sig: string; keyId: string }>("SELECT body, snapshotId, digest, sig, keyId FROM evidence_snapshots WHERE sequence = ?", [seq]);
      if (!snap) throw new Error(`evidence.publish: ${seq} not found`);
      // Signed wrapper: the signed bytes travel verbatim; digest is SHA-256 of exactly those bytes.
      const wrapper = JSON.stringify({ schemaVersion: "library-evidence-signed/v1", envelopeBytes: snap.body, digest: snap.digest, sig: snap.sig, keyId: snap.keyId });
      await deps.mirror.put(`outbox/orrery/${String(seq).padStart(12, "0")}-${snap.snapshotId}.json`, new TextEncoder().encode(wrapper), { onlyIfAbsent: true });
      return;
    }
    case "authz.checkpoint": {
      const seq = Number(row.target);
      const ev = db.get<{ seq: number; ts: string; kind: string; principal: string | null; payload: string; epoch: number }>("SELECT * FROM authz_events WHERE seq = ?", [seq]);
      if (!ev) throw new Error(`authz.checkpoint: ${seq} not found`);
      const key = `authz/${String(seq).padStart(12, "0")}.json`;
      const bytes = new TextEncoder().encode(canonicalJson({ ...ev, minPolicyEpoch: ev.epoch }));
      await deps.mirror.put(key, bytes, { onlyIfAbsent: true });
      const actual = await deps.mirror.get(key);
      if (!actual || sha256Hex(actual) !== sha256Hex(bytes)) throw new Error('authz-checkpoint-readback-failed');
      return;
    }
    default: throw new Error(`unknown outbox step ${row.step}`);
  }
}

export function backoffSeconds(attempts: number): number { return Math.min(3600, 2 ** Math.min(attempts, 12)); }

export async function dispatchOutbox(deps: OutboxDeps, opts: DispatchOptions = {}): Promise<DispatchReport> {
  const { db } = deps;
  const now = deps.now();
  const rows = opts.only !== undefined
    ? db.all<OutboxRow>("SELECT * FROM outbox WHERE state = 'pending' AND id = ?", [opts.only])
    : db.all<OutboxRow>(`SELECT * FROM outbox WHERE state = 'pending' ${opts.ignoreBackoff ? "" : "AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)"} ORDER BY id LIMIT ?`, opts.ignoreBackoff ? [opts.limit ?? 10000] : [now, opts.limit ?? 10000]);
  const report: DispatchReport = { ran: 0, done: 0, retried: 0, crashed: false };
  let nth = 0;
  for (const row of rows) {
    nth++; report.ran++;
    db.run("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", [row.id]);
    try {
      await performStep(deps, row);
      if (opts.crashAfterEffect?.(row, nth)) { report.crashed = true; throw new InjectedCrash(row.step); }
      db.run("UPDATE outbox SET state = 'done', completedAt = ?, lastError = NULL, nextAttemptAt = NULL WHERE id = ?", [deps.now(), row.id]);
      report.done++;
    } catch (e) {
      if (e instanceof InjectedCrash) return report; // the process died: completion was never recorded
      // Never terminal: stay pending with backoff. Repeated failure is a hard alarm, not a lost step.
      const next = new Date(Date.parse(deps.now()) + backoffSeconds(row.attempts + 1) * 1000).toISOString();
      db.run("UPDATE outbox SET lastError = ?, nextAttemptAt = ? WHERE id = ?", [(e as Error).message.slice(0, 200), next, row.id]);
      report.retried++;
    }
  }
  return report;
}

export function outboxSummary(db: SqlDriver): { pending: number; done: number; hardAlarms: number } {
  const pending = db.get<{ c: number }>("SELECT count(*) AS c FROM outbox WHERE state = 'pending'")!.c;
  const done = db.get<{ c: number }>("SELECT count(*) AS c FROM outbox WHERE state = 'done'")!.c;
  const hardAlarms = db.get<{ c: number }>("SELECT count(*) AS c FROM outbox WHERE state = 'pending' AND attempts >= ?", [HARD_ALARM_ATTEMPTS])!.c;
  return { pending, done, hardAlarms };
}
