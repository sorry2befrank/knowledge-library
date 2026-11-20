// Admission guard (DESIGN §3.3). Runs BEFORE any durable write. Rules are data (from the accepted
// policy / reference pack); this file is the engine. Responses carry rule codes and a request id,
// never matched text. Identical outcomes for single save, batch and multipart: every path calls admit().
import { sha256Hex, toBytes } from "../primitives/sha256.ts";
import { canonicalClassSet } from "../catalog/privacy.ts";
import { referenceProfile } from "./reference-policy.ts";

export interface DenyRules {
  /** Set only by the trusted reference-policy loader; the guard also checks its private binding. */
  referencePolicy?: true;
  segments: string[];
  libraryExtensionSegments: string[];
  ledgers: string[];
  badFile: string;
  contentPatterns: { code: string; pattern: string }[];
  studentContentSignatures: string[];
  studentPathSignatures: string[];
  clientNamesOverlay: string[];
  foundersSegments: string[];
}

export interface ClientDecision { client: string; store_ok: boolean; clients_ok: string[]; collection: string; class?: string }

export interface AdmissionInput {
  requestId: string;
  content: Uint8Array | string;
  path?: string;
  requestedCollection?: string;
  decisions?: ClientDecision[];
  /** Every other string the save would store (title, tags, kind, feedback topic/detail...). All are scanned. */
  fields?: Record<string, string | string[] | undefined>;
  /** Computed by the SERVER from reads through the saver's grant and resolved derivedFrom citations; never caller-supplied. */
  lineage?: { hold: false } | { hold: true; code: "lineage-uncertain" | "lineage-narrower-source"; ceiling: string };
  saverInbox?: string;
}

export type AdmissionOutcome = "admitted" | "rejected" | "held";

/** Bytes that passed the guard. Only the guard constructs this; BlobWriter accepts nothing else. */
export class AdmittedBytes {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly requestId: string;
  private constructor(bytes: Uint8Array, sha: string, requestId: string) { this.bytes = bytes; this.sha256 = sha; this.requestId = requestId; }
  /** @internal */
  static _mint(bytes: Uint8Array, requestId: string): AdmittedBytes { return new AdmittedBytes(bytes, sha256Hex(bytes), requestId); }
}

export interface AdmissionResult {
  requestId: string;
  outcome: AdmissionOutcome;
  ruleCodes: string[];
  destination?: { collection: string; quarantine: boolean; privacyClassCeiling?: string };
  /** sha256 of any klb_ token found in the content; the server revokes them. Never the token itself. */
  revokeTokenHashes: string[];
  admitted?: AdmittedBytes;
}

export const ADMISSION_RULE_CODES = [
  "policy.unavailable",
  "secret.file.badname", "secret.credential", "student.content", "student.path", "deny.segment", "deny.client-ledger",
  "client.match.no-store-ok", "client.match.quarantine", "lineage-uncertain", "lineage-narrower-source", "collection.not-allowed", "destination.not-allowed",
] as const;

/** A guard content pattern as a global RegExp; a leading (?i) becomes the i flag. Exported so a local pre-check matches exactly as the guard does. */
export function compileContentPattern(pattern: string): RegExp { return compile(pattern); }
function compile(pattern: string): RegExp {
  let flags = "g";
  let p = pattern;
  if (p.startsWith("(?i)")) { p = p.slice(4); flags += "i"; }
  return new RegExp(p, flags);
}

