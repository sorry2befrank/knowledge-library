// Independent takeover review: synthetic inputs only, no live service or files.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validate, validateEvidence, verifySignedEvidence } from "@kl/contracts";
import { callTool, designSpec, generateServiceKey, ed25519Signer, importPublicKey, publishEvidence, produceEvidence, saveCandidate, BASELINE_V0, BASELINE_V0_HASH, HARD_ALARM_ATTEMPTS, type ProducerConfig } from "@kl/core";
import { newCatalog, FRANK, FRANK_CONNECTOR } from "./helpers/load.ts";
import { findMutations } from "../scripts/lib/mutating-sql.ts";

const fixture = (name: string) => JSON.parse(readFileSync("schemas/fixtures/library-evidence/v1/" + name + ".json", "utf8"));
const signed = (name: string) => JSON.parse(readFileSync("schemas/fixtures/library-evidence-signed/v1/" + name + ".json", "utf8"));
const cfg: ProducerConfig = {
 producerVersion: "independent-review", keyId: "synthetic-review",
 policyRevision: "unaccepted", mappingRevision: "none", integrationProjectId: "00000000-0000-4000-8000-000000000001",
 collectionId: "col:synth-desk", folderId: null, authorizedCollections: ["col:synth-desk"],
 milestonesEnabled: ["ingest-custody","retrieval-index"],
};

