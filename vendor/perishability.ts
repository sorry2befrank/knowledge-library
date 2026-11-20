/**
 * Reference extraction: source ID legacy-local-triage.
 * Source SHA-256: CB5B20269F81724862CD5C9B1AFB70A76B2568547C06BF67958A223EFB9D1059
 * Symbols: PERISHABLE_MARKERS, SCAN_CHARS, Perishability, perishability.
 * Personal benchmark commentary and IO/ranking wrappers are omitted.
 * This estimates claim density; it does not establish truth, relevance, or removal eligibility.
 * The source carried no license declaration; the owner, who wrote it, approved publishing this exact pack inventory under the repository's MIT license.
 */

const PERISHABLE_MARKERS: Array<[string, RegExp, number]> = [
  ["status-word", /\b(?:DONE|SHIPPED|LIVE|COMPLETE|COMPLETED|GAP|BLOCKED|PENDING|TODO|WIP|STALLED)\b/g, 3],
  ["temporal-claim", /\b(?:not yet|still open|still needs|still pending|no longer|as of|currently|awaiting)\b/gi, 3],
  ["money", /\$[\d,]+(?:\.\d{2})?/g, 2],
  ["counter", /\b\d+\s*\/\s*\d+\b/g, 2],
  ["version", /\bv?\d+\.\d+\.\d+\b/g, 1],
  ["commit-sha", /\b[0-9a-f]{7,40}\b/g, 1],
  ["iso-date", /\b20\d{2}-\d{2}-\d{2}\b/g, 0.5],
];

const SCAN_CHARS = 8000;

export interface Perishability {
  /** Raw marker count in the scanned head. */
  hits: number;
  /** Weighted marker density per 1,000 characters, rounded to two decimal places. */
  per1k: number;
  /** Matching marker classes in declaration order. */
  classes: string[];
}

/** Pure legacy scoring function. No IO, model call, or clock access. */
export function perishability(text: string): Perishability {
  const head = text.slice(0, SCAN_CHARS);
  let hits = 0;
  let weighted = 0;
  const classes: string[] = [];
  for (const [name, pattern, weight] of PERISHABLE_MARKERS) {
    const found = head.match(pattern);
    if (found?.length) {
      hits += found.length;
      weighted += found.length * weight;
      classes.push(name);
    }
  }
  const breadth = classes.length === 0 ? 0 : (classes.length + 1) / (classes.length + 2);
  return {
    hits,
    per1k: Number((((weighted * breadth) / Math.max(head.length, 1)) * 1000).toFixed(2)),
    classes,
  };
}
