// Trusted server construction only. A reference document or a caller's approval flag is not policy.
// Reuse the existing signature/epoch verifier over a detached snapshot; never consume mutable
// LoadedPolicy.files supplied by a caller. Nothing here reads private files or activates a service.
import { canonicalJson } from "../primitives/canonical.ts";
import { bundleHash, loadPolicy, type PolicyBundle, type Trust } from "../policy/acceptance.ts";
import { compileReferenceSignals, type ReferenceSignals } from "./reference.ts";
import type { DenyRules } from "./guard.ts";

/** Fixed minimum extensions from DESIGN section 3.2. The reference's two base detectors stay first. */
export const LIBRARY_CREDENTIAL_PATTERNS = Object.freeze([
  { code: "secret.credential.stripe", pattern: "\\b[rs]k_(live|test)_[A-Za-z0-9]{16,}" },
  { code: "secret.credential.jwt", pattern: "\\beyJ[\\w-]{10,}\\.[\\w-]{10,}\\.[\\w-]{10,}" },
  { code: "secret.credential.anthropic", pattern: "\\bsk-ant-[\\w-]{20,}" },
  { code: "secret.credential.slack", pattern: "\\bxox[abprs]-[\\w-]{10,}" },
  { code: "secret.credential.google", pattern: "\\bAIza[\\w-]{35}" },
  { code: "secret.credential.meta", pattern: "\\bEAA[A-Za-z0-9]{40,}" },
  { code: "secret.credential.square", pattern: "\\bK0\\d{2}[A-Za-z0-9]{27}" },
  { code: "secret.credential.npm", pattern: "_authToken\\s*=" },
  { code: "secret.credential.private-key", pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { code: "secret.credential.env", pattern: "(?i)\\b[A-Z0-9_]*(SECRET|TOKEN|PRIVATE|SERVICE_ROLE|API)_?KEY\\s*[=:]\\s*\\S{16,}" },
  { code: "secret.credential.klb", pattern: "\\bklb_[A-Za-z0-9_-]{43,}" },
].map(p => Object.freeze(p)));

/** The guard's content patterns for compiled reference signals: the reference's base detectors first, then the DESIGN §3.2 extensions. */
function contentPatternsFor(signals: ReferenceSignals): { code: string; pattern: string }[] {
  return [...signals.credentialRules.map(p => ({ code: p.code, pattern: (p.flags === "i" ? "(?i)" : "") + p.source })), ...LIBRARY_CREDENTIAL_PATTERNS.map(p => ({ ...p }))];
}
/** The guard's denied-basename source from a published reference (legacySignals.deniedBasename). */
function badFileFor(reference: Record<string, unknown>): string {
  return record(record(reference.legacySignals).deniedBasename).source as string;
}
/** Client-ledger paths the guard refuses in every folder, before the private overlay's own (DESIGN §3.2). */
const PUBLIC_LEDGERS = Object.freeze(["PIPELINE.md", "RELATIONSHIP-REGISTER.md", "secretary/LEDGER.md", "FOLLOW-UPS.md", "BLOCKED.md"]);
export interface PublicReferenceRules {
  contentPatterns: { code: string; pattern: string }[];
  badFile: string;
  ledgers: string[];
  recordSignals: ReferenceSignals["recordSignals"];
}
/**
 * The public half of the guard for a published reference (deny.reference.json, which in production is policy/deny.template.json):
 * exactly the content patterns, denied-basename rule, public ledgers and student-record signals the loader builds. For a local
 * pre-check that must agree with the server, such as `kl handoff`. It carries no private declarations and authenticates nothing.
 */
export function publicReferenceRules(reference: unknown): PublicReferenceRules {
  const r = record(reference);
  const signals = compileReferenceSignals(r);
  return { contentPatterns: contentPatternsFor(signals), badFile: badFileFor(r), ledgers: [...PUBLIC_LEDGERS], recordSignals: (path, contents) => signals.recordSignals(path, contents) };
}

type Profile = { ready: false } | {
  ready: true; policyHash: string; epoch: number; signals: ReferenceSignals;
  deniedPrivatePath(path: string): boolean; deniedPrivateDirectory(segment: string): boolean;
};
const profiles = new WeakMap<DenyRules, Profile>();
/** @internal A copied/forged marker cannot acquire a trusted profile. */
export function referenceProfile(rules: DenyRules): Profile | undefined { return profiles.get(rules); }

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("policy.shape");
  return value as Record<string, unknown>;
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || value.some(x => typeof x !== "string" || !x.trim() || x.length > 512 || x.includes("\0"))) throw Error("policy.list");
  return value as string[];
}
function makeRules(profile: Profile, partial: Partial<DenyRules> = {}): DenyRules {
  const rules: DenyRules = {
    segments: [], libraryExtensionSegments: [], ledgers: [], badFile: "(?!)", contentPatterns: [],
    studentContentSignatures: [], studentPathSignatures: [], clientNamesOverlay: [], foundersSegments: [],
    ...partial, referencePolicy: true,
  };
  profiles.set(rules, freeze(profile));
  return freeze(rules);
}

