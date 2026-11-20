// Data-only helpers. No receipt verification, journal acknowledgement or filesystem authority.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../primitives/canonical.ts';

export const DAY = 86_400_000;
export function insist(value: unknown, code = 'input-invalid'): asserts value { if (!value) throw new Error(code); }
export const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
export const hash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
export const count = (x: unknown, max = Number.MAX_SAFE_INTEGER): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= max;
export const time = (x: unknown): x is number => count(x, 253402300799999);
export const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e12;
export function keys(x: object, expected: string): void {
  insist(x && typeof x === 'object' && !Array.isArray(x));
  insist(Object.keys(x).sort().join(',') === expected.split(' ').sort().join(','));
}
export function uniqueIds(xs: readonly string[], max = 10000): void {
  insist(Array.isArray(xs) && xs.length <= max && xs.every(id) && new Set(xs).size === xs.length);
}
/** Reject ambiguous/non-JSON inputs before hashing; bounded traversal also rejects cycles. */
export function dataCopy<T>(input: T): T {
  let remaining = 1_000_000;
  function copy(x: unknown, depth: number): unknown {
    insist(--remaining >= 0 && depth <= 24, 'workload-limit');
    if (x === null || typeof x === 'boolean') return x;
    if (typeof x === 'number') { insist(Number.isFinite(x)); return x; }
    if (typeof x === 'string') { insist(x.length <= 8192); return x; }
    insist(typeof x === 'object' && x !== null);
    if (Array.isArray(x)) { insist(x.length <= 100000, 'workload-limit'); return x.map(v => copy(v, depth + 1)); }
    insist(Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
    const entries = Object.entries(x); insist(entries.length <= 100000, 'workload-limit');
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of entries) {
      insist(k.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(k));
      out[k] = copy(v, depth + 1);
    }
    return out;
  }
  return copy(input, 0) as T;
}
export function freeze<T>(x: T): T {
  if (x && typeof x === 'object') { for (const v of Object.values(x)) freeze(v); Object.freeze(x); }
  return x;
}
export const digest = (x: unknown): string => createHash('sha256').update(canonicalJson(x)).digest('hex');
export function errorCode(error: unknown): string {
  return error instanceof Error && ['workload-limit', 'history-invalid', 'timezone-unproven', 'pilot-unproven', 'ripple-unproven', 'review-invalid', 'plan-held', 'pending-quiet', 'revision-conflict', 'quiet-unproven', 'run-reused'].includes(error.message)
    ? error.message : 'input-invalid';
}
