// Content-free, hash-chained event ledger. Payloads hold only ids, ints, enums and 64-hex hashes;
// assertContentFree() is the runtime lint. Text (titles, paths, reasons) lives in values_(hash, text).
import { sha256Hex, HEX64 } from "../primitives/sha256.ts";
import { NOTE_ID } from "../primitives/base32.ts";
import { canonicalJson } from "../primitives/canonical.ts";
import type { SqlDriver } from "./driver.ts";

const ID32 = /^[0-9a-f]{32}$/;
const SHORT_ID = /^[A-Za-z][A-Za-z0-9:._@-]{0,47}$/; // ids and enums: no whitespace, bounded
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export class ContentInPayloadError extends Error {
  constructor(path: string) { super(`ledger payload must be content-free; offending field: ${path}`); }
}

export function assertContentFree(payload: unknown, path = "payload"): void {
  if (payload === null || typeof payload === "boolean") return;
  if (typeof payload === "number") { if (!Number.isInteger(payload)) throw new ContentInPayloadError(path); return; }
  if (typeof payload === "string") {
    if (NOTE_ID.test(payload) || HEX64.test(payload) || ID32.test(payload) || SHORT_ID.test(payload) || ISO.test(payload)) return;
    throw new ContentInPayloadError(path);
  }
  if (Array.isArray(payload)) { payload.forEach((v, i) => assertContentFree(v, `${path}[${i}]`)); return; }
  if (typeof payload === "object") { for (const [k, v] of Object.entries(payload as Record<string, unknown>)) { if (!SHORT_ID.test(k)) throw new ContentInPayloadError(`${path}.${k}`); assertContentFree(v, `${path}.${k}`); } return; }
  throw new ContentInPayloadError(path);
}

export interface EventRow { seq: number; ts: string; principal: string; client: string; kind: string; payload: string; prev_hash: string; hash: string }

export const GENESIS = "0".repeat(64);

export function eventHash(e: Omit<EventRow, "hash">): string {
  return sha256Hex(canonicalJson({ seq: e.seq, ts: e.ts, principal: e.principal, client: e.client, kind: e.kind, payload: JSON.parse(e.payload), prev_hash: e.prev_hash }));
}

/** Append one event inside the caller's transaction. Returns seq and hash. */
export function appendEvent(db: SqlDriver, e: { ts: string; principal: string; client: string; kind: string; payload: Record<string, unknown> }): { seq: number; hash: string } {
  if (!db.inTransaction()) throw new Error("appendEvent must run inside apply()'s transaction");
  assertContentFree(e.payload);
  const head = db.get<{ seq: number; hash: string }>("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1");
  const seq = (head?.seq ?? 0) + 1;
  const prev_hash = head?.hash ?? GENESIS;
  const payload = canonicalJson(e.payload);
  const hash = eventHash({ seq, ts: e.ts, principal: e.principal, client: e.client, kind: e.kind, payload, prev_hash });
  db.run("INSERT INTO events(seq, ts, principal, client, kind, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)", [seq, e.ts, e.principal, e.client, e.kind, payload, prev_hash, hash]);
  return { seq, hash };
}

export function ledgerHead(db: SqlDriver): { seq: number; hash: string } {
  return db.get<{ seq: number; hash: string }>("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1") ?? { seq: 0, hash: GENESIS };
}

/** Recompute the chain and report the first broken link, if any. */
export function verifyChain(db: SqlDriver): { ok: true; seq: number } | { ok: false; brokenAt: number } {
  let prev = GENESIS, last = 0;
  for (const e of db.all<EventRow>("SELECT * FROM events ORDER BY seq")) {
    if (e.prev_hash !== prev || eventHash(e) !== e.hash) return { ok: false, brokenAt: e.seq };
    try { assertContentFree(JSON.parse(e.payload)); } catch { return { ok: false, brokenAt: e.seq }; }
    prev = e.hash; last = e.seq;
  }
  return { ok: true, seq: last };
}

/** Store text by hash (purgeable values table). Returns the 64-hex key used in payloads. */
export function putValue(db: SqlDriver, text: string): string {
  if (!db.inTransaction()) throw new Error("putValue must run inside apply()'s transaction");
  const h = sha256Hex(text);
  db.run("INSERT OR IGNORE INTO values_(hash, text) VALUES (?,?)", [h, text]);
  return h;
}
export function getValue(db: SqlDriver, hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  return db.get<{ text: string }>("SELECT text FROM values_ WHERE hash = ?", [hash])?.text;
}
