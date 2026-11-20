// S1c section B (data integrity). Each test was written to FAIL against the S1b code and pass against the fix.
import { describe, it, expect } from "vitest";
import { HARD_ALARM_ATTEMPTS, STEP_KINDS, callTool, clientClassFor, authenticate, sha256Hex, type OutboxRow, type ReceiptVerifier } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, idMap, issueToken } from "./helpers/load.ts";
import { findMutations } from "../scripts/lib/mutating-sql.ts";

const fx = generateFixtures();
const approveAll: ReceiptVerifier = { verify: (r) => (r ? { ok: true } : { ok: false, reason: "no-approval-channel" }) };
const RECEIPT = { receiptId: "test-receipt", actionKind: "x", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "test" };

describe("B1: a proposal applied in the vault, then pushed", () => {
  it("a push with baseVer == currentVer whose bytes match a pending proposal promotes it to current; the next push is not a conflict", async () => {
    const { catalog } = newCatalog(fx);
    const n = fx.notes.find((x) => x.title === "invoice-export")!;
    const report = await loadFixtures(catalog, fx, (x) => x.title === "invoice-export");
    const a = report.admitted.get(n.noteId)!;
    const path = `${n.folder}/${n.relPath}`;
    const proposed = await catalog.save(FRANK_CONNECTOR, { content: n.body + "\nedit from MCP", path, collection: n.collection });
    expect(proposed.ok && proposed.status === "proposed-edit").toBe(true);
    if (!proposed.ok) return;
    // Frank applies the proposal in the vault and kl pushes the same bytes against the current version
    const pushed = await catalog.save(FRANK, { content: n.body + "\nedit from MCP", path, collection: n.collection, folderId: `folder:${n.folder}`, baseVer: a.ver });
    expect(pushed.ok && pushed.status === "current" && pushed.ver === proposed.ver, JSON.stringify(pushed)).toBe(true);
    expect(catalog.db.get<{ currentVer: number; status: string }>("SELECT currentVer, status FROM notes WHERE noteId = ?", [a.noteId])).toEqual({ currentVer: proposed.ver, status: "current" });
    expect(catalog.db.get<{ vstatus: string }>("SELECT vstatus FROM versions WHERE noteId = ? AND ver = ?", [a.noteId, proposed.ver])!.vstatus).toBe("current");
    // the next push (same bytes, baseVer = the new current) is a plain dedup, never a conflict sibling
    const again = await catalog.save(FRANK, { content: n.body + "\nedit from MCP", path, collection: n.collection, folderId: `folder:${n.folder}`, baseVer: proposed.ver });
    expect(again.ok && again.deduped && again.status === "current" && again.ver === proposed.ver, JSON.stringify(again)).toBe(true);
    const next = await catalog.save(FRANK, { content: n.body + "\nedit from MCP\nand more", path, collection: n.collection, folderId: `folder:${n.folder}`, baseVer: proposed.ver });
    expect(next.ok && next.status === "current" && next.ver === proposed.ver + 1, JSON.stringify(next)).toBe(true);
    expect(catalog.db.get<{ status: string }>("SELECT status FROM notes WHERE noteId = ?", [a.noteId])!.status).toBe("current");
  });
});

