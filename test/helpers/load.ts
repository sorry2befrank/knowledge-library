// Load the synthetic vault into a Catalog exactly the way kl push / library_save would: every note goes
// through the admission guard, BlobWriter and apply(). Returns what was admitted and what was rejected.
import { Catalog, MemoryObjectStore, openNodeSqlite, seededRng, mintToken, tokenScopes, tokenExpiry, clientClassFor, opHash, noApprovalChannel, type Op, type Actor, type DenyRules, type ReceiptVerifier, type ApprovalReceipt } from "@kl/core";
import { generateFixtures, type Fixtures, type SynthNote } from "../../fixtures/gen.ts";

export interface LoadReport { admitted: Map<string, { noteId: string; ver: number; sha256: string; cite: string }>; rejected: Map<string, string[]>; refused: Map<string, string> }

export class FixedClock {
  private t: number;
  constructor(startIso = "2026-10-04T12:00:00.000Z") { this.t = Date.parse(startIso); }
  now(): string { this.t += 1000; return new Date(this.t).toISOString(); }
  set(iso: string): void { this.t = Date.parse(iso); }
}

export const FRANK: Actor = { principal: "frank", clientClass: "kl-device", interactive: true };
export const PARTNER: Actor = { principal: "partner", clientClass: "connector", interactive: true };
export const FRANK_CONNECTOR: Actor = { principal: "frank", clientClass: "connector", interactive: true };

export const TEST_BOOTSTRAP_SECRET = "synthetic-bootstrap-secret-for-tests-only";

// Test-only issuance channel: a short-lived object-identity capability binds one exact
// token operation. It is never exported to production and cannot approve any other op.
const fixtureIssuers = new WeakMap<Catalog, (op: Extract<Op, { kind: "token.issue" }>) => void>();

/** Mint and register a synthetic token without reopening sealed setup. */
export function issueToken(catalog: Catalog, principal: string, kind: "kl-device" | "cc-bearer" | "cx-bearer", extra: string[] = [], seed = `${principal}-${kind}-${extra.join()}`): string {
  const rng = seededRng(seed);
  const { token, hash } = mintToken((n) => rng.bytes(n));
  const op: Extract<Op, { kind: "token.issue" }> = { kind: "token.issue", tokenHash: hash, principal, tokenKind: kind, scopes: tokenScopes(kind, extra), clientClass: clientClassFor(kind), expiresAt: tokenExpiry(kind, catalog.clock.now()) };
  if (catalog.inSetupMode()) catalog.apply(FRANK, { kind: "setup", bootstrapSecret: TEST_BOOTSTRAP_SECRET }, op);
  else {
    const issue = fixtureIssuers.get(catalog);
    if (!issue) throw new Error("synthetic receipt issuer unavailable for this catalog");
    issue(op);
  }
  return token;
}

export function newCatalog(fx: Fixtures = generateFixtures(), opts: { denyRules?: DenyRules; clock?: FixedClock; seed?: number; receipts?: ReceiptVerifier } = {}) {
  const rng = seededRng(opts.seed ?? 42);
  const blobStore = new MemoryObjectStore();
  const mirror = new MemoryObjectStore();
  const clock = opts.clock ?? new FixedClock();
  const originalReceipts = opts.receipts ?? noApprovalChannel;
  const issuedReceipts = new WeakMap<ApprovalReceipt, string>();
  const receipts: ReceiptVerifier = {
    verify(receipt, expect) {
      if (receipt && issuedReceipts.has(receipt)) return expect.actionKind === "token.issue" && issuedReceipts.get(receipt) === expect.actionHash
        ? { ok: true } : { ok: false, reason: "action-mismatch" };
      return originalReceipts.verify(receipt, expect);
    },
    ...(originalReceipts.verifyCorrection ? { verifyCorrection: originalReceipts.verifyCorrection.bind(originalReceipts) } : {}),
  };
  const catalog = new Catalog({ db: openNodeSqlite(":memory:"), blobStore, mirror, clock, random: (n) => rng.bytes(n), denyRules: opts.denyRules ?? fx.denyRules, receipts });
  fixtureIssuers.set(catalog, op => {
    const actionHash = opHash(op);
    const receipt: ApprovalReceipt = { receiptId: `synthetic-token-${actionHash}`, actionKind: "token.issue", actionHash, evidenceHash: actionHash,
      principal: op.principal, credentialId: "synthetic-token-issuer", issuedAt: clock.now(), expiresAt: op.expiresAt, serverSig: "synthetic-object-identity-only" };
    issuedReceipts.set(receipt, actionHash);
    try { catalog.apply(FRANK, { kind: "receipt", receipt }, op); }
    finally { issuedReceipts.delete(receipt); }
  });
  catalog.enableSetup(TEST_BOOTSTRAP_SECRET); // a new catalog starts sealed; tests enable setup explicitly
  const setup = { kind: "setup" as const };
  const sys: Actor = { principal: "system", clientClass: "kl-device" };
  for (const p of fx.principals) catalog.apply(sys, setup, { kind: "principal.create", id: p.id, email: p.email, allowedClasses: p.allowedClasses });
  catalog.apply(sys, setup, { kind: "collection.create", collectionId: "inbox:frank", class: "frank-private" });
  catalog.apply(sys, setup, { kind: "collection.create", collectionId: "inbox:partner", class: "partner-private" });
  for (const f of fx.folders) catalog.apply(sys, setup, { kind: "collection.create", collectionId: f.collection, class: f.privacyClass, model_processing: false });
  return { catalog, blobStore, mirror, clock, fx };
}

