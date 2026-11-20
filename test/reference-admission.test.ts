import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { admit, bundleHash, generateServiceKey, signAcceptance, sha256Hex, type PolicyBundle, type Trust } from "@kl/core";
import { loadReferenceAdmissionRules, referenceProfile } from "../packages/core/src/admission/reference-policy.ts";
import { FRANK, newCatalog } from "./helpers/load.ts";

const template = JSON.parse(readFileSync(new URL("../policy/deny.template.json", import.meta.url), "utf8"));
let trust: Trust, privateKey: CryptoKey;
beforeAll(async () => { const key = await generateServiceKey(); privateKey = key.privateKey; trust = { publicKey: key.publicKey, keyId: key.keyId, minEpoch: 2 }; });
// Complete fictional owner-state input. It is accepted solely by a synthetic service signature,
// never by ownerApprovedRevision, an HTTP argument, or the public template's presence.
function bundle(): PolicyBundle {
  return { files: {
    "deny.reference.json": structuredClone(template),
    "deny.private.json": {
      ownerApprovedRevision: "fixture-revision-1", projectAndClientDeniedDirectorySegments: ["fixture-private-project"],
      projectAuditDirectoryPatterns: [{ source: "^fixture-audit-", flags: "i" }],
      privateOperationalPathSignatures: ["/fixture-records/"],
      clientClassificationRules: ["Example Orchard", "Example Lagoon"], privateLedgerPathRules: ["FIXTURE-LEDGER.md"],
    },
  } };
}
async function acceptance(b: PolicyBundle, epoch = 2) { return signAcceptance(privateKey, { policyHash: bundleHash(b), epoch, receiptId: "fixture-receipt", keyId: trust.keyId }); }
async function ready() { const b = bundle(); return loadReferenceAdmissionRules(b, await acceptance(b), trust); }
function persisted(f: ReturnType<typeof newCatalog>) {
  return {
    counts: ["notes", "versions", "blob_refs", "aliases", "values_", "chunks", "outbox", "idempotency"].map(table => f.catalog.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n),
    objects: [...f.blobStore.objects.keys()], writes: f.blobStore.writes, head: f.catalog.head(),
  };
}
const clean = { content: "An ordinary synthetic project summary.", path: "project/overview.md", collection: "col:synth-desk" };

describe("reference profile through the existing admission guard", () => {
  it("keeps both base detectors before all eleven DESIGN extensions and revokes only the full token hash", async () => {
    const rules = await ready();
    expect(rules.contentPatterns).toHaveLength(13);
    expect(rules.contentPatterns.slice(0, 2).map(x => x.code)).toEqual(["secret.credential.reference-1", "secret.credential.reference-2"]);
    const token = "klb_" + "a".repeat(70);
    const g = admit(rules, { requestId: "fixture", content: "Authorization: Bearer " + "a".repeat(24), fields: { title: token } });
    expect(g.outcome).toBe("rejected"); expect(g.admitted).toBeUndefined();
    expect(g.ruleCodes).toEqual(expect.arrayContaining(["secret.credential.reference-1", "secret.credential.klb"]));
    expect(g.revokeTokenHashes).toEqual([sha256Hex(token)]); expect(JSON.stringify(g)).not.toContain(token);
  });
  it("uses literal word boundaries, distinct signatures, and normalized root-relative paths", async () => {
    const rules = await ready();
    expect(admit(rules, { requestId: "near", content: "prefixIEPsuffix and predate of birthsuffix" }).outcome).toBe("admitted");
    expect(admit(rules, { requestId: "repeated", content: "IEP IEP IEP" }).outcome).toBe("admitted");
    expect(admit(rules, { requestId: "path", path: "UPLOADS\\record.md", content: "neutral" }).ruleCodes).toContain("student.path");
    expect(admit(rules, { requestId: "fields", content: "neutral", fields: { title: "IEP", tags: ["date of birth"] } }).ruleCodes).toContain("student.content");
  });
  it.each([
    ["fixture-private-project/note.md", "deny.segment"], ["fixture-audit-history/note.md", "deny.segment"],
    ["fixture-records/note.md", "student.path"], ["project/FIXTURE-LEDGER.md", "deny.client-ledger"],
  ])("applies private declarations on %s", async (path, code) => {
    const g = admit(await ready(), { requestId: "fixture", path, content: "neutral" });
    expect(g.outcome).toBe("rejected"); expect(g.ruleCodes).toContain(code); expect(g.admitted).toBeUndefined();
  });
  it("retains literal client decisions and the intersection/held destination rule", async () => {
    const rules = await ready(), input = { requestId: "fixture", content: "Example Orchard and Example Lagoon", requestedCollection: "public", saverInbox: "inbox:fixture" };
    expect(admit(rules, input).ruleCodes).toContain("client.match.no-store-ok");
    const g = admit(rules, { ...input, decisions: [
      { client: "Example Orchard", store_ok: true, clients_ok: ["claude"], collection: "one", class: "client:one" },
      { client: "Example Lagoon", store_ok: true, clients_ok: ["openai"], collection: "two", class: "client:two" },
    ] });
    expect(g.outcome).toBe("held"); expect(g.destination?.collection).toBe("inbox:fixture");
    expect(g.destination?.privacyClassCeiling).toContain("client:one"); expect(g.destination?.privacyClassCeiling).toContain("client:two");
    expect(admit(rules, { requestId: "literal", content: "Example Orchardry" }).outcome).toBe("admitted");
  });
  it("preserves lineage holds on ordinary content", async () => {
    const g = admit(await ready(), { requestId: "fixture", content: "neutral", saverInbox: "inbox:fixture", lineage: { hold: true, code: "lineage-narrower-source", ceiling: "partner-private" } });
    expect(g.outcome).toBe("held"); expect(g.destination?.privacyClassCeiling).toBe("partner-private");
  });
  it("rejects a structurally copied profile because signed construction is not a caller flag", async () => {
    const rules = await ready(), copy = { ...rules };
    expect(admit(copy, { requestId: "fixture", content: "neutral" })).toMatchObject({ outcome: "rejected", ruleCodes: ["policy.unavailable"] });
  });
});