describe("B2: a hidden note holding a path", () => {
  it("three identical saves to a path a hidden note holds give one note at version 1, deduped twice, with the hidden note untouched", async () => {
    const { catalog } = newCatalog(fx);
    const privNote = fx.notes.find((n) => n.title === "private-hiring-plan")!;
    const report = await loadFixtures(catalog, fx, (n) => n.title === "private-hiring-plan");
    const hidden = report.admitted.get(privNote.noteId)!;
    catalog.db.run("UPDATE collections SET class = 'team' WHERE collectionId = 'col:frank-journal'"); // usable by the partner; the version stays frank-private
    const path = `${privNote.folder}/${privNote.relPath}`;
    const before = catalog.db.all("SELECT * FROM versions WHERE noteId = ?", [hidden.noteId]);
    const saves = [];
    for (let i = 0; i < 3; i++) saves.push(await catalog.save(PARTNER, { content: "# partner's own note\nat the same path", path, collection: "col:frank-journal" }));
    expect(saves.every((s) => s.ok)).toBe(true);
    const ids = new Set(saves.map((s) => (s.ok ? s.noteId : "")));
    expect(ids.size, JSON.stringify(saves)).toBe(1);
    expect(saves.map((s) => (s.ok ? `${s.ver}:${s.deduped}` : "fail"))).toEqual(["1:false", "1:true", "1:true"]);
    expect(catalog.db.all("SELECT * FROM versions WHERE noteId = ?", [hidden.noteId])).toEqual(before);
    expect(catalog.db.get<{ noteId: string }>("SELECT noteId FROM aliases a JOIN values_ pv ON pv.hash = a.path_h WHERE pv.text = ? AND a.valid_to IS NULL AND a.owner IS NULL", [path])!.noteId).toBe(hidden.noteId);
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM notes WHERE collectionId = 'col:frank-journal'")!.c).toBe(2);
    // the partner's note resolves by citation and shows its path
    const r = await catalog.read(PARTNER, saves[0]!.ok ? saves[0]!.cite : "");
    expect(r.ok && r.path === path).toBe(true);
  });
});

describe("B3: blob states", () => {
  it("two failed puts in a row leave gc-pending with no pending reference; the reservation on a gc-pending row is pending, not live", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    const sha = sha256Hex("will fail twice");
    blobStore.failWhen = (k) => k.endsWith(sha);
    const states: string[] = [];
    const origApply = catalog.apply.bind(catalog);
    catalog.apply = ((actor, authority, op) => { const r = origApply(actor, authority, op); if (op.kind === "blob.reserve" && op.sha256 === sha) states.push(catalog.db.get<{ state: string }>("SELECT state FROM blob_refs WHERE sha256 = ?", [sha])!.state); return r; }) as typeof catalog.apply;
    for (let i = 0; i < 2; i++) await expect(catalog.save(FRANK_CONNECTOR, { content: "will fail twice" })).rejects.toThrow(/injected/);
    expect(states).toEqual(["pending", "pending"]);
    expect(catalog.db.get("SELECT state, refcount, pendingRefs FROM blob_refs WHERE sha256 = ?", [sha])).toEqual({ state: "gc-pending", refcount: 0, pendingRefs: "[]" });
  });
  it("two refused saves in a row (refused inside apply, after the reservation) leave gc-pending", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const doomed = await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody" });
    if (!doomed.ok) throw new Error();
    catalog.apply(FRANK, { kind: "receipt", receipt: RECEIPT }, { kind: "note.withdraw", noteId: doomed.noteId });
    const sha = sha256Hex("supersedes a withdrawn note");
    for (let i = 0; i < 2; i++) expect(await catalog.save(FRANK_CONNECTOR, { content: "supersedes a withdrawn note", supersedes: doomed.noteId })).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(catalog.db.get("SELECT state, refcount, pendingRefs FROM blob_refs WHERE sha256 = ?", [sha])).toEqual({ state: "gc-pending", refcount: 0, pendingRefs: "[]" });
  });
});

