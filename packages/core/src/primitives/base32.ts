// Crockford base32 (no I, L, O, U). noteId = 10 chars = 50 random bits.
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const NOTE_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export function encodeCrockford(bytes: Uint8Array, chars: number): string {
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < chars) { out += CROCKFORD[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= chars) break;
  }
  while (out.length < chars) { out += CROCKFORD[(acc << (5 - bits)) & 31]; bits = 0; }
  return out;
}

/** Mint a noteId from a source of random bytes (crypto in production, seeded RNG in fixtures). */
export function mintNoteId(randomBytes: (n: number) => Uint8Array): string {
  return encodeCrockford(randomBytes(7), 10);
}

export function isNoteId(s: unknown): s is string {
  return typeof s === "string" && NOTE_ID.test(s);
}
