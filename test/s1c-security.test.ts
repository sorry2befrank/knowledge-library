// S1c section A (security and privacy). Each test was written to FAIL against the S1b code (fa7a2bd) and pass
// against the fix; the turnover names how each one was seen failing (see docs/sessions/S1c.md).
import { describe, it, expect } from "vitest";
import { createApiHandler, pickSaveInput, MULTIPART_MAX_PARTS } from "@kl/api";
import { callTool, sha256Hex, ftsTableFor, produceEvidence, designSpec, saveCandidate, installBaseline, BASELINE_V0, BASELINE_V0_HASH, type Catalog, type ReceiptVerifier, type Actor } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, issueToken, FixedClock } from "./helpers/load.ts";

const fx = generateFixtures();
const SYS: Actor = { principal: "system", clientClass: "kl-device" };
const FRANK_CC: Actor = { principal: "frank", clientClass: "claude-code", interactive: true };
const approveAll: ReceiptVerifier = { verify: (r) => (r ? { ok: true } : { ok: false, reason: "no-approval-channel" }) };
const RECEIPT = { receiptId: "test-receipt", actionKind: "x", actionHash: "0".repeat(64), evidenceHash: "0".repeat(64), principal: "frank", credentialId: "c", issuedAt: "2026-10-05T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", serverSig: "test" };

