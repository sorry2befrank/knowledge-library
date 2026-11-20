// Pure DESIGN 6.4 closure only. Inputs come from a complete trusted inventory and
// the other kernel rules, never a model or request body. This grants no custody
// or removal authority and performs no file, provider or network operations.
export interface ClosureNote {
  id: string;
  hardPinned: boolean;
  designated: boolean;
  approvedGoalMatched: boolean;
  newestEditMs: number | null;
}
export type ReferenceKind = "link" | "path" | "ambiguous" | "canvas" | "base" | "name" | "ripple" | "dependency" | "instruction";
export interface ClosureReference {
  // The inventory expands an ambiguous reference into every possible target.
  // Local opaque IDs only; reports must not disclose unpushed source paths.
  id: string;
  source: string;
  target: string;
  kind: ReferenceKind;
}
export interface ClosureInput {
  nowMs: number;
  complete: boolean;
  notes: readonly ClosureNote[];
  references: readonly ClosureReference[];
  // Only files that pass the remaining kernel rules, including goal approval,
  // recency, identity, ownership, sweep holds, custody and active reservations.
  seed: readonly string[];
  linkGuard: "strict" | "stale-sources";
}
export type ClosureBlock = { rule: 7 | 9 | 10; referenceId: string };
export interface ClosureResult {
  eligible: string[];
  blocked: Record<string, ClosureBlock[]>;
  nameMentionCounts: Record<string, number>;
  coverage: "complete" | "incomplete";
  iterations: number;
}
const DAY = 86_400_000;
const kinds = new Set<string>(["link", "path", "ambiguous", "canvas", "base", "name", "ripple", "dependency", "instruction"]);
const direct = new Set<ReferenceKind>(["link", "path", "ambiguous", "canvas", "base"]);
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function sorted(values: Iterable<string>): string[] { return [...values].sort(); }
function emptyIncomplete(): ClosureResult {
  return { eligible: [], blocked: Object.create(null), nameMentionCounts: Object.create(null), coverage: "incomplete", iterations: 0 };
}
function checked(input: ClosureInput): Map<string, ClosureNote> | null {
  if (input.complete !== true || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !["strict", "stale-sources"].includes(input.linkGuard)) return null;
  const notes = new Map<string, ClosureNote>();
  for (const note of input.notes) {
    if (!validId(note.id) || notes.has(note.id)
      || typeof note.hardPinned !== "boolean" || typeof note.designated !== "boolean"
      || typeof note.approvedGoalMatched !== "boolean"
      || (note.newestEditMs !== null && (!Number.isSafeInteger(note.newestEditMs) || note.newestEditMs < 0))) return null;
    notes.set(note.id, note);
  }
  if (new Set(input.seed).size !== input.seed.length || input.seed.some(id => !notes.has(id) || notes.get(id)!.hardPinned)) return null;
  const refs = new Set<string>();
  for (const ref of input.references) {
    if (!validId(ref.id) || refs.has(ref.id) || !notes.has(ref.source) || !notes.has(ref.target) || !kinds.has(ref.kind)) return null;
    refs.add(ref.id);
  }
  return notes;
}
function protectiveSource(note: ClosureNote, input: ClosureInput): boolean {
  // Unknown or future edit times protect rather than acquiring stale status.
  return input.linkGuard === "strict" || note.hardPinned || note.designated || note.approvedGoalMatched
    || note.newestEditMs === null || input.nowMs - note.newestEditMs <= 90 * DAY;
}
function compute(input: ClosureInput, starting: readonly string[]): ClosureResult {
  const notes = checked(input);
  if (!notes || new Set(starting).size !== starting.length || starting.some(id => !input.seed.includes(id))) return emptyIncomplete();
  const pool = new Set(starting), blocked: Record<string, ClosureBlock[]> = Object.create(null);
  let iterations = 0;
  // Simultaneous removal makes reasons independent of input order. Each changing
  // round removes a member, so at most seed.length + 1 rounds are possible.
  for (;;) {
    iterations++;
    const drops = new Map<string, ClosureBlock[]>();
    for (const ref of input.references) {
      if (!pool.has(ref.target)) continue;
      let rule: 7 | 9 | 10 | null = null;
      if (ref.kind === "dependency" || ref.kind === "instruction") rule = 10;
      else if (!pool.has(ref.source) && ref.kind === "ripple") rule = 9;
      // Hard-pinned sources protect even name-only references under either guard.
      else if (!pool.has(ref.source) && ref.kind === "name" && notes.get(ref.source)!.hardPinned) rule = 7;
      // Only a resolved ordinary link may use the stale-source discount.
      // Explicit paths and unresolved/structured references remain protective.
      else if (!pool.has(ref.source) && direct.has(ref.kind)
        && (ref.kind !== "link" || protectiveSource(notes.get(ref.source)!, input))) rule = 7;
      if (rule !== null) drops.set(ref.target, [...(drops.get(ref.target) ?? []), { rule, referenceId: ref.id }]);
    }
    if (!drops.size) break;
    for (const [id, reasons] of drops) {
      pool.delete(id);
      blocked[id] = reasons.sort((a, b) => a.rule - b.rule || (a.referenceId < b.referenceId ? -1 : a.referenceId > b.referenceId ? 1 : 0));
    }
  }
  const nameMentionCounts: Record<string, number> = Object.create(null);
  for (const id of sorted(pool)) {
    // One kept source may mention a name repeatedly; the reason counts sources.
    nameMentionCounts[id] = new Set(input.references.filter(r => r.kind === "name" && r.target === id && !pool.has(r.source)).map(r => r.source)).size;
  }
  return { eligible: sorted(pool), blocked, nameMentionCounts, coverage: "complete", iterations };
}
export function closeEligibility(input: ClosureInput): ClosureResult { return compute(input, input.seed); }
export function closeProposal(input: ClosureInput, proposed: readonly string[]): ClosureResult {
  // Recompute E from current evidence. Learned or stale proposals can only narrow
  // it, and members of E omitted by P become kept notes during the second closure.
  const fresh = closeEligibility(input);
  if (fresh.coverage !== "complete" || new Set(proposed).size !== proposed.length || proposed.some(id => !validId(id))) return emptyIncomplete();
  const eligible = new Set(fresh.eligible);
  return compute(input, proposed.filter(id => eligible.has(id)));
}
