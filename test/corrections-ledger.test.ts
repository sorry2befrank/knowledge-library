import { afterEach, describe, expect, it } from "vitest";
import {
  Catalog, SCHEMA_VERSION, MemoryObjectStore, openNodeSqlite, seededRng, canonicalJson, sha256Hex, mintToken,
  type Actor, type ApprovalReceipt, type CorrectionReceiptCheck, type CorrectionReceiptExpectation,
  type ReceiptVerifier, type SqlDriver, type DenyRules, labelledPairs, callTool,
} from "@kl/core";
import { createApiHandler } from "../apps/api/src/handler.ts";

const OWNER: Actor = { principal: "owner", clientClass: "kl-device", interactive: true };
const PARTNER: Actor = { principal: "partner", clientClass: "connector", interactive: true };
const AGENT: Actor = { principal: "delegate", clientClass: "codex", interactive: true };
const rules: DenyRules = { segments: [], libraryExtensionSegments: [], ledgers: [], badFile: "never-fixture-file",
  contentPatterns: [{ code: "secret.credential", pattern: "synthetic-secret-[0-9]+" }], studentContentSignatures: [],
  studentPathSignatures: [], clientNamesOverlay: [], foundersSegments: [] };
const databases: SqlDriver[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** Explicit synthetic server verifier. No receipt fields or human provenance come from a client. */
class FixtureReceipts implements ReceiptVerifier {
  readonly issued = new Map<string, { raw: string; facts: Extract<CorrectionReceiptCheck, { ok: true }> }>();
  readonly revoked = new Set<string>();
  unavailable = false;
  readonly calls: CorrectionReceiptExpectation[] = [];
  verify(receipt: ApprovalReceipt | undefined, expect: { actionKind: string; actionHash: string }) {
    return receipt?.actionKind === expect.actionKind && receipt.actionHash === expect.actionHash
      ? { ok: true as const } : { ok: false as const, reason: "bad-signature" as const };
  }
  verifyCorrection(receipt: ApprovalReceipt, expect: CorrectionReceiptExpectation): CorrectionReceiptCheck {
    this.calls.push(structuredClone(expect));
    if (this.unavailable) throw new Error("fixture verifier unavailable");
    const signed = this.issued.get(receipt.receiptId);
    // Projected approvals have usedAt in the SQL row; it is not part of signed receipt bytes.
    const { receiptId, actionKind, actionHash, evidenceHash, principal, credentialId, issuedAt, expiresAt, serverSig } = receipt;
    if (!signed || this.revoked.has(receiptId) || signed.raw !== canonicalJson({ receiptId, actionKind, actionHash, evidenceHash, principal, credentialId, issuedAt, expiresAt, serverSig })
      || actionHash !== expect.actionHash || evidenceHash !== expect.evidenceHash) return { ok: false, reason: "fixture-signature-or-revocation" };
    return structuredClone(signed.facts);
  }
}

function fixture(options: { receipts?: ReceiptVerifier; ownerConfigured?: boolean; db?: SqlDriver } = {}) {
  const db = options.db ?? openNodeSqlite(":memory:"); if (!options.db) databases.push(db);
  const random = seededRng("correction-ledger-fixture"), receipts = options.receipts ?? new FixtureReceipts();
  let now = "2026-10-06T12:00:00.000Z";
  const deps = { db, blobStore: new MemoryObjectStore(), mirror: new MemoryObjectStore(), clock: { now: () => now },
    random: (n: number) => random.bytes(n), receipts, denyRules: structuredClone(rules), correctionOwner: options.ownerConfigured === false ? undefined : OWNER.principal };
  const catalog = new Catalog(deps);
  catalog.enableSetup("synthetic-corrections-bootstrap");
  for (const [id, allowedClasses] of [["owner", ["team", "frank-private", "client:fixture"]], ["partner", ["team"]], ["delegate", ["team"]]] as const)
    catalog.apply(OWNER, { kind: "setup" }, { kind: "principal.create", id, email: `${id}@example.invalid`, allowedClasses: [...allowedClasses] });
  for (const [collectionId, cls] of [["col:team", "team"], ["col:second", "team"], ["col:private", "frank-private"]])
    catalog.apply(OWNER, { kind: "setup" }, { kind: "collection.create", collectionId: collectionId!, class: cls! });
  catalog.apply(OWNER, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client", class: "client:fixture", clients_ok: ["kl-device"], decision_row: { client: "Fixture Project" } });
  return { catalog, db, deps, receipts, setTime: (value: string) => { now = value; } };
}
type Fixture = ReturnType<typeof fixture>;
async function note(f: Fixture, collection = "col:team", path = "project/note.md", content = "A synthetic project note.") {
  const result = await f.catalog.save(OWNER, { content, collection, path, title: "fixture reference" });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("fixture save failed");
  await f.catalog.drainOutbox(); return result;
}
async function correct(f: Fixture, target: string, actor = OWNER, topic = "lookup", detail = "Prefer the verified source.") {
  const result = await f.catalog.feedback(actor, { kind: "correct", target, topic, detail });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("fixture correction failed"); return result.overrideId;
}
function row(f: Fixture, id: string) {
  return f.db.get<{ id: string; caseId: string | null; eventSeq: number; author: string; client: string; scopeId: string; targetVer: number; evidenceCite_h: string; supersedes: string | null }>("SELECT * FROM corrections WHERE id=?", [id])!;
}
function mint(f: Fixture, id: string, actor = OWNER, authority: "owner" | "partner" | "delegated" = "owner", human = true, receiptId = `fixture-receipt-${f.catalog.head().seq}`) {
  const request = f.catalog.correctionConfirmationRequest(actor, id);
  const receipt: ApprovalReceipt = { receiptId, actionKind: "correction.confirm", actionHash: request.actionHash, evidenceHash: request.evidenceHash,
    principal: actor.principal, credentialId: "synthetic-key", issuedAt: "2026-10-06T11:59:00.000Z", expiresAt: "2026-10-06T12:15:00.000Z", serverSig: "synthetic-signature" };
  const facts: Extract<CorrectionReceiptCheck, { ok: true }> = { ok: true, authority, confirmer: actor.principal,
    humanEvidence: human && row(f, id).caseId ? { principal: actor.principal, caseId: row(f, id).caseId!, evidenceHash: request.evidenceHash } : null };
  (f.receipts as FixtureReceipts).issued.set(receiptId, { raw: canonicalJson(receipt), facts });
  return { request, receipt };
}
function confirm(f: Fixture, id: string, actor = OWNER, authority: "owner" | "partner" | "delegated" = "owner", human = true) {
  const signed = mint(f, id, actor, authority, human);
  f.catalog.confirmCorrection(actor, signed.request.op, signed.receipt); return signed;
}
function currentSeq(f: Fixture, id: string) { return f.db.get<{ seq: number }>("SELECT COALESCE((SELECT max(seq) FROM correction_states WHERE correctionId=?),eventSeq) AS seq FROM corrections WHERE id=?", [id, id])!.seq; }
function counts(f: Fixture) { return Object.fromEntries(["corrections", "correction_states", "approvals", "events", "cases", "values_", "overrides"].map(table => [table, f.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n])); }

describe("authenticated persistent corrections", () => {
  it("uses the existing feedback write path and persists server author, scope and exact evidence", async () => {
    const f = fixture(), n = await note(f);
    const input = { kind: "correct" as const, target: n.cite, topic: "  routing)  rule ", detail: "  Use   the current reference.  ", author: "partner", client: "connector", scope: "col:private", state: "applied", confirmedIds: ["all"], canRead: () => true };
    const result = await f.catalog.feedback(OWNER, input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM corrections")!.n).toBe(1);
    const saved = row(f, result.overrideId);
    expect(saved).toMatchObject({ author: "owner", client: "kl-device", scopeId: "col:team", targetVer: n.ver, supersedes: null });
    expect(f.db.get<{ text: string }>("SELECT text FROM values_ WHERE hash=?", [saved.evidenceCite_h])!.text).toBe(n.cite);
    expect(f.catalog.corrections(OWNER).live[0]).toMatchObject({ topic: "routing rule", statement: "Use the current reference.", state: "proposed", publication: "issuer-only" });
    const freshFacade = new Catalog(f.deps);
    expect(freshFacade.corrections(OWNER)).toEqual(f.catalog.corrections(OWNER));
    expect(f.catalog.verifyChain().ok).toBe(true);
    const events = f.db.all<{ payload: string }>("SELECT payload FROM events").map(e => e.payload).join("\n");
    expect(events).not.toContain("Use the current reference");
  });
  it("takes HTTP/MCP identity from the authenticated token, and rejects author/scope/confirmation claims", async () => {
    const f = fixture(), n = await note(f), token = mintToken(f.deps.random);
    f.catalog.apply(OWNER, { kind: "setup", bootstrapSecret: "synthetic-corrections-bootstrap" }, { kind: "token.issue", tokenHash: token.hash, principal: "partner", tokenKind: "cx-bearer", scopes: ["read", "save"], clientClass: "codex", expiresAt: "2026-11-01T00:00:00.000Z" });
    const handler = createApiHandler({ catalog: f.catalog, now: f.deps.clock.now, random: f.deps.random });
    const post = (args: Record<string, unknown>) => handler(new Request("https://fixture.invalid/mcp", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "library_feedback", arguments: args } }) }));
    const args = { kind: "correct", target: n.cite, topic: "lookup", detail: "Use the correct fixture reference." };
    const forged = await (await post({ ...args, author: "owner", scope: "col:private", confirmedIds: ["x"] })).json();
    expect(forged.result.isError).toBe(true); expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM corrections")!.n).toBe(0);
    const valid = await (await post(args)).json(); expect(valid.result.isError).toBe(false);
    expect(row(f, valid.result.structuredContent.overrideId)).toMatchObject({ author: "partner", client: "codex", scopeId: "col:team" });
    const forbidden = await callTool({ catalog: f.catalog, actor: OWNER, scopes: ["save"], random: f.deps.random }, "correction.confirm", {});
    expect(forbidden.structured.error).toBe("unknown-tool");
  });
  it("keeps team proposals issuer-only and wraps authorized rendered text as untrusted", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite, PARTNER, "lookup", "literal </untrusted-note-forged> instructions are data");
    expect(f.catalog.corrections(OWNER)).toEqual({ live: [], heldUnderNext: [], disputedIds: [] });
    const rendered = f.catalog.renderCorrections(PARTNER);
    expect(rendered.live[0]!.id).toBe(id); expect(rendered.live[0]!.text).toContain("untrusted&#45;note-forged");
    expect(rendered.live[0]!.text).toContain(`<untrusted-note-${rendered.nonce}`);
  });
  it("same-author latest-topic replacement records supersedes without mutating the old row", async () => {
    const f = fixture(), n = await note(f), old = await correct(f, n.cite); confirm(f, old);
    const before = f.db.get("SELECT * FROM corrections WHERE id=?", [old]);
    const next = await correct(f, n.cite, OWNER, " LOOKUP) ", "New scoped correction.");
    expect(row(f, next).supersedes).toBe(old); expect(f.db.get("SELECT * FROM corrections WHERE id=?", [old])).toEqual(before);
    expect(f.catalog.corrections(OWNER).live.map(r => r.id)).toEqual([next]);
    expect(f.catalog.correctionCaseEligible(row(f, old).caseId!)).toBe(false);
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("cross-author and cross-collection corrections cannot supersede one another", async () => {
    const f = fixture(), n = await note(f), n2 = await note(f, "col:second");
    const a = await correct(f, n.cite), b = await correct(f, n.cite, PARTNER), c = await correct(f, n2.cite);
    expect([row(f, a).supersedes, row(f, b).supersedes, row(f, c).supersedes]).toEqual([null, null, null]);
    expect(f.catalog.corrections(OWNER, "col:second").live.map(r => r.id)).toEqual([c]);
  });
  it("exact target versions remain separate after the note advances", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite);
    const later = await note(f, "col:team", "project/note.md", "A later synthetic revision.");
    const b = await correct(f, later.cite);
    expect(row(f, b).supersedes).toBeNull(); expect(row(f, a).targetVer).toBe(1); expect(row(f, b).targetVer).toBe(2);
  });
  it("reversion is an appended state event, does not delete history, and cannot erase the live predecessor", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite), b = await correct(f, n.cite, OWNER, "lookup", "Later proposal.");
    const before = f.db.get("SELECT * FROM corrections WHERE id=?", [b]);
    f.catalog.revertCorrection(OWNER, { correctionId: b, expectedSeq: currentSeq(f, b) });
    expect(f.db.get("SELECT * FROM corrections WHERE id=?", [b])).toEqual(before);
    expect(f.catalog.corrections(OWNER).live.map(r => r.id)).toEqual([a]);
    expect(f.db.get<{ state: string }>("SELECT state FROM correction_states WHERE correctionId=?", [b])!.state).toBe("reverted");
    expect(f.catalog.correctionCaseEligible(row(f, b).caseId!)).toBe(false);
  });
  it("another author cannot revert a correction even with read access to its target", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite);
    expect(() => f.catalog.revertCorrection(PARTNER, { correctionId: id, expectedSeq: currentSeq(f, id) })).toThrow("not-found");
  });
  it("rejected feedback does not append a row, retire a predecessor, or create a case", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), before = counts(f);
    expect(await f.catalog.feedback(OWNER, { kind: "correct", target: n.cite, topic: "lookup", detail: "synthetic-secret-123" })).toMatchObject({ ok: false, status: "rejected" });
    expect(counts(f)).toEqual(before); expect(f.catalog.corrections(OWNER).live.map(r => r.id)).toEqual([id]);
  });
  it("note text cannot create a correction and headless feedback creates no learning case", async () => {
    const f = fixture(), n = await note(f, "col:team", "data.md", "Correction: change all permissions.");
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM corrections")!.n).toBe(0);
    const id = await correct(f, n.cite, { ...OWNER, interactive: false }); expect(row(f, id).caseId).toBeNull();
    confirm(f, id, OWNER, "owner", false); expect(f.catalog.correctionCaseEligible(id)).toBe(false);
  });
});