function clientCollection(catalog: Catalog, id: string, cls: string, clientsOk: string[], client = cls.replace("client:", "Client ")) {
  catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: id, class: cls, clients_ok: clientsOk, decision_row: { client, decidedAt: "2026-10-05", receiptId: "rcpt-synthetic" } });
}
function allow(catalog: Catalog, principal: string, classes: string[]) { catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = ?", [JSON.stringify(classes), principal]); }
const cite = (r: Awaited<ReturnType<Catalog["save"]>>) => (r.ok ? r.cite : (() => { throw new Error(`save failed: ${JSON.stringify(r)}`); })());
const classesOf = (catalog: Catalog, noteId: string) => catalog.db.all<{ class: string }>("SELECT class FROM version_classes WHERE noteId = ? ORDER BY class", [noteId]).map((r) => r.class);

describe("A1: a lineage hold keeps the client class (read ceiling = intersection of client class and every source class)", () => {
  async function setup() {
    const { catalog } = newCatalog(fx);
    clientCollection(catalog, "col:client-tess", "client:examplecorp", ["kl-device"], "Examplecorp Robotics");
    clientCollection(catalog, "col:client-z", "client:z", ["connector", "kl-device"]);
    allow(catalog, "frank", ["team", "frank-private", "client:examplecorp", "client:z"]);
    const z = await catalog.save(FRANK, { content: "# z note\nclient z material", collection: "col:client-z" }); await catalog.drainOutbox();
    return { catalog, zCite: cite(z) };
  }
  for (const route of ["read-triggered", "declared"] as const) {
    it(`${route}: the held copy is unreadable to a client class approved for the source but not the client, readable to one approved for both`, async () => {
      const { catalog, zCite } = await setup();
      const grant = `${route}-grant`.padEnd(64, "g");
      let held;
      if (route === "read-triggered") { expect((await catalog.read(FRANK_CONNECTOR, zCite, { grant })).ok).toBe(true); held = await catalog.save(FRANK_CONNECTOR, { content: "Notes for Examplecorp Robotics after reading z", collection: "col:synth-desk" }, { grant }); }
      else held = await catalog.save(FRANK_CONNECTOR, { content: "Notes for Examplecorp Robotics derived from z", collection: "col:synth-desk", derivedFrom: [zCite] }, { grant });
      expect(held.ok && held.status === "held" && held.collection === "inbox:frank", JSON.stringify(held)).toBe(true);
      if (!held.ok) return;
      await catalog.drainOutbox();
      expect(classesOf(catalog, held.noteId)).toEqual(["client:examplecorp", "client:z"]);
      expect(await catalog.read(FRANK_CONNECTOR, held.cite)).toEqual({ ok: false, error: "not-found" }); // connector: approved for z, not for examplecorp
      expect((await catalog.read(FRANK, held.cite)).ok).toBe(true); // kl-device: approved for both
    });
  }
});

describe("A2: classes that cannot be compared are held, and the held copy needs every source class", () => {
  async function setup() {
    const { catalog } = newCatalog(fx);
    clientCollection(catalog, "col:client-x", "client:x", ["connector", "kl-device"]);
    clientCollection(catalog, "col:client-y", "client:y", ["connector", "kl-device", "claude-code"]); // claude-code: approved for y only
    allow(catalog, "frank", ["team", "frank-private", "client:x", "client:y"]);
    const x = await catalog.save(FRANK, { content: "# x note\nclient x material", collection: "col:client-x" });
    const y = await catalog.save(FRANK, { content: "# y note\nclient y material", collection: "col:client-y" });
    await catalog.drainOutbox();
    return { catalog, x: cite(x), y: cite(y) };
  }
  for (const order of ["x-then-y", "y-then-x"] as const) {
    for (const dest of ["col:synth-desk", "col:client-y"] as const) {
      it(`${order}, saving to ${dest}: held with ceiling {client:x, client:y}; a class approved for y only reads neither copy`, async () => {
        const { catalog, x, y } = await setup();
        const grant = `${order}-${dest}`.padEnd(64, "k");
        for (const c of order === "x-then-y" ? [x, y] : [y, x]) expect((await catalog.read(FRANK_CONNECTOR, c, { grant })).ok).toBe(true);
        const r = await catalog.save(FRANK_CONNECTOR, { content: `summary after reading both (${order}, ${dest})`, collection: dest }, { grant });
        expect(r.ok && r.status === "held" && r.collection === "inbox:frank", JSON.stringify(r)).toBe(true);
        if (!r.ok) return;
        await catalog.drainOutbox();
        expect(classesOf(catalog, r.noteId)).toEqual(["client:x", "client:y"]);
        expect((await catalog.read(FRANK_CONNECTOR, r.cite)).ok).toBe(true); // approved for both
        expect(await catalog.read(FRANK_CC, r.cite)).toEqual({ ok: false, error: "not-found" }); // approved for y only
        expect(catalog.search(FRANK_CC, "summary after reading both", { k: 10 }).hits.some((h) => h.noteId === r.noteId)).toBe(false);
      });
    }
  }
  it("a single incomparable source (x read, save to client:y) is held like a narrower flow", async () => {
    const { catalog, x } = await setup();
    const grant = "single".padEnd(64, "s");
    await catalog.read(FRANK_CONNECTOR, x, { grant });
    const r = await catalog.save(FRANK_CONNECTOR, { content: "x-derived note for y", collection: "col:client-y" }, { grant });
    expect(r.ok && r.status === "held" && r.reason === "lineage-uncertain").toBe(true);
    if (r.ok) { expect(classesOf(catalog, r.noteId)).toEqual(["client:x", "client:y"]); expect(await catalog.read(FRANK_CC, r.cite)).toEqual({ ok: false, error: "not-found" }); }
  });
});

describe("A3: reads follow the same clients_ok rule as writes", () => {
  for (const order of ["P-then-Q", "Q-then-P"] as const) {
    it(`${order}: two client:x collections with different clients_ok; a class refused a write cannot read the collection either`, async () => {
      const { catalog } = newCatalog(fx);
      const mk = { P: () => clientCollection(catalog, "col:x-p", "client:x", ["connector"]), Q: () => clientCollection(catalog, "col:x-q", "client:x", ["kl-device"]) };
      if (order === "P-then-Q") { mk.P(); mk.Q(); } else { mk.Q(); mk.P(); }
      allow(catalog, "frank", ["team", "frank-private", "client:x"]);
      expect(await catalog.save(FRANK_CONNECTOR, { content: "into q", collection: "col:x-q" })).toMatchObject({ ok: false, reason: "collection.not-allowed" });
      const q = await catalog.save(FRANK, { content: "# q note\nonly devices", collection: "col:x-q" });
      const p = await catalog.save(FRANK_CONNECTOR, { content: "# p note\nconnectors may", collection: "col:x-p" });
      await catalog.drainOutbox();
      expect(await catalog.read(FRANK_CONNECTOR, cite(q))).toEqual({ ok: false, error: "not-found" }); // refused the write: refused the read
      expect((await catalog.read(FRANK_CONNECTOR, cite(p))).ok).toBe(true); // its own collection's clients_ok
      expect((await catalog.read(FRANK, cite(q))).ok).toBe(true);
      expect(catalog.search(FRANK_CONNECTOR, "q note only devices", { k: 10 }).hits.some((h) => h.noteId === (q.ok ? q.noteId : ""))).toBe(false);
      // a client:x version HELD in another collection needs every decision row of client:x to admit the class
      const grant = "held".padEnd(64, "h");
      await catalog.read(FRANK, cite(q), { grant });
      const held = await catalog.save(FRANK, { content: "team summary after a q read", collection: "col:synth-desk" }, { grant });
      expect(held.ok && held.status === "held").toBe(true);
      await catalog.drainOutbox();
      expect(await catalog.read(FRANK, cite(held))).toEqual({ ok: false, error: "not-found" }); // P does not admit kl-device
    });
  }
  it("a client or founders collection without a decision row refuses writes", async () => {
    const { catalog } = newCatalog(fx);
    catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-nodec", class: "client:nodec", clients_ok: ["kl-device", "connector"] });
    catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:founders-nodec", class: "founders", clients_ok: ["kl-device"] });
    allow(catalog, "frank", ["team", "frank-private", "client:nodec", "founders"]);
    expect(await catalog.save(FRANK, { content: "no decision row", collection: "col:client-nodec" })).toMatchObject({ ok: false, reason: "collection.not-allowed" });
    expect(await catalog.save(FRANK, { content: "founders without a row", collection: "col:founders-nodec" })).toMatchObject({ ok: false, reason: "collection.not-allowed" });
  });
});

describe("A4: search hits count as reads", () => {
  it("a search whose hits include a narrower note records reads for the grant, so a later broader save is held", async () => {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
    const grant = "search-grant".padEnd(64, "q");
    const r = await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read", "save"], random: catalog.random, grant }, "library_search", { q: "private hiring plan candidate scorecard", k: 5 });
    expect(r.isError).toBe(false);
    const priv = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM reads WHERE grant_h = ? AND privacy_class = 'frank-private'", [grant])!.c;
    expect(priv).toBeGreaterThan(0);
    const held = await catalog.save(FRANK_CONNECTOR, { content: "team summary after only a search", collection: "col:synth-desk" }, { grant });
    expect(held.ok && held.status === "held" && held.reason === "lineage-uncertain", JSON.stringify(held)).toBe(true);
  });
});

describe("A5: idempotent replay under the caller's access; keys bind on dedup too", () => {
  it("a replay of a key whose version the caller cannot read is refused, never ok with an unreadable cite", async () => {
    const { catalog } = newCatalog(fx);
    clientCollection(catalog, "col:client-y", "client:y", ["kl-device"]);
    allow(catalog, "frank", ["team", "frank-private", "client:y"]);
    const dev = await catalog.save(FRANK, { content: "client y bytes", collection: "col:client-y", idempotencyKey: "key-y" });
    expect(dev.ok).toBe(true);
    const replay = await catalog.save(FRANK_CONNECTOR, { content: "client y bytes", idempotencyKey: "key-y" }); // the inbox is usable; the key's version is not visible
    expect(replay).toMatchObject({ ok: false, status: "refused", reason: "held-for-review" });
    expect(JSON.stringify(replay)).not.toContain(dev.ok ? dev.noteId : "never");
  });
  it("a held save replays as held with its real collection", async () => {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.title === "private-hiring-plan");
    const priv = catalog.search(FRANK_CONNECTOR, "private hiring plan").hits[0]!.cite;
    const grant = "replay-held".padEnd(64, "r");
    await catalog.read(FRANK_CONNECTOR, priv, { grant });
    const first = await catalog.save(FRANK_CONNECTOR, { content: "held team summary", collection: "col:synth-desk", idempotencyKey: "key-held" }, { grant });
    expect(first.ok && first.status === "held" && first.collection === "inbox:frank").toBe(true);
    const again = await catalog.save(FRANK_CONNECTOR, { content: "held team summary", collection: "col:synth-desk", idempotencyKey: "key-held" }, { grant: "other".padEnd(64, "o") });
    expect(again.ok && again.deduped && again.status === "held" && again.collection === "inbox:frank", JSON.stringify(again)).toBe(true);
  });
  it("a key whose first use hit dedup is still bound to its bytes", async () => {
    const { catalog } = newCatalog(fx);
    await catalog.save(FRANK_CONNECTOR, { content: "same bytes", path: "inbox/same.md" });
    const dedup = await catalog.save(FRANK_CONNECTOR, { content: "same bytes", path: "inbox/same.md", idempotencyKey: "key-dedup" });
    expect(dedup.ok && dedup.deduped).toBe(true);
    expect(await catalog.save(FRANK_CONNECTOR, { content: "different bytes", idempotencyKey: "key-dedup" })).toMatchObject({ ok: false, reason: "idempotency-key-conflict" });
  });
});

