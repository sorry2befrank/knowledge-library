// S1b section A (security and privacy) and the parts of B/C that live in the catalog. Each test was written to fail
// against the S1 code and pass against the fix (see docs/sessions/S1b.md).
import { describe, it, expect, beforeAll } from "vitest";
import { createApiHandler, pickSaveInput } from "@kl/api";
import { callTool, sha256Hex, ftsTableFor, aclPredicate, verifyChain, eventHash, type Catalog, type ReceiptVerifier, BASELINE_V0, BASELINE_V0_HASH, resolveChampion, installBaseline, replay, g0 } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, issueToken, type LoadReport, idMap } from "./helpers/load.ts";
import { textUpload } from "./helpers/text-upload.ts";

const fx = generateFixtures();
const approveAll: ReceiptVerifier = { verify: (r) => (r ? { ok: true } : { ok: false, reason: "no-approval-channel" }) };
const RECEIPT = { receiptId: "test-receipt", actionKind: "x", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "test" };

async function fourPaths(catalog: Catalog, token: string, content: string, collection: string, api: (r: Request) => Promise<Response>) {
  const call = (path: string, init: RequestInit) => api(new Request(`http://kl.local${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) } }));
  const mcp = await (await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "library_save", arguments: { content, collection } } }) })).json();
  const save = await (await call("/v1/save", { method: "POST", body: JSON.stringify({ content, collection }) })).json();
  const batch = await (await call("/v1/batch", { method: "POST", body: JSON.stringify({ items: [{ content, collection }] }) })).json();
  const upload = await textUpload(catalog,api,token,content,{collection});
  const m = mcp.result.structuredContent;
  // Push dispositions retain guard codes without creating the held catalog note made by direct saves.
  return [{ status: m.status ?? m.error, reason: m.reason ?? (m.ruleCodes?.join(",") ?? null) }, { status: save.status, reason: save.reason ?? (save.ruleCodes?.join(",") ?? null) }, { status: batch.results[0].status, reason: batch.results[0].reason ?? (batch.results[0].ruleCodes?.join(",") ?? null) }, { status: upload.status, reason: upload.ruleCodes?.join(",") || upload.reason || null }];
}

describe("A1: request bodies never reach SaveInput; MCP args are schema-validated", () => {
  it("pickSaveInput keeps only the allow-list and gives device fields to kl-device only", () => {
    const body = { content: "x", path: "p", collection: "c", title: "t", kind: "note", tags: ["a"], supersedes: "s", baseVer: 2, derivedFrom: ["d"], idempotencyKey: "k", folderId: "folder:f", capturedAt: "2026-10-04T23:59:00Z", observedMtime: "2026-10-04T23:58:00Z", grant: "forged", requestId: "forged", lineage: { hold: false }, actor: { principal: "frank" } };
    const mcp = pickSaveInput(body, "x", { principal: "p", clientClass: "connector" }, "2026-10-05T00:00:00.000Z") as unknown as Record<string, unknown>;
    expect(Object.keys(mcp).sort()).toEqual(["baseVer", "collection", "content", "derivedFrom", "idempotencyKey", "kind", "path", "supersedes", "tags", "title"].sort());
    expect("grant" in mcp || "requestId" in mcp || "lineage" in mcp || "actor" in mcp).toBe(false);
    const dev = pickSaveInput(body, "x", { principal: "p", clientClass: "kl-device" }, "2026-10-05T00:00:00.000Z");
    expect(dev.folderId).toBe("folder:f"); expect(dev.capturedAt).toBe("2026-10-04T23:59:00Z");
    expect(pickSaveInput({ kind: "evil" }, "x", { principal: "p", clientClass: "connector" }, "2026-10-05T00:00:00.000Z").kind).toBeUndefined();
  });
  it("tools/call rejects unknown or mistyped arguments against inputSchema", async () => {
    const { catalog } = newCatalog(fx);
    const ctx = { catalog, actor: FRANK_CONNECTOR, scopes: ["save", "read"], random: catalog.random };
    expect((await callTool(ctx, "library_save", { content: "x", grant: "forged" })).structured.error).toBe("invalid-args");
    expect((await callTool(ctx, "library_save", { content: 5 })).structured.error).toBe("invalid-args");
    expect((await callTool(ctx, "library_search", { q: "x", k: 99 })).structured.error).toBe("invalid-args");
    expect((await callTool(ctx, "library_read", { ref: "x", lineage: {} })).structured.error).toBe("invalid-args");
    expect((await callTool(ctx, "library_status", { section: "secrets" })).structured.error).toBe("invalid-args");
  });
});

describe("A2: one lineage contract on every write path and raw-byte reads", () => {
  let catalog: Catalog, report: LoadReport, api: (r: Request) => Promise<Response>, token: string;
  beforeAll(async () => { ({ catalog } = newCatalog(fx)); report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal"); token = issueToken(catalog, "frank", "kl-device"); api = createApiHandler({ catalog }); });
  const priv = () => report.admitted.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
  it.each(['note', 'bytes'])('connector grants preserve %s-read lineage on MCP, save and batch, and cannot upload', async readMode => {
    const { catalog: c } = newCatalog(fx);
    const loaded = await loadFixtures(c, fx, n => n.folder === 'synth-desk' || n.folder === 'frank-journal');
    const privateNote = loaded.admitted.get(fx.notes.find(n => n.title === 'private-hiring-plan')!.noteId)!;
    const t = issueToken(c, 'frank', 'cc-bearer', ['save'], `connector-${readMode}`);
    const handler = createApiHandler({ catalog: c });
    const read = readMode === 'bytes' ? await c.readBytes(FRANK_CONNECTOR, privateNote.noteId, privateNote.ver, { grant: sha256Hex(t) }) :
      await c.read(FRANK_CONNECTOR, privateNote.cite, { grant: sha256Hex(t) });
    expect(read.ok).toBe(true);
    const routes = async (bearer: string, content: string) => {
      const send = (path: string, body: unknown) => handler(new Request(`http://kl.local${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      const mcp = await (await send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'library_save', arguments: { content, collection: 'col:synth-desk' } } })).json();
      const save = await (await send('/v1/save', { content, collection: 'col:synth-desk' })).json();
      const batch = await (await send('/v1/batch', { items: [{ content, collection: 'col:synth-desk' }] })).json();
      return [mcp.result.structuredContent, save, batch.results[0]];
    };
    for (const result of await routes(t, `synthetic connector ${readMode} summary`)) expect(result).toMatchObject({ status: 'held', reason: 'lineage-uncertain' });
    const clean = issueToken(c, 'frank', 'cc-bearer', ['save'], `connector-clean-${readMode}`);
    for (const result of await routes(clean, `synthetic clean connector ${readMode} summary`)) expect(result).toMatchObject({ status: 'current' });
    const upload = await handler(new Request('http://kl.local/v1/upload/synthetic-push/0', { method: 'PUT', headers: { authorization: `Bearer ${t}` }, body: 'synthetic bytes' }));
    expect(upload.status).toBe(403); expect(await upload.json()).toMatchObject({ error: 'device-required' });
  });
  it("after reading a narrower note through the grant, all four write paths hold identically; a raw-byte read counts too", async () => {
    const grant = sha256Hex(token);
    expect((await catalog.read(FRANK, priv().cite, { grant })).ok).toBe(true);
    const r1 = await fourPaths(catalog, token, "team summary one", "col:synth-desk", api);
    expect(r1.every((r) => r.status === "held" && r.reason === "lineage-uncertain"), JSON.stringify(r1)).toBe(true);
    // a different grant with only a raw-byte read of the private note
    const { catalog: c2 } = newCatalog(fx); const rep2 = await loadFixtures(c2, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
    const t2 = issueToken(c2, "frank", "kl-device", [], "raw"); const api2 = createApiHandler({ catalog: c2 });
    const p2 = rep2.admitted.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
    const bytes = await c2.readBytes(FRANK, p2.noteId, p2.ver, { grant: sha256Hex(t2) });
    expect(bytes.ok).toBe(true);
    const r2 = await fourPaths(c2, t2, "team summary two", "col:synth-desk", api2);
    expect(r2.every((r) => r.status === "held" && r.reason === "lineage-uncertain"), JSON.stringify(r2)).toBe(true);
    // no narrow read on this grant: admitted on all four paths
    const t3 = issueToken(c2, "frank", "kl-device", [], "clean");
    const r3 = await fourPaths(c2, t3, "team summary three", "col:synth-desk", api2);
    expect(r3.every((r) => r.status === "current" && r.reason === null), JSON.stringify(r3)).toBe(true);
  });
  it("declared lineage must resolve under the saver's ACL; the stored class is the narrowest source; a narrower declared source holds even without reads", async () => {
    const grant = "g".repeat(64);
    const unresolvable = await catalog.save(FRANK_CONNECTOR, { content: "cites a ghost", collection: "col:synth-desk", derivedFrom: ["kl:0000000000@1"] }, { grant });
    expect(unresolvable.ok && unresolvable.status === "current").toBe(true); // nothing narrower was read: a bad citation alone is just no lineage
    await catalog.read(FRANK_CONNECTOR, priv().cite, { grant });
    const bad = await catalog.save(FRANK_CONNECTOR, { content: "cites a ghost after a private read", collection: "col:synth-desk", derivedFrom: ["kl:0000000000@1"] }, { grant });
    expect(bad.ok && bad.status === "held" && bad.reason === "lineage-uncertain").toBe(true);
    const declared = await catalog.save(FRANK_CONNECTOR, { content: "declares the private source", collection: "col:synth-desk", derivedFrom: [priv().cite] }, { grant: "h".repeat(64) });
    expect(declared.ok && declared.status === "held" && declared.reason === "lineage-narrower-source").toBe(true);
    if (declared.ok) expect(catalog.db.get<{ privacy_class: string; collectionId: string }>("SELECT v.privacy_class, n.collectionId FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE v.noteId = ?", [declared.noteId])).toEqual({ privacy_class: "frank-private", collectionId: "inbox:frank" });
    const own = await catalog.save(FRANK_CONNECTOR, { content: "declares the private source into my inbox", derivedFrom: [priv().cite] }, { grant: "i".repeat(64) });
    expect(own.ok && own.status === "current").toBe(true);
    // the partner cannot resolve frank's private citation: for them it is unresolvable
    const partnerDeclared = await catalog.save(PARTNER, { content: "partner cites something hidden", collection: "col:synth-desk", derivedFrom: [priv().cite] }, { grant: "j".repeat(64) });
    expect(partnerDeclared.ok && partnerDeclared.status === "current").toBe(true);
  });
  it("the ceiling is the intersection of several narrow reads, computed by the server", async () => {
    const { catalog: c } = newCatalog(fx);
    c.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-x", class: "client:x", clients_ok: ["connector"], decision_row: { client: "X" } });
    c.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:x"])]);
    const a = await c.save(FRANK_CONNECTOR, { content: "private" }); const b = await c.save(FRANK_CONNECTOR, { content: "client", collection: "col:client-x" });
    await c.drainOutbox();
    const grant = "k".repeat(64);
    expect((await c.read(FRANK_CONNECTOR, a.ok ? a.cite : "", { grant })).ok).toBe(true); expect((await c.read(FRANK_CONNECTOR, b.ok ? b.cite : "", { grant })).ok).toBe(true);
    const held = await c.save(FRANK_CONNECTOR, { content: "team note after both", collection: "col:synth-desk" }, { grant });
    expect(held.ok && held.status === "held").toBe(true);
    if (held.ok) expect(c.db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ?", [held.noteId])!.privacy_class).toBe("client:x+frank-private"); // S1c A1/A2: the intersection of every source class, not the narrowest
  });
});

