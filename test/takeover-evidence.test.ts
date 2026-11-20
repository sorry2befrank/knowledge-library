import { expect, it } from "vitest";
import { produceEvidence, saveCandidate, BASELINE_V0, BASELINE_V0_HASH, type ProducerConfig } from "@kl/core";
import { validateEvidence } from "@kl/contracts";
import { newCatalog, FRANK } from "./helpers/load.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const cfg: ProducerConfig = {
  producerVersion: "takeover-test", keyId: "synthetic-key",
  policyRevision: "proposal-unaccepted", mappingRevision: "none",
  integrationProjectId: "00000000-0000-4000-8000-000000000001", collectionId: "col:synth-desk",
  folderId: null, authorizedCollections: ["col:synth-desk"],
  milestonesEnabled: ["ingest-custody", "retrieval-index"],
};

it("keeps unresolved custody ahead of verified operations when more than fifty versions await indexing", async () => {
  const { catalog, blobStore } = newCatalog();
  blobStore.failWhenGet = () => true;
  const pending = await catalog.save(FRANK, { content: "An older pending version", collection: cfg.collectionId });
  expect(pending.ok && pending.custody).toBe("received");
  blobStore.failWhenGet = null;
  for (let n = 0; n < 50; n++) {
    const result = await catalog.save(FRANK, { content: `A newer verified version ${n}`, collection: cfg.collectionId });
    expect(result.ok && result.custody).toBe("verified");
  }
  const doc = produceEvidence(catalog, cfg);
  expect(doc.truncated).toMatchObject({ operations: true });
  const result = validateEvidence(doc, { now: catalog.clock.now() });
  expect(result.valid, result.errors.join("; ")).toBe(true);
  expect(result.verdicts["ingest-custody"]).toBe("unproven");
});

it("checks truncated ordering across disabled milestones without changing untruncated milestone isolation", async () => {
  const { catalog } = newCatalog();
  await catalog.save(FRANK, { content: "A verified indexed note", collection: cfg.collectionId });
  await catalog.drainOutbox();
  const doc = produceEvidence(catalog, { ...cfg, milestonesEnabled: ["retrieval-index"] });
  const ops = doc.operations as Record<string, unknown>[];
  const indexed = ops.find(op => op.milestone === "retrieval-index")!;
  doc.operations = [indexed, { ...indexed, operationId: "f".repeat(32), milestone: "focus", stage: "PLANNED", result: "pending" }];
  const ordinary = validateEvidence(doc, { now: catalog.clock.now() });
  expect(ordinary.valid, ordinary.errors.join("; ")).toBe(true);
  expect(ordinary.verdicts).toEqual({ "retrieval-index": "verified" });
  doc.truncated = { operations: true, omittedOperations: 1 };
  const truncated = validateEvidence(doc, { now: catalog.clock.now() });
  expect(truncated.valid, truncated.errors.join("; ")).toBe(true);
  expect(truncated.verdicts).toEqual({ "retrieval-index": "unproven" });
});

it("limits learning counts to authorized collections even when two collections share a privacy class", () => {
  const { catalog } = newCatalog();
  catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:other-team", class: "team" });
  for (const scopeId of [cfg.collectionId, "col:other-team", "global"]) {
    saveCandidate(catalog, { scopeId, privacy: "team" }, BASELINE_V0, BASELINE_V0_HASH, "synthetic", []);
  }
  const doc = produceEvidence(catalog, cfg);
  expect((doc.learning as { proposals: number }).proposals).toBe(1);
  const none = produceEvidence(catalog, { ...cfg, authorizedCollections: [] });
  expect((none.learning as { proposals: number }).proposals).toBe(0);
});

it("defaults the producer to the exact build-time specification identity", () => {
  const { catalog } = newCatalog();
  const withoutSpec = { ...cfg };
  delete (withoutSpec as Partial<ProducerConfig>).specRevision;
  delete (withoutSpec as Partial<ProducerConfig>).specHash;
  const doc = produceEvidence(catalog, withoutSpec);
  const text = readFileSync("docs/DESIGN.md", "utf8").replace(/\r\n/g, "\n");
  const revision = /^revision:\s*([0-9.]+)\s*$/m.exec(text)![1];
  expect(doc.spec).toEqual({ revision: `r${revision}`, hash: createHash("sha256").update(text).digest("hex") });
});