describe("A6: withdrawn notes refuse identical bytes too", () => {
  it("exact bytes to a withdrawn note's path return withdrawn, like different bytes", async () => {
    const { catalog } = newCatalog(fx, { receipts: approveAll });
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody", path: "inbox/doomed.md", idempotencyKey: "doomed" }); await catalog.drainOutbox();
    if (!r.ok) throw new Error("save failed");
    catalog.apply(FRANK, { kind: "receipt", receipt: RECEIPT }, { kind: "note.withdraw", noteId: r.noteId });
    expect(await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody", path: "inbox/doomed.md" })).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody", path: "inbox/doomed.md", idempotencyKey: "doomed" })).toMatchObject({ ok: false, reason: "withdrawn" });
    expect(await catalog.save(FRANK_CONNECTOR, { content: "# doomed\nbody v2", path: "inbox/doomed.md", baseVer: r.ver })).toMatchObject({ ok: false, reason: "withdrawn" });
  });
});

describe("A7: device fields are validated and scanned", () => {
  const dev: Actor = { principal: "frank", clientClass: "kl-device" };
  const now = "2026-10-05T12:00:00.000Z";
  it("capturedAt and observedMtime must be strict ISO-8601 UTC, parseable and at most 5 minutes ahead; folderId must match the folder-id pattern", () => {
    const ok = pickSaveInput({ capturedAt: "2026-10-05T11:59:00Z", observedMtime: "2026-10-05T11:58:00.250Z", folderId: "folder:synth-desk" }, "x", dev, now);
    expect(ok).toMatchObject({ capturedAt: "2026-10-05T11:59:00Z", observedMtime: "2026-10-05T11:58:00.250Z", folderId: "folder:synth-desk" });
    for (const bogus of ["2020", "2026-10-05 11:59:00", "2026-10-05T11:59:00+02:00", "2026-13-40T11:59:00Z", "not a date", 42]) {
      const r = pickSaveInput({ capturedAt: bogus, observedMtime: bogus }, "x", dev, now);
      expect(r.capturedAt, String(bogus)).toBeUndefined(); expect(r.observedMtime, String(bogus)).toBeUndefined();
    }
    const future = pickSaveInput({ capturedAt: "2026-10-05T12:06:00Z", observedMtime: "2027-01-01T00:00:00Z" }, "x", dev, now);
    expect(future.capturedAt).toBeUndefined(); expect(future.observedMtime).toBeUndefined();
    expect(pickSaveInput({ capturedAt: "2026-10-05T12:04:59Z" }, "x", dev, now).capturedAt).toBe("2026-10-05T12:04:59Z");
    for (const bad of ["evil string", "folder:", "../x", `folder:${"a".repeat(200)}`, "Examplecorp Robotics"]) expect(pickSaveInput({ folderId: bad }, "x", dev, now).folderId, bad).toBeUndefined();
  });
  it("the catalog scans all three fields like every other stored string", async () => {
    const { catalog } = newCatalog(fx);
    const tok = issueToken(catalog, "frank", "cc-bearer", [], "a7");
    expect((await catalog.save(FRANK, { content: "clean", folderId: `folder:${tok}` })).ok).toBe(false);
    expect(catalog.db.get<{ revokedAt: string | null }>("SELECT revokedAt FROM tokens WHERE hash = ?", [sha256Hex(tok)])!.revokedAt).toBeTruthy();
    expect(await catalog.save(FRANK, { content: "clean", observedMtime: "Examplecorp Robotics" })).toMatchObject({ ok: false, status: "rejected" });
    expect(await catalog.save(FRANK, { content: "clean", capturedAt: `sk_live_${"Q".repeat(20)}` })).toMatchObject({ ok: false, status: "rejected" });
  });
});