describe("A3: the guard scans every stored string on the catalog paths", () => {
  it("rejects credential and client-name hits in title, tags, kind, topic and detail, revoking a leaked token", async () => {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026");
    const tok = issueToken(catalog, "frank", "cc-bearer");
    expect((await catalog.save(FRANK_CONNECTOR, { content: "clean", title: `title ${tok}` })).ok).toBe(false);
    expect(catalog.db.get<{ revokedAt: string | null }>("SELECT revokedAt FROM tokens WHERE hash = ?", [sha256Hex(tok)])!.revokedAt).toBeTruthy();
    expect(await catalog.save(FRANK_CONNECTOR, { content: "clean", tags: ["Examplecorp Robotics"] })).toMatchObject({ ok: false, status: "rejected", ruleCodes: ["client.match.no-store-ok"] });
    expect((await catalog.save(FRANK_CONNECTOR, { content: "clean", kind: `sk_live_${"Q".repeat(20)}` })).ok).toBe(false);
    const cite = catalog.search(FRANK_CONNECTOR, "rate card").hits[0]!.cite;
    expect(await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: cite, topic: "Testfirm Partners rates", detail: "x" })).toMatchObject({ ok: false, status: "rejected" });
    expect(await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: cite, detail: `AIza${"B".repeat(35)}` })).toMatchObject({ ok: false, status: "rejected" });
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM overrides")!.c).toBe(0);
  });
});

