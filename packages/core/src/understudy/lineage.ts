// Lineage-safe groups (DESIGN §7.4): a note plus its alias, duplicate and supersede component, following
// RECEIPT-CONFIRMED edges only (S1c C2): a proposed edge from an MCP save never merges groups or moves a split.
// The split is assigned once by hash(groupKey) mod 10: 0–5 train, 6–8 held-out, 9 audit.
import { sha256Hex } from "../primitives/sha256.ts";
import type { SqlDriver } from "../catalog/driver.ts";

export function computeLineageKey(db: SqlDriver, noteId: string): string {
  const seen = new Set<string>([noteId]);
  const queue = [noteId];
  while (queue.length) {
    const cur = queue.pop()!;
    const rows = db.all<{ src: string; dst: string }>("SELECT src, dst FROM edges WHERE (src = ? OR dst = ?) AND type IN ('duplicate_of','supersedes') AND state = 'confirmed'", [cur, cur]);
    for (const r of rows) for (const n of [r.src, r.dst]) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return `lineage:${[...seen].sort()[0]}`;
}

export type Split = "train" | "heldout" | "audit";
export function splitFor(groupKey: string): Split {
  const bucket = parseInt(sha256Hex(groupKey).slice(0, 8), 16) % 10;
  return bucket <= 5 ? "train" : bucket <= 8 ? "heldout" : "audit";
}