describe("B4: crash tests that actually crash", () => {
  it("a crash between commit and the check leaves custody=received and the version unreadable; a crash after the check's effect converges", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    blobStore.failWhenGet = (k) => k.startsWith("blobs/"); // the post-commit HEAD cannot run: the process died (or storage is down) right after the commit
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# crash\nbody" });
    blobStore.failWhenGet = null;
    expect(r.ok && r.custody === "received", JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(catalog.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [r.noteId])!.custody).toBe("received");
    expect(await catalog.read(FRANK_CONNECTOR, r.cite)).toEqual({ ok: false, error: "not-indexed-yet" });
    expect(await catalog.readBytes(FRANK_CONNECTOR, r.noteId, r.ver)).toEqual({ ok: false, error: "not-indexed-yet" });
    expect(catalog.search(FRANK_CONNECTOR, "crash body").hits.length).toBe(0);
    const pending = catalog.db.get<{ step: string; attempts: number }>("SELECT step, attempts FROM outbox WHERE state = 'pending' ORDER BY id LIMIT 1")!;
    expect(pending).toEqual({ step: "custody.verify", attempts: 1 });
    // crash AFTER the effect of custody.verify (the promotion is in the ledger, the outbox row is not done), then redispatch
    const first = await catalog.dispatchOutbox({ ignoreBackoff: true, crashAfterEffect: (row: OutboxRow) => row.step === "custody.verify" });
    expect(first.crashed).toBe(true);
    expect(catalog.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [r.noteId])!.custody).toBe("verified");
    expect(catalog.db.get<{ state: string }>("SELECT state FROM outbox WHERE step = 'custody.verify'")!.state).toBe("pending");
    await catalog.drainOutbox();
    expect(catalog.outbox()).toMatchObject({ pending: 0 });
    expect(catalog.db.get<{ custody: string }>("SELECT custody FROM versions WHERE noteId = ?", [r.noteId])!.custody).toBe("indexed");
    expect(catalog.db.all<{ kind: string }>("SELECT kind FROM events WHERE kind = 'version.custody'").length).toBe(2); // verified once, indexed once: the retry was a no-op
    expect((await catalog.read(FRANK_CONNECTOR, r.cite)).ok).toBe(true);
  });
  it("the crash matrix includes custody.verify as a PENDING step", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "payment-terms", { dispatch: false, deferCustody: blobStore });
    const pendingKinds = new Set(catalog.db.all<{ step: string }>("SELECT DISTINCT step FROM outbox WHERE state = 'pending'").map((r) => r.step));
    expect(pendingKinds).toEqual(new Set(["custody.verify", "index.version", "mirror.meta"]));
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody = 'received'")!.c).toBeGreaterThan(0);
    void STEP_KINDS;
  });
  it("an unverified version is unreadable to everyone, including its saver", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    blobStore.failWhenGet = (k) => k.startsWith("blobs/");
    const r = await catalog.save(FRANK, { content: "# unverified\nbody", collection: "col:synth-desk" });
    blobStore.failWhenGet = null;
    if (!r.ok) throw new Error();
    expect(r.custody).toBe("received");
    for (const actor of [FRANK, FRANK_CONNECTOR, PARTNER]) expect(await catalog.read(actor, r.cite)).toEqual({ ok: false, error: "not-indexed-yet" });
  });
  it("a guard-hit token revocation is checkpointed to authz/<seq>.json before save() returns", async () => {
    const { catalog } = newCatalog(fx);
    const token = issueToken(catalog, "frank", "cc-bearer", [], "ack");
    const before = (await catalog.mirror.list("authz/")).length;
    const r = await catalog.save(FRANK_CONNECTOR, { content: `leaked ${token}` });
    expect(r).toMatchObject({ ok: false, status: "rejected" });
    const after = await catalog.mirror.list("authz/");
    expect(after.length).toBe(before + 1); // written before the response, not left for a later dispatch
    const cp = JSON.parse(new TextDecoder().decode((await catalog.mirror.get(after.at(-1)!))!));
    expect(cp.kind).toBe("token.revoke"); expect(cp.minPolicyEpoch).toBe(0); expect(JSON.stringify(cp)).not.toContain(token);
    expect(authenticate(catalog.db, token, catalog.clock.now())).toEqual({ ok: false, reason: "revoked" });
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM outbox WHERE state = 'pending' AND step = 'authz.checkpoint'")!.c).toBe(0);
  });
  it("cx-bearer is stamped with client class codex at issue", () => {
    const { catalog } = newCatalog(fx);
    expect(clientClassFor("cc-bearer")).toBe("claude-code"); expect(clientClassFor("cx-bearer")).toBe("codex"); expect(clientClassFor("kl-device")).toBe("kl-device");
    const token = issueToken(catalog, "partner", "cx-bearer", [], "cx");
    expect(authenticate(catalog.db, token, catalog.clock.now())).toMatchObject({ ok: true, principal: "partner", clientClass: "codex", tokenKind: "cx-bearer", scopes: ["read"] });
  });
});