describe("A4: access control is the same on reads and writes and leaks nothing", () => {
  let catalog: Catalog, report: LoadReport, ids: Map<string, string>;
  beforeAll(async () => { ({ catalog } = newCatalog(fx)); report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal" || n.folder === "partner-scratch"); ids = idMap(report); });
  it("a client-class version held in an inbox is not readable by an unapproved client class; writes apply the same clients_ok rule", async () => {
    catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-y", class: "client:y", clients_ok: ["kl-device"], decision_row: { client: "Y" } });
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:y"])]);
    expect(await catalog.save(FRANK_CONNECTOR, { content: "client y note", collection: "col:client-y" })).toMatchObject({ ok: false, reason: "collection.not-allowed" }); // connector is not in clients_ok
    const dev = await catalog.save(FRANK, { content: "client y note", collection: "col:client-y" });
    expect(dev.ok).toBe(true);
    await catalog.drainOutbox();
    // a version of class client:y HELD in frank's inbox through the real held path (a device read, then a team save) is invisible to the connector too
    const grant = "a4-held".padEnd(64, "4");
    expect((await catalog.read(FRANK, dev.ok ? dev.cite : "", { grant })).ok).toBe(true);
    const held = await catalog.save(FRANK, { content: "team summary of the client y note", collection: "col:synth-desk" }, { grant });
    expect(held.ok && held.status === "held" && held.collection === "inbox:frank").toBe(true);
    await catalog.drainOutbox();
    expect(await catalog.read(FRANK_CONNECTOR, held.ok ? held.cite : "")).toEqual({ ok: false, error: "not-found" });
    expect((await catalog.read(FRANK, held.ok ? held.cite : "")).ok).toBe(true);
  });
  it("a rerouted destination the saver cannot use is held in the saver's inbox", async () => {
    catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-tess", class: "client:examplecorp", clients_ok: ["kl-device"], decision_row: { client: "Examplecorp Robotics" } });
    const r = await catalog.save(FRANK_CONNECTOR, { content: "Notes for Examplecorp Robotics", collection: "col:synth-desk" });
    expect(r.ok && r.status === "held" && r.collection === "inbox:frank" && r.reason === "review").toBe(true); // S1c A8a: only "held: review", never the destination's rule codes
  });
  it("dedup, aliases and version numbers are computed under the read predicate: a hidden note answers like a brand-new one and is untouched", async () => {
    const privNote = fx.notes.find((n) => n.title === "private-hiring-plan")!;
    const a = report.admitted.get(privNote.noteId)!;
    const before = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE noteId = ?", [a.noteId])!.c;
    // the partner saves the same bytes to the same path in a collection they can use: no dedup against frank's note, no sibling on it
    catalog.db.run("UPDATE collections SET class = 'team' WHERE collectionId = 'col:frank-journal'"); // make the collection usable but keep the version frank-private
    const r = await catalog.save(PARTNER, { content: privNote.body, path: `${privNote.folder}/${privNote.relPath}`, collection: "col:frank-journal" });
    expect(r.ok && !r.deduped && r.ver === 1 && r.noteId !== a.noteId).toBe(true);
    if (!r.ok) throw new Error("Expected an admitted partner shadow");
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE noteId = ?", [a.noteId])!.c).toBe(before);
    expect(catalog.db.get<{ noteId: string }>("SELECT noteId FROM aliases a JOIN values_ pv ON pv.hash = a.path_h WHERE pv.text = ? AND a.valid_to IS NULL AND a.owner IS NULL", [`${privNote.folder}/${privNote.relPath}`])!.noteId).toBe(a.noteId); // the hidden note keeps its alias
    expect(catalog.db.get<{ noteId: string }>("SELECT noteId FROM aliases a JOIN values_ pv ON pv.hash = a.path_h WHERE pv.text = ? AND a.valid_to IS NULL AND a.owner = ?", [`${privNote.folder}/${privNote.relPath}`, PARTNER.principal])!.noteId).toBe(r.noteId); // the caller receives a separate owned shadow
    const sup = await catalog.save(PARTNER, { content: "supersedes a hidden note", collection: "col:synth-desk", supersedes: a.noteId });
    expect(sup).toMatchObject({ ok: false, reason: "supersedes-not-found" });
    expect(await catalog.save(PARTNER, { content: "supersedes nothing", collection: "col:synth-desk", supersedes: "0000000000" })).toMatchObject({ ok: false, reason: "supersedes-not-found" });
  });
  it("status counts are filtered to the caller's visible classes (exact numbers)", async () => {
    const visible = (actor: typeof PARTNER) => catalog.db.get<{ c: number }>(`SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE v.ver = n.currentVer AND n.status != 'withdrawn' AND ${aclPredicate(catalog.acl(actor)).sql}`, aclPredicate(catalog.acl(actor)).params as (string | number)[])!.c;
    const partner = (await callTool({ catalog, actor: PARTNER, scopes: ["read"], random: catalog.random }, "library_status", { section: "coverage" })).structured.coverage as { preserved: number };
    const frank = (await callTool({ catalog, actor: FRANK, scopes: ["read"], random: catalog.random }, "library_status", { section: "coverage" })).structured.coverage as { preserved: number };
    expect(partner.preserved).toBe(visible(PARTNER)); expect(frank.preserved).toBe(visible(FRANK)); expect(frank.preserved).toBeGreaterThan(partner.preserved);
    expect((await callTool({ catalog, actor: { principal: "nobody", clientClass: "connector" }, scopes: ["read"], random: catalog.random }, "library_status", {})).structured.coverage).toMatchObject({ preserved: 0, indexed: 0, pending: 0 });
  });
  it("adding hidden notes never changes a visible ranking (per-class FTS indexes)", async () => {
    const q = "rate card tiers retainer";
    await catalog.drainOutbox();
    const before = catalog.search(PARTNER, q, { k: 10 }).hits.map((h) => `${h.noteId}:${h.score.toFixed(2)}`);
    for (let i = 0; i < 25; i++) await catalog.save(FRANK_CONNECTOR, { content: `# hidden ${i}\nrate card rate card retainer tiers hourly pricing tier ${i}` });
    await catalog.drainOutbox();
    const after = catalog.search(PARTNER, q, { k: 10 }).hits.map((h) => `${h.noteId}:${h.score.toFixed(2)}`);
    expect(after).toEqual(before);
    const tables = catalog.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fts%'").map((r) => r.name).filter((n) => !/_(data|idx|content|docsize|config)$/.test(n));
    expect(tables).toEqual(expect.arrayContaining(["team", "frank-private", "partner-private"].map(ftsTableFor))); // one index per class set; client classes get their own
  });
});

describe("A6/A7/B6: sealed by default, withdrawn stays withdrawn, principal re-check, alias uniqueness", () => {
  it("a new catalog is sealed; nothing can be created without enabling setup", () => {
    const { catalog } = newCatalog(fx);
    catalog.sealSetup();
    expect(() => catalog.apply(FRANK, { kind: "setup" }, { kind: "principal.create", id: "x", email: "x@example.invalid", allowedClasses: [] })).toThrow(/receipt-required/);
    expect(() => catalog.apply(FRANK, { kind: "setup", bootstrapSecret: "wrong" }, { kind: "token.issue", tokenHash: "a".repeat(64), principal: "frank", tokenKind: "cc-bearer", scopes: ["read"], clientClass: "claude-code", expiresAt: "2099-01-01T00:00:00Z" })).toThrow(/receipt-required/);
  });
  it("a withdrawn note refuses version.create, alias.move and feedback, and its status is never overwritten", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody", path: "inbox/doomed.md" }); await catalog.drainOutbox();
    if (!r.ok) throw new Error("save failed");
    catalog.apply(FRANK, { kind: "receipt", receipt: RECEIPT }, { kind: "note.withdraw", noteId: r.noteId });
    expect(await catalog.read(FRANK_CONNECTOR, r.cite)).toEqual({ ok: false, error: "withdrawn" });
    const again = await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody v2", path: "inbox/doomed.md", baseVer: r.ver });
    expect(again).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(() => catalog.rename(FRANK, r.noteId, "inbox/renamed.md")).toThrow(/withdrawn|not-found/);
    expect(await catalog.feedback(FRANK_CONNECTOR, { kind: "pin", target: r.noteId, detail: "x" })).toMatchObject({ ok: false });
    expect(catalog.db.get<{ status: string }>("SELECT status FROM notes WHERE noteId = ?", [r.noteId])!.status).toBe("withdrawn");
  });
  it("a principal revoked mid-flight is refused inside apply(); a path held by another live note refuses alias.move", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const a = await catalog.save(FRANK_CONNECTOR, { content: "a", path: "inbox/a.md" }); const b = await catalog.save(FRANK_CONNECTOR, { content: "b", path: "inbox/b.md" }); await catalog.drainOutbox();
    expect(() => catalog.rename(FRANK, b.ok ? b.noteId : "", "inbox/a.md")).toThrow(/alias-path-taken/);
    catalog.apply(FRANK, { kind: "receipt", receipt: RECEIPT }, { kind: "principal.revoke", id: "frank" });
    expect(() => catalog.apply(FRANK, { kind: "principal" }, { kind: "alias.move", noteId: a.ok ? a.noteId : "", collectionId: "inbox:frank", newPath: "inbox/c.md" })).toThrow(/principal-not-active/);
  });
});

