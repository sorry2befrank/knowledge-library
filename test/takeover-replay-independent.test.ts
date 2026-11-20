import { describe, expect, it } from "vitest";
import { BASELINE_V0, computeLineageKey, ingestSignals, captureCases, mineSynonyms, replay, splitFor, type Catalog } from "@kl/core";
import { newCatalog, FRANK } from "./helpers/load.ts";

// Only synthetic catalog state. A private historical version is seeded explicitly,
// as in the scope author's current-version privacy regression.
async function oracle(catalog:Catalog,split:"train"|"heldout") {
 for(let i=0;i<80;i++){
  const path="independent-review/oracle-"+i+".md";
  const saved=await catalog.save(FRANK,{collection:"col:synth-desk",folderId:"folder:independent-review",path,title:"Synthetic oracle "+i,content:"Synthetic independent evidence "+i});
  if(!saved.ok)throw Error("Synthetic save failed");
  const groupKey=computeLineageKey(catalog.db,saved.noteId);
  if(splitFor(groupKey)===split){await catalog.drainOutbox();return {...saved,path,groupKey};}
 }
 throw Error("Could not find synthetic split");
}
describe("independent replay privacy and learning boundaries",()=>{
 for(const explicitVersion of [true,false])it("historical private query cannot become a team lesson; explicit version "+explicitVersion,async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"train");
  catalog.db.run("UPDATE versions SET privacy_class = 'frank-private' WHERE noteId = ?",[target.noteId]);
  catalog.db.run("UPDATE version_classes SET class = 'frank-private' WHERE noteId = ?",[target.noteId]);
  expect(ingestSignals(catalog,[{kind:"S1",principal:"frank",client:"connector",scopeId:"col:synth-desk",targetNoteId:target.noteId,query:"historicalprivatelexeme",interactive:true,...(explicitVersion?{targetVer:target.ver}:{})}]).recorded).toBe(1);
  const next=await catalog.save(FRANK,{collection:"col:synth-desk",path:target.path,folderId:"folder:independent-review",baseVer:target.ver,title:"Shared new summary",content:"Fresh independently authored public summary"});
  expect(next.ok&&next.ver).toBe(target.ver+1);await catalog.drainOutbox();
  expect(captureCases(catalog).created).toBe(1);
  catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-review'");
  const mined=mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"});
  expect(mined.trainCases,JSON.stringify(mined.delta)).toBe(0);
 });
 it("unversioned caller input is pinned while valid historical team evidence remains usable",async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"train");
  expect(ingestSignals(catalog,[{kind:"S1",principal:"frank",client:"connector",scopeId:"col:synth-desk",targetNoteId:target.noteId,query:"sharedhistoricallexeme",interactive:true}]).recorded).toBe(1);
  expect(catalog.db.get<{target:string}>("SELECT target FROM signals")!.target).toBe(target.noteId+"@"+target.ver);
  const next=await catalog.save(FRANK,{collection:"col:synth-desk",path:target.path,folderId:"folder:independent-review",baseVer:target.ver,title:"New team title",content:"New same-class team content"});
  expect(next.ok&&next.ver).toBe(target.ver+1);await catalog.drainOutbox();
  captureCases(catalog);catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-review'");
  const mined=mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"});
  expect(mined.trainCases).toBe(1);expect(mined.delta.synonyms.sharedhistoricallexeme).toEqual(["new team title"]);
 });
 it("legacy unversioned signals cannot supply a training query",async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"train");
  expect(ingestSignals(catalog,[{kind:"S1",principal:"frank",client:"connector",scopeId:"col:synth-desk",targetNoteId:target.noteId,targetVer:target.ver,query:"legacylexeme",interactive:true}]).recorded).toBe(1);
  catalog.db.run("UPDATE signals SET target = ?",[target.noteId]);
  expect(captureCases(catalog)).toMatchObject({created:0,unproven:1});catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-review'");
  expect(mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"}).trainCases).toBe(0);
 });
 it("feedback without a version pins the authorized version and its actual privacy",async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"train");
  catalog.db.run("UPDATE versions SET privacy_class = 'frank-private' WHERE noteId = ?",[target.noteId]);
  catalog.db.run("UPDATE version_classes SET class = 'frank-private' WHERE noteId = ?",[target.noteId]);
  expect((await catalog.feedback(FRANK,{kind:"missed",target:target.noteId,topic:"feedbackprivatelexeme",detail:"Synthetic private feedback"})).ok).toBe(true);
  expect(catalog.db.get<{target:string}>("SELECT target FROM signals")!.target).toBe(target.noteId+"@"+target.ver);
  expect(catalog.db.get<{privacy:string}>("SELECT privacy FROM cases")!.privacy).toBe("frank-private");
  catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-review'");
  expect(mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"}).trainCases).toBe(0);
 });
 it("an existing confirmed legacy case cannot be relabelled from today's version",async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"train");
  expect((await catalog.feedback(FRANK,{kind:"missed",target:target.cite,topic:"legacycaselexeme",detail:"Synthetic legacy case"})).ok).toBe(true);
  catalog.db.run("UPDATE cases SET status = 'confirmed', receiptId = 'synthetic-review', sourceSignals = '[]', inputRef = ?",[JSON.stringify({target:target.noteId})]);
  expect(mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"}).trainCases).toBe(0);
 });
 it("an absent targeted group does not satisfy G2",()=>{
  const {catalog}=newCatalog();
  const report=replay(catalog,BASELINE_V0,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team",targetGroups:["lineage:0000000000"]});
  expect(report.g2.ok).toBe(false);
 });
 it("the miner does not fetch held-out oracle title rows",async()=>{
  const {catalog}=newCatalog();const target=await oracle(catalog,"heldout");
  const original=catalog.db.get.bind(catalog.db);let reads=0;
  catalog.db.get=((sql:string,params?:any[])=>{const result=original(sql,params);if(sql.includes("COALESCE(pv.text")&&params?.includes(target.noteId)&&result)reads++;return result;})as typeof catalog.db.get;
  expect(mineSynonyms(catalog,BASELINE_V0,{scopeId:"col:synth-desk",privacy:"team"},[{q:"heldoutlexeme",principal:"frank",expectedNoteId:target.noteId}]).trainCases).toBe(0);
  expect(reads).toBe(0);
 });
});
