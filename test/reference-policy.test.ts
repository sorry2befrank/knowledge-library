// Source-review first. Reads only two pinned published synthetic JSON files; no app/process/network calls.
import { it as test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileReferenceSignals, ReferencePolicyError } from "../packages/core/src/admission/reference.ts";
import { compileSyntheticOverlay, classifyReferencePrerequisites } from "./helpers/reference-fixtures.ts";

function data(path: URL, sha256: string): any {
  const bytes = readFileSync(path);
  assert.equal(createHash("sha256").update(bytes).digest("hex").toUpperCase(), sha256);
  return JSON.parse(bytes.toString("utf8"));
}
const template = data(new URL("../policy/deny.template.json", import.meta.url), "FD6B312333F393F2159C077A064CF64C7AD01EDBE4AFEFF4E173FF1F98A725CB");
const fixtures = data(new URL("../fixtures/reference/policy.cases.json", import.meta.url), "45660399B5704C945DEF8171DD4441CB61212073516A845B6FB078C4BEBD8BC5");
const signals = compileReferenceSignals(template), overlay = compileSyntheticOverlay(fixtures.syntheticOverlay);
function construct(value: unknown, depth = 0): string {
  assert(depth <= 12);
  if (typeof value === "string") { assert(value.length <= 8192); return value; }
  assert(value && typeof value === "object" && !Array.isArray(value));
  const v = value as Record<string, any>;
  assert.equal(Object.keys(v).length, 1);
  if (Array.isArray(v.concat)) { assert(v.concat.length <= 32); const s = v.concat.map((x: unknown) => construct(x, depth + 1)).join(""); assert(s.length <= 8192); return s; }
  assert(Array.isArray(v.repeat) && v.repeat.length === 2 && Number.isInteger(v.repeat[1]) && v.repeat[1] >= 0 && v.repeat[1] <= 1024);
  const s = construct(v.repeat[0], depth + 1).repeat(v.repeat[1]); assert(s.length <= 8192); return s;
}
assert.equal(fixtures.cases.length, 35);
for (const c of fixtures.cases) test(`published policy fixture: ${c.id}`, () => {
  let actual: unknown;
  switch (c.operation) {
    case "generic-directory-segment": actual = signals.deniedDirectorySegment(construct(c.input)) ? "denied" : "allowed-by-this-check"; break;
    case "extension": actual = signals.supportedExtension(construct(c.input)) ? "allowed-by-this-check" : "denied"; break;
    case "basename": actual = signals.deniedBasename(construct(c.input)) ? "denied" : "allowed-by-this-check"; break;
    case "legacy-guard": actual = signals.legacyGuard(c.relativePath, construct(c.text)); break;
    case "synthetic-overlay-directory": actual = overlay.deniedDirectorySegment(c.input) ? "denied" : "allowed-by-this-check"; break;
    case "synthetic-overlay-path": actual = overlay.deniedPath(c.relativePath) ? "denied" : "allowed-by-this-check"; break;
    case "library-admission": actual = classifyReferencePrerequisites(c.inputs); break;
    default: assert.fail("Unknown published operation; do not skip it.");
  }
  assert.deepEqual(actual, c.expected); // Fixed public oracle; no constructed source text in assertion diagnostics.
});
test("public template is reference-only, immutable and carries 41 generic vault declarations", () => {
  assert.equal(template.legacySignals.vaultDeniedDirectorySegments.length, 41);
  assert.equal(signals.referenceOnly, true);
  assert.equal(overlay.syntheticOnly, true);
  assert(Object.isFrozen(signals) && Object.isFrozen(signals.genericSegments) && Object.isFrozen(signals.credentialRules));
  assert.equal("admitted" in signals, false); assert.equal("acceptance" in signals, false);
});
test("base credentials remain first when a DESIGN extension also matches", () => {
  const s = compileReferenceSignals(template, [{ code: "secret.credential.extension-fixture", source: "^sk-", flags: "" }]);
  const codes = s.credentialCodes([["sk-", "A".repeat(24)].join("")]);
  assert.deepEqual(codes, ["secret.credential.reference-1", "secret.credential.extension-fixture"]);
});
test("DESIGN-only signals remain active without changing legacy source results", () => {
  const s = compileReferenceSignals(template, [{ code: "secret.credential.extension-fixture", source: "^EXTENSION_SENTINEL$", flags: "" }]);
  assert.deepEqual(s.credentialCodes(["EXTENSION_SENTINEL"]), ["secret.credential.extension-fixture"]);
  assert.deepEqual(s.legacyGuard("sample/overview.md", "EXTENSION_SENTINEL"), { flagged: false, secret: false, reasons: [] });
});
test("repeated calls do not inherit regex lastIndex state", () => {
  const value = ["sk-", "A".repeat(24)].join("");
  for (let i = 0; i < 3; i++) assert.deepEqual(signals.credentialCodes([value]), ["secret.credential.reference-1"]);
});
test("a synthetic marker returns reference-only, never real clearance", () => {
  assert.equal(classifyReferencePrerequisites({ synthetic: true, overlayApproved: false, scopeAllowed: false, clientApproved: false, secret: false, flagged: false }), "reference-only");
});
test("scope denial and incomplete facts fail closed", () => {
  assert.equal(classifyReferencePrerequisites({ synthetic: false, overlayApproved: true, scopeAllowed: false, clientApproved: true, secret: false, flagged: false }), "reject-before-persistence");
  assert.throws(() => classifyReferencePrerequisites({ synthetic: false }), (e: unknown) => e instanceof ReferencePolicyError && e.code === "reference.prerequisites");
});
for (const [name, edit, code] of [
  ["unknown schema", (x: any) => { x.schema = "unknown"; }, "reference.version"],
  ["claims installed", (x: any) => { x.requiredPrivateOverlay.installed = true; }, "reference.overlay-boundary"],
  ["missing base detector", (x: any) => { x.legacySignals.credentialPatterns.pop(); }, "reference.base-detectors"],
  ["stateful pattern flags", (x: any) => { x.legacySignals.credentialPatterns[0].flags = "g"; }, "reference.flags"],
  ["invalid regex", (x: any) => { x.legacySignals.credentialPatterns[0].source = "["; }, "reference.regex"],
  ["changed signature threshold", (x: any) => { x.legacySignals.recordGuard.distinctContentSignatureThreshold = 1; }, "reference.contract"],
  ["changed path normalization", (x: any) => { x.legacySignals.recordGuard.pathNormalization = "none"; }, "reference.contract"],
  ["duplicate signature", (x: any) => { x.legacySignals.recordGuard.contentSignatures.push("iep"); }, "reference.duplicate"]
] as const) test(`malformed reference refuses: ${name}`, () => {
  const copy = structuredClone(template); edit(copy);
  assert.throws(() => compileReferenceSignals(copy), (e: unknown) => e instanceof ReferencePolicyError && e.code === code);
});
