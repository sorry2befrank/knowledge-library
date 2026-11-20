import { describe, it, expect } from "vitest";
import { generateFixtures, fixtureDigest, DEFAULT_SEED } from "../fixtures/gen.ts";

// Pinned so any change to the generator is a deliberate, visible change.
export const PINNED_DIGEST = "795d6c728aa83b816697286df62b2c677734cd74047d26d0dd1661b26d67ec5d";

describe("fixtures/gen.ts", () => {
  it("regenerates byte-identical from the seed (hash before and after)", () => {
    const a = generateFixtures(DEFAULT_SEED), b = generateFixtures(DEFAULT_SEED);
    expect(fixtureDigest(a)).toBe(fixtureDigest(b));
    expect(fixtureDigest(a)).toBe(PINNED_DIGEST);
    expect(fixtureDigest(generateFixtures("another-seed"))).not.toBe(PINNED_DIGEST);
  });
  it("covers every category the work order lists", () => {
    const fx = generateFixtures();
    expect(fx.notes.length).toBe(600);
    const has = (pred: (n: (typeof fx.notes)[number]) => boolean) => fx.notes.some(pred);
    expect(fx.notes.filter((n) => n.kind === "decision").length).toBeGreaterThanOrEqual(60);
    expect(fx.notes.filter((n) => n.kind === "implementation").length).toBeGreaterThanOrEqual(60);
    expect(has((n) => n.kind === "turnover")).toBe(true);
    expect(has((n) => !!n.flags.duplicateOf)).toBe(true);
    expect(has((n) => !!n.flags.nearDuplicateOf)).toBe(true);
    expect(fx.notes.filter((n) => n.flags.supersedes).length).toBeGreaterThanOrEqual(8);
    expect(has((n) => n.links.length > 2)).toBe(true);
    expect(has((n) => n.pathMentions.length > 0)).toBe(true);
    expect(fx.orreryTree.length).toBeGreaterThan(0);
    expect(has((n) => !!n.flags.personaHome)).toBe(true);
    expect(has((n) => !!n.flags.ledger)).toBe(true);
    expect(has((n) => !!n.flags.clientLookalike)).toBe(true);
    expect(has((n) => !!n.flags.founders)).toBe(true);
    expect(has((n) => !!n.flags.studentLookalike)).toBe(true);
    expect(fx.notes.filter((n) => n.flags.credentialLookalike).length).toBe(10);
    expect(fx.notes.filter((n) => n.flags.injection).length).toBe(8);
    expect(fx.injectionGoals.length).toBe(3);
    expect(has((n) => !!n.flags.ghost)).toBe(true);
    expect(has((n) => !!n.flags.recreated)).toBe(true);
    expect(has((n) => n.tracked)).toBe(true);
    expect(fx.codeFiles.some((f) => f.path.endsWith(".git"))).toBe(true);
    expect(fx.weeks.length).toBe(6);
    expect(fx.weeks.every((w) => w.signals.some((s) => s.headless) && w.signals.some((s) => s.selfReferential))).toBe(true);
    expect(fx.goldenQueries.filter((g) => g.vocabularyMismatch).length).toBeGreaterThanOrEqual(5);
  });
  it("contains no real-looking identities: all emails and URLs use .invalid", () => {
    const fx = generateFixtures();
    const text = JSON.stringify(fx);
    for (const m of text.matchAll(/https?:\/\/([^\s/"\\]+)/g)) expect(m[1]).toMatch(/\.invalid$/);
    for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) if (!m[0].startsWith("kl:")) expect(m[1]).toMatch(/\.invalid$/);
  });
});
