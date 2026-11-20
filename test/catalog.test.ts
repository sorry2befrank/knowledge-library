import { describe, it, expect, beforeAll } from "vitest";
import { ApplyRefused, ContentInPayloadError, assertContentFree, parseCitation, type Catalog } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, type LoadReport } from "./helpers/load.ts";

const fx = generateFixtures();
let catalog: Catalog, report: LoadReport;

beforeAll(async () => {
  ({ catalog } = newCatalog(fx));
  report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
});

describe("save → read (A1 text, A2 citations)", () => {
  it("admits what the guard admits and rejects what it rejects, with nothing stored for rejects", async () => {
    const expectedRejected = fx.notes.filter((n) => (n.folder === "synth-desk" || n.folder === "frank-journal") && n.expected.admission === "rejected");
    expect(report.rejected.size).toBe(expectedRejected.length);
    expect(report.refused.size).toBe(0);
    for (const n of expectedRejected) expect(await catalog.blobs.has((await import("@kl/core")).sha256Hex(n.body))).toBe(false);
  });
  it("reads back exact bytes by citation and verifies the hash on read", async () => {
    const n = fx.notes.find((x) => x.title === "rate-card-2026")!;
    const a = report.admitted.get(n.noteId)!;
    const r = await catalog.read(FRANK_CONNECTOR, a.cite);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.text).toBe(n.body); expect(r.sha256).toBe(a.sha256); expect(r.freshness.liveness).toBe("last-known"); expect(r.freshness.role).toBe("note"); expect(r.freshness.lastPushAt).toBe(r.freshness.publishedAt); expect(r.role).toBe("note"); }
  });
  it("dedupes identical bytes and advances only when bytes differ", async () => {
    const first = await catalog.save(FRANK_CONNECTOR, { content: "# Dedup\nsame", path: "inbox/dedup.md" });
    const again = await catalog.save(FRANK_CONNECTOR, { content: "# Dedup\nsame", path: "inbox/dedup.md" });
    const changed = await catalog.save(FRANK_CONNECTOR, { content: "# Dedup\ndifferent", path: "inbox/dedup.md" });
    expect(first.ok && again.ok && changed.ok).toBe(true);
    if (first.ok && again.ok && changed.ok) { expect(again.deduped).toBe(true); expect(again.ver).toBe(1); expect(changed.ver).toBe(2); expect(changed.deduped).toBe(false); }
  });
  it("a rename keeps the citation working; the hit shows the new path", async () => {
    const n = fx.notes.find((x) => x.title === "payment-terms")!;
    const a = report.admitted.get(n.noteId)!;
    catalog.rename(FRANK, a.noteId, "synth-desk/finance/payment-terms-renamed.md");
    await catalog.dispatchOutbox();
    const r = await catalog.read(FRANK_CONNECTOR, a.cite);
    expect(r.ok && r.text === n.body && r.path === "synth-desk/finance/payment-terms-renamed.md").toBe(true);
    const s = catalog.search(FRANK_CONNECTOR, "payment terms", { k: 20 });
    const hit = s.hits.find((h) => h.noteId === a.noteId);
    expect(hit?.path).toBe("synth-desk/finance/payment-terms-renamed.md");
    expect(hit?.cite).toBe(a.cite);
  });
  it("version-not-found never returns the latest; a denied note is not-found", async () => {
    const n = fx.notes.find((x) => x.title === "rate-card-2026")!;
    const a = report.admitted.get(n.noteId)!;
    const missing = await catalog.read(FRANK_CONNECTOR, `kl:${a.noteId}@99`);
    expect(missing).toEqual({ ok: false, error: "version-not-found" });
    const bytes = await catalog.readBytes(FRANK_CONNECTOR, a.noteId, 99);
    expect(bytes).toEqual({ ok: false, error: "version-not-found" });
    const bogus = await catalog.read(FRANK_CONNECTOR, "kl:0000000000@1");
    expect(bogus).toEqual({ ok: false, error: "not-found" });
  });
  it("a tampered span hash is corrupt-object, a good one resolves", async () => {
    const n = fx.notes.find((x) => x.title === "rate-card-2026")!;
    const a = report.admitted.get(n.noteId)!;
    const good = await catalog.read(FRANK_CONNECTOR, a.cite);
    const bad = await catalog.read(FRANK_CONNECTOR, a.cite.replace(/~[0-9a-f]{8}$/, "~00000000"));
    expect(good.ok).toBe(true); expect(bad).toEqual({ ok: false, error: "corrupt-object" });
    const c = parseCitation(a.cite)!;
    const lines = await catalog.read(FRANK_CONNECTOR, `kl:${c.noteId}@${c.ver}#L1-L2`);
    expect(lines.ok && lines.text === n.body.split("\n").slice(0, 2).join("\n")).toBe(true);
  });
  it("divergent saves become siblings with status conflict; a pushed-folder save without baseVer is a proposed-edit", async () => {
    const n = fx.notes.find((x) => x.title === "invoice-export")!;
    const a = report.admitted.get(n.noteId)!;
    const proposed = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nedit from MCP", path: `${n.folder}/${n.relPath}`, collection: n.collection });
    expect(proposed.ok && proposed.status === "proposed-edit").toBe(true);
    const missingBase = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nstale base", path: `${n.folder}/${n.relPath}`, collection: n.collection, baseVer: a.ver + 7 });
    expect(missingBase).toMatchObject({ ok: false, status: "refused", reason: "base-version-not-found" });
    // make v+1 current, then save against the older existing version: a sibling
    const advance = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nadvance", path: `${n.folder}/${n.relPath}`, collection: n.collection, baseVer: a.ver });
    expect(advance.ok && advance.status === "current").toBe(true);
    const sibling = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nstale base", path: `${n.folder}/${n.relPath}`, collection: n.collection, baseVer: a.ver });
    expect(sibling.ok && sibling.status === "sibling").toBe(true);
    const siblingAgain = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nstale base", path: `${n.folder}/${n.relPath}`, collection: n.collection, baseVer: a.ver });
    expect(siblingAgain.ok && siblingAgain.deduped && siblingAgain.ver === (sibling.ok ? sibling.ver : -1)).toBe(true); // non-current saves are idempotent too
    const cur = await catalog.read(FRANK_CONNECTOR, a.noteId);
    expect(cur.ok && cur.ver === (advance.ok ? advance.ver : -1) && cur.status === "conflict").toBe(true); // currentVer did not advance past the proper edit
    const ok = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nproper edit", path: `${n.folder}/${n.relPath}`, collection: n.collection, baseVer: advance.ok ? advance.ver : 0 });
    expect(ok.ok && ok.status === "current" && ok.ver > a.ver).toBe(true);
  });
  it("idempotencyKey makes a retried save return the same version", async () => {
    const a = await catalog.save(FRANK_CONNECTOR, { content: "retry me", idempotencyKey: "k-1" });
    const b = await catalog.save(FRANK_CONNECTOR, { content: "retry me", idempotencyKey: "k-1" });
    expect(a.ok && b.ok && a.noteId === b.noteId && a.ver === b.ver).toBe(true);
  });
  it("refuses a collection outside the principal's allowed set", async () => {
    const r = await catalog.save({ principal: "partner", clientClass: "connector" }, { content: "x", collection: "col:frank-journal" });
    expect(r).toMatchObject({ ok: false, status: "refused", reason: "collection.not-allowed" });
  });
});