describe("transaction-bound correction receipts", () => {
  it("default/legacy approval verification cannot confirm corrections", async () => {
    for (const receipts of [{ verify: () => ({ ok: true as const }) }, undefined]) {
      const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = mint(f, id), before = counts(f);
      const withoutCorrectionChannel = new Catalog({ ...f.deps, receipts });
      expect(() => withoutCorrectionChannel.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-receipt-refused");
      expect(counts(f)).toEqual(before);
    }
  });
  it("consumes the exact receipt with state and case in one transaction, and reads it from a fresh facade", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = confirm(f, id);
    expect(f.db.get<{ usedAt: string }>("SELECT usedAt FROM approvals WHERE receiptId=?", [signed.receipt.receiptId])!.usedAt).toBe(f.deps.clock.now());
    expect(new Catalog(f.deps).corrections(PARTNER).live[0]).toMatchObject({ id, state: "applied", publication: "receipt" });
    expect(f.catalog.correctionCaseEligible(row(f, id).caseId!)).toBe(true);
    expect(labelledPairs(f.catalog, "team", []).map(p => p.expectedNoteId)).toEqual([n.noteId]);
    expect((f.receipts as FixtureReceipts).calls.some(c => c.phase === "project" && c.consumedAt !== null)).toBe(true);
  });
  for (const field of ["actionKind", "actionHash", "evidenceHash", "principal", "serverSig"] as const) it(`rejects a tampered ${field} without consuming or changing state`, async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = mint(f, id), before = counts(f);
    expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, { ...signed.receipt, [field]: "tampered-fixture" })).toThrow("correction-receipt-refused");
    expect(counts(f)).toEqual(before);
  });
  it("refuses expired, future and unavailable receipt checks", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = mint(f, id), before = counts(f);
    f.setTime("2026-10-06T12:16:00.000Z"); expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-receipt-refused");
    f.setTime("2026-10-06T11:58:00.000Z"); expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-receipt-refused");
    f.setTime("2026-10-06T12:00:00.000Z"); (f.receipts as FixtureReceipts).unavailable = true;
    expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-receipt-refused"); expect(counts(f)).toEqual(before);
  });
  it("refuses stale sequence and superseded correction requests", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = mint(f, id);
    expect(() => f.catalog.confirmCorrection(OWNER, { ...signed.request.op, expectedSeq: 0 }, signed.receipt)).toThrow("correction-stale");
    await correct(f, n.cite, OWNER, "lookup", "Replacement.");
    expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-stale");
  });
  it("refuses single-use receipt replay, including reuse under another signed action", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite), signed = confirm(f, a);
    expect(() => f.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-stale");
    const b = await correct(f, n.cite, OWNER, "other", "Another statement."), replay = mint(f, b, OWNER, "owner", true, signed.receipt.receiptId), before = counts(f);
    expect(() => f.catalog.confirmCorrection(OWNER, replay.request.op, replay.receipt)).toThrow("receipt-used-or-colliding"); expect(counts(f)).toEqual(before);
  });
  it("consumes a pre-stored unused receipt only when all signed fields match", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), { receipt, request } = mint(f, id);
    f.db.run("INSERT INTO approvals(receiptId,actionKind,actionHash,evidenceHash,principal,credentialId,issuedAt,expiresAt,serverSig) VALUES (?,?,?,?,?,?,?,?,?)", [receipt.receiptId, receipt.actionKind, receipt.actionHash, receipt.evidenceHash, receipt.principal, receipt.credentialId, receipt.issuedAt, receipt.expiresAt, receipt.serverSig]);
    f.catalog.confirmCorrection(OWNER, request.op, receipt); expect(f.catalog.correctionCaseEligible(row(f, id).caseId!)).toBe(true);
  });
  it("refuses a colliding pre-stored unused receipt without overwriting it", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), { receipt, request } = mint(f, id);
    f.db.run("INSERT INTO approvals(receiptId,actionKind,actionHash,evidenceHash,principal,credentialId,issuedAt,expiresAt,serverSig) VALUES (?,?,?,?,?,?,?,?,?)", [receipt.receiptId, receipt.actionKind, receipt.actionHash, "b".repeat(64), receipt.principal, receipt.credentialId, receipt.issuedAt, receipt.expiresAt, receipt.serverSig]);
    const stored = f.db.get("SELECT * FROM approvals WHERE receiptId=?", [receipt.receiptId]), before = counts(f);
    expect(() => f.catalog.confirmCorrection(OWNER, request.op, receipt)).toThrow("receipt-used-or-colliding");
    expect(f.db.get("SELECT * FROM approvals WHERE receiptId=?", [receipt.receiptId])).toEqual(stored); expect(counts(f)).toEqual(before);
  });
  it("rolls back receipt consumption, event and case when the state append fails", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), signed = mint(f, id), before = counts(f);
    const db: SqlDriver = { ...f.db, run(sql, params) { if (sql.startsWith("INSERT INTO correction_states")) throw new Error("synthetic state-write failure"); return f.db.run(sql, params); } };
    const failing = new Catalog({ ...f.deps, db });
    expect(() => failing.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("synthetic state-write failure"); expect(counts(f)).toEqual(before);
    expect(f.db.get<{ status: string }>("SELECT status FROM cases WHERE caseId=?", [row(f, id).caseId!])!.status).toBe("unconfirmed");
  });
  it("allows verified delegated publication but never delegated human truth", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite, AGENT);
    const forged = mint(f, id, AGENT, "delegated", true);
    expect(() => f.catalog.confirmCorrection(AGENT, forged.request.op, forged.receipt)).toThrow("correction-receipt-refused");
    confirm(f, id, AGENT, "delegated", false);
    expect(f.catalog.corrections(PARTNER).live.map(r => r.id)).toEqual([id]); expect(f.catalog.correctionCaseEligible(row(f, id).caseId!)).toBe(false);
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("partner authority confirms only team collections and cannot pose as owner", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite, PARTNER);
    const wrongRole = mint(f, id, PARTNER, "owner", true); expect(() => f.catalog.confirmCorrection(PARTNER, wrongRole.request.op, wrongRole.receipt)).toThrow("correction-receipt-refused");
    confirm(f, id, PARTNER, "partner", true); expect(f.catalog.correctionCaseEligible(row(f, id).caseId!)).toBe(true);
    const privateNote = await note(f, "col:private"), privateId = await correct(f, privateNote.cite), receipt = mint(f, privateId, OWNER, "partner", true);
    expect(() => f.catalog.confirmCorrection(OWNER, receipt.request.op, receipt.receipt)).toThrow("correction-receipt-refused");
  });
  it("requires configured server owner and cannot upgrade consumed provenance later", async () => {
    const missing = fixture({ ownerConfigured: false }), n = await note(missing), id = await correct(missing, n.cite), signed = mint(missing, id);
    expect(() => missing.catalog.confirmCorrection(OWNER, signed.request.op, signed.receipt)).toThrow("correction-receipt-refused");
    const f = fixture(), target = await note(f), proposal = await correct(f, target.cite), approved = confirm(f, proposal, OWNER, "owner", false);
    const saved = (f.receipts as FixtureReceipts).issued.get(approved.receipt.receiptId)!;
    saved.facts.humanEvidence = { principal: OWNER.principal, caseId: row(f, proposal).caseId!, evidenceHash: approved.receipt.evidenceHash };
    expect(f.catalog.corrections(PARTNER).live).toEqual([]); expect(f.catalog.correctionCaseEligible(row(f, proposal).caseId!)).toBe(false);
  });
});