describe("takeover independent B/D review", () => {
 it("D1 keeps an older pending version visible when another version in the same run completes later", () => {
  const doc = fixture("one-run-two-versions-pending");
  doc.operations[1].timestamps.RECEIVED = "2026-10-04T17:00:00.000Z";
  expect(validate("library-evidence/v1", doc).valid).toBe(true);
  const result = validateEvidence(doc, {now: doc.observedAt});
  expect(result.valid).toBe(true);
  expect(result.verdicts["ingest-custody"]).toBe("unproven");
 });

 it.each([
  ['double-quoted slashes', String.raw`const a = "/* //"; db.run("update notes SET status = 1")`, ["UPDATE notes"]],
  ['single-quoted slashes', String.raw`const a = '/* //'; db.run("update notes SET status = 1")`, ["UPDATE notes"]],
  ['regex escaped slash', String.raw`const a = /\//; db.run("delete from main.notes")`, ["DELETE main.notes"]],
  ['regex bracket slashes', String.raw`const a = /[/*]/; db.run("insert into notes values (?)")`, ["INSERT notes"]],
  ['actual block comment', String.raw`/* UPDATE notes SET x=1 */ db.run("replace into notes values (?)")`, ["REPLACE notes"]],
  ['template literal slashes', 'const a = `/* //`; db.run("UPDATE outbox SET x=1")', ["UPDATE outbox"]],
  ['template expression comment', 'const a = `${1 /* UPDATE notes SET x=1 */}`; db.run("DELETE FROM notes")', ["DELETE notes"]],
  ['property delete and SQL', 'delete a.b; db.run("DELETE FROM main.notes")', ["DELETE main.notes"]],
  ['real comments', '// UPDATE notes SET x=1\n/* DELETE FROM notes */ const a = 1;', []],
 ] as const)("B6 literal-boundary cross-case: %s", (_name, source, expected) => {
  expect(findMutations(source).map(x => x.verb+" "+x.table)).toEqual(expected);
 });

 it("B6 detects escaped-newline SQL that really mutates the synthetic database", async () => {
  const {catalog} = newCatalog();
  await catalog.save(FRANK, {content:"Synthetic escaped newline check", collection:cfg.collectionId});
  const sql = "UPDATE\n notes SET status = 'withdrawn'";
  catalog.db.run(sql);
  expect(catalog.db.get<{count:number}>("SELECT count(*) AS count FROM notes WHERE status = 'withdrawn'")!.count).toBe(1);
  const source = "db.run("+JSON.stringify(sql)+")";
  expect(findMutations(source).map(x=>x.verb+" "+x.table)).toEqual(["UPDATE notes"]);
 });

 it("B6 detects an escaped static SQL prefix before a template expression", () => {
  const source = 'db.run(`UPDATE\\n notes SET status = ${value}`)';
  expect(findMutations(source).map(x=>x.verb+" "+x.table)).toEqual(["UPDATE notes"]);
 });

 it.each(["specRevision", "specHash"] as const)("D9 refuses a partial explicit specification override missing %s", (field) => {
  const text = readFileSync("docs/DESIGN.md", "utf8").replace(/\r\n/g, "\n");
  const config = {...cfg, specRevision:"r"+/^revision:\s*([0-9.]+)\s*$/m.exec(text)![1], specHash:createHash("sha256").update(text).digest("hex")};
  delete (config as Partial<ProducerConfig>)[field];
  expect(() => produceEvidence(newCatalog().catalog, config)).toThrow(/supplied together/);
 });

 it("D8 learning scope includes registered folders and whole-class global learners without exposing neighboring collections", () => {
  const {catalog} = newCatalog();
  catalog.apply(FRANK, {kind:"setup"}, {kind:"collection.create", collectionId:"col:review-other", class:"team"});
  for (const [folder, collection] of [["folder:review-a", cfg.collectionId], ["folder:review-b", "col:review-other"]]) {
   catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)", [folder!, "synthetic", "synthetic", "synthetic", "synthetic", "frank", collection!]);
  }
  const scopes=[cfg.collectionId,"folder:review-a","col:review-other","folder:review-b","global","unknown-scope"];
  for (const [n,scope] of scopes.entries()) {
   saveCandidate(catalog, {scopeId:scope,privacy:"team"}, BASELINE_V0, BASELINE_V0_HASH, "synthetic-review", []);
   for (const revoked of [false,true]) catalog.db.run("INSERT INTO champions(capability,scopeId,privacy,playbookHash,receiptId,promotedAt,revokedAt,frozenBaseline) VALUES (?,?,?,?,?,?,?,0)", ["retrieval",scope,"team",BASELINE_V0_HASH,`receipt-${n}-${revoked ? "revoked" : "live"}`,"2026-10-05T00:00:00.000Z",revoked ? "2026-10-05T01:00:00.000Z" : null]);
  }
  catalog.db.run("UPDATE candidates SET state = 'tested'");
  const learning=(cols:string[])=>produceEvidence(catalog,{...cfg,authorizedCollections:cols}).learning;
  expect(learning([cfg.collectionId])).toMatchObject({proposals:2,evaluations:2,promotions:2,reversions:2,confirmingReceiptId:"receipt-1-live"});
  const wholeClass=catalog.db.all<{collectionId:string}>("SELECT collectionId FROM collections WHERE class='team'").map(x=>x.collectionId);
  expect(learning(wholeClass)).toMatchObject({proposals:5,evaluations:5,promotions:5,reversions:5,confirmingReceiptId:"receipt-4-live"});
  expect(learning([])).toMatchObject({proposals:0,evaluations:0,promotions:0,reversions:0,confirmingReceiptId:null});
 });

 it("D2 caps a known fresh sync with an older producer observation", () => {
  const doc = fixture("positive");
  doc.observedAt = "2026-10-04T17:00:00.000Z";
  doc.freshness.lastSuccessfulSync = "2026-10-04T18:00:00.000Z";
  const result = validateEvidence(doc, { now: "2026-10-04T18:01:00.000Z" });
  expect(result.valid, result.errors.join("; ")).toBe(true);
  expect(result.freshness).toBe("stale");
  expect(result.verdicts["retrieval-index"]).toBe("verified");
 });

 it("D7 id fields reject empty values and embedded whitespace", () => {
  const paths = [
   ["producer", "version"], ["producer", "keyId"], ["operations", "0", "runId"], ["operations", "0", "planId"],
   ["scope", "authorizedCollections", "0"], ["identity", "collectionId"], ["identity", "folderId"],
   ["learning", "trustRevision", "scopeId"], ["learning", "trustRevision", "revision"],
  ];
  for (const path of paths) for (const value of ["", "bad value", "\u00a0"]) {
   const doc = fixture("positive");
   let parent: any = doc;
   for (const part of path.slice(0, -1)) parent = parent[part];
   parent[path.at(-1)!] = value;
   expect(validate("library-evidence/v1", doc).valid, path.join(".")+"="+JSON.stringify(value)).toBe(false);
  }
 });

 it("D7 an otherwise valid receipt rejects embedded whitespace", () => {
  const doc = fixture("positive");
  doc.operations[0].proof.custodyReceipt = "bad receipt";
  expect(validate("library-evidence/v1", doc).valid).toBe(false);
 });

 it.each(["indexed", "preserved", "pending"] as const)("D6 rejects an independently mismatched indexing.%s count", (field) => {
  const doc = fixture("positive"); doc.state.indexing[field]++;
  expect(validate("library-evidence/v1", doc).valid).toBe(true);
  const result = validateEvidence(doc, { now: doc.observedAt });
  expect(result.valid).toBe(false);
  expect(result.errors.some(e=>e.includes("/state indexing."+field))).toBe(true);
 });

 it("D9 spec identity equals the actual LF-normalized DESIGN bytes", async () => {
  const text = readFileSync("docs/DESIGN.md", "utf8").replace(/\r\n/g, "\n");
  const expectedHash = createHash("sha256").update(text,"utf8").digest("hex");
  expect((await designSpec()).hash).toBe(expectedHash);
 });

 it("D8 validates real signatures and refuses changed bytes, forged signature and wrong inner key", async () => {
  const key = signed("trust");
  const trust = {keyId:key.keyId, publicKey:await importPublicKey(key.publicKeyB64)};
  const good = signed("valid-signed");
  expect((await verifySignedEvidence(good,trust,{now:"2026-10-04T18:00:00.000Z"})).valid).toBe(true);
  const changed = {...good,envelopeBytes:good.envelopeBytes+" "};
  expect((await verifySignedEvidence(changed,trust)).signature).toBe("bad-digest");
  expect((await verifySignedEvidence(signed("tampered-signed"),trust)).signature).toBe("bad-signature");
  expect((await verifySignedEvidence(signed("key-mismatch-signed"),trust)).signature).toBe("key-mismatch");
 });

 it("B5 library_status reports an independently failed evidence.publish alarm", async () => {
  const {catalog,mirror}=newCatalog();
  await catalog.save(FRANK,{content:"Synthetic independently reviewed evidence",collection:cfg.collectionId});
  await catalog.drainOutbox();
  const key=await generateServiceKey();const signer=await ed25519Signer(key.privateKey,key.keyId);
  expect((await publishEvidence(catalog,{...cfg,keyId:key.keyId},signer)).published).toBe(true);
  mirror.failWhen=(key)=>key.startsWith("outbox/orrery/");
  for(let i=0;i<HARD_ALARM_ATTEMPTS;i++)await catalog.dispatchOutbox({ignoreBackoff:true});
  expect(catalog.outbox().hardAlarms).toBe(1);
  const status=await callTool({catalog,actor:FRANK_CONNECTOR,scopes:["read"],random:catalog.random},"library_status",{});
  expect((status.structured as {passdown:{BLOCKED:{checkpointFailures:number}}}).passdown.BLOCKED.checkpointFailures).toBe(1);
 });

 it("B6 detects a late SET on the actual outbox table", () => {
  const source='db.run("UPDATE outbox '+ " ".repeat(130) +" SET state = 'pending' WHERE id = ?\")";
  expect(findMutations(source).map(x=>x.verb+" "+x.table)).toEqual(["UPDATE outbox"]);
 });

 it("B6 does not discard SQL after a regex containing slash characters", () => {
  const source=String.raw`const r = /[//]/; db.run("UPDATE notes SET status = 'x'")`;
  expect(findMutations(source).map(x=>x.verb+" "+x.table)).toEqual(["UPDATE notes"]);
 });
});