describe("B5: status alarms", () => {
  it("library_status counts failed authz.checkpoint and evidence.publish rows, counts a stuck version once, and reports received versions as pending coverage", async () => {
    const { catalog, blobStore, mirror } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026");
    const ids = idMap(report);
    const okId = ids.get(fx.notes.find((n) => n.title === "rate-card-2026")!.noteId)!;
    // a version whose object is unreadable: custody.verify AND index.version keep failing (two rows, one version)
    blobStore.failWhenGet = (k) => k.startsWith("blobs/") && !k.endsWith(catalog.db.get<{ sha256: string }>("SELECT sha256 FROM versions WHERE noteId = ?", [okId])!.sha256);
    const stuck = await catalog.save(FRANK_CONNECTOR, { content: "# stuck\nbody", collection: "col:synth-desk" });
    expect(stuck.ok && stuck.custody === "received").toBe(true);
    // a token revocation whose checkpoint cannot be written
    const hash = sha256Hex(issueToken(catalog, "frank", "cc-bearer", [], "b5"));
    mirror.failWhen = (k) => k.startsWith("authz/");
    catalog.apply({ principal: "system", clientClass: "kl-device" }, { kind: "system" }, { kind: "token.revoke", tokenHash: hash, reason: "owner" });
    for (let i = 0; i < HARD_ALARM_ATTEMPTS + 1; i++) await catalog.dispatchOutbox({ ignoreBackoff: true });
    expect(catalog.outbox().hardAlarms).toBe(3); // custody.verify + index.version for the stuck version, plus the checkpoint
    const st = await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read"], random: catalog.random }, "library_status", {});
    const s = st.structured as { passdown: { BLOCKED: { custodyFailures: number; checkpointFailures: number; coverageGaps: number } }; coverage: { pending: number; indexed: number; preserved: number } };
    expect(s.passdown.BLOCKED.custodyFailures).toBe(1); // once per version, not per outbox row
    expect(s.passdown.BLOCKED.checkpointFailures).toBe(1);
    expect(s.coverage.pending).toBe(1); // the received version
    expect(s.coverage.preserved).toBe(2); expect(s.coverage.indexed).toBe(1);
    expect(s.passdown.BLOCKED.coverageGaps).toBe(1);
    blobStore.failWhenGet = null; mirror.failWhen = null;
  });
});

describe("B6: the mutating-SQL lint", () => {
  it("flags DELETE FROM main.notes, SQL after a // inside a string, and an UPDATE whose SET comes late", () => {
    expect(findMutations(`db.run("DELETE FROM main.notes WHERE noteId = ?")`).map((m) => `${m.verb} ${m.table}`)).toEqual(["DELETE main.notes"]);
    expect(findMutations(`const url = "https://x.invalid/"; db.run("UPDATE notes SET status = 'x'")`).map((m) => `${m.verb} ${m.table}`)).toEqual(["UPDATE notes"]);
    const late = `db.run("UPDATE notes ${" ".repeat(130)} SET status = 'withdrawn' WHERE noteId = ?")`;
    expect(findMutations(late).map((m) => `${m.verb} ${m.table}`)).toEqual(["UPDATE notes"]);
    // JavaScript property deletes are not SQL; real comments are stripped
    expect(findMutations(`delete m.durationMs; // DELETE FROM events\n/* UPDATE x SET y */`)).toEqual([]);
    expect(findMutations(`// prose: update the notes that need it\nconst x = 1;`)).toEqual([]);
    expect(findMutations(`db.run("INSERT OR IGNORE INTO outbox(a) VALUES (?)")`).map((m) => `${m.verb} ${m.table}`)).toEqual(["INSERT outbox"]);
  });
});
