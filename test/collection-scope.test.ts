import { describe, expect, it } from "vitest";
import { authenticate, BASELINE_V0, callTool, clientClassFor, mintToken, seededRng, sha256Hex, tokenExpiry, tokenScopes, type Actor, type Catalog } from "@kl/core";
import { TextPush } from "../packages/core/src/catalog/push.ts";
import { collectionFtsTableFor } from "../packages/core/src/catalog/search-index.ts";
import { migrate } from "../packages/core/src/catalog/schema.ts";
import { createApiHandler } from "../apps/api/src/handler.ts";
import { FRANK, newCatalog, TEST_BOOTSTRAP_SECRET } from "./helpers/load.ts";

const scoped = (collectionIds: string[]): Actor => ({ ...FRANK, collectionIds });
function fixture() {
  const f = newCatalog();
  for (const collectionId of ["scope-a", "scope-b"]) f.catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId, class: "team" });
  return f;
}
async function save(c: Catalog, collection: string, path: string, content = "quartz compass") {
  const r = await c.save(FRANK, { collection, path, content });
  if (!r.ok) throw new Error(JSON.stringify(r));
  await c.drainOutbox(); return r;
}
function issue(c: Catalog, kind: "cc-bearer" | "cx-bearer" | "kl-device", collectionIds: string[], expiresAt?: string) {
  const rng = seededRng(`${kind}-${collectionIds.join()}`), t = mintToken(n => rng.bytes(n));
  c.enableSetup(TEST_BOOTSTRAP_SECRET);
  c.apply(FRANK, { kind: "setup", bootstrapSecret: TEST_BOOTSTRAP_SECRET }, { kind: "token.issue", tokenHash: t.hash, principal: FRANK.principal, tokenKind: kind, scopes: tokenScopes(kind), clientClass: clientClassFor(kind), expiresAt: expiresAt ?? tokenExpiry(kind, c.clock.now()), collectionIds });
  return t;
}
async function rpc(api: ReturnType<typeof createApiHandler>, token: string, name: string, args: object) {
  const r = await api(new Request("https://archive.example/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return { status: r.status, body: await r.json() as any };
}

describe("collection-scoped application grants", () => {
  it("denies sibling-collection reads, bytes, history and feedback exactly like missing", async () => {
    const { catalog } = fixture();
    const a = await save(catalog, "scope-a", "a.md"), b = await save(catalog, "scope-b", "b.md");
    const actor = scoped(["scope-a"]);
    expect((await catalog.read(actor, a.cite)).ok).toBe(true);
    expect(await catalog.read(actor, b.cite)).toEqual(await catalog.read(actor, "0000000000"));
    expect(await catalog.read(actor, `kl:${b.noteId}@99`)).toEqual({ ok: false, error: "not-found" });
    expect(await catalog.readBytes(actor, b.noteId, b.ver)).toEqual({ ok: false, error: "not-found" });
    expect(await catalog.feedback(actor, { kind: "correct", target: b.cite, detail: "Scoped correction" })).toEqual({ ok: false, status: "refused", reason: "not-found" });
    expect(await catalog.save(actor, { collection: "scope-b", content: "no write" })).toMatchObject({ ok: false, reason: "collection.not-allowed" });
    expect(() => catalog.rename(actor, b.noteId, "changed.md")).toThrow("not-found");
    expect((await catalog.feedback(FRANK, { kind: "correct", target: b.cite, topic: "hidden topic", detail: "Hidden correction" })).ok).toBe(true);
    expect(catalog.corrections(actor).live).toEqual([]);
    expect(JSON.stringify(catalog.renderCorrections(actor))).not.toContain(b.noteId);
  });

  it("persists exact scopes and propagates both client classes through real MCP and byte handlers", async () => {
    const { catalog, clock } = fixture();
    const a = await save(catalog, "scope-a", "a.md"), b = await save(catalog, "scope-b", "b.md");
    const api = createApiHandler({ catalog });
    for (const kind of ["cc-bearer", "cx-bearer"] as const) {
      const t = issue(catalog, kind, ["scope-a"]);
      expect(authenticate(catalog.db, t.token, clock.now())).toMatchObject({ ok: true, collectionIds: ["scope-a"] });
      expect((await rpc(api, t.token, "library_read", { ref: a.cite })).body.result.structuredContent.cite).toBe(a.cite);
      expect((await rpc(api, t.token, "library_read", { ref: b.cite })).body.result.structuredContent).toEqual({ error: "not-found" });
      const search = (await rpc(api, t.token, "library_search", { q: "quartz", scope: { collection: "scope-b" } })).body.result.structuredContent;
      expect(search.hits).toEqual([]);
      expect(search.total).toBe(0);
      const bytes = await api(new Request(`https://archive.example/v1/version/${b.noteId}@${b.ver}/bytes`, { headers: { authorization: `Bearer ${t.token}` } }));
      expect(bytes.status).toBe(404);
      expect((await rpc(api, t.token, "library_save", { collection: "scope-a", content: "no save" })).body.result.structuredContent.error).toBe("insufficient-scope");
      catalog.apply(FRANK, { kind: "system" }, { kind: "token.revoke", tokenHash: t.hash, reason: "owner" });
      expect((await rpc(api, t.token, "library_read", { ref: a.cite })).status).toBe(401);
    }
  });

  it("keeps scores, candidate saturation and coverage independent of hidden same-class collections", async () => {
    const { catalog } = fixture();
    await save(catalog, "scope-a", "a.md", "quartz compass on a mountain");
    const actor = scoped(["scope-a"]);
    const playbook = { ...BASELINE_V0, rerank: { ...BASELINE_V0.rerank, recency: 0 } };
    const before = catalog.search(actor, "quartz compass", { k: 1 }, playbook);
    await save(catalog, "scope-b", "hidden.md", Array.from({ length: 420 }, () => "quartz compass\n".repeat(120)).join("\n"));
    // Prime the coverage cache with a wider caller at the same generation.
    expect(catalog.search(FRANK, "").coverage.preserved).toBe(2);
    const after = catalog.search(actor, "quartz compass", { k: 1 }, playbook);
    expect(after.hits.map(h => [h.noteId, h.score])).toEqual(before.hits.map(h => [h.noteId, h.score]));
    expect(after.total).toBe(1); expect(after.totalIsLowerBound).toBe(false);
    expect(after.coverage).toEqual({ indexed: 1, preserved: 1, pending: 0 });
    expect(catalog.search(scoped([]), "quartz").coverage.preserved).toBe(0);
    expect(catalog.search(scoped([]), "quartz").hits).toEqual([]);
  });

  it("filters overrides, learning counts and ladder state to collection and registered folder scopes", async () => {
    const { catalog } = fixture();
    const a = await save(catalog, "scope-a", "a.md"), b = await save(catalog, "scope-b", "b.md");
    await catalog.feedback(FRANK, { kind: "pin", target: a.cite, detail: "keep a" });
    await catalog.feedback(FRANK, { kind: "pin", target: b.cite, detail: "keep b" });
    catalog.db.run("INSERT INTO ladder_state VALUES ('retrieval','scope-a',1,2),('focus','scope-b',2,9)");
    catalog.db.run("INSERT INTO playbooks VALUES ('p','retrieval','{}','2026-10-18')");
    catalog.db.run("INSERT INTO candidates(candidateId,capability,scopeId,privacy,playbookHash,generator,targetGroups,state,verdict,createdAt) VALUES ('ca','retrieval','scope-a','team','p','test','[]','open','tested','2026-10-18'),('cb','retrieval','scope-b','team','p','test','[]','open','tested','2026-10-18')");
    const r = await callTool({ catalog, actor: scoped(["scope-a"]), scopes: ["read"], random: catalog.random }, "library_status", {});
    expect((r.structured.passdown as any).NEXT.unconfirmedOverrides).toBe(1);
    expect((r.structured.passdown as any).LEARNED.saved).toBe(1);
    expect((r.structured.ladder as any).streaks).toEqual({ retrieval: 2 });
  });

  it("refuses malformed, empty, missing-collection and expired scoped issues without inserting a grant", () => {
    const { catalog } = fixture();
    for (const collectionIds of [[], ["missing"], ["scope-a", "scope-a"], [null]]) {
      expect(() => issue(catalog, "cc-bearer", collectionIds as string[])).toThrow();
    }
    for (const expiresAt of ["not-a-date", "2000-01-01T00:00:00.000Z"]) expect(() => issue(catalog, "cc-bearer", ["scope-a"], expiresAt)).toThrow();
    const t = issue(catalog, "cc-bearer", ["scope-a"]);
    catalog.db.run("UPDATE tokens SET collection_ids='{}' WHERE hash=?", [t.hash]);
    expect(authenticate(catalog.db, t.token, catalog.clock.now()).ok).toBe(false);
    expect(sha256Hex(t.token)).toBe(t.hash);
  });

  it("denies every device upload form outside scope and rechecks multipart scope on later requests", async () => {
    const { catalog } = fixture();
    for (const id of ["scope-a", "scope-b"]) catalog.db.run("UPDATE collections SET binary=1,decision_row='{}' WHERE collectionId=?", [id]);
    const t = issue(catalog, "kl-device", ["scope-a"]), api = createApiHandler({ catalog });
    const request = (path: string, body: unknown, method = "POST") => api(new Request(`https://archive.example${path}`, { method, headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", "x-kl-collection-ids": "scope-b" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    expect(await (await request("/v1/save", { collection: "scope-b", content: "hidden write" })).json()).toMatchObject({ ok: false, reason: "collection.not-allowed" });
    const batch = await (await request("/v1/batch", { items: [{ collection: "scope-a", content: "allowed" }, { collection: "scope-b", content: "denied" }] })).json() as any;
    expect(batch.results.map((r: any) => r.ok)).toEqual([true, false]);
    expect((await request("/v1/multipart/start", { collection: "scope-b" })).status).toBe(403);
    const multipart = await (await request("/v1/multipart/start", { collection: "scope-a" })).json() as any;
    expect(multipart.pushId).toBeTruthy();
    catalog.db.run("UPDATE tokens SET collection_ids=? WHERE hash=?", [JSON.stringify(["scope-b"]), t.hash]);
    expect((await request(`/v1/multipart/${multipart.pushId}/0`, "part", "PUT")).status).toBe(404);
    expect((await request(`/v1/multipart/${multipart.pushId}/complete`, {})).status).toBe(404);
    catalog.db.run("UPDATE tokens SET expiresAt='2000-01-01T00:00:00.000Z' WHERE hash=?", [t.hash]);
    expect((await request("/v1/save", { collection: "scope-b", content: "expired" })).status).toBe(401);
  });

  it("omits public global sequences and learned expansions, and masks hidden supersession links", async () => {
    const { catalog } = fixture(), actor = scoped(["scope-a"]);
    const a = await save(catalog, "scope-a", "a.md"), b = await save(catalog, "scope-b", "b.md");
    catalog.db.run("UPDATE notes SET supersededBy=? WHERE noteId=?", [b.noteId, a.noteId]);
    const before = await callTool({ catalog, actor, scopes: ["read"], random: catalog.random }, "library_status", {});
    await save(catalog, "scope-b", "other.md", "hidden addition");
    const after = await callTool({ catalog, actor, scopes: ["read"], random: catalog.random }, "library_status", {});
    expect(after.structured).toEqual(before.structured);
    expect(after.structured).not.toHaveProperty("generation");
    const query = await callTool({ catalog, actor, scopes: ["read"], random: catalog.random }, "library_search", { q: "quartz" });
    expect(query.structured).not.toHaveProperty("generation");
    expect((query.structured.hits as any[])[0].supersededBy).toBeNull();
    expect(await catalog.read(actor, a.cite)).toMatchObject({ ok: true, supersededBy: null });
    catalog.championPlaybook = () => ({ ...BASELINE_V0, synonyms: { quartz: ["hiddenphrase"] } });
    expect(catalog.search(actor, "quartz").expanded).not.toContain("hiddenphrase");
    const feedback = await callTool({ catalog, actor, scopes: ["read"], random: catalog.random }, "library_feedback", { kind: "pin", target: a.cite, detail: "Visible feedback" });
    expect(feedback.isError).toBe(false);
    expect(feedback.structured).not.toHaveProperty("eventId");
    expect(await (await createApiHandler({ catalog })(new Request("https://archive.example/healthz"))).json()).toEqual({ ok: true });
  });

  it("enforces the current stored grant for text push even when a trusted caller omits actor scope", async () => {
    const { catalog } = fixture();
    for (const collection of ["scope-a", "scope-b"]) catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)", [`folder:${collection}`,"device","vol","root","path",FRANK.principal,collection]);
    const t = issue(catalog, "kl-device", ["scope-a"]), push = new TextPush(catalog);
    const manifest = { snapshotId: "snapshot", folderId: "folder:scope-b", collection: "scope-b", device: "device", identity: { volumeSerial: "vol", rootFileId: "root" }, scanComplete: true, heldLocal: {}, entries: [] };
    expect(() => push.diff(FRANK, t.hash, manifest)).toThrow("not-found");
    const allowed = { ...manifest, folderId: "folder:scope-a", collection: "scope-a" };
    const d = push.diff(FRANK, t.hash, allowed);
    expect(d.pushId).toBeTruthy();
    catalog.db.run("UPDATE tokens SET collection_ids=? WHERE hash=?", [JSON.stringify(["scope-b"]), t.hash]);
    await expect(push.commit(FRANK, t.hash, d.pushId)).rejects.toThrow("not-found");
  });

  it("backfills legacy projection partitions and isolates scoped request keys", async () => {
    const { catalog } = fixture();
    await save(catalog, "scope-a", "a.md");
    const table = collectionFtsTableFor("scope-a", "team");
    catalog.db.exec(`DROP TABLE ${table}`);
    catalog.db.run("UPDATE meta SET value='3' WHERE key='schema_version'");
    migrate(catalog.db);
    expect(catalog.search(scoped(["scope-a"]), "quartz").hits).toHaveLength(1);
    migrate(catalog.db);
    expect(catalog.db.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)!.c).toBe(1);
    const first = await catalog.save(scoped(["scope-a"]), { collection: "scope-a", path: "one.md", content: "first", idempotencyKey: "same" });
    const second = await catalog.save(scoped(["scope-b"]), { collection: "scope-b", path: "two.md", content: "second", idempotencyKey: "same" });
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(await catalog.save(scoped(["scope-b"]), { collection: "scope-b", path: "two.md", content: "second", idempotencyKey: "same" })).toMatchObject({ ok: true, deduped: true });
  });
});
