import { sha256Hex } from "../primitives/sha256.ts";
export const REFERENCE_PROVENANCE_SHA256 = "BF817D944409A3343CE62B344BA2B7C842800207837E855409A8283FD282B572";
export const OWNER_MANIFEST_SHA256 = "75B0F41B5AFA67C464297E352F9F53B075D78DDA2D8A48FB63A854AFD50EF531";
export const OWNER_MANIFEST_REFERENCE = `orrery-owner-manifest@${OWNER_MANIFEST_SHA256.toLowerCase()}`;
type ObjectRow = Record<string, unknown>;
function object(value: unknown): ObjectRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provenance.object");
  return value as ObjectRow;
}
function list(value: unknown, size?: number): unknown[] {
  if (!Array.isArray(value) || (size !== undefined && value.length !== size)) throw new Error("provenance.count");
  return value;
}
function text(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("provenance.text"); return value; }
function hash(value: unknown): string { const v = text(value); if (!/^[A-F0-9]{64}$/.test(v)) throw new Error("provenance.hash"); return v; }
// Coherence only. The pinned wrapper below additionally binds the approved manifest bytes.
export function inspectReferenceProvenance(value: unknown, artifacts: ReadonlyMap<string, Uint8Array>): { artifacts: 19; sources: 33 } {
  const p = object(value); if (p.format !== "reference-pack-provenance/v1") throw new Error("provenance.version");
  const sources = new Map<string, ObjectRow>();
  for (const raw of list(p.sources, 33)) {
    const s = object(raw), id = text(s.id); if (sources.has(id)) throw new Error("provenance.duplicate-source");
    hash(s.sha256);
    for (const key of ["symbols", "transforms"]) { const values = list(s[key]); if (!values.length) throw new Error("provenance.missing-attribution"); for (const v of values) text(v); }
    sources.set(id, s);
  }
  if (sources.get("owner-manifest-envelope")?.sha256 !== OWNER_MANIFEST_SHA256) throw new Error("provenance.owner-source");
  const seen = new Set<string>();
  for (const raw of list(p.artifacts, 19)) {
    const a = object(raw), path = text(a.path);
    if (!/^(?:docs\/reference|vendor|policy|fixtures\/reference)\/[A-Za-z0-9._/-]+$/.test(path)
      || path.split("/").some(s => !s || s === "." || s === "..") || path === "docs/reference/provenance.json") throw new Error("provenance.path");
    if (seen.has(path)) throw new Error("provenance.duplicate-artifact"); seen.add(path);
    const bytes = artifacts.get(path); if (!bytes || bytes.byteLength !== a.bytes || sha256Hex(bytes).toUpperCase() !== hash(a.sha256)) throw new Error("provenance.artifact-bytes");
    const refs = list(a.derivedFrom); if (!refs.length && path !== "docs/reference/README.md") throw new Error("provenance.source-reference");
    for (const id of refs) if (!sources.has(text(id))) throw new Error("provenance.source-reference");
  }
  if (artifacts.size !== seen.size || [...artifacts.keys()].some(k => !seen.has(k))) throw new Error("provenance.extra-artifact");
  return { artifacts: 19, sources: 33 };
}
export function verifyPinnedReferencePack(manifestBytes: Uint8Array, artifacts: ReadonlyMap<string, Uint8Array>): { artifacts: 19; sources: 33 } {
  if (sha256Hex(manifestBytes).toUpperCase() !== REFERENCE_PROVENANCE_SHA256) throw new Error("provenance.manifest-pin");
  return inspectReferenceProvenance(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), artifacts);
}
