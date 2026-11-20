const enc = new TextEncoder();
/** Deterministic token estimate: ceil(utf8Bytes / 3.6). It is an estimate, not a count. */
export function estimateTokens(text: string): number {
  return Math.ceil(enc.encode(text).length / 3.6);
}