/**
 * Bundle keys: deny.reference.json (published public declarations), deny.private.json (the complete
 * private contentsTemplate, populated in owner-controlled state). ownerApprovedRevision identifies
 * that private revision; only the signed acceptance authenticates it. Scope/client decisions remain
 * the Catalog's current server facts. No synthetic or request-provided approval bypass exists.
 */
export async function loadReferenceAdmissionRules(bundle: PolicyBundle | undefined, acceptance: unknown, trust: Trust): Promise<DenyRules> {
  try {
    if (!bundle) return makeRules({ ready: false });
    // Snapshot BEFORE the async signature check, including the acceptance and epoch floor.
    const snapshot = freeze(JSON.parse(canonicalJson(bundle)) as PolicyBundle);
    const acceptedRecord: unknown = acceptance === undefined ? undefined : freeze(JSON.parse(canonicalJson(acceptance)));
    const trusted = Object.freeze({ publicKey: trust.publicKey, keyId: trust.keyId, minEpoch: trust.minEpoch });
    const policy = await loadPolicy(snapshot, acceptedRecord, trusted);
    if (policy.mode !== "accepted" || policy.policyHash !== bundleHash(snapshot)) return makeRules({ ready: false });
    const reference = record(snapshot.files["deny.reference.json"]);
    const signals = compileReferenceSignals(reference);
    const overlay = record(snapshot.files["deny.private.json"]);
    if (typeof overlay.ownerApprovedRevision !== "string" || !overlay.ownerApprovedRevision.trim() || overlay.ownerApprovedRevision.length > 256) throw Error("policy.revision");
    const privateSegments = list(overlay.projectAndClientDeniedDirectorySegments);
    const privatePaths = list(overlay.privateOperationalPathSignatures).map(p => {
      if (!p.startsWith("/") || !p.endsWith("/") || p.includes("\\")) throw Error("policy.path");
      return p.toLowerCase();
    });
    const names = list(overlay.clientClassificationRules);
    const ledgers = list(overlay.privateLedgerPathRules);
    if (!Array.isArray(overlay.projectAuditDirectoryPatterns) || overlay.projectAuditDirectoryPatterns.length > 16) throw Error("policy.patterns");
    const auditPatterns = overlay.projectAuditDirectoryPatterns.map(value => {
      const p = record(value);
      if (typeof p.source !== "string" || !p.source || p.source.length > 8192 || p.flags !== "i") throw Error("policy.pattern");
      return new RegExp(p.source, "i");
    });
    const legacy = record(reference.legacySignals), records = record(legacy.recordGuard);
    const profile: Profile = {
      ready: true, policyHash: policy.policyHash, epoch: policy.epoch, signals,
      deniedPrivatePath(path) { const p = "/" + path.replace(/\\/g, "/").toLowerCase().replace(/^\/+|\/+$/g, "") + "/"; return privatePaths.some(s => p.includes(s)); },
      deniedPrivateDirectory(segment) { return auditPatterns.some(p => p.test(segment)); },
    };
    return makeRules(profile, {
      segments: [...signals.genericSegments, ...privateSegments],
      libraryExtensionSegments: ["founders", "members", "_owner-ops", "intake", "uploads", "client-work-*audit-*", ".remember", ".obsidian", ".git", "node_modules"],
      ledgers: [...PUBLIC_LEDGERS, ...ledgers],
      badFile: badFileFor(reference),
      contentPatterns: contentPatternsFor(signals),
      studentContentSignatures: list(records.contentSignatures), studentPathSignatures: list(records.genericPathSignatures),
      clientNamesOverlay: names, foundersSegments: ["founders", "members"],
    });
  } catch {
    // Diagnostics never carry private declarations, source bytes, or regex-engine error text.
    return makeRules({ ready: false });
  }
}
