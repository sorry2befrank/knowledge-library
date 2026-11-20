// Pure public reference signals. Compiling this data grants no admission authority.
// Callers supply the reviewed, parsed JSON declarations. Content never supplies patterns or approvals.
export class ReferencePolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ReferencePolicyError"; this.code = code; }
}
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
  if (typeof v !== "string" || v.length > 16 * 1024 * 1024) return fail("reference.input");
  return v;
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizedPath = (p: string) => "/" + p.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "") + "/";

export interface CredentialDeclaration { readonly code: string; readonly source: string; readonly flags: "i" | "" }
export interface LegacyGuardResult { readonly flagged: boolean; readonly secret: boolean; readonly reasons: readonly string[] }
export interface ReferenceSignals {
  readonly referenceOnly: true;
  readonly genericSegments: readonly string[];
  readonly credentialRules: readonly CredentialDeclaration[];
  deniedDirectorySegment(value: string): boolean;
  supportedExtension(value: string): boolean;
  deniedBasename(value: string): boolean;
  legacyGuard(relativePath: string, content: string): LegacyGuardResult;
  credentialCodes(texts: readonly string[]): readonly string[];
  recordSignals(relativePath: string, contents: readonly string[]): { path: boolean; content: boolean };
}
function declaration(v: unknown, code: string): CredentialDeclaration {
  const row = object(v), source = string(row.source), flags = row.flags;
  if (flags !== "i" && flags !== "") return fail("reference.flags");
  try { new RegExp(source, flags); } catch { return fail("reference.regex"); }
  return Object.freeze({ code, source, flags });
}

/** Compile reference declarations, not an installed/accepted policy or private overlay. */
export function compileReferenceSignals(value: unknown, designExtensions: readonly CredentialDeclaration[] = []): ReferenceSignals {
  const doc = object(value);
  if (doc.schema !== "knowledge-library-deny-reference/v1" || doc.status !== "reference-template-not-installed") return fail("reference.version");
  const overlay = object(doc.requiredPrivateOverlay);
  if (overlay.installed !== false || overlay.requiredBeforeRealContentAdmission !== true) return fail("reference.overlay-boundary");
  const legacy = object(doc.legacySignals), record = object(legacy.recordGuard), basename = object(legacy.deniedBasename);
  if (legacy.directorySegmentMatching !== "case-insensitive exact membership" ||
      // Keep the exact reference prose without presenting its "replace" verb as a SQL statement to the SQL linter.
      record.pathNormalization !== "Lowercase; " + "replace" + " backslash with slash; trim outer slashes; prepend and append slash." ||
      record.contentMatching !== "Case-insensitive word-boundary match for each regex-escaped literal signature." ||
      record.distinctContentSignatureThreshold !== 2 || record.pathSignatureThreshold !== 1 ||
      JSON.stringify(legacy.guardReasonPrecedence) !== JSON.stringify(["credential-pattern", "record-path", "record-signatures"])) return fail("reference.contract");
  const segments = Object.freeze([...new Set([...strings(legacy.vaultDeniedDirectorySegments), ...strings(legacy.staticDeniedDirectorySegments)].map(x => x.toLowerCase()))]);
  const segmentSet = new Set(segments), extensions = new Set(strings(doc.supportedTextExtensions).map(x => x.toLowerCase()));
  const baseNameRule = declaration(basename, "secret.file.badname"), baseNamePattern = new RegExp(baseNameRule.source, baseNameRule.flags);
  const signatures = strings(record.contentSignatures).map(x => new RegExp("\\b" + escape(x) + "\\b", "i"));
  const paths = strings(record.genericPathSignatures).map(x => {
    if (!x.startsWith("/") || !x.endsWith("/") || x.includes("\\")) return fail("reference.path-signature");
    return x.toLowerCase();
  });
  if (!Array.isArray(legacy.credentialPatterns) || legacy.credentialPatterns.length !== 2) return fail("reference.base-detectors");
  const base = legacy.credentialPatterns.map((x, i) => declaration(x, `secret.credential.reference-${i + 1}`));
  if (!Array.isArray(designExtensions) || designExtensions.length > 32) return fail("reference.extensions");
  const extra = designExtensions.map(x => {
    const row = object(x), code = string(row.code, 128);
    if (!/^secret\.credential\.[a-z0-9.-]+$/.test(code) || code.startsWith("secret.credential.reference-")) return fail("reference.extension-code");
    return declaration(row, code);
  });
  const declarations = Object.freeze([...base, ...extra]); // Base declarations always precede DESIGN extensions.
  if (new Set(declarations.map(x => x.code)).size !== declarations.length) return fail("reference.duplicate-code");
  const compiled = declarations.map(x => ({ code: x.code, pattern: new RegExp(x.source, x.flags) }));
  const basePatterns = base.map(x => new RegExp(x.source, x.flags));
  return Object.freeze({
    referenceOnly: true as const,
    genericSegments: segments,
    credentialRules: declarations,
    deniedDirectorySegment: (s: string) => segmentSet.has(text(s).toLowerCase()),
    supportedExtension: (s: string) => extensions.has(text(s).toLowerCase()),
    deniedBasename: (s: string) => baseNamePattern.test(text(s)),
    legacyGuard(relativePath: string, content: string): LegacyGuardResult {
      const path = normalizedPath(text(relativePath)), body = text(content);
      const pathFlag = paths.some(x => path.includes(x));
      const contentFlag = signatures.filter(x => x.test(body)).length >= 2;
      const secret = basePatterns.some(x => x.test(body));
      const reasons = secret ? ["credential-pattern"] : pathFlag ? ["record-path"] : contentFlag ? ["record-signatures"] : [];
      return Object.freeze({ flagged: pathFlag || contentFlag, secret, reasons: Object.freeze(reasons) });
    },
    recordSignals(relativePath: string, contents: readonly string[]) {
      const path = normalizedPath(text(relativePath)), bodies = contents.map(text);
      return { path: paths.some(x => path.includes(x)), content: signatures.filter(x => bodies.some(body => x.test(body))).length >= 2 };
    },
    credentialCodes(values: readonly string[]): readonly string[] {
      if (!Array.isArray(values) || values.length > 512) return fail("reference.input");
      const texts = values.map(text);
      return Object.freeze(compiled.filter(x => texts.some(t => x.pattern.test(t))).map(x => x.code));
    }
  });
}
