// Independent takeover review: synthetic-only regressions for S1c E1 and the G2 field/path matrix.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createApiHandler } from "@kl/api";
import { generateFixtures } from "../fixtures/gen.ts";
import { scanTree } from "../scripts/lib/scan-secrets.ts";
import { FRANK, issueToken, newCatalog } from "./helpers/load.ts";
import { textUpload } from "./helpers/text-upload.ts";

function removeReviewTree(root: string): void {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("review cleanup outside temporary directory");
  rmSync(root, { recursive: true, force: true });
}

describe("takeover hygiene review", () => {
  for (const noIndex of [true, false]) {
    it(`E1 catches an ASCII credential shape in a NUL-containing tracked payload (noIndex=${noIndex})`, () => {
      const root = mkdtempSync(join(tmpdir(), "kl-takeover-binary-scan-"));
      try {
        mkdirSync(join(root, "schemas"));
        const payload = ["synthetic-only", ["ghp_", "A".repeat(36)].join(""), ""].join("\n");
        const file = join(root, "schemas", "synthetic-payload.md");
        writeFileSync(file, Buffer.concat([Buffer.from([0]), Buffer.from(payload)]));
        if (!noIndex) {
          expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
          expect(spawnSync("git", ["add", "--", "schemas/synthetic-payload.md"], { cwd: root }).status).toBe(0);
        }
        const scan = scanTree(root, { noIndex });
        expect(scan.error).toBeUndefined();
        expect(scan.ok).toBe(false);
        expect(scan.hits.some((hit) => hit.pattern === "github token")).toBe(true);
      } finally { removeReviewTree(root); }
    });
  }

  it("G2 refuses unsupported single-upload folder metadata before content admission", async () => {
    const { catalog, blobStore } = newCatalog(generateFixtures());
    const token = issueToken(catalog, "frank", "kl-device", [], "takeover-upload-field");
    const handler = createApiHandler({ catalog });
    const versionCountBefore = catalog.db.get<{ count: number }>("SELECT count(*) AS count FROM versions")!.count;
    const blobCountBefore = blobStore.objects.size;
    const folderId = ["folder:", "klb_", "r".repeat(43)].join("");
    const response = await textUpload(catalog,handler,token,"Clean synthetic content for the upload field check.",{collection:"col:synth-desk",headers:{"x-kl-folder":folderId}});
    expect(response).toMatchObject({error:"unsupported-upload-metadata"});
    expect(catalog.db.get<{ count: number }>("SELECT count(*) AS count FROM versions")!.count).toBe(versionCountBefore);
    expect(blobStore.objects.size).toBe(blobCountBefore);
  });
});

describe("takeover hygiene missing matrix cells", () => {
  it("E3 pins the required Node engine floor as well as lockfile equality", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).engines).toEqual({ node: ">=22.18" });
    expect(JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].engines).toEqual({ node: ">=22.18" });
  });

  const cases = [
    ...["mcp", "save", "batch"].map((route) => ({ route, field: "kind", value: "status" })),
    { route: "multipart", field: "kind", value: "binary" },
    ...["capturedAt", "observedMtime"].flatMap((field) => ["save", "batch", "multipart"].map((route) => ({ route, field, value: "2026-10-03T11:12:13.000Z" }))),
  ];
  for (const { route, field, value } of cases) {
    it(`G2 extra field matrix: ${field} is scanned on ${route}`, async () => {
      const fx = generateFixtures();
      // Valid API values reach the guard. A synthetic policy sentinel proves scanning without relying on invalid values that the API drops.
      const denyRules = { ...fx.denyRules, contentPatterns: [...fx.denyRules.contentPatterns, { code: "secret.credential", pattern: `^${value.replace(/\./g, "\\.")}$` }] };
      const { catalog, blobStore } = newCatalog(fx, { denyRules });
      const binaryCollection = "col:synthetic-review-binary";
      catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: binaryCollection, class: "team", binary: true, decision_row: { client: "none", binary: true } });
      const token = issueToken(catalog, "frank", "kl-device", [], `takeover-${route}-${field}`);
      const handler = createApiHandler({ catalog });
      const call = (path: string, body: string, method = "POST", contentType = "application/json") => handler(new Request(`http://kl.local${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": contentType }, body,
      }));
      const body = { content: "Clean synthetic matrix body.", collection: "col:synth-desk", [field]: value };
      const versionCountBefore = catalog.db.get<{ count: number }>("SELECT count(*) AS count FROM versions")!.count;
      const blobCountBefore = blobStore.objects.size;
      let result: Record<string, unknown>;
      if (route === "mcp") {
        const reply = await (await call("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "library_save", arguments: body } }))).json();
        result = reply.result.structuredContent;
      } else if (route === "batch") {
        result = (await (await call("/v1/batch", JSON.stringify({ items: [body] }))).json()).results[0];
      } else if (route === "multipart") {
        const start = await (await call("/v1/multipart/start", JSON.stringify({ collection: binaryCollection }))).json();
        expect(start.pushId).toBeTypeOf("string");
        const part = await call(`/v1/multipart/${start.pushId}/0`, body.content, "PUT", "application/octet-stream");
        expect(part.status).toBe(200);
        result = await (await call(`/v1/multipart/${start.pushId}/complete`, JSON.stringify(body))).json();
      } else {
        result = await (await call("/v1/save", JSON.stringify(body))).json();
      }
      expect(result).toMatchObject(route === "mcp"
        ? { error: "rejected", ruleCodes: expect.arrayContaining(["secret.credential"]) }
        : { ok: false, status: "rejected", ruleCodes: expect.arrayContaining(["secret.credential"]) });
      expect(catalog.db.get<{ count: number }>("SELECT count(*) AS count FROM versions")!.count).toBe(versionCountBefore);
      expect(blobStore.objects.size).toBe(blobCountBefore);
    });
  }
});
