import { describe, it, expect, beforeAll } from "vitest";
import { produceEvidence, publishEvidence, evidenceDigest, countUnknowns, ed25519Signer, generateServiceKey, importPublicKey, sha256Hex, designSpec, type Catalog, type EvidenceSigner, type ProducerConfig } from "@kl/core";
import { validateEvidence, validate, verifySignedEvidence, type SignedEvidence } from "@kl/contracts";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, FRANK_CONNECTOR } from "./helpers/load.ts";

const fx = generateFixtures();
let catalog: Catalog, signer: EvidenceSigner, publicKey: CryptoKey, otherKey: CryptoKey, cfg: ProducerConfig;

beforeAll(async () => {
  // The spec identity is the real DESIGN.md hash (S1c D9), never a placeholder.
  const spec = await designSpec();
  expect(spec.hash).toMatch(/^[0-9a-f]{64}$/); expect(spec.revision).toBe("r0.6"); expect(spec.status).toBe("FINAL");
  cfg = { producerVersion: "0.1.0-s1c", keyId: "k-synthetic", specRevision: spec.revision, specHash: spec.hash, policyRevision: "proposal-unaccepted", mappingRevision: "none",
    integrationProjectId: "00000000-0000-4000-8000-000000000001", collectionId: "col:synth-desk", folderId: "folder:synth-desk", authorizedCollections: ["col:synth-desk"], milestonesEnabled: ["ingest-custody", "retrieval-index"] };
  ({ catalog } = newCatalog(fx)); await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk" || n.folder === "frank-journal");
  const k = await generateServiceKey(); signer = await ed25519Signer(k.privateKey, k.keyId); publicKey = await importPublicKey(k.publicKeyB64);
  otherKey = await importPublicKey((await generateServiceKey()).publicKeyB64);
});

describe("producer honesty (S1c D4)", () => {
  it("retrieval-index is unproven while a version is verified but not indexed; a pending op is emitted for it; preserved counts verified custody only; receipts cite version.custody", async () => {
    const { catalog: c, blobStore } = newCatalog(fx);
    await loadFixtures(c, fx, (n) => n.title === "rate-card-2026" || n.title === "payment-terms");
    blobStore.failWhenGet = (k) => k.startsWith("blobs/");
    const stuck = await c.save(FRANK, { content: "# never verified\nbody", collection: "col:synth-desk" });
    blobStore.failWhenGet = null;
    expect(stuck.ok && stuck.custody === "received").toBe(true);
    const half = await c.save(FRANK, { content: "# verified only\nbody", collection: "col:synth-desk" }); // verified inline, not yet indexed (no drain)
    expect(half.ok && half.custody === "verified").toBe(true);
    const doc = produceEvidence(c, cfg);
    const st = doc.state as { custody: { receivedOnly: number; verifiedNotIndexed: number; indexed: number }; indexing: { preserved: number; pending: number } };
    expect(st.custody).toEqual({ receivedOnly: 1, verifiedNotIndexed: 1, indexed: 2 });
    expect(st.indexing.preserved).toBe(3); expect(st.indexing.pending).toBe(2);
    const bytesVerified = c.db.get<{ b: number }>("SELECT sum(bytes) AS b FROM versions WHERE custody != 'received'")!.b;
    expect((doc.measurement as { bytesLogicallyPreserved: number }).bytesLogicallyPreserved).toBe(bytesVerified);
    const ops = doc.operations as { milestone: string; stage: string; result: string; sourceVersion: string; proof: { custodyReceipt?: string } }[];
    const halfSv = half.ok ? `${half.noteId}@${half.ver}` : "";
    expect(ops.filter((o) => o.sourceVersion === halfSv).map((o) => `${o.milestone}:${o.stage}:${o.result}`).sort()).toEqual(["ingest-custody:COMMITTED:completed", "retrieval-index:COMMITTED:pending"]);
    expect(ops.filter((o) => o.sourceVersion === (stuck.ok ? `${stuck.noteId}@${stuck.ver}` : "")).map((o) => `${o.milestone}:${o.stage}:${o.result}`).sort()).toEqual(["ingest-custody:RECEIVED:pending", "retrieval-index:RECEIVED:pending"]);
    // pending attempts come first; the custody receipt names the version.custody event, not version.create
    const firstVerified = ops.findIndex((o) => o.result === "completed");
    expect(ops.slice(firstVerified).every((o) => o.result === "completed")).toBe(true);
    const committed = ops.find((o) => o.sourceVersion === halfSv && o.milestone === "ingest-custody")!;
    const ev = c.db.get<{ kind: string }>("SELECT kind FROM events WHERE seq = ?", [Number(committed.proof.custodyReceipt!.slice(3))])!;
    expect(ev.kind).toBe("version.custody");
    const r = validateEvidence(doc, { now: c.clock.now() });
    expect(r.valid, r.errors.join("; ")).toBe(true);
    expect(r.verdicts).toEqual({ "ingest-custody": "unproven", "retrieval-index": "unproven" });
    blobStore.failWhenGet = (k) => k.endsWith(stuck.ok ? stuck.sha256 : "");
    await c.drainOutbox();
    blobStore.failWhenGet = null;
    // the stuck version stays received; everything else indexes: both milestones stay unproven while it is pending
    const doc2 = produceEvidence(c, cfg);
    expect((doc2.state as { custody: { receivedOnly: number; verifiedNotIndexed: number; indexed: number } }).custody).toEqual({ receivedOnly: 1, verifiedNotIndexed: 0, indexed: 3 });
    expect(validateEvidence(doc2, { now: c.clock.now() }).verdicts).toEqual({ "ingest-custody": "unproven", "retrieval-index": "unproven" });
  });
});

