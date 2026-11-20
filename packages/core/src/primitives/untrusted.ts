import { hex } from "./sha256.ts";

/** 8-hex nonce per response. */
export function responseNonce(randomBytes: (n: number) => Uint8Array): string {
  return hex(randomBytes(4));
}

/**
 * Wrap note-derived text as untrusted. Any "untrusted-note" inside the content is escaped so
 * the content cannot close or forge the wrapper. Hygiene, not a security boundary (DESIGN §4.5).
 */
export function wrapUntrusted(text: string, cite: string, nonce: string): string {
  const escaped = text.replace(/untrusted-note/gi, (m) => m.replace(/-/, "&#45;"));
  return `<untrusted-note-${nonce} cite="${cite.replace(/"/g, "&quot;")}">${escaped}</untrusted-note-${nonce}>`;
}