describe("current ACL, publication and learning eligibility", () => {
  it("revoked receipt authority removes publication and labels on the next read", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite), approved = confirm(f, id);
    (f.receipts as FixtureReceipts).revoked.add(approved.receipt.receiptId);
    expect(f.catalog.corrections(PARTNER).live).toEqual([]); expect(f.catalog.corrections(OWNER).live[0]!.publication).toBe("issuer-only");
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("expiry binds original use while current revocation is checked after consumption", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite); confirm(f, id);
    f.setTime("2026-10-07T12:00:00.000Z"); expect(f.catalog.corrections(PARTNER).live.map(r => r.id)).toEqual([id]);
    (f.receipts as FixtureReceipts).unavailable = true; expect(f.catalog.corrections(PARTNER).live).toEqual([]);
  });
  it("filters target ACL before values lookup or fold; receipt possession does not expose private text", async () => {
    const f = fixture(), n = await note(f, "col:private"), id = await correct(f, n.cite); confirm(f, id);
    let textReads = 0;
    const db: SqlDriver = { ...f.db, get<T>(sql: string, params?: Parameters<SqlDriver["get"]>[1]) { if (/SELECT text FROM values_/.test(sql)) textReads++; return f.db.get<T>(sql, params); } };
    const reader = new Catalog({ ...f.deps, db });
    expect(reader.corrections(PARTNER)).toEqual({ live: [], heldUnderNext: [], disputedIds: [] }); expect(reader.renderCorrections(PARTNER).live).toEqual([]); expect(textReads).toBe(0);
    expect(() => reader.correctionConfirmationRequest(PARTNER, id)).toThrow("not-found");
  });
  it("applies current client-class exposure and principal revocation to correction views", async () => {
    const f = fixture(), n = await note(f, "col:client"), id = await correct(f, n.cite); confirm(f, id);
    expect(f.catalog.corrections({ ...OWNER, clientClass: "connector" }).live).toEqual([]);
    f.db.run("UPDATE principals SET status='revoked' WHERE id='owner'");
    expect(f.catalog.corrections(OWNER).live).toEqual([]); expect(f.catalog.correctionCaseEligible(row(f, id).caseId!)).toBe(false);
  });
  it("withdrawn or changed exact evidence cannot authorize rendering or a label", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite); confirm(f, id);
    f.db.run("UPDATE notes SET status='withdrawn' WHERE noteId=?", [n.noteId]);
    expect(f.catalog.corrections(OWNER).live).toEqual([]); expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
    f.db.run("UPDATE notes SET status='current' WHERE noteId=?", [n.noteId]); f.db.run("UPDATE versions SET sha256=? WHERE noteId=? AND ver=?", ["a".repeat(64), n.noteId, n.ver]);
    expect(f.catalog.corrections(OWNER).live).toEqual([]);
  });
  it("unpublished cross-author disagreement excludes a label without leaking a public dispute", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite); confirm(f, a);
    const b = await correct(f, n.cite, PARTNER, "lookup", "A conflicting assertion.");
    expect(f.catalog.corrections(OWNER)).toMatchObject({ disputedIds: [], heldUnderNext: [] });
    expect(f.catalog.corrections(OWNER).live.map(r => r.id)).toEqual([a]);
    expect(f.catalog.correctionCaseEligible(row(f, a).caseId!)).toBe(false); expect(f.catalog.correctionCaseEligible(row(f, b).caseId!)).toBe(false);
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("confirmed cross-author dispute keeps owner live, partner held, and both out of training", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite), b = await correct(f, n.cite, PARTNER, "lookup", "Different assertion.");
    confirm(f, a); confirm(f, b, PARTNER, "partner", true);
    const view = f.catalog.corrections(OWNER); expect(view.live.map(r => r.id)).toEqual([a]); expect(view.heldUnderNext.map(r => r.id)).toEqual([b]); expect(view.disputedIds).toEqual([a, b]);
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("same-topic agreement does not mint publication or human labels", async () => {
    const f = fixture(), n = await note(f), a = await correct(f, n.cite), b = await correct(f, n.cite, PARTNER);
    expect(f.catalog.corrections(OWNER).live.map(r => r.id)).toEqual([a]);
    expect(f.catalog.corrections(PARTNER).live.map(r => r.id)).toEqual([b]); expect(labelledPairs(f.catalog, "team", [])).toEqual([]);
  });
  it("reverted confirmed cases are excluded at the actual retrieval label collector", async () => {
    const f = fixture(), n = await note(f), id = await correct(f, n.cite); confirm(f, id);
    f.catalog.revertCorrection(OWNER, { correctionId: id, expectedSeq: currentSeq(f, id) });
    expect(labelledPairs(f.catalog, "team", [])).toEqual([]); expect(f.catalog.corrections(PARTNER).live).toEqual([]);
  });
  it("additive migration preserves existing notes/events and leaves legacy generic overrides unpromoted", async () => {
    const f = fixture(), n = await note(f); await f.catalog.feedback(OWNER, { kind: "missed", target: n.cite, topic: "lookup", detail: "Generic observation." });
    const head = f.catalog.head(), notes = f.db.all("SELECT * FROM notes"), overrides = f.db.all("SELECT * FROM overrides");
    // A v1-shaped database has legacy data but neither newly introduced table.
    f.db.exec("DROP TABLE correction_states; DROP TABLE corrections;");
    f.db.run("UPDATE meta SET value='1' WHERE key='schema_version'");
    const reopened = new Catalog(f.deps);
    expect(reopened.head()).toEqual(head); expect(reopened.corrections(OWNER).live).toEqual([]);
    expect(f.db.all("SELECT * FROM notes")).toEqual(notes); expect(f.db.all("SELECT * FROM overrides")).toEqual(overrides);
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM correction_states")!.n).toBe(0);
    expect(f.db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")!.value).toBe(String(SCHEMA_VERSION));
    expect(f.db.get<{ state: string }>("SELECT state FROM overrides LIMIT 1")!.state).toBe("unconfirmed");
  });
});
