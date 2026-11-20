// S1c sections E (CI hygiene) and G2 (tests that assert what they claim).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "@kl/api";
import { Catalog, MemoryObjectStore, openNodeSqlite, mintToken, seededRng, sha256Hex, ADMISSION_RULE_CODES, callTool, type DenyRules } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { scanTree, CREDENTIAL_PATTERNS } from "../scripts/lib/scan-secrets.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR, PARTNER, issueToken } from "./helpers/load.ts";

const fx = generateFixtures();
const SYS = { principal: "system", clientClass: "kl-device" as const };

describe("E1: the secret scan", () => {
  it("catches freshly generated synthetic tokens planted under docs/, test/ and schemas/, one per credential shape, and the real tree is clean", () => {
    const rng = seededRng("scan");
    const b = (n: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") => Array.from(rng.bytes(n), (x) => alphabet[x % alphabet.length]).join("");
    const plants: Record<string, string> = {
      "stripe-like (live, test, restricted)": ["rk_test_", b(24)].join(""),
      jwt: ["eyJ", b(16), ".", b(24), ".", b(32)].join(""),
      "anthropic-like": ["sk-ant-", b(32)].join(""),
      "slack-like": ["xoxb-", b(20)].join(""),
      "google-like": ["AIza", b(35)].join(""),
      "meta-like": ["EAA", b(48)].join(""),
      "square-like": ["K0", "12", b(27)].join(""),
      "npm _authToken": ["//registry.example/:_auth", "Token=", b(20)].join(""),
      "private key block": ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIB", b(40), "\n-----END ", "RSA PRIVATE KEY-----"].join(""),
      "environment secret assignment": ["SERVICE_ROLE_", "KEY=", b(24)].join(""),
      "klb_ bearer token": mintToken((n) => rng.bytes(n)).token,
      "github token": ["ghp_", b(36)].join(""),
      "aws access key id": ["AKIA", b(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")].join(""),
      "workstation path": ["d:/", "REPOS/x and e:/", "ORRERY/orrery/x and E:/", ".Knowledge-Library/state"].join(""), // every drive root in a case the real roots do not use: only a case-insensitive scan catches it
    };
    expect(Object.keys(plants).filter((k) => k !== "workstation path").sort()).toEqual(CREDENTIAL_PATTERNS.map((p) => p.name).sort());
    const root = mkdtempSync(join(tmpdir(), "kl-scan-"));
    try {
      const dirs = ["docs", "test", "schemas"];
      Object.entries(plants).forEach(([name, value], i) => { const d = join(root, name === "workstation path" ? "docs" : dirs[i % 3]!); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${i}-${name.replace(/[^a-z]+/gi, "-")}.md`), `planted\n${value}\n`); });
      const r = scanTree(root, { noIndex: true });
      expect(r.error).toBeUndefined(); expect(r.ok).toBe(false);
      const caught = new Set(r.hits.map((h) => h.pattern));
      for (const name of Object.keys(plants)) { if (name === "workstation path") continue; expect(caught.has(name), name).toBe(true); }
      expect(caught.has("workstation path")).toBe(false); // planted under docs/: paths are excluded there
      // the same path planted outside docs/ is caught, case-insensitively
      writeFileSync(join(root, "test", "path.ts"), `const p = "${plants["workstation path"]!.replace(/\\/g, "\\\\")}";\n`);
      expect(scanTree(root, { noIndex: true }).hits.some((h) => h.pattern === "workstation path" && h.line.includes("test/path.ts"))).toBe(true);
      // a clean tree passes
      rmSync(root, { recursive: true, force: true }); mkdirSync(join(root, "docs"), { recursive: true }); writeFileSync(join(root, "docs", "clean.md"), "nothing to see\n");
      expect(scanTree(root, { noIndex: true })).toEqual({ ok: true, hits: [] });
      // the scan fails CLOSED when git grep cannot run
      const bad = scanTree(join(root, "does-not-exist"), { noIndex: true });
      expect(bad.ok).toBe(false); expect(bad.error).toMatch(/git grep failed/);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const real = scanTree(process.cwd());
    expect(real.error).toBeUndefined();
    expect(real.hits, real.hits.map((h) => `${h.pattern}: ${h.line}`).join("\n")).toEqual([]);
  });
  it("ci.yml runs the script and carries no pattern of its own; the lockfile engine matches package.json", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/node scripts\/scan-secrets\.ts/); expect(ci).not.toMatch(/sk_live|AKIA|klb_/);
    expect(JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].engines).toEqual(JSON.parse(readFileSync("package.json", "utf8")).engines);
  });
});

describe("G2: tests that assert what they claim", () => {
  it("a catalog is sealed BY DEFAULT: no sealSetup() call, and setup-only ops are refused until enableSetup", () => {
    const catalog = new Catalog({ db: openNodeSqlite(":memory:"), blobStore: new MemoryObjectStore(), mirror: new MemoryObjectStore(), denyRules: fx.denyRules });
    expect(catalog.inSetupMode()).toBe(false);
    expect(() => catalog.apply(FRANK, { kind: "setup" }, { kind: "principal.create", id: "x", email: "x@example.invalid", allowedClasses: [] })).toThrow(/receipt-required/);
    expect(() => catalog.apply(FRANK, { kind: "setup", bootstrapSecret: "whatever-whatever" }, { kind: "token.issue", tokenHash: "a".repeat(64), principal: "frank", tokenKind: "cc-bearer", scopes: ["read"], clientClass: "claude-code", expiresAt: "2099-01-01T00:00:00Z" })).toThrow(/receipt-required/);
    catalog.enableSetup("synthetic-bootstrap-secret-for-tests-only");
    expect(catalog.inSetupMode()).toBe(true);
  });
  it("a client-class version held in an inbox by the REAL held path is unreadable to an unapproved client class", async () => {
    const { catalog } = newCatalog(fx);
    catalog.apply(SYS, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-y", class: "client:y", clients_ok: ["kl-device"], decision_row: { client: "Y" } });
    catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:y"])]);
    const y = await catalog.save(FRANK, { content: "# y\nclient y material", collection: "col:client-y" }); await catalog.drainOutbox();
    const grant = "held-path".padEnd(64, "p");
    expect((await catalog.read(FRANK, y.ok ? y.cite : "", { grant })).ok).toBe(true);
    const held = await catalog.save(FRANK, { content: "team summary of y", collection: "col:synth-desk" }, { grant });
    expect(held.ok && held.status === "held" && held.collection === "inbox:frank").toBe(true);
    await catalog.drainOutbox();
    expect(await catalog.read(FRANK_CONNECTOR, held.ok ? held.cite : "")).toEqual({ ok: false, error: "not-found" });
    expect((await catalog.read(FRANK, held.ok ? held.cite : "")).ok).toBe(true);
  });
  it("status counts are filtered to the caller's visible classes, with exact numbers", async () => {
    const { catalog } = newCatalog(fx);
    const report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal" || n.folder === "partner-scratch");
    const count = (f: string) => fx.notes.filter((n) => n.folder === f && report.admitted.has(n.noteId)).length;
    const frank = (await callTool({ catalog, actor: FRANK_CONNECTOR, scopes: ["read"], random: catalog.random }, "library_status", { section: "coverage" })).structured.coverage as { preserved: number; indexed: number; pending: number };
    const partner = (await callTool({ catalog, actor: PARTNER, scopes: ["read"], random: catalog.random }, "library_status", { section: "coverage" })).structured.coverage as { preserved: number };
    expect(frank).toMatchObject({ preserved: count("synth-desk") + count("frank-journal"), indexed: count("synth-desk") + count("frank-journal"), pending: 0 });
    expect(partner.preserved).toBe(count("synth-desk") + count("partner-scratch"));
    expect((await callTool({ catalog, actor: { principal: "nobody", clientClass: "connector" }, scopes: ["read"], random: catalog.random }, "library_status", {})).structured.coverage).toMatchObject({ preserved: 0, indexed: 0, pending: 0 });
  });
});

import { textUpload } from "./helpers/text-upload.ts";
import { RateLimiter } from "@kl/core";

describe("G2: every admission rule code and every scanned field, on every write path; lineage on multipart", () => {
  const BIN = "col:synthetic-binaries";
  async function api() {
    const { catalog } = newCatalog(fx);
    await loadFixtures(catalog, fx, (n) => n.title === "rate-card-2026" || n.title === "private-hiring-plan");
    catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: BIN, class: "team", binary: true, decision_row: { client: "none", binary: true } });
    const token = issueToken(catalog, "frank", "kl-device", [], "paths");
    const handler = createApiHandler({ catalog,rateLimiter:new RateLimiter(10000) });
    const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => handler(new Request(`http://kl.local${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } }));
    const codes = (r: Record<string, unknown>) => r.status === "held"
      ? `held:${(r.ruleCodes as string[] | undefined)?.join(",") || r.reason || ""}`
      : (r.ruleCodes as string[] | undefined)?.join(",") ?? `${r.status}:${r.reason ?? ""}`;
    async function everyPath(body: Record<string, unknown>, content: string) {
      const mcp = (await (await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "library_save", arguments: { content, ...body } } }) })).json()).result.structuredContent;
      const save = await (await call("/v1/save", { method: "POST", body: JSON.stringify({ content, ...body }) })).json();
      const batch = (await (await call("/v1/batch", { method: "POST", body: JSON.stringify({ items: [{ content, ...body }] }) })).json()).results[0];
      const upload = await textUpload(catalog,handler,token,content,{collection:body.collection as string | undefined,path:body.path as string | undefined});
      const start = await (await call("/v1/multipart/start", { method: "POST", body: JSON.stringify({ collection: BIN }) })).json();
      await call(`/v1/multipart/${start.pushId}/0`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: content });
      const mp = await (await call(`/v1/multipart/${start.pushId}/complete`, { method: "POST", body: JSON.stringify(body) })).json();
      return { mcp: codes(mcp), save: codes(save), batch: codes(batch), upload: codes(upload), multipart: codes(mp) };
    }
    return { catalog, everyPath, token };
  }
  it("each rejecting rule code gives identical rule codes on MCP save, /v1/save, /v1/batch, /v1/upload and multipart; so does each scanned field", async () => {
    const { everyPath } = await api();
    const token = `klb_${"b".repeat(49)}`;
    const triggers: Record<string, { body?: Record<string, unknown>; content: string }> = {
      "secret.file.badname": { content: "harmless", body: { path: "x/.env.production" } },
      "secret.credential": { content: `token ${token}` },
      "student.content": { content: "Student ID: 1. Report card attached." },
      "student.path": { content: "harmless", body: { path: "x/gradebook/y.md" } },
      "deny.segment": { content: "harmless", body: { path: "x/founders/y.md" } },
      "deny.client-ledger": { content: "harmless", body: { path: "x/secretary/LEDGER.md" } },
      "client.match.no-store-ok": { content: "Notes for Examplecorp Robotics" },
    };
    // policy.unavailable is a construction failure, covered on all five routes in reference-routes.test.ts.
    const rejecting = (ADMISSION_RULE_CODES as readonly string[]).filter((c) => !["policy.unavailable", "client.match.quarantine", "lineage-uncertain", "lineage-narrower-source", "collection.not-allowed", "destination.not-allowed"].includes(c));
    expect(Object.keys(triggers).sort()).toEqual(rejecting.sort()); // every rejecting code has a trigger
    for (const [code, t] of Object.entries(triggers)) {
      const r = await everyPath(t.body ?? {}, t.content);
      const all = Object.values(r);
      expect(new Set(all).size, `${code}: ${JSON.stringify(r)}`).toBe(1);
      expect(all[0], code).toContain(code);
    }
    // every scanned field: a client name in title, tags, kind (kind is validated by the API: an unknown kind is dropped), folderId
    for (const fields of [{ title: "Notes for Examplecorp Robotics" }, { tags: ["Examplecorp Robotics"] }, { folderId: "folder:Examplecorp-Robotics" }] as Record<string, unknown>[]) {
      const r = await everyPath(fields, "clean content");
      const expectAll = fields.folderId ? ["save", "batch", "multipart"] : ["mcp", "save", "batch", "multipart"]; // folderId exists only on the kl-device REST paths; upload takes no title/tags
      const vals = expectAll.map((k) => r[k as keyof typeof r]);
      expect(new Set(vals).size, JSON.stringify({ fields, r })).toBe(1);
      expect(vals[0]).toContain("client.match");
    }
  });
  it("lineage is enforced on multipart: after a narrow read through the device grant, a multipart push is held like every other path", async () => {
    const { catalog, everyPath, token } = await api();
    const priv = catalog.search(FRANK, "private hiring plan").hits[0]!.cite;
    expect((await catalog.read(FRANK, priv, { grant: sha256Hex(token) })).ok).toBe(true);
    const r = await everyPath({ collection: "col:synth-desk" }, "team summary after a private read");
    expect(r.multipart).toBe("held:lineage-uncertain");
    expect(new Set(Object.values(r)).size, JSON.stringify(r)).toBe(1);
  });
});
