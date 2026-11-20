// Seeded deterministic PRNG (xoshiro128**). Same seed, same stream, on every platform.
export interface Rng {
  next(): number;              // uint32
  float(): number;             // [0,1)
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  bytes(n: number): Uint8Array;
  chance(p: number): boolean;
  shuffle<T>(arr: T[]): T[];
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function seededRng(seed: number | string): Rng {
  let seedNum = 0;
  if (typeof seed === "string") { for (const ch of seed) seedNum = (Math.imul(seedNum, 31) + ch.charCodeAt(0)) >>> 0; }
  else seedNum = seed >>> 0;
  const sm = splitmix32(seedNum);
  let a = sm(), b = sm(), c = sm(), d = sm();
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  const next = (): number => {
    const result = (Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9)) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return result;
  };
  const rng: Rng = {
    next,
    float: () => next() / 0x100000000,
    int: (m) => (m <= 0 ? 0 : Math.floor(rng.float() * m)),
    pick: (arr) => arr[rng.int(arr.length)]!,
    bytes: (n) => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = next() & 0xff; return out; },
    chance: (p) => rng.float() < p,
    shuffle: (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = rng.int(i + 1); const t = arr[i]!; arr[i] = arr[j]!; arr[j] = t; } return arr; },
  };
  return rng;
}

export function cryptoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