/** Literal match over a stated normalization: NFC, case-folded, runs of whitespace/punctuation collapsed. */
export function normalizeForNameMatch(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

export function matchesClientName(text: string, name: string): boolean {
  const t = ` ${normalizeForNameMatch(text)} `;
  const n = normalizeForNameMatch(name);
  return n.length > 0 && t.includes(` ${n} `);
}

export function admit(rules: DenyRules, input: AdmissionInput): AdmissionResult {
  const profile = referenceProfile(rules);
  if (rules.referencePolicy && !profile?.ready) {
    return { requestId: input.requestId, outcome: "rejected", ruleCodes: ["policy.unavailable"], revokeTokenHashes: [] };
  }
  const bytes = toBytes(input.content);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const codes = new Set<string>();
  const revoke: string[] = [];
  const path = (input.path ?? "").replace(/\\/g, "/");
  const base = path.split("/").pop() ?? "";
  // Every stored string is scanned: content, path, and each extra field (title, tags, kind, topic, detail...).
  const fieldTexts = Object.values(input.fields ?? {}).flatMap((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));
  const scanTexts = [text, path, ...fieldTexts];

  // Files: the badFile regex over the basename.
  if (base && new RegExp(rules.badFile, "i").test(base)) codes.add("secret.file.badname");

  // Credential patterns over every scanned string. Each pattern has its own code; the generic code is also set.
  for (const { code, pattern } of rules.contentPatterns) {
    let hit = false;
    for (const t of scanTexts) {
      const re = compile(pattern);
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        hit = true;
        if (/klb_/.test(m[0])) { const tok = /klb_[A-Za-z0-9_-]{43,}/.exec(t.slice(m.index)); if (tok) revoke.push(sha256Hex(tok[0])); } // the full token, not the 43-char scanner match
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
    if (hit) { codes.add(code); codes.add("secret.credential"); }
  }

  // The public reference uses distinct literal phrases, word boundaries and wrapped path segments.
  // All stored strings participate; splitting a record across title/body/tags does not bypass it.
  if (profile?.ready) {
    const record = profile.signals.recordSignals(path, scanTexts);
    if (record.path || profile.deniedPrivatePath(path)) codes.add("student.path");
    if (record.content) codes.add("student.content");
  } else {
    // Compatibility for existing explicitly injected S1 rule fixtures (not a reference acceptance).
    const lower = text.toLowerCase();
    const lowerPath = path.toLowerCase();
    if (rules.studentPathSignatures.some((s) => lowerPath.includes(s.toLowerCase()))) codes.add("student.path");
    const studentHits = rules.studentContentSignatures.filter((s) => lower.includes(s.toLowerCase())).length;
    if (studentHits >= 2) codes.add("student.content");
  }

  // Denied segments and client ledgers, in any folder.
  const segs = path.split("/").slice(0, -1);
  const denied = new Set([...rules.segments, ...rules.libraryExtensionSegments].map((s) => s.toLowerCase()));
  const globSegs = [...rules.segments, ...rules.libraryExtensionSegments].filter((s) => s.includes("*")).map((s) => new RegExp("^" + s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i"));
  if (segs.some((s) => denied.has(s.toLowerCase()) || globSegs.some((g) => g.test(s)))) codes.add("deny.segment");
  if (profile?.ready && segs.some(s => profile.deniedPrivateDirectory(s))) codes.add("deny.segment");
  const ledgerPath = profile?.ready ? path.normalize("NFC").toLowerCase() : path;
  if (rules.ledgers.some((l) => {
    const rule = profile?.ready ? l.replace(/\\/g, "/").normalize("NFC").toLowerCase() : l;
    return ledgerPath === rule || ledgerPath.endsWith("/" + rule);
  })) codes.add("deny.client-ledger");

  // Client-name overlay. Rejected unless a store_ok decision exists for that client.
  const matchedClients = rules.clientNamesOverlay.filter((n) => scanTexts.some((t) => matchesClientName(t, n)));
  let destination: AdmissionResult["destination"] | undefined;
  let matchedClass: string | undefined;
  let multiClient = false;
  if (matchedClients.length > 0) {
    const decisions = input.decisions ?? [];
    const okDecisions = matchedClients.map((c) => decisions.find((d) => d.store_ok && normalizeForNameMatch(d.client) === normalizeForNameMatch(c)));
    if (okDecisions.some((d) => !d)) codes.add("client.match.no-store-ok");
    else {
      const d = okDecisions[0]!;
      const quarantine = !!input.requestedCollection && input.requestedCollection !== d.collection;
      destination = { collection: d.collection, quarantine };
      matchedClass = canonicalClassSet(okDecisions.map((decision) => decision!.class ?? "secret"));
      multiClient = new Set(okDecisions.map((decision) => decision!.collection)).size > 1;
      if (quarantine) codes.add("client.match.quarantine");
    }
  }

  const rejecting = ["secret.file.badname", "secret.credential", "student.content", "student.path", "deny.segment", "deny.client-ledger", "client.match.no-store-ok"];
  if (rejecting.some((c) => codes.has(c))) {
    return { requestId: input.requestId, outcome: "rejected", ruleCodes: [...codes].sort(), revokeTokenHashes: revoke };
  }

  // Lineage (DESIGN §3.3): the server decided whether this save is held and at which ceiling; the guard applies it.
  // A client match is never dropped by the hold: the ceiling is the intersection of the client class and every source (S1c A1).
  if (input.lineage?.hold || multiClient) {
    if (input.lineage?.hold) codes.add(input.lineage.code);
    if (multiClient) codes.add("client.match.quarantine");
    return {
      requestId: input.requestId, outcome: "held", ruleCodes: [...codes].sort(), revokeTokenHashes: revoke,
      destination: { collection: input.saverInbox ?? input.requestedCollection ?? "inbox", quarantine: true, privacyClassCeiling: canonicalClassSet([...(input.lineage?.hold ? [input.lineage.ceiling] : []), ...(matchedClass ? [matchedClass] : [])]) },
      admitted: AdmittedBytes._mint(bytes, input.requestId),
    };
  }

  return {
    requestId: input.requestId, outcome: "admitted", ruleCodes: [...codes].sort(), revokeTokenHashes: revoke,
    destination: destination ?? (input.requestedCollection ? { collection: input.requestedCollection, quarantine: false } : undefined),
    admitted: AdmittedBytes._mint(bytes, input.requestId),
  };
}
