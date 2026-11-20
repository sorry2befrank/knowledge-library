// Bearer tokens for S1 (DESIGN §9.3). Format: klb_ + 43 base64url chars + a CRC32 suffix (6 base64url
// chars), so scanners recognise them. Stored server-side as SHA-256 and compared in constant time.
import { sha256Hex } from "../primitives/sha256.ts";
import { crc32 } from "../primitives/crc32.ts";
import { toBase64Url } from "../primitives/base64url.ts";
import type { RandomBytes } from "../primitives/ids.ts";
import type { SqlDriver } from "../catalog/driver.ts";
import type { ClientClass } from "../catalog/acl.ts";

export const TOKEN_KINDS = {
  "kl-device": { scopes: ["ingest", "focus-exec", "pull", "request-approval"], ttlDays: 90, clientClass: "kl-device" as ClientClass },
  "cc-bearer": { scopes: ["read"], optionalScopes: ["save"], ttlDays: 30, clientClass: "claude-code" as ClientClass },
  "cx-bearer": { scopes: ["read"], optionalScopes: ["save"], ttlDays: 30, clientClass: "codex" as ClientClass },
} as const;
/** Each bearer token is issued for exactly one client class, stamped at issue. */
export function clientClassFor(kind: TokenKind): ClientClass { return TOKEN_KINDS[kind].clientClass; }
export type TokenKind = keyof typeof TOKEN_KINDS;

const enc = new TextEncoder();
const TOKEN_RE = /^klb_([A-Za-z0-9_-]{43})([A-Za-z0-9_-]{6})$/;

function crcSuffix(body: string): string {
  const c = crc32(enc.encode(body));
  return toBase64Url(new Uint8Array([(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]));
}

export function mintToken(random: RandomBytes): { token: string; hash: string } {
  const body = toBase64Url(random(32)).slice(0, 43);
  const token = `klb_${body}${crcSuffix(body)}`;
  return { token, hash: sha256Hex(token) };
}

export type TokenParse = { ok: true; hash: string } | { ok: false; reason: "format" | "crc" };
export function parseToken(presented: string): TokenParse {
  const m = TOKEN_RE.exec(presented);
  if (!m) return { ok: false, reason: "format" };
  if (!constantTimeEqual(crcSuffix(m[1]!), m[2]!)) return { ok: false, reason: "crc" };
  return { ok: true, hash: sha256Hex(presented) };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export type AuthResult =
  | { ok: true; principal: string; scopes: string[]; clientClass: ClientClass; tokenKind: TokenKind; tokenHash: string; collectionIds?: string[] }
  | { ok: false; reason: "format" | "crc" | "unknown" | "revoked" | "expired" | "principal-revoked" | "enrollment-pending" };

/** Authenticate a presented bearer token. principals.status is checked on every request. */
export function authenticate(db: SqlDriver, presented: string, nowIso: string): AuthResult {
  if (db.get("SELECT 1 FROM meta WHERE key='recovery_state'")) return {ok:false,reason:'enrollment-pending'};
  const enrollment = db.get<{ value: string }>("SELECT value FROM meta WHERE key='enrollment_state'")?.value;
  if (enrollment !== undefined && enrollment !== "active") return { ok: false, reason: "enrollment-pending" };
  const p = parseToken(presented);
  if (!p.ok) return p;
  const row = db.get<{ hash: string; principal: string; kind: TokenKind; scopes: string; client_class: ClientClass; expiresAt: string; revokedAt: string | null; status: string; collection_ids: string | null }>(
    "SELECT t.hash, t.principal, t.kind, t.scopes, t.client_class, t.expiresAt, t.revokedAt, t.collection_ids, p.status FROM tokens t JOIN principals p ON p.id = t.principal WHERE t.hash = ?", [p.hash]);
  if (!row || !constantTimeEqual(row.hash, p.hash)) return { ok: false, reason: "unknown" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (!Number.isFinite(Date.parse(row.expiresAt)) || row.expiresAt <= nowIso) return { ok: false, reason: "expired" };
  if (row.status !== "active") return { ok: false, reason: "principal-revoked" };
  let collectionIds: string[] | undefined;
  if (row.collection_ids !== null) {
    try { const ids: unknown = JSON.parse(row.collection_ids); if (!validCollectionIds(ids)) return { ok: false, reason: "unknown" }; collectionIds = ids; }
    catch { return { ok: false, reason: "unknown" }; }
  }
  return { ok: true, principal: row.principal, scopes: JSON.parse(row.scopes) as string[], clientClass: row.client_class, tokenKind: row.kind, tokenHash: row.hash, ...(collectionIds === undefined ? {} : { collectionIds }) };
}

export function validCollectionIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id)) && new Set(value).size === value.length;
}

export function tokenExpiry(kind: TokenKind, nowIso: string): string {
  return new Date(Date.parse(nowIso) + TOKEN_KINDS[kind].ttlDays * 86400000).toISOString();
}

export function tokenScopes(kind: TokenKind, requested: string[] = []): string[] {
  const def = TOKEN_KINDS[kind];
  const optional = "optionalScopes" in def ? (def.optionalScopes as readonly string[]) : [];
  return [...def.scopes, ...requested.filter((s) => optional.includes(s))];
}

/** Scope needed for each API capability. */
export const SCOPE_FOR = { save: ["save", "ingest"], read: ["read", "pull", "ingest"], search: ["read", "pull", "ingest"], feedback: ["read", "ingest"], status: ["read", "pull", "ingest"], rename: ["ingest"] } as const;
export function hasScope(scopes: string[], need: readonly string[]): boolean { return need.some((s) => scopes.includes(s)); }

/** Simple fixed-window rate limiter: 60 requests per minute per principal. */
export class RateLimiter {
  private readonly windows = new Map<string, { minute: number; count: number }>();
  private readonly limit: number;
  constructor(limit = 60) { this.limit = limit; }
  allow(principal: string, nowMs: number): boolean {
    const minute = Math.floor(nowMs / 60000);
    const w = this.windows.get(principal);
    if (!w || w.minute !== minute) { this.windows.set(principal, { minute, count: 1 }); return true; }
    w.count++;
    return w.count <= this.limit;
  }
}