describe("library-evidence/v1 producer (A29 producer side)", () => {
  it("produces a valid, content-free envelope with completed operations carrying their proof", () => {
    const doc = produceEvidence(catalog, cfg);
    const r = validateEvidence(doc, { previousSequence: 0, now: catalog.clock.now() });
    expect(r.valid, r.errors.join("; ")).toBe(true);
    expect(r.verdicts).toEqual({ "ingest-custody": "verified", "retrieval-index": "verified" });
    // the fixture load was a kl-device push: lastSuccessfulSync is the server's record of it (the fixed clock ran past 15 minutes during the load, so it is stale at the default window and fresh at a day)
    expect((doc.freshness as { lastSuccessfulSync: string }).lastSuccessfulSync).toMatch(/^2026-/);
    expect(r.freshness).toBe("stale");
    expect(validateEvidence(produceEvidence(catalog, { ...cfg, staleAfterSeconds: 86400 }), { now: catalog.clock.now() }).freshness).toBe("fresh");
    expect(validateEvidence(produceEvidence(newCatalog(fx).catalog, cfg), { now: catalog.clock.now() }).freshness).toBe("unknown"); // no push yet: null sync, no acceptance
    expect((doc.spec as { hash: string }).hash).not.toMatch(/^(.)\1{63}$/); // the real DESIGN hash
    expect((doc.operations as unknown[]).length).toBe(100);
    expect(doc.truncated).toMatchObject({ operations: true });
    expect((doc.measurement as { unknownCount: number }).unknownCount).toBe(countUnknowns(doc)); // counted from the fields that say "unknown"
    expect((doc.measurement as { unknownCount: number }).unknownCount).toBeGreaterThanOrEqual(3);
    expect(typeof (doc.measurement as { durationMs: number }).durationMs).toBe("number");
    // scope: the private collection is POPULATED, and still nothing of it appears in a synth-desk-only snapshot; a journal-only snapshot sees only it
    const journal = catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId = 'col:frank-journal'")!.c;
    expect(journal).toBeGreaterThan(0);
    const scoped = produceEvidence(catalog, { ...cfg, authorizedCollections: ["col:frank-journal"] });
    expect((scoped.state as { custody: { indexed: number } }).custody.indexed).toBe(journal);
    expect((doc.state as { custody: { indexed: number } }).custody.indexed).toBe(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions v JOIN notes n ON n.noteId = v.noteId WHERE n.collectionId = 'col:synth-desk'")!.c);
    expect((produceEvidence(catalog, { ...cfg, authorizedCollections: ["col:nothing"] }).operations as unknown[]).length).toBe(0);
    const text = JSON.stringify(doc);
    for (const n of fx.notes.filter((n) => n.folder === "synth-desk").slice(0, 50)) expect(text).not.toContain(n.title); // no titles, no paths, no text
    expect(text).not.toContain("synth-desk/");
    expect(validate("library-evidence/v1", doc).valid).toBe(true);
  });
  it("publishes a SIGNED snapshot with a monotonic sequence through apply() and the outbox; an unchanged state is a no-op", async () => {
    const a = await publishEvidence(catalog, cfg, signer);
    expect(a).toMatchObject({ published: true, sequence: 1 });
    expect(await publishEvidence(catalog, cfg, signer)).toEqual({ published: false, reason: "duplicate" });
    await catalog.dispatchOutbox();
    const files = await catalog.mirror.list("outbox/orrery/");
    expect(files.length).toBe(1); expect(files[0]).toMatch(/^outbox\/orrery\/000000000001-[0-9a-f]{32}\.json$/);
    const wrapper = JSON.parse(new TextDecoder().decode((await catalog.mirror.get(files[0]!))!)) as SignedEvidence;
    expect(wrapper.schemaVersion).toBe("library-evidence-signed/v1"); expect(wrapper.keyId).toBe(signer.keyId);
    const good = await verifySignedEvidence(wrapper, { keyId: signer.keyId, publicKey }, { previousSequence: 0, now: catalog.clock.now() });
    expect(good.signature).toBe("ok"); expect(good.valid, good.errors.join("; ")).toBe(true);
    // the accepted checkpoint (wrapper digest or snapshotId) replayed is a duplicate, not a rollback
    const again = await verifySignedEvidence(wrapper, { keyId: signer.keyId, publicKey }, { previousSequence: 1, accepted: { digest: wrapper.digest, snapshotId: a.published ? a.snapshotId : "" } });
    expect(again.duplicate).toBe(true); expect(again.valid).toBe(true);
    // kl cannot alter a snapshot without failing the check; an unknown producer key is refused before the schema
    const tamperedBytes = { ...wrapper, envelopeBytes: wrapper.envelopeBytes.replace('"notesHeld":0', '"notesHeld":99') };
    expect((await verifySignedEvidence(tamperedBytes, { keyId: signer.keyId, publicKey })).signature).toBe("bad-digest");
    const redigested = { ...tamperedBytes, digest: sha256Hex(tamperedBytes.envelopeBytes) };
    expect((await verifySignedEvidence(redigested, { keyId: signer.keyId, publicKey })).signature).toBe("bad-signature");
    expect(good.envelope?.producer).toMatchObject({ keyId: signer.keyId });
    expect((await verifySignedEvidence(wrapper, { keyId: signer.keyId, publicKey: otherKey })).signature).toBe("bad-signature");
    expect((await verifySignedEvidence(wrapper, { keyId: "someone-else", publicKey })).signature).toBe("unknown-key");
    await catalog.save(FRANK_CONNECTOR, { content: "# new\nchanges the state", collection: "col:synth-desk", path: "synth-desk/new.md" });
    await catalog.dispatchOutbox();
    const b = await publishEvidence(catalog, cfg, signer);
    expect(b).toMatchObject({ published: true, sequence: 2 });
    expect(catalog.db.all("SELECT sequence FROM evidence_snapshots ORDER BY sequence").map((r) => (r as { sequence: number }).sequence)).toEqual([1, 2]);
  });
  it("the digest ignores per-snapshot ids and times but not state", () => {
    const d1 = produceEvidence(catalog, cfg), d2 = produceEvidence(catalog, cfg);
    expect(d1.snapshotId).not.toBe(d2.snapshotId);
    expect(evidenceDigest(d1)).toBe(evidenceDigest(d2));
    expect(evidenceDigest({ ...d1, state: { ...(d1.state as object), conflicts: 99 } })).not.toBe(evidenceDigest(d1));
  });
});