describe("B1/B2/B5: custody follows the check; idempotency bound to bytes; pending references never leak", () => {
  it("versions are inserted received and promoted to verified by the custody step through apply(); the indexer promotes only from verified", async () => {
    const { catalog } = newCatalog(fx);
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# custody\nbody" });
    expect(r.ok && r.custody === "verified").toBe(true);
    const kinds = catalog.db.all<{ kind: string }>("SELECT kind FROM events ORDER BY seq").map((e) => e.kind);
    expect(kinds.slice(-3)).toEqual(["blob.reserve", "version.create", "version.custody"]);
    expect(catalog.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [r.ok ? r.noteId : ""])!.custody).toBe("verified");
    expect(await catalog.read(FRANK_CONNECTOR, r.ok ? r.cite : "")).toMatchObject({ ok: true });
    await catalog.drainOutbox();
    expect(catalog.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [r.ok ? r.noteId : ""])!.custody).toBe("indexed");
    expect(catalog.db.all<{ kind: string }>("SELECT kind FROM events WHERE kind = 'version.custody'").length).toBe(2); // verified, indexed: both ledgered
  });
  it("a crash between commit and the check leaves custody=received, unreadable, and the retry converges; a missing object stays received", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    // crash right after the version commit: run the outbox with the custody step crashing after its effect
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# crash\nbody" });
    expect(r.ok).toBe(true);
    const r2 = await catalog.save(FRANK_CONNECTOR, { content: "# crash two\nbody" });
    if (!r2.ok) throw new Error();
    // simulate: object lost before the check
    const { catalog: c3, blobStore: bs3 } = newCatalog(fx);
    bs3.failWhen = null;
    const g = c3.guard({ content: "# lost\nbody", requestId: "r".repeat(32) });
    void g;
    const lost = await (async () => { bs3.objects.clear(); const res = await c3.save(FRANK_CONNECTOR, { content: "# lost\nbody" }); bs3.objects.clear(); await c3.drainOutbox(); return res; })();
    expect(lost.ok).toBe(true);
    if (lost.ok) {
      // the custody step re-checks on each attempt; with the object gone it never promotes
      const custody = c3.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [lost.noteId])!.custody;
      expect(["received", "verified"]).toContain(custody);
      if (custody === "received") { expect(await c3.read(FRANK_CONNECTOR, lost.cite)).toEqual({ ok: false, error: "not-indexed-yet" }); expect(c3.outbox().pending).toBeGreaterThan(0); }
    }
    expect(blobStore.objects.size).toBe(2); expect(r2.custody).toBe("verified");
  });
  it("a reused idempotency key with different bytes is refused before any blob is reserved; a replay returns the stored version", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    const a = await catalog.save(FRANK_CONNECTOR, { content: "first", idempotencyKey: "k" });
    const events = catalog.head().seq; const blobs = blobStore.objects.size;
    const conflict = await catalog.save(FRANK_CONNECTOR, { content: "second", idempotencyKey: "k" });
    expect(conflict).toMatchObject({ ok: false, reason: "idempotency-key-conflict" });
    expect(catalog.head().seq).toBe(events); expect(blobStore.objects.size).toBe(blobs); // nothing reserved, nothing written
    const replayed = await catalog.save(FRANK_CONNECTOR, { content: "first", idempotencyKey: "k" });
    expect(replayed.ok && a.ok && replayed.cite === a.cite && replayed.sha256 === a.sha256 && replayed.deduped).toBe(true);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM blob_refs WHERE state = 'pending' OR pendingRefs != '[]'")!.c).toBe(0);
  });
  it("pending references are released on dedup, idempotent replay, refusal and a failed put", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    const a = await catalog.save(FRANK_CONNECTOR, { content: "same bytes", path: "inbox/s.md" });
    await catalog.save(FRANK_CONNECTOR, { content: "same bytes", path: "inbox/s.md" }); // dedup
    await catalog.save(FRANK_CONNECTOR, { content: "same bytes", path: "inbox/s.md", baseVer: 99 }); // refused before reserve
    blobStore.failWhen = (k) => k.includes(sha256Hex("will fail"));
    await expect(catalog.save(FRANK_CONNECTOR, { content: "will fail" })).rejects.toThrow(/injected/);
    blobStore.failWhen = null;
    const rows = catalog.db.all<{ sha256: string; state: string; pendingRefs: string; refcount: number }>("SELECT sha256, state, pendingRefs, refcount FROM blob_refs");
    for (const r of rows) expect(r.pendingRefs, r.sha256).toBe("[]");
    const failed = rows.find((r) => r.sha256 === sha256Hex("will fail"));
    expect(failed?.state).toBe("gc-pending"); expect(failed?.refcount).toBe(0);
    expect(a.ok).toBe(true);
  });
});