describe("A8: no disclosures to callers who lack access", () => {
  it("(a) a caller who cannot see the destination gets only held: review", async () => {
    const { catalog } = newCatalog(fx);
    clientCollection(catalog, "col:client-tess", "client:examplecorp", ["kl-device"], "Examplecorp Robotics");
    const r = await catalog.save(FRANK_CONNECTOR, { content: "Notes for Examplecorp Robotics", collection: "col:synth-desk" });
    expect(r.ok && r.status === "held" && r.collection === "inbox:frank" && r.reason === "review", JSON.stringify(r)).toBe(true);
  });
  it("(b) /v1/multipart/start answers a forbidden collection exactly like a missing one", async () => {
    const { catalog } = newCatalog(fx);
    catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-bin", class: "client:b", binary: true, clients_ok: ["kl-device"], decision_row: { client: "B", binary: true } });
    allow(catalog, "frank", ["team", "frank-private", "client:b"]);
    const api = createApiHandler({ catalog });
    const tok = issueToken(catalog, "partner", "cc-bearer", ["save"], "mp-partner");
    const start = (collection: string) => api(new Request("http://kl.local/v1/multipart/start", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ collection }) }));
    const forbidden = await start("col:client-bin"), missing = await start("col:does-not-exist");
    expect(forbidden.status).toBe(missing.status);
    const strip = (s: string) => s.replace(/"requestId":"[0-9a-f]{32}"/, "");
    expect(strip(await forbidden.text())).toBe(strip(await missing.text()));
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM multipart_pushes")!.c).toBe(0);
  });
  it("(c) status LEARNED and cycles counts, and the producer's learning and signal counts, apply clients_ok and the authorized collections", async () => {
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "private-hiring-plan");
    clientCollection(catalog, "col:client-x", "client:x", ["kl-device"]);
    allow(catalog, "frank", ["team", "frank-private", "client:x"]);
    installBaseline(catalog, { scopeId: "global", privacy: "client:x" });
    saveCandidate(catalog, { scopeId: "global", privacy: "client:x" }, { ...BASELINE_V0, synonyms: { a: ["b"] } }, BASELINE_V0_HASH, "test", []);
    saveCandidate(catalog, { scopeId: "global", privacy: "frank-private" }, { ...BASELINE_V0, synonyms: { c: ["d"] } }, BASELINE_V0_HASH, "test", []);
    const st = await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read"], random: catalog.random }, "library_status", {});
    const s = st.structured as { passdown: { LEARNED: { saved: number } }; cycles: { rehearsal: { candidates: number } } };
    expect(s.passdown.LEARNED.saved).toBe(1); // the client:x candidate is invisible to a class outside clients_ok
    expect(s.cycles.rehearsal.candidates).toBe(1);
    // producer: a frank-private candidate and a signal about a frank-journal note are outside a synth-desk-only scope
    const priv = report.admitted.get(fx.notes.find((n) => n.title === "private-hiring-plan")!.noteId)!;
    await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target: priv.cite, topic: "hiring", detail: "x" });
    const spec = await designSpec();
    const doc = produceEvidence(catalog, { producerVersion: "t", keyId: "k", specRevision: spec.revision, specHash: spec.hash, policyRevision: "p", mappingRevision: "m", integrationProjectId: "00000000-0000-4000-8000-000000000001", collectionId: "col:synth-desk", folderId: null, authorizedCollections: ["col:synth-desk"], milestonesEnabled: ["ingest-custody"] });
    expect((doc.learning as { proposals: number; observationCounts: Record<string, number> }).proposals).toBe(0);
    expect((doc.learning as { observationCounts: Record<string, number> }).observationCounts).toEqual({});
  });
});

