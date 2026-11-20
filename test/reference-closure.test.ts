import { describe, it, expect } from "vitest";
import { closeEligibility, closeProposal, type ClosureInput, type ClosureNote, type ClosureReference } from "../packages/core/src/focus/reference-closure.ts";
const DAY = 86_400_000, now = 200 * DAY;
const note = (id: string, rest: Partial<ClosureNote> = {}): ClosureNote => ({ id, hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: 0, ...rest });
const edge = (id: string, source: string, target: string, kind: ClosureReference["kind"] = "link"): ClosureReference => ({ id, source, target, kind });
function fixture(extra: Partial<ClosureInput> = {}): ClosureInput {
  return { nowMs: now, complete: true, notes: [note("a"), note("b"), note("c"), note("kept")], references: [], seed: ["a", "b", "c"], linkGuard: "strict", ...extra };
}
describe("pure reference closure, no removal authority", () => {
  it("lets a mutually linked candidate group leave together", () => {
    expect(closeEligibility(fixture({ references: [edge("ab", "a", "b"), edge("ba", "b", "a")] })).eligible).toEqual(["a", "b", "c"]);
  });
  it("cascades kept references to a fixed point independent of order", () => {
    const refs = [edge("ka", "kept", "a"), edge("ab", "a", "b"), edge("bc", "b", "c")];
    const a = closeEligibility(fixture({ references: refs })), b = closeEligibility(fixture({ references: [...refs].reverse(), seed: ["c", "b", "a"] }));
    expect(a.eligible).toEqual([]); expect(a.iterations).toBe(4); expect(b).toEqual(a);
  });
  it.each(["link", "path", "ambiguous", "canvas", "base"] as const)("protects a kept %s target", kind => {
    const result = closeEligibility(fixture({ references: [edge("r", "kept", "a", kind)] }));
    expect(result.eligible).toEqual(["b", "c"]); expect(result.blocked.a).toEqual([{ rule: 7, referenceId: "r" }]);
  });
  it("protects every possible target of an ambiguous reference", () => {
    expect(closeEligibility(fixture({ references: [edge("r1", "kept", "a", "ambiguous"), edge("r2", "kept", "b", "ambiguous")] })).eligible).toEqual(["c"]);
  });
  it("counts unique kept name sources without removing a candidate", () => {
    const result = closeEligibility(fixture({ references: [edge("n1", "kept", "a", "name"), edge("n2", "kept", "a", "name"), edge("n3", "b", "a", "name")] }));
    expect(result.eligible).toEqual(["a", "b", "c"]); expect(result.nameMentionCounts.a).toBe(1);
    expect(closeProposal(fixture({ references: [edge("n", "b", "a", "name")] }), ["a"]).nameMentionCounts.a).toBe(1);
  });
  it("stale-sources releases only ordinary old link sources", () => {
    expect(closeEligibility(fixture({ linkGuard: "stale-sources", references: [edge("r", "kept", "a")] })).eligible).toContain("a");
  });
  it.each([
    { hardPinned: true }, { designated: true }, { approvedGoalMatched: true },
    { newestEditMs: now - 90 * DAY }, { newestEditMs: null }, { newestEditMs: now + DAY },
  ])("stale-sources still protects qualifying source %j", change => {
    expect(closeEligibility(fixture({ linkGuard: "stale-sources", notes: [note("a"), note("b"), note("c"), note("kept", change)], references: [edge("r", "kept", "a")] })).eligible).not.toContain("a");
  });
  it("ripple never acquires the stale-sources exception", () => {
    const result = closeEligibility(fixture({ linkGuard: "stale-sources", references: [edge("r", "kept", "a", "ripple")] }));
    expect(result.eligible).not.toContain("a"); expect(result.blocked.a?.[0]?.rule).toBe(9);
  });
  it("ripple cascades with links, but ignores candidate self and peer references", () => {
    const graph = [edge("self", "a", "a", "ripple"), edge("ab", "a", "b", "ripple"), edge("bc", "b", "c")];
    expect(closeEligibility(fixture({ references: graph })).eligible).toEqual(["a", "b", "c"]);
    expect(closeEligibility(fixture({ references: [...graph, edge("ka", "kept", "a", "ripple")] })).eligible).toEqual([]);
  });
  it.each(["dependency", "instruction"] as const)("%s protection is never excluded with candidate peers", kind => {
    expect(closeEligibility(fixture({ references: [edge("r", "b", "a", kind)] })).blocked.a).toEqual([{ rule: 10, referenceId: "r" }]);
  });
  it("proposal rechecks omitted eligible peers as kept notes", () => {
    const input = fixture({ references: [edge("ab", "a", "b"), edge("ba", "b", "a")] });
    expect(closeProposal(input, ["a", "b"]).eligible).toEqual(["a", "b"]);
    expect(closeProposal(input, ["a"]).eligible).toEqual([]);
  });
  it("new apply-time evidence can shrink an earlier proposal", () => {
    const old = closeProposal(fixture(), ["a", "b", "c"]);
    expect(closeProposal(fixture({ references: [edge("new", "kept", "a"), edge("ab", "a", "b")] }), old.eligible).eligible).toEqual(["c"]);
  });
  it("untrusted learned choices cannot introduce noneligible IDs", () => {
    expect(closeProposal(fixture({ seed: ["a"] }), ["a", "b", "kept", "invented"]).eligible).toEqual(["a"]);
  });
  it.each([
    { complete: false }, { nowMs: Number.NaN }, { nowMs: -1 },
    { notes: [note("a"), note("a")] }, { seed: ["a", "a"] }, { seed: ["unknown"] },
    { notes: [note("a", { hardPinned: true }), note("b"), note("c")] },
    { references: [edge("r", "unknown", "a")] }, { references: [edge("r", "kept", "unknown")] },
    { references: [edge("same", "a", "b"), edge("same", "b", "c")] },
  ])("invalid or incomplete inventory cannot produce candidates %j", change => {
    const result = closeEligibility(fixture(change)); expect(result.coverage).toBe("incomplete"); expect(result.eligible).toEqual([]);
  });
  it.each(["strict", "stale-sources"] as const)("hard-pinned name sources protect under %s", linkGuard => {
    const input = fixture({ linkGuard, notes: [note("a"), note("b"), note("c"), note("kept", { hardPinned: true })], references: [edge("name-pin", "kept", "a", "name")] });
    const result = closeEligibility(input);
    expect(result.eligible).toEqual(["b", "c"]);
    expect(result.blocked.a).toEqual([{ rule: 7, referenceId: "name-pin" }]);
    expect(closeProposal(input, ["a", "b", "c"]).eligible).toEqual(["b", "c"]);
  });
  it.each(["path", "ambiguous", "canvas", "base"] as const)("stale-sources retains ordinary old %s protection", kind => {
    const input = fixture({ linkGuard: "stale-sources", references: [edge("explicit", "kept", "a", kind)] });
    const result = closeEligibility(input);
    expect(result.eligible).toEqual(["b", "c"]);
    expect(result.blocked.a).toEqual([{ rule: 7, referenceId: "explicit" }]);
  });
  it.each(["strict", "stale-sources"] as const)("ordinary name-only sources remain nonblocking under %s", linkGuard => {
    const result = closeEligibility(fixture({ linkGuard, references: [edge("ordinary-name", "kept", "a", "name")] }));
    expect(result.eligible).toEqual(["a", "b", "c"]);
    expect(result.nameMentionCounts.a).toBe(1);
    expect(result.blocked.a).toBeUndefined();
  });
  it("does not mutate caller evidence", () => {
    const input = fixture({ references: [edge("r", "kept", "a")] }), before = JSON.stringify(input);
    closeEligibility(input); closeProposal(input, ["a", "b"]); expect(JSON.stringify(input)).toBe(before);
  });
  it("10,000 generated learned proposals remain within fresh eligibility and close every kept edge", () => {
    let state = 0x71b39c42, nonempty = 0, narrowed = 0, unchanged = 0;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let round = 0; round < 10_000; round++) {
      const ids = ["a", "b", "c", "d", "e", "kept"], seed = ids.slice(0, 5), refs: ClosureReference[] = [];
      const kinds: ClosureReference["kind"][] = ["link", "ripple", "dependency", "instruction", "ambiguous", "name"];
      for (let i = 0; i < 12; i++) refs.push(edge(`r${i}`, ids[random() % ids.length]!, ids[random() % 5]!, kinds[random() % kinds.length]!));
      const input = fixture({ notes: ids.map(id => note(id)), references: refs, seed });
      const fresh = closeEligibility(input), proposed = seed.filter(() => (random() & 1) === 1), result = closeProposal(input, [...proposed, "invented"]);
      if (result.eligible.length) nonempty++;
      if (result.eligible.length < proposed.length) narrowed++;
      if (result.eligible.length === proposed.length) unchanged++;
      const final = new Set(result.eligible), eligible = new Set(fresh.eligible);
      expect(result.eligible.every(id => eligible.has(id) && proposed.includes(id))).toBe(true);
      expect(closeEligibility(input)).toEqual(fresh);
      for (const ref of refs) if (final.has(ref.target) && ref.kind !== "name") {
        expect(ref.kind === "dependency" || ref.kind === "instruction" || !final.has(ref.source)).toBe(false);
      }
    }
    expect(nonempty).toBeGreaterThan(100); expect(narrowed).toBeGreaterThan(100); expect(unchanged).toBeGreaterThan(100);
  });
});