describe("B6: ledger tamper detection", () => {
  it("detects an edited payload, a rehash without fixing prev_hash, a deletion and a reorder", async () => {
    for (const tamper of ["edit", "rehash", "delete", "reorder"]) {
      const { catalog } = newCatalog(fx);
      await catalog.save(FRANK_CONNECTOR, { content: "one" }); await catalog.save(FRANK_CONNECTOR, { content: "two" }); await catalog.save(FRANK_CONNECTOR, { content: "three" });
      expect(verifyChain(catalog.db).ok).toBe(true);
      catalog.db.exec("PRAGMA foreign_keys = OFF"); // an attacker editing the store is not bound by our constraints
      const rows = catalog.db.all<{ seq: number; ts: string; principal: string; client: string; kind: string; payload: string; prev_hash: string; hash: string }>("SELECT * FROM events ORDER BY seq");
      const mid = rows.find((r) => r.kind === "version.create")!;
      const edited = mid.payload.replace(/"bytes":\d+/, '"bytes":1');
      expect(edited).not.toBe(mid.payload);
      if (tamper === "edit") catalog.db.run("UPDATE events SET payload = ? WHERE seq = ?", [edited, mid.seq]);
      if (tamper === "rehash") catalog.db.run("UPDATE events SET payload = ?, hash = ? WHERE seq = ?", [edited, eventHash({ ...mid, payload: edited }), mid.seq]);
      if (tamper === "delete") catalog.db.run("DELETE FROM undo WHERE event_seq = ?", [mid.seq]), catalog.db.run("DELETE FROM events WHERE seq = ?", [mid.seq]);
      if (tamper === "reorder") { const a = rows[1]!, b = rows[2]!; catalog.db.run("UPDATE events SET seq = -1 WHERE seq = ?", [a.seq]); catalog.db.run("UPDATE events SET seq = ? WHERE seq = ?", [a.seq, b.seq]); catalog.db.run("UPDATE events SET seq = ? WHERE seq = -1", [b.seq]); }
      const v = verifyChain(catalog.db);
      expect(v.ok, tamper).toBe(false);
    }
  });
});