describe("A9: feedback never lands outside a client's collection; rename runs the guard", () => {
  it("feedback text that matches a client with store_ok is rejected, not quarantined", async () => {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026");
    clientCollection(catalog, "col:client-tess", "client:examplecorp", ["connector"], "Examplecorp Robotics");
    const target = catalog.search(FRANK_CONNECTOR, "rate card").hits[0]!.cite;
    expect(await catalog.feedback(FRANK_CONNECTOR, { kind: "missed", target, detail: "Examplecorp Robotics wanted this" })).toMatchObject({ ok: false, status: "rejected" });
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM overrides")!.c).toBe(0);
  });
  it("rename refuses a denied path", async () => {
    const { catalog } = newCatalog(fx);
    const r = await catalog.save(FRANK_CONNECTOR, { content: "# movable\nbody", path: "inbox/movable.md" }); await catalog.drainOutbox();
    if (!r.ok) throw new Error();
    expect(() => catalog.rename(FRANK, r.noteId, "inbox/secretary/LEDGER.md")).toThrow(/deny\.client-ledger/);
    expect(() => catalog.rename(FRANK, r.noteId, "inbox/.env.production")).toThrow(/secret\.file\.badname/);
    expect(() => catalog.rename(FRANK, r.noteId, `inbox/Examplecorp Robotics.md`)).toThrow(/client\.match/);
    expect(catalog.rename(FRANK, r.noteId, "inbox/moved.md").result).toMatchObject({ noteId: r.noteId });
  });
});

