const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < 64; i++) LOOKUP[ALPHABET[i]!] = i;

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i]! << 16) | ((rem > 1 ? bytes[i + 1]! : 0) << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (rem > 1) out += ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const ch of s) {
    const v = LOOKUP[ch];
    if (v === undefined) throw new Error("invalid base64url");
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}