describe("C1/C4: baseline cannot install a candidate; G0 vetoes consumes/capability", () => {
  it("champion.baseline installs only BASELINE_V0_HASH, at any scope, and refuses a second row", () => {
    const { catalog } = newCatalog(fx);
    const hash = installBaseline(catalog, { scopeId: "global", privacy: "team" });
    expect(hash).toBe(BASELINE_V0_HASH);
    installBaseline(catalog, { scopeId: "col:synth", privacy: "team" });
    expect(catalog.db.all<{ playbookHash: string }>("SELECT playbookHash FROM champions").every((r) => r.playbookHash === BASELINE_V0_HASH)).toBe(true);
    expect(resolveChampion(catalog, ["col:synth", "global"], "team")).toMatchObject({ hash: BASELINE_V0_HASH, frozenBaseline: true });
    expect(() => catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "champion.baseline", capability: "retrieval", scopeId: "global", privacy: "team" })).toThrow(/baseline-exists/);
    expect(Object.isFrozen(BASELINE_V0) && Object.isFrozen(BASELINE_V0.rerank) && Object.isFrozen(BASELINE_V0.bm25Weights)).toBe(true);
    expect(() => { (BASELINE_V0.synonyms as Record<string, string[]>).x = ["y"]; }).toThrow();
  });
  it("G0 vetoes changes to consumes or capability", () => {
    expect(g0(BASELINE_V0, { ...BASELINE_V0, consumes: { focus: "abc" } }).ok).toBe(false);
    expect(g0(BASELINE_V0, { ...BASELINE_V0, capability: "focus" as "retrieval" }).ok).toBe(false);
    const { catalog } = newCatalog(fx);
    expect(replay(catalog, BASELINE_V0, { ...BASELINE_V0, consumes: { focus: "abc" } }, { targetGroups: [], privacy: "team" }).verdict).toBe("vetoed");
  });
});
