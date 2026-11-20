import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validate } from "@kl/contracts";
import { OWNER_MANIFEST_REFERENCE, OWNER_MANIFEST_SHA256, inspectReferenceProvenance, verifyPinnedReferencePack } from "../packages/core/src/understudy/reference-provenance.ts";
const bytes = readFileSync(new URL("../docs/reference/provenance.json", import.meta.url));
const provenance = JSON.parse(bytes.toString("utf8"));
// Only the reviewed public artifact list, with lexical scope validated before any read.
const artifacts = new Map<string, Uint8Array>();
for (const a of provenance.artifacts) {
  if (!/^(?:docs\/reference|vendor|policy|fixtures\/reference)\/[A-Za-z0-9._/-]+$/.test(a.path) || a.path.split("/").some((s: string) => !s || s === "." || s === "..")) throw Error("fixture.path");
  artifacts.set(a.path, readFileSync(new URL(`../${a.path}`, import.meta.url)));
}
it("all 19 approved artifacts and 33 source symbol/transform records are intact", () => {
  expect(verifyPinnedReferencePack(bytes, artifacts)).toEqual({ artifacts: 19, sources: 33 });
});
it("the Library manifest pins the reviewed source envelope and keeps its existing privacy/tool boundary", () => {
  const manifest = JSON.parse(readFileSync(new URL("../persona/understudy.librarian.frank-epps.manifest.json", import.meta.url), "utf8"));
  expect(manifest.adaptedFrom).toBe(OWNER_MANIFEST_REFERENCE);
  expect(validate("persona-manifest/v1", manifest).valid).toBe(true);
  expect(provenance.sources.find((s: any) => s.id === "owner-manifest-envelope").sha256).toBe(OWNER_MANIFEST_SHA256);
  expect(manifest.knowledge.privacy_ceiling).toBe("principal"); expect(manifest.crew).toEqual({});
  expect(manifest.tools.never).toEqual(expect.arrayContaining(["policy.*", "acl.*", "roots.*", "eligibility.*", "pins.*", "delete", "purge"]));
  expect(manifest.persona.system_prompt_stable).toBeUndefined(); expect(manifest.knowledge.writes).toBeUndefined();
});
for (const [name, edit, code] of [
  ["artifact bytes", (p: any) => { p.artifacts[0].sha256 = "0".repeat(64); }, "provenance.artifact-bytes"],
  ["unknown source", (p: any) => { p.artifacts[1].derivedFrom = ["missing-source"]; }, "provenance.source-reference"],
  ["duplicate source", (p: any) => { p.sources[1].id = p.sources[0].id; }, "provenance.duplicate-source"],
  ["missing symbols", (p: any) => { p.sources[0].symbols = []; }, "provenance.missing-attribution"],
  ["missing transforms", (p: any) => { p.sources[0].transforms = []; }, "provenance.missing-attribution"],
  ["path traversal", (p: any) => { p.artifacts[0].path = "docs/reference/../private.md"; }, "provenance.path"],
  ["source envelope", (p: any) => { p.sources.find((x: any) => x.id === "owner-manifest-envelope").sha256 = "0".repeat(64); }, "provenance.owner-source"],
] as const) it(`provenance rejects ${name}`, () => {
  const p = structuredClone(provenance); edit(p); expect(() => inspectReferenceProvenance(p, artifacts)).toThrow(code);
});
it("rejects absent/extra artifacts and changed approved manifest bytes", () => {
  const absent = new Map(artifacts); absent.delete(provenance.artifacts[0].path);
  expect(() => inspectReferenceProvenance(provenance, absent)).toThrow("provenance.artifact-bytes");
  const extra = new Map(artifacts); extra.set("docs/reference/extra.md", new Uint8Array());
  expect(() => inspectReferenceProvenance(provenance, extra)).toThrow("provenance.extra-artifact");
  expect(() => verifyPinnedReferencePack(Buffer.concat([bytes, Buffer.from(" ")]), artifacts)).toThrow("provenance.manifest-pin");
});
