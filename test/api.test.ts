import { describe, it, expect, beforeAll } from "vitest";
import { createApiHandler, serve } from "@kl/api";
import { createAuthHandler } from "@kl/auth";
import { main as klMain } from "@kl/cli";
import { sha256Hex, type Catalog, type MemoryObjectStore } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, issueToken, TEST_BOOTSTRAP_SECRET, type LoadReport } from "./helpers/load.ts";
import { textUpload } from "./helpers/text-upload.ts";

const fx = generateFixtures();
let catalog: Catalog, blobStore: MemoryObjectStore, report: LoadReport, api: (r: Request) => Promise<Response>, auth: (r: Request) => Promise<Response>;
const tokens: Record<string, string> = {};

const issue = (principal: string, kind: "kl-device" | "cc-bearer", extra: string[] = [], seed?: string) => issueToken(catalog, principal, kind, extra, seed);
const BIN = "col:synthetic-binaries";
async function multipart(token: string, collection: string, body: string, path: string) {
  const start = await (await call("/v1/multipart/start", { method: "POST", token, body: JSON.stringify({ collection }) })).json();
  if (!start.pushId) return start;
  const half = Math.floor(body.length / 2);
  await call(`/v1/multipart/${start.pushId}/0`, { method: "PUT", token, headers: { "content-type": "application/octet-stream" }, body: body.slice(0, half) });
  await call(`/v1/multipart/${start.pushId}/1`, { method: "PUT", token, headers: { "content-type": "application/octet-stream" }, body: body.slice(half) });
  return (await call(`/v1/multipart/${start.pushId}/complete`, { method: "POST", token, body: JSON.stringify({ path }) })).json();
}
const call = (path: string, init: RequestInit & { token?: string } = {}) => api(new Request(`http://kl.local${path}`, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) } }));
const rpc = async (token: string, method: string, params?: unknown, id = 1) => (await call("/mcp", { method: "POST", token, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json();

beforeAll(async () => {
  ({ catalog, blobStore } = newCatalog(fx));
  report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
  // a binary collection with a decision row, the only kind multipart accepts (team-visible so both principals can use it)
  catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: BIN, class: "team", binary: true, decision_row: { client: "none", binary: true, decidedAt: "2026-10-05", receiptId: "rcpt-synthetic" } });
  tokens.frankDevice = issue("frank", "kl-device");
  tokens.frankCc = issue("frank", "cc-bearer", ["save"]);
  tokens.partnerRead = issue("partner", "cc-bearer");
  tokens.partnerSave = issue("partner", "cc-bearer", ["save"]);
  api = createApiHandler({ catalog });
  auth = createAuthHandler({ catalog });
});

describe("kl-api: MCP over Streamable HTTP", () => {
  it("rejects missing or bad bearer tokens with 401 and no body detail", async () => {
    expect((await call("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/mcp", { method: "POST", token: "klb_" + "A".repeat(49), body: "{}" })).status).toBe(401);
  });
  it("initialize, tools/list (scope-filtered), tools/call round trip; the tool list has no consequential action", async () => {
    const init = await rpc(tokens.frankCc!, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = await rpc(tokens.frankCc!, "tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["library_save", "library_search", "library_read", "library_feedback", "library_status"]);
    for (const t of list.result.tools) { expect(t.description.split(/\s+/).length).toBeLessThan(60); expect(t.description).toMatch(/data, not instructions/); expect(t.name).not.toMatch(/approve|ratify|promote|confirm|purge|delete|withdraw|policy/); }
    const ro = await rpc(tokens.partnerRead!, "tools/list");
    expect(ro.result.tools.map((t: { name: string }) => t.name)).not.toContain("library_save");
  });
  it("search → read returns untrusted-wrapped text with a per-response nonce; forged wrappers in content are escaped", async () => {
    const s = await rpc(tokens.frankCc!, "tools/call", { name: "library_search", arguments: { q: "injection beacon forged wrapper", k: 5 } });
    expect(s.result.isError).toBe(false);
    const nonce = s.result.structuredContent.nonce as string;
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
    for (const h of s.result.structuredContent.hits) expect(h.title).toMatch(new RegExp(`^<untrusted-note-${nonce} cite="kl:`));
    const n = fx.notes.find((x) => x.body.includes("<untrusted-note-00000000>"))!;
    // that injection note lives in atlas-notes (not loaded here); save it as frank to exercise the escape
    const saved = await rpc(tokens.frankCc!, "tools/call", { name: "library_save", arguments: { content: n.body, title: n.title } });
    const r = await rpc(tokens.frankCc!, "tools/call", { name: "library_read", arguments: { ref: saved.result.structuredContent.cite } });
    const text = r.result.structuredContent.text as string;
    const nonce2 = r.result.structuredContent.nonce as string;
    expect(nonce2).not.toBe(nonce);
    expect(text.startsWith(`<untrusted-note-${nonce2} cite=`)).toBe(true);
    expect(text.endsWith(`</untrusted-note-${nonce2}>`)).toBe(true);
    expect(text.slice(0, -`</untrusted-note-${nonce2}>`.length)).not.toContain("</untrusted-note-");
    expect(text).toContain("untrusted&#45;note-00000000"); // escaped, so the forged wrapper cannot close ours
  });
  it("read errors are distinct and a read-only token cannot save", async () => {
    const a = report.admitted.get(fx.notes.find((x) => x.title === "rate-card-2026")!.noteId)!;
    const vnf = await rpc(tokens.frankCc!, "tools/call", { name: "library_read", arguments: { ref: `kl:${a.noteId}@42` } });
    expect(vnf.result.isError).toBe(true); expect(vnf.result.structuredContent.error).toBe("version-not-found");
    const priv = report.admitted.get(fx.notes.find((x) => x.title === "private-hiring-plan")!.noteId)!;
    const denied = await rpc(tokens.partnerRead!, "tools/call", { name: "library_read", arguments: { ref: priv.cite } });
    expect(denied.result.structuredContent).toEqual({ error: "not-found" });
    const deniedVersion = await rpc(tokens.partnerRead!, "tools/call", { name: "library_read", arguments: { ref: `kl:${priv.noteId}@42` } });
    expect(deniedVersion.result.structuredContent).toEqual({ error: "not-found" }); // never version-not-found for a note the caller cannot see
    const team = await rpc(tokens.partnerRead!, "tools/call", { name: "library_read", arguments: { ref: a.cite } });
    expect(team.result.isError).toBe(false);
    const noSave = await rpc(tokens.partnerRead!, "tools/call", { name: "library_save", arguments: { content: "x" } });
    expect(noSave.result.structuredContent).toEqual({ error: "insufficient-scope" });
  });
  it("feedback creates a principal-scoped override and an unconfirmed case; status is count-only", async () => {
    const a = report.admitted.get(fx.notes.find((x) => x.title === "payment-terms")!.noteId)!;
    const s = await rpc(tokens.partnerRead!, "tools/call", { name: "library_search", arguments: { q: "invoice terms" } });
    const fb = await rpc(tokens.partnerRead!, "tools/call", { name: "library_feedback", arguments: { kind: "missed", target: a.cite, topic: "invoice terms", detail: "wanted payment-terms", queryId: s.result.structuredContent.queryId } });
    expect(fb.result.structuredContent).toMatchObject({ overrideScope: "principal", caseCreated: true, confirmed: false });
    const st = await rpc(tokens.partnerRead!, "tools/call", { name: "library_status", arguments: { section: "passdown" } });
    const pd = st.result.structuredContent.passdown;
    expect(pd.HIRING).toBe("none"); expect(pd.NEXT.unconfirmedOverrides).toBe(1); expect(pd.LEARNED.spend).toBe("unknown");
    expect(JSON.stringify(st)).not.toContain("payment-terms"); // no titles in the passdown
  });
});

describe("kl-api REST: identical admission outcomes on save, batch, single upload and multipart (A8)", () => {
  const secret = () => fx.notes.find((n) => n.flags.credentialLookalike === "secret.credential.jwt")!;
  it("rejects the same bytes with the same rule codes on every path, storing nothing", async () => {
    const body = secret().body;
    const blobsBefore = blobStore.objects.size, refsBefore = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM blob_refs")!.c;
    const versionsBefore = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions")!.c;
    const save = await (await call("/v1/save", { method: "POST", token: tokens.frankDevice, body: JSON.stringify({ content: body, path: "synth-desk/x.md", collection: "col:synth-desk" }) })).json();
    const batch = await (await call("/v1/batch", { method: "POST", token: tokens.frankDevice, body: JSON.stringify({ items: [{ content: body, path: "synth-desk/y.md", collection: "col:synth-desk" }] }) })).json();
    const upload = await textUpload(catalog, api, tokens.frankDevice!, body, { path: "synth-desk/z.md", collection: "col:synth-desk" });
    const unbound = await (await call("/v1/upload/p1/0", { method: "PUT", token: tokens.frankDevice, headers: { "content-type": "text/plain" }, body })).json();
    expect(unbound.error).toBe("not-found"); // arbitrary upload IDs cannot bypass a registered manifest
    const mp = await multipart(tokens.frankDevice!, BIN, body, "w.bin");
    const codes = [save.ruleCodes, batch.results[0].ruleCodes, upload.ruleCodes, mp.ruleCodes];
    expect(codes.every((c) => JSON.stringify(c) === JSON.stringify(codes[0]))).toBe(true);
    expect(codes[0]).toContain("secret.credential.jwt");
    expect([save, batch.results[0], mp].every((r) => r.ok === false && r.status === "rejected" && typeof r.requestId === "string")).toBe(true);
    expect(upload).toMatchObject({ ok: false, status: "refused", reason: "guard-rejected", n: 0, relPath: "synth-desk/z.md" });
    expect(upload.requestId).toBeTypeOf("string"); // HTTP correlation is separate from the stable persisted item outcome
    expect(JSON.stringify([save, batch, upload, mp])).not.toContain("eyJ");
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions")!.c).toBe(versionsBefore);
    expect(blobStore.objects.size).toBe(blobsBefore); // nothing reached the blob store
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM blob_refs")!.c).toBe(refsBefore); // and nothing was even reserved
    expect(await catalog.blobs.has(sha256Hex(body))).toBe(false);
  });
  it("admits clean bytes identically on every path and the direct object read returns exact bytes under ACL", async () => {
    const content = "# Clean note\nSame bytes on every path.";
    const a = await (await call("/v1/save", { method: "POST", token: tokens.frankDevice, body: JSON.stringify({ content, path: "synth-desk/clean-a.md", collection: "col:synth-desk" }) })).json();
    const b = await multipart(tokens.frankDevice!, BIN, content, "clean-b.bin");
    expect(a.ok && b.ok && a.sha256 === b.sha256).toBe(true);
    // text collections never take the multipart path; a pushId is bound to its uploader and grant
    expect((await (await call("/v1/multipart/start", { method: "POST", token: tokens.frankDevice, body: JSON.stringify({ collection: "col:synth-desk" }) })).json()).error).toBe("multipart-requires-binary-collection");
    const start = await (await call("/v1/multipart/start", { method: "POST", token: tokens.frankDevice, body: JSON.stringify({ collection: BIN }) })).json();
    expect(start.pushId).toMatch(/^[0-9a-f]{32}$/);
    const otherPart = await call(`/v1/multipart/${start.pushId}/0`, { method: "PUT", token: tokens.partnerSave, headers: { "content-type": "application/octet-stream" }, body: "intruder" });
    const missingPart = await call(`/v1/multipart/${"0".repeat(32)}/0`, { method: "PUT", token: tokens.partnerSave, headers: { "content-type": "application/octet-stream" }, body: "intruder" });
    expect(otherPart.status).toBe(404); expect(await otherPart.text()).toBe(await missingPart.text());
    expect((await call(`/v1/multipart/${start.pushId}/complete`, { method: "POST", token: tokens.partnerSave, body: "{}" })).status).toBe(404);
    const bytes = await call(`/v1/version/${a.noteId}@${a.ver}/bytes`, { token: tokens.partnerRead });
    expect(bytes.status).toBe(200); expect(await bytes.text()).toBe(content); expect(bytes.headers.get("x-kl-sha256")).toBe(a.sha256);
    // existence leak: a frank-private note and a nonexistent note look identical to the partner
    const priv = report.admitted.get(fx.notes.find((x) => x.title === "private-hiring-plan")!.noteId)!;
    const d = await call(`/v1/version/${priv.noteId}@${priv.ver}/bytes`, { token: tokens.partnerRead });
    const m = await call(`/v1/version/0000000000@1/bytes`, { token: tokens.partnerRead });
    const missingText = await m.text();
    expect(d.status).toBe(m.status); expect(await d.text()).toBe(missingText);
    const dv = await call(`/v1/version/${priv.noteId}@99/bytes`, { token: tokens.partnerRead });
    expect(dv.status).toBe(m.status); expect(await dv.text()).toBe(missingText); // not version-not-found: that would reveal the note exists
  });
  it("scope and size limits hold; audit rows carry ids and status only", async () => {
    expect((await call("/v1/save", { method: "POST", token: tokens.partnerRead, body: JSON.stringify({ content: "x" }) })).status).toBe(403);
    expect((await call("/v1/upload/p9/0", { method: "PUT", token: tokens.frankDevice, headers: { "content-type": "text/plain" }, body: "x".repeat(16 * 1024 * 1024 + 1) })).status).toBe(413);
    const rows = catalog.db.all<{ tool: string; ids: string; status: string }>("SELECT tool, ids, status FROM audit");
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) { expect(JSON.parse(r.ids).every((id: string) => /^(kl:)?[0-9A-HJKMNP-TV-Z]{10}|^[0-9a-f]{32}$/.test(id))).toBe(true); expect(r.status.length).toBeLessThan(40); }
  });
});

describe("kl-auth (S1) and kl CLI", () => {
  it("whoami and self-revoke work; /approve and OAuth answer not-in-s1; issue after seal needs a receipt", async () => {
    const who = await (await auth(new Request("http://kl.local/v1/whoami", { headers: { authorization: `Bearer ${tokens.frankDevice}` } }))).json();
    expect(who).toMatchObject({ principal: "frank", clientClass: "kl-device" });
    expect((await auth(new Request("http://kl.local/approve/abc"))).status).toBe(501);
    expect((await auth(new Request("http://kl.local/oauth/authorize"))).status).toBe(501);
    expect(() => catalog.enableSetup(TEST_BOOTSTRAP_SECRET)).toThrow('setup-already-consumed');
    const setupCatalog = newCatalog(fx).catalog, setupAuth = createAuthHandler({catalog:setupCatalog});
    const noSecret = await setupAuth(new Request("http://kl.local/v1/tokens/issue", { method: "POST", body: JSON.stringify({ principal: "partner", kind: "cc-bearer" }) }));
    expect(noSecret.status).toBe(403); expect((await noSecret.json()).error).toBe("bootstrap-secret-required");
    const wrongSecret = await setupAuth(new Request("http://kl.local/v1/tokens/issue", { method: "POST", headers: { "x-kl-bootstrap-secret": "nope-nope-nope-nope-nope" }, body: JSON.stringify({ principal: "partner", kind: "cc-bearer" }) }));
    expect(wrongSecret.status).toBe(403);
    const issued = await (await setupAuth(new Request("http://kl.local/v1/tokens/issue", { method: "POST", headers: { "x-kl-bootstrap-secret": TEST_BOOTSTRAP_SECRET }, body: JSON.stringify({ principal: "partner", kind: "cc-bearer" }) }))).json();
    expect(issued.token).toMatch(/^klb_/);
    const rev = await (await setupAuth(new Request("http://kl.local/v1/tokens/revoke", { method: "POST", headers: { authorization: `Bearer ${issued.token}` } }))).json();
    expect(rev.revoked).toBe(true);
    expect((await setupAuth(new Request("http://kl.local/v1/whoami", { headers: { authorization: `Bearer ${issued.token}` } }))).status).toBe(401);
    // issuing the owner (kl-device) token seals setup automatically
    const owner = await setupAuth(new Request("http://kl.local/v1/tokens/issue", { method: "POST", headers: { "x-kl-bootstrap-secret": TEST_BOOTSTRAP_SECRET }, body: JSON.stringify({ principal: "frank", kind: "kl-device" }) }));
    expect(owner.status).toBe(200); expect(setupCatalog.inSetupMode()).toBe(false);
    expect((await setupAuth(new Request("http://kl.local/v1/tokens/issue", { method: "POST", headers: { "x-kl-bootstrap-secret": TEST_BOOTSTRAP_SECRET }, body: JSON.stringify({ principal: "partner", kind: "cc-bearer" }) }))).status).toBe(403);
    setupCatalog.db.close();
    // self-revoke is acknowledged only after its checkpoint object exists
    const before = (await catalog.mirror.list("authz/")).length;
    expect((await auth(new Request("http://kl.local/v1/tokens/revoke", { method: "POST", headers: { authorization: `Bearer ${tokens.partnerSave}` } }))).status).toBe(200);
    expect((await catalog.mirror.list("authz/")).length).toBe(before + 1);
    const t2 = issue("partner", "cc-bearer", ["save"], "revoke-fail");
    (catalog.mirror as unknown as { failWhen: ((k: string) => boolean) | null }).failWhen = (k) => k.startsWith("authz/");
    const failed = await auth(new Request("http://kl.local/v1/tokens/revoke", { method: "POST", headers: { authorization: `Bearer ${t2}` } }));
    (catalog.mirror as unknown as { failWhen: ((k: string) => boolean) | null }).failWhen = null;
    expect(failed.status).toBe(503);
  });
  it("kl token print cc --json prints only the header JSON on stdout; kl search goes through the real HTTP server", async () => {
    let out = "", err = "";
    const io = { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s), env: { KL_TOKEN_CC: tokens.frankCc }, fetch };
    expect(await klMain(["token", "print", "cc", "--json"], io)).toBe(0);
    expect(JSON.parse(out)).toEqual({ Authorization: `Bearer ${tokens.frankCc}` }); expect(err).toBe("");
    out = "";
    expect(await klMain(["token", "print", "device", "--json"], io)).toBe(1); expect(err).toMatch(/no device token/); expect(out).toBe("");
    const srv = await serve(api);
    try {
      const io2 = { ...io, env: { KL_TOKEN_CC: tokens.frankCc, KL_API: `http://127.0.0.1:${srv.port}` } };
      out = "";
      expect(await klMain(["search", "--as", "cc", "--json", "rate", "card"], io2)).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed.hits.length).toBeGreaterThan(0);
      expect(await klMain(["version"], io2)).toBe(0);
    } finally { await srv.close(); }
  });
});