describe("A10: FTS table names are injective", () => {
  it("distinct classes never share a table, including names that differ only in punctuation or case", () => {
    const classes = ["client:a-b", "client:a.b", "client:a_b", "client:A-B", "client:ab", "team", "frank-private", "client:x+client:y"];
    const names = classes.map((c) => ftsTableFor(c).toLowerCase());
    expect(new Set(names).size).toBe(classes.length);
    for (const n of names) expect(n).toMatch(/^fts_[a-z0-9_]+$/);
  });
});

describe("A11: multipart hygiene", () => {
  async function setup() {
    const { catalog, clock } = newCatalog(fx, { clock: new FixedClock("2026-10-05T00:00:00.000Z") });
    catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:bin", class: "team", binary: true, decision_row: { client: "none", binary: true } });
    const api = createApiHandler({ catalog });
    const frank = issueToken(catalog, "frank", "kl-device", [], "mp-frank"), partner = issueToken(catalog, "partner", "cc-bearer", [], "mp-partner");
    const call = (path: string, token: string, init: RequestInit = {}) => api(new Request(`http://kl.local${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", ...((init.headers as Record<string, string>) ?? {}) } }));
    const start = await (await call("/v1/multipart/start", frank, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection: "col:bin" }) })).json();
    return { catalog, clock, call, frank, partner, pushId: start.pushId as string };
  }
  it("pushes older than 2 days are swept by any request, without the owner touching them", async () => {
    const { catalog, clock, call, frank, partner, pushId } = await setup();
    expect((await call(`/v1/multipart/${pushId}/0`, frank, { method: "PUT", body: "part" })).status).toBe(200);
    clock.set("2026-10-07T01:00:00.000Z"); // past the 2-day TTL
    expect((await call("/v1/status", partner, { method: "GET" })).status).toBe(200); // someone else's unrelated request
    expect(catalog.db.get<{ state: string }>("SELECT state FROM multipart_pushes WHERE pushId = ?", [pushId])!.state).toBe("expired");
    expect((await call(`/v1/multipart/${pushId}/1`, frank, { method: "PUT", body: "late" })).status).toBe(404);
    expect((await call(`/v1/multipart/${pushId}/complete`, frank, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
  it("part size and part count are capped as DESIGN §3.5 specifies (64 MiB parts, 1 GiB total)", async () => {
    const { call, frank, pushId } = await setup();
    expect(MULTIPART_MAX_PARTS).toBe(128); // 1 GiB / 8 MiB minimum parts
    expect((await call(`/v1/multipart/${pushId}/${MULTIPART_MAX_PARTS}`, frank, { method: "PUT", body: "one too many" })).status).toBe(413);
    expect((await call(`/v1/multipart/${pushId}/0`, frank, { method: "PUT", body: new Uint8Array(64 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await call(`/v1/multipart/${pushId}/0`, frank, { method: "PUT", body: "fine" })).status).toBe(200);
  });
});
