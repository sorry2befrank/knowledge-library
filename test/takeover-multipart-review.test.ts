import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { newCatalog, FRANK, issueToken } from "./helpers/load.ts";
import type { createApiHandler as HandlerFactory } from "@kl/api";

// Execute the actual handler with only byte-size constants reduced. This exercises the
// aggregate boundary without allocating gigabytes on the workstation running Orrery.
const reviewRoot = resolve(".review");
let directory: string, createApiHandler: typeof HandlerFactory;
beforeAll(async () => {
  mkdirSync(reviewRoot, { recursive: true }); directory = mkdtempSync(join(reviewRoot, "multipart-"));
  const source = readFileSync("apps/api/src/handler.ts", "utf8")
    .replace("64 * 1024 * 1024", "4")
    .replace("export const MULTIPART_MAX_TOTAL_BYTES = 1024 * 1024 * 1024", "export const MULTIPART_MAX_TOTAL_BYTES = 8")
    // The temporary handler has a different directory; keep its real enrollment dependency.
    .replace('from "./enrollment.ts"', `from ${JSON.stringify(pathToFileURL(resolve("apps/api/src/enrollment.ts")).href)}`);
  const path = join(directory, "handler.mjs");
  writeFileSync(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
  ({ createApiHandler } = await import(pathToFileURL(path).href));
});
afterAll(() => {
  if (directory && resolve(directory).startsWith(reviewRoot + sep)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const { catalog } = newCatalog();
  catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:binary", class: "team", binary: true, decision_row: { client: "none", binary: true } });
  const token = issueToken(catalog, "frank", "kl-device"); const handler = createApiHandler({ catalog });
  const call = (path: string, body: BodyInit, method = "POST") => handler(new Request(`http://kl.local${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit));
  const start = await (await call("/v1/multipart/start", JSON.stringify({ collection: "col:binary" }))).json();
  return { call, prefix: `/v1/multipart/${start.pushId}` };
}

it("caps the total, counts replacement bytes once, and leaves refused bytes out", async () => {
  const { call, prefix } = await setup();
  expect((await call(`${prefix}/0`, "aaaa", "PUT")).status).toBe(200);
  expect((await call(`${prefix}/1`, "bbbb", "PUT")).status).toBe(200);
  expect((await call(`${prefix}/2`, "c", "PUT")).status).toBe(413);
  expect((await call(`${prefix}/0`, "d", "PUT")).status).toBe(200);
  expect((await call(`${prefix}/2`, "eee", "PUT")).status).toBe(200);
  expect((await call(`${prefix}/3`, "f", "PUT")).status).toBe(413);
});

it("cancels an oversized part stream before consuming its tail", async () => {
  const { call, prefix } = await setup();
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  expect((await call(`${prefix}/0`, stream, "PUT")).status).toBe(413);
  expect(cancelled).toBe(true); expect(pulls).toBe(1);
  expect((await call(`${prefix}/0`, "fine", "PUT")).status).toBe(200);
});
