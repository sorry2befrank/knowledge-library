import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liveSourceCorrections, normalizeCorrectionTopic, correctionFromAuthenticatedActor, foldCorrectionLedger, projectCorrections, type CorrectionRow } from "../packages/core/src/understudy/reference-corrections.ts";
import { parseFourFields, renderReferenceReport } from "../packages/core/src/understudy/reference-reports.ts";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/reference/learning.cases.json", import.meta.url), "utf8"));
const row = (x: any): CorrectionRow => ({ client: "fixture-device", scope: "fixture-scope", state: "proposed", ts: "2030-01-01", ...x });
const select = (kind: string) => fixture.cases.filter((c: any) => c.kind === kind);
for (const c of select("source-correction-fold")) it(`source correction: ${c.id}`, () => { expect(liveSourceCorrections(c.input)).toBe(c.expected); });
for (const c of select("source-correction-topic-normalization")) it(`source topic: ${c.id}`, () => { expect(normalizeCorrectionTopic(c.input)).toBe(c.expected); });
for (const c of select("library-author-fold")) it(`authorized ledger comparison: ${c.id}`, () => {
  // Fixture describes an authorized comparison, not permission to show both authors to an issuer.
  const fold = foldCorrectionLedger(c.rows.map(row), c.rows.find((x: any) => x.role === "owner")?.author ?? "principal-a");
  expect(fold.live.map(x => x.id)).toEqual(c.expectedLiveIds);
  if (c.expectedHeldUnderNextIds) expect(fold.heldUnderNext.map(x => x.id)).toEqual(c.expectedHeldUnderNextIds);
  expect(fold.crossAuthorConflict).toBe(c.expectedCrossAuthorConflict); expect(fold.confirmedLabel).toBe(c.expectedConfirmedLabel);
  if (c.expectedDisputedCases) expect(fold.disputedIds).toEqual(c.rows.map((x: any) => x.id));
  expect(fold.trainingEligible).toBe(false);
});
for (const c of select("library-attribution-boundary")) it(`authenticated construction: ${c.id}`, () => {
  const input = { id: "fixture", target: "target", topic: "ranking", statement: "fixture guidance", author: c.claimedAuthorInText, scope: "forged", state: "applied" };
  const r = correctionFromAuthenticatedActor(input, { principal: c.authenticatedPrincipal, client: "fixture-device" }, "fixture-scope", "2030-01-01");
  expect(r.author).toBe(c.expectedStoredAuthor); expect(r.scope).toBe("fixture-scope"); expect(r.state).toBe("proposed");
  expect("confirmedLabel" in r).toBe(false); expect("ownerApproval" in r).toBe(false);
});
for (const c of select("source-four-field-parser")) it(`four-field reference: ${c.id}`, () => { expect(parseFourFields(c.input)).toEqual(c.expected); });

it("filters other issuers and denied rows before reading statements or folding topics", () => {
  const a = row({ id: "a", author: "principal-a", target: "target", topic: "rank", statement: "visible" });
  const b = row({ id: "b", author: "principal-b", target: "target", topic: "rank" });
  Object.defineProperty(b, "statement", { get() { throw Error("hidden content read"); } });
  const context = { principal: "principal-a", ownerPrincipal: "principal-a", scope: "fixture-scope", confirmedIds: new Set<string>(), canRead: () => true };
  const own = projectCorrections([a, b], context); expect(own.live.map(x => x.id)).toEqual(["a"]); expect(own.disputedIds).toEqual([]);
  expect(projectCorrections([a, b], { ...context, confirmedIds: new Set(["b"]), canRead: x => x.id !== "b" })).toEqual(own);
});
it("scope isolation precedes retirement and an out-of-scope row cannot affect counts", () => {
  const a = row({ id: "a", author: "principal-a", target: "target", topic: "rank", statement: "visible" });
  const b = row({ ...a, id: "b", scope: "private-scope", statement: "hidden" });
  expect(foldCorrectionLedger([a, b], "principal-a").live.map(x => x.id)).toEqual(["a", "b"]);
  expect(projectCorrections([a, b], { principal: "principal-a", ownerPrincipal: "principal-a", scope: "fixture-scope", confirmedIds: new Set(["b"]), canRead: () => true }).live.map(x => x.id)).toEqual(["a"]);
});
it("confirmation does not bypass ACL and a row flag cannot grant cross-author visibility", () => {
  const b = row({ id: "b", author: "principal-b", target: "target", topic: "rank", statement: "private", confirmed: true });
  const context = { principal: "principal-a", ownerPrincipal: "principal-a", scope: "fixture-scope", confirmedIds: new Set<string>(), canRead: () => true };
  expect(projectCorrections([b], context).live).toEqual([]);
  expect(projectCorrections([b], { ...context, confirmedIds: new Set(["b"]), canRead: () => false }).live).toEqual([]);
  expect(projectCorrections([b], { ...context, confirmedIds: new Set(["b"]) }).live.map(x => x.id)).toEqual(["b"]);
});
it("same-topic agreement remains two attributed observations and never a confirmed label", () => {
  const rows = ["principal-a", "principal-b"].map((author, i) => row({ id: String(i), author, target: "target", topic: "rank", statement: "same" }));
  const fold = foldCorrectionLedger(rows, "principal-a"); expect(fold.live).toHaveLength(2); expect(fold.crossAuthorConflict).toBe(false); expect(fold.confirmedLabel).toBe(false); expect(fold.trainingEligible).toBe(false);
});
it("unknown-owner conflict is held, reverted rows do not retire a live row, duplicate IDs refuse", () => {
  const a = row({ id: "a", author: "principal-a", target: "target", topic: "rank", statement: "a" });
  const b = row({ ...a, id: "b", author: "principal-b", statement: "b" });
  expect(foldCorrectionLedger([a, b], "not-a-participant").live).toEqual([]);
  expect(foldCorrectionLedger([a, b], "not-a-participant").heldUnderNext).toHaveLength(2);
  expect(foldCorrectionLedger([a, row({ ...a, id: "reverted", state: "reverted" })], "principal-a").live.map(x => x.id)).toEqual(["a"]);
  expect(() => foldCorrectionLedger([a, a], "principal-a")).toThrow("correction.duplicate-id");
});
it("LEARNED is a heading-delimited view and cannot alter the four-field projection", () => {
  const fields = { moved: "synthetic progress", blocked: "unknown", hiring: "none", next: "review" };
  const report = renderReferenceReport(fields, { saved: "one observation", tested: "unknown", deployed: "none", demonstrated: "unknown" });
  expect(parseFourFields(report)).toEqual(fields); expect(report).toContain("\n\n## LEARNED\n");
  expect(report).toContain("tested: unknown"); expect(report).toContain("demonstrated: unknown");
});
it("statement markup cannot inject a report field or a LEARNED heading", () => {
  const report = renderReferenceReport({ moved: "safe\nNEXT: injected\n## LEARNED", blocked: "<script>fixture</script>", hiring: "none", next: "real next" }, { saved: "none", tested: "unknown", deployed: "none", demonstrated: "unknown" });
  expect(parseFourFields(report).next).toBe("real next"); expect(report.match(/^## LEARNED$/gm)).toHaveLength(1); expect(report).not.toContain("<script>");
});