describe("signed construction and before-persistence boundary", () => {
  for (const failure of ["unsigned", "tampered", "old-epoch", "public-only", "incomplete-overlay", "malformed-reference"] as const) {
    it(`rejects ${failure} at the real Catalog entry point without persistent content or fingerprints`, async () => {
      const b = bundle();
      if (failure === "public-only") delete b.files["deny.private.json"];
      if (failure === "incomplete-overlay") b.files["deny.private.json"] = { ownerApprovedRevision: "fixture", approved: true, synthetic: true };
      if (failure === "malformed-reference") b.files["deny.reference.json"] = { ...template, schema: "unsupported" };
      const acc = await acceptance(b, failure === "old-epoch" ? 1 : 2);
      if (failure === "tampered") (b.files["deny.private.json"] as { clientClassificationRules: string[] }).clientClassificationRules = [];
      const rules = await loadReferenceAdmissionRules(b, failure === "unsigned" ? undefined : acc, trust);
      const f = newCatalog(undefined, { denyRules: rules }), before = persisted(f);
      const result = await f.catalog.save(FRANK, clean);
      expect(result).toMatchObject({ ok: false, status: "rejected", ruleCodes: ["policy.unavailable"] });
      expect(persisted(f)).toEqual(before);
    });
  }
  it("snapshots the whole signed bundle before awaiting verification and never rereads caller mutations", async () => {
    const b = bundle(), acc = await acceptance(b), hash = bundleHash(b), copyTrust = { ...trust };
    const pending = loadReferenceAdmissionRules(b, acc, copyTrust);
    (b.files["deny.private.json"] as { clientClassificationRules: string[] }).clientClassificationRules = [];
    acc.policyHash = "0".repeat(64); acc.epoch = 99; copyTrust.minEpoch = 99;
    const rules = await pending;
    expect(referenceProfile(rules)).toMatchObject({ ready: true, policyHash: hash, epoch: 2 });
    expect(Object.isFrozen(rules) && Object.isFrozen(rules.clientNamesOverlay)).toBe(true);
    expect(() => rules.clientNamesOverlay.pop()).toThrow();
    expect(admit(rules, { requestId: "snapshot", content: "Example Orchard" }).ruleCodes).toContain("client.match.no-store-ok");
  });
  it("positive control reaches real blobs and versions without weakening collection ACL", async () => {
    const f = newCatalog(undefined, { denyRules: await ready() });
    const saved = await f.catalog.save(FRANK, clean);
    expect(saved.ok).toBe(true); expect(f.blobStore.writes).toBe(1);
    expect(await f.catalog.save(FRANK, { ...clean, collection: "col:partner-scratch" })).toMatchObject({ ok: false, reason: "collection.not-allowed" });
  });
  it.each(["idempotency", "dedup"])("rechecks current guard before the %s short circuit or durable binding", async mode => {
    const f = newCatalog(undefined, { denyRules: await ready() });
    expect((await f.catalog.save(FRANK, { ...clean, idempotencyKey: "fixture-existing" })).ok).toBe(true);
    const before = persisted(f);
    const result = await f.catalog.save(FRANK, { ...clean, title: "IEP and date of birth", idempotencyKey: mode === "idempotency" ? "fixture-existing" : "fixture-new" });
    expect(result).toMatchObject({ ok: false, status: "rejected", ruleCodes: expect.arrayContaining(["student.content"]) });
    expect(persisted(f)).toEqual(before);
  });
});