describe("ledger (A12 content-free, chain)", () => {
  it("the chain verifies and every payload is content-free", () => {
    const v = catalog.verifyChain();
    expect(v.ok).toBe(true);
    expect(catalog.head().seq).toBeGreaterThan(100);
  });
  it("rejects text in payloads at runtime", () => {
    expect(() => assertContentFree({ title: "Hello world, a real title" })).toThrow(ContentInPayloadError);
    expect(() => assertContentFree({ noteId: "7QK2M9X4AB", sha: "a".repeat(64), n: 3, kind: "version.create" })).not.toThrow();
    expect(() => assertContentFree({ x: 1.5 })).toThrow(ContentInPayloadError);
  });
  it("mutating SQL outside apply() is not how rows change: apply() refuses outside its gates", () => {
    expect(() => catalog.apply(FRANK, { kind: "principal" }, { kind: "case.create", capability: "retrieval", scopeId: "global", privacy: "team", groupKey: "g", lineageKey: "l", inputRef: "x", frozenFeatures: {}, expected: {}, sourceSignals: [], author: "frank" })).toThrow(ApplyRefused);
  });
});

describe("consequential actions need a receipt (A17 shape, S1: no approval channel)", () => {
  it("after setup is sealed, collection.create needs a receipt, and the S1 verifier refuses every receipt", () => {
    const { catalog: c } = newCatalog(fx);
    c.sealSetup();
    expect(c.inSetupMode()).toBe(false);
    expect(() => c.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:x", class: "team" })).toThrow(/receipt-required/);
    const fake = { receiptId: "r1", actionKind: "collection.create", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "sig" };
    expect(() => c.apply(FRANK, { kind: "receipt", receipt: fake }, { kind: "collection.create", collectionId: "col:x", class: "team" })).toThrow(/receipt-refused:no-approval-channel/);
    expect(() => c.apply(FRANK, { kind: "receipt", receipt: fake }, { kind: "note.withdraw", noteId: "7QK2M9X4AB" })).toThrow(/no-approval-channel/);
  });
});