export function ownerOf(note: SynthNote): Actor { return note.privacyClass === "partner-private" ? { ...PARTNER, clientClass: "kl-device" } : FRANK; }

/** deferCustody: the blob store whose reads fail during the load, so every version stays received and custody.verify stays PENDING (crash matrices). */
/** confirmEdges: confirm every supersedes edge the fixture declares with this receipt (the catalog needs a verifier that accepts it), so the HANDOFF chain is one lineage group (S1c C2). */
export async function loadFixtures(catalog: Catalog, fx: Fixtures, filter: (n: SynthNote) => boolean = () => true, opts: { dispatch?: boolean; deferCustody?: MemoryObjectStore; confirmEdges?: ApprovalReceipt } = {}): Promise<LoadReport> {
  const report: LoadReport = { admitted: new Map(), rejected: new Map(), refused: new Map() };
  if (opts.deferCustody) opts.deferCustody.failWhenGet = (k) => k.startsWith("blobs/");
  for (const n of fx.notes.filter(filter)) {
    const actor = ownerOf(n);
    const folderId = `folder:${n.folder}`;
    const bodies = [...n.history, n.body];
    let last: { noteId: string; ver: number } | undefined;
    for (const body of bodies) {
      const r = await catalog.save(actor, { content: body, path: `${n.folder}/${n.relPath}`, collection: n.collection, title: n.title, kind: n.kind, folderId, baseVer: last?.ver,
        capturedAt: new Date(Date.UTC(2026, 9, 4) - n.mtimeDaysAgo * 86400000).toISOString(), supersedes: n.flags.supersedes ? report.admitted.get(n.flags.supersedes)?.noteId : undefined }, { grant: `grant-${actor.principal}` });
      if (r.ok) {
        last = { noteId: r.noteId, ver: r.ver }; report.admitted.set(n.noteId, { noteId: r.noteId, ver: r.ver, sha256: r.sha256, cite: r.cite });
        const sup = n.flags.supersedes ? report.admitted.get(n.flags.supersedes)?.noteId : undefined;
        if (sup && opts.confirmEdges && body === n.body) catalog.apply(FRANK, { kind: "receipt", receipt: opts.confirmEdges }, { kind: "edge.confirm", src: r.noteId, dst: sup, type: "supersedes" });
      }
      else if (r.status === "rejected") { report.rejected.set(n.noteId, r.ruleCodes); break; }
      else { report.refused.set(n.noteId, r.reason); break; }
    }
  }
  if (opts.deferCustody) opts.deferCustody.failWhenGet = null;
  if (opts.dispatch !== false) await catalog.drainOutbox();
  return report;
}

/** Map synthetic noteId -> catalog noteId (the catalog mints its own ids). */
export function idMap(report: LoadReport): Map<string, string> { return new Map([...report.admitted].map(([k, v]) => [k, v.noteId])); }
