// Published fixture predicates only; never imported by runtime admission.
import { ReferencePolicyError } from "../../packages/core/src/admission/reference.ts";
const fail = (code: string): never => { throw new ReferencePolicyError(code); };
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("reference.shape");
  return v as Record<string, unknown>;
};
const string = (v: unknown, max = 8192): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max || v.includes("\0")) return fail("reference.string");
  return v;
};
const strings = (v: unknown): readonly string[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 512) return fail("reference.list");
  const values = v.map(x => string(x, 512));
  if (new Set(values.map(x => x.toLowerCase())).size !== values.length) return fail("reference.duplicate");
  return Object.freeze(values);
};
const text = (v: unknown): string => {
  if (typeof v !== "string" || v.length > 1_048_576) return fail("reference.input");
  return v;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizedPath = (p: string) => "/" + p.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "") + "/";

function declaration(v: unknown, code: string) { const row = object(v); const source = string(row.source); const flags = row.flags; if (flags !== "i" && flags !== "") return fail("reference.flags"); try { new RegExp(source, flags); } catch { return fail("reference.regex"); } return { source, flags, code }; }
/** Fictional fixture adapter. It is intentionally not accepted private-policy construction. */
export function compileSyntheticOverlay(value: unknown): {
  readonly syntheticOnly: true;
  deniedDirectorySegment(value: string): boolean;
  deniedPath(value: string): boolean;
} {
  const row = object(value);
  if (row.approved !== true || typeof row.revision !== "string" || !row.revision.startsWith("synthetic-")) return fail("reference.synthetic-overlay");
  const segments = new Set(strings(row.deniedDirectorySegments).map(x => x.toLowerCase()));
  if (!Array.isArray(row.auditDirectoryPatterns) || row.auditDirectoryPatterns.length > 16) return fail("reference.synthetic-overlay");
  const patterns = row.auditDirectoryPatterns.map(x => { const d = declaration(x, "reference.audit"); return new RegExp(d.source, d.flags); });
  const paths = strings(row.privateOperationalPathSignatures).map(x => {
    if (!x.startsWith("/") || !x.endsWith("/") || x.includes("\\")) return fail("reference.path-signature");
    return x.toLowerCase();
  });
  return Object.freeze({
    syntheticOnly: true as const,
    deniedDirectorySegment(value: string) { const s = text(value); return segments.has(s.toLowerCase()) || patterns.some(x => x.test(s)); },
    deniedPath(value: string) { const p = normalizedPath(text(value)); return paths.some(x => p.includes(x)); }
  });
}

/** Partial reference predicate only. Booleans in a fixture are not approval receipts or server facts. */
export function classifyReferencePrerequisites(value: unknown): "reject-before-persistence" | "allowed-by-these-checks" | "reference-only" {
  const row = object(value);
  const keys = ["synthetic", "overlayApproved", "scopeAllowed", "clientApproved", "secret", "flagged"];
  if (keys.some(k => typeof row[k] !== "boolean")) return fail("reference.prerequisites");
  if (row.synthetic) return "reference-only"; // Never a caller-controlled real-admission bypass.
  return !row.overlayApproved || !row.scopeAllowed || !row.clientApproved || row.secret || row.flagged
    ? "reject-before-persistence" : "allowed-by-these-checks";
}
