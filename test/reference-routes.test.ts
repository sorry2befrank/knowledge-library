// In-process Request handlers only: no listener, network, provider, filesystem store, or real policy.
import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createApiHandler } from "@kl/api";
import { bundleHash, generateServiceKey, loadReferenceAdmissionRules, signAcceptance, type DenyRules } from "@kl/core";
import { FRANK, issueToken, newCatalog } from "./helpers/load.ts";
import { textUpload } from "./helpers/text-upload.ts";

let accepted: DenyRules, unavailable: DenyRules;
beforeAll(async () => {
  const key = await generateServiceKey(), trust = { publicKey: key.publicKey, keyId: key.keyId, minEpoch: 1 };
  const bundle = { files: {
    "deny.reference.json": JSON.parse(readFileSync(new URL("../policy/deny.template.json", import.meta.url), "utf8")),
    "deny.private.json": { ownerApprovedRevision: "fixture-route-revision", projectAndClientDeniedDirectorySegments: [], projectAuditDirectoryPatterns: [], privateOperationalPathSignatures: [], clientClassificationRules: [], privateLedgerPathRules: [] },
  } };
  const acceptance = await signAcceptance(key.privateKey, { policyHash: bundleHash(bundle), epoch: 1, receiptId: "fixture-route-receipt", keyId: key.keyId });
  accepted = await loadReferenceAdmissionRules(bundle, acceptance, trust);
  unavailable = await loadReferenceAdmissionRules(bundle, undefined, trust);
});

for (const route of ["mcp", "save", "batch", "upload", "multipart"] as const) {
  for (const trigger of ["base-credential", "student", "unavailable"] as const) {
    it(`${route} rejects ${trigger} through the reference guard without permanent content`, async () => {
      const { catalog, blobStore } = newCatalog(undefined, { denyRules: trigger === "unavailable" ? unavailable : accepted });
      const collection = "col:fixture-route-binary";
      catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: collection, class: "team", binary: true, decision_row: { client: "none", binary: true } });
      const token = issueToken(catalog, "frank", "kl-device", [], `${route}-${trigger}`);
      const handler = createApiHandler({ catalog });
      const call = (path: string, body: string, method = "POST", headers: Record<string, string> = {}) => handler(new Request(`http://kl.local${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body,
      }));
      const tables = ["notes", "versions", "blob_refs", "chunks", "idempotency", ...(route === "upload" ? [] : ["values_"])];
      const counts = () => tables.map(table => catalog.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);
      const before = counts();
      const valuesBefore = catalog.db.get<{ n: number }>("SELECT count(*) AS n FROM values_")!.n;
      const content = trigger === "base-credential" ? "Authorization: Bearer " + "a".repeat(24) : trigger === "student" ? "IEP with date of birth" : "Ordinary fixture content";
      const body = { content, collection, path: "project/note.md" };
      let result: Record<string, unknown>;
      if (route === "mcp") {
        result = (await (await call("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "library_save", arguments: body } }))).json()).result.structuredContent;
      } else if (route === "batch") {
        result = (await (await call("/v1/batch", JSON.stringify({ items: [body] }))).json()).results[0];
      } else if (route === "upload") {
        result = await textUpload(catalog,handler,token,content,{collection,path:body.path});
      } else if (route === "multipart") {
        const start = await (await call("/v1/multipart/start", JSON.stringify({ collection }))).json();
        expect(start.pushId).toBeTypeOf("string");
        expect((await call(`/v1/multipart/${start.pushId}/0`, content, "PUT", { "content-type": "application/octet-stream" })).status).toBe(200);
        result = await (await call(`/v1/multipart/${start.pushId}/complete`, JSON.stringify(body))).json();
      } else {
        // These request flags have no authority, including when the signed policy is unavailable.
        result = await (await call("/v1/save", JSON.stringify({ ...body, synthetic: true, overlayApproved: true, allow_sensitive: true }))).json();
      }
      expect(result).toMatchObject(route === "mcp" ? { error: "rejected" } : route === "upload" && trigger !== "unavailable"
        ? { ok: false, status: "refused", reason: "guard-rejected", n: 0, relPath: body.path }
        : { ok: false, status: "rejected" });
      expect(result.ruleCodes).toContain(trigger === "unavailable" ? "policy.unavailable" : trigger === "student" ? "student.content" : "secret.credential.reference-1");
      expect(counts()).toEqual(before);
      if (route === "upload") {
        // Policy-unavailable refuses before a manifest exists. Content refusal
        // retains exactly the resume manifest and a bounded terminal disposition.
        expect(catalog.db.get<{ n: number }>("SELECT count(*) AS n FROM values_")!.n - valuesBefore).toBe(trigger === "unavailable" ? 0 : 2);
        if (trigger !== "unavailable") {
          const manifests = catalog.db.all<{ text: string }>("SELECT v.text FROM text_pushes p JOIN values_ v ON v.hash=p.manifest_h");
          expect(manifests).toHaveLength(1);
          expect(JSON.parse(manifests[0]!.text).entries).toEqual([expect.objectContaining({ relPath: body.path, size: Buffer.byteLength(content) })]);
          const outcomes = catalog.db.all<{ text: string }>("SELECT v.text FROM text_push_items i JOIN values_ v ON v.hash=i.result_h WHERE i.state='terminal'");
          expect(outcomes).toHaveLength(1);
          expect(JSON.parse(outcomes[0]!.text)).toEqual({ ok: false, status: "refused", reason: "guard-rejected", ruleCodes: result.ruleCodes });
        }
      }
      expect(JSON.stringify(catalog.db.all("SELECT text FROM values_"))).not.toContain(content); // only safe manifest metadata may remain
      expect([...blobStore.objects.keys()]).toEqual([]); // Multipart's explicitly approved temporary parts were also removed.
      expect(JSON.stringify(catalog.db.all("SELECT * FROM audit"))).not.toContain(content);
    });
  }
}
