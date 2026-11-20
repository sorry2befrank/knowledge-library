import { describe, it, expect, vi } from "vitest";
import { createApiHandler } from "../apps/api/src/handler.ts";
import { TextPush } from "../packages/core/src/catalog/push.ts";
import { Catalog, RateLimiter, sha256Hex } from "@kl/core";
import { newCatalog, issueToken, FRANK } from "./helpers/load.ts";

function fixture(moves=false) {
  const original=newCatalog();
  const f={...original,catalog:new Catalog({db:original.catalog.db,blobStore:original.blobStore,mirror:original.mirror,clock:original.clock,random:original.catalog.random,denyRules:original.catalog.denyRules,moveEligibility:()=>moves})};
  const folderId = "folder:liveness", collection = "col:synth-desk";
  f.catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)", [folderId,"fixture-device","fixture-volume","fixture-root","0".repeat(64),"frank",collection]);
  const cc = issueToken(f.catalog,"frank","cc-bearer",["save"]);
  const token = issueToken(f.catalog,"frank","kl-device"), api = createApiHandler({catalog:f.catalog,rateLimiter:new RateLimiter(10000)});
  const call = async(path:string,body:unknown,bearer=token,method="POST") => { const r=await api(new Request(`https://synthetic.invalid${path}`,{method,headers:{authorization:`Bearer ${bearer}`,"content-type":"application/json"},body:method==="PUT"?String(body):JSON.stringify(body)}));return {http:r.status,...await r.json() as any}; };
  let seq=0;
  const entry=(content:string,relPath="note.md",lastKnownVer?:number)=>({relPath,sha256:sha256Hex(content),size:Buffer.byteLength(content),mtime:"2026-10-01T12:00:00.000Z",gitTracked:false,...(lastKnownVer?{lastKnownVer}: {})});
  const manifest=(entries:unknown[])=>({snapshotId:`liveness-${++seq}`,folderId,collection,device:"fixture-device",identity:{volumeSerial:"fixture-volume",rootFileId:"fixture-root"},scanComplete:true,heldLocal:{},entries});
  const upload=async(entries:{text:string;path?:string;ver?:number}[])=>{const d=await call("/v1/manifest/diff",manifest(entries.map(e=>entry(e.text,e.path,e.ver))));expect(d.http).toBe(200);await call("/v1/batch",{pushId:d.pushId,items:entries.map((e,n)=>({n,content:e.text}))});return call("/v1/commit",{pushId:d.pushId});};
  const count=(table:string)=>f.catalog.db.get<{n:number}>(`SELECT count(*) AS n FROM ${table}`)!.n;
  return {...f,folderId,collection,token,cc,call,entry,manifest,upload,count};
}

describe("push liveness and per-item terminal outcomes",()=>{
  it("serializes open snapshots per folder inside the write transaction",async()=>{
    const f=fixture(),m=f.manifest([f.entry("first")]),d=await f.call("/v1/manifest/diff",m);
    expect((await f.call("/v1/manifest/diff",m)).pushId).toBe(d.pushId);
    const before=f.catalog.head().seq;
    const later=await f.call("/v1/manifest/diff",f.manifest([f.entry("new snapshot")]));
    expect(later).toMatchObject({http:409,error:"push-in-progress"});
    expect(f.catalog.head().seq).toBe(before);expect(f.count("text_pushes")).toBe(1);
  });

  it("recovers received dedup custody before committing an unrelated edit",async()=>{
    const f=fixture(),verify=f.catalog.verifyCustody.bind(f.catalog);
    const fail=vi.spyOn(f.catalog,"verifyCustody").mockResolvedValue("received");
    const first=await f.upload([{text:"same bytes"},{text:"old other",path:"other.md"}]);fail.mockRestore();
    expect(first.results[0].custody).toBe("received");
    const probe=vi.spyOn(f.catalog,"verifyCustody").mockImplementation(verify);
    const second=await f.upload([{text:"same bytes",ver:1},{text:"new other",path:"other.md",ver:1}]);
    expect(second).toMatchObject({http:200,partial:false});expect(second.results[1]).toMatchObject({ok:true,status:"current",ver:2});expect(probe).toHaveBeenCalledWith(first.results[0].noteId,1);probe.mockRestore();
  });

  it("reports custody-pending per item while an unrelated item commits",async()=>{
    const f=fixture(),fail=vi.spyOn(f.catalog,"verifyCustody").mockResolvedValue("received");
    const first=await f.upload([{text:"still pending"}]);fail.mockRestore();
    const verify=f.catalog.verifyCustody.bind(f.catalog),pending=vi.spyOn(f.catalog,"verifyCustody").mockImplementation((id,ver)=>id===first.results[0].noteId?Promise.resolve("received"):verify(id,ver));
    const second=await f.upload([{text:"still pending",ver:1},{text:"unrelated",path:"other.md"}]);
    expect(second).toMatchObject({http:200,partial:true,missing:[0]});expect(second.results[0]).toMatchObject({ok:false,status:"pending",reason:"custody-pending"});expect(second.results[1]).toMatchObject({ok:true,status:"current"});pending.mockRestore();
    const replay=await f.call("/v1/commit",{pushId:second.pushId});expect(replay.partial).toBe(false);expect(f.count("versions")).toBe(2);
  });

  it("holds lineage-narrowing items without creating copies and permits the next snapshot",async()=>{
    const f=fixture(),privateNote=await f.catalog.save(FRANK,{content:"synthetic private",collection:"inbox:frank"});if(!privateNote.ok)throw Error("fixture");
    await f.catalog.read(FRANK,privateNote.cite,{grant:sha256Hex(f.token)});const before=f.count("notes");
    for(let n=0;n<2;n++) {const c=await f.upload([{text:"synthetic shared text"}]);expect(c).toMatchObject({http:200,partial:true,missing:[]});expect(c.results[0]).toMatchObject({ok:false,status:"held",reason:"review"});expect(c.results[0]).not.toHaveProperty("cite");}
    expect(f.count("notes")).toBe(before);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM text_pushes WHERE state='open'")!.n).toBe(0);
  });

  it("reroutes as a terminal disposition without publishing to the other collection",async()=>{
    const f=fixture();
    f.catalog.denyRules.clientNamesOverlay.push("Synthetic Client Foxtrot");
    f.catalog.db.run("UPDATE collections SET decision_row=?,clients_ok=? WHERE collectionId='col:client-examplecorp'",[JSON.stringify({client:"Synthetic Client Foxtrot"}),JSON.stringify(["kl-device"])]);
    f.catalog.db.run("UPDATE principals SET allowed_classes=? WHERE id='frank'",[JSON.stringify(["team","frank-private","client:examplecorp"])]);
    for(let n=0;n<2;n++) {
      const c=await f.upload([{text:"An update for Synthetic Client Foxtrot"}]);
      expect(c).toMatchObject({http:200,partial:true,missing:[]});expect(c.results[0]).toMatchObject({ok:false,status:"rerouted",reason:"destination-changed"});
      expect(c.results[0]).not.toHaveProperty("collection");expect(c.results[0]).not.toHaveProperty("cite");
    }
    expect(f.count("notes")).toBe(0);expect(f.count("aliases")).toBe(0);expect(f.blobStore.objects.size).toBe(0);
  });

  it("reapplies lineage to an unchanged in-place item instead of taking an early twin shortcut",async()=>{
    const f=fixture();await f.upload([{text:"unchanged body"}]);
    const privateNote=await f.catalog.save(FRANK,{content:"synthetic private",collection:"inbox:frank"});if(!privateNote.ok)throw Error("fixture");
    await f.catalog.read(FRANK,privateNote.cite,{grant:sha256Hex(f.token)});
    const d=await f.call("/v1/manifest/diff",f.manifest([f.entry("unchanged body")]));expect(d.unchanged).toHaveLength(1);
    const before=f.count("versions"),c=await f.call("/v1/commit",{pushId:d.pushId});
    expect(c.results[0]).toMatchObject({ok:false,status:"held",reason:"review"});expect(c.partial).toBe(true);expect(f.count("versions")).toBe(before);
  });

  it("does not treat a custody failure as permission to promote an incompatible same-bytes proposal",async()=>{
    const f=fixture(),current=await f.catalog.save(FRANK,{content:"current",path:"note.md",folderId:f.folderId,collection:f.collection});
    const proposal=await f.catalog.save(FRANK,{content:"proposed",path:"note.md",folderId:f.folderId,collection:f.collection});if(!current.ok || !proposal.ok)throw Error("fixture");
    f.catalog.db.run("UPDATE versions SET held=1 WHERE noteId=? AND ver=?",[proposal.noteId,proposal.ver]);
    const c=await f.upload([{text:"proposed",ver:1}]);expect(c.results[0]).toMatchObject({ok:false,status:"held",reason:"review"});
    expect(f.catalog.db.get<{currentVer:number}>("SELECT currentVer FROM notes WHERE noteId=?",[current.noteId])!.currentVer).toBe(1);
  });

  it("checks the prepared class set on a readable unchanged in-place twin",async()=>{
    const f=fixture(),first=await f.upload([{text:"readable but narrower"}]),id=first.results[0].noteId;
    f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=?",[id]);
    f.catalog.db.run("DELETE FROM version_classes WHERE noteId=?",[id]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'frank-private')",[id]);
    const d=await f.call("/v1/manifest/diff",f.manifest([f.entry("readable but narrower")]));expect(d.unchanged).toHaveLength(1);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.results[0]).toMatchObject({ok:false,status:"refused",reason:"review"});expect(c.partial).toBe(true);expect(f.count("versions")).toBe(1);
  });

  it("refuses server-denied content terminally, preserves admitted siblings and withholds absence",async()=>{
    const f=fixture();await f.upload([{text:"must stay present",path:"previous.md"}]);
    f.catalog.denyRules.contentPatterns.push({code:"fixture.denied",pattern:"SYNTHETIC_DENIED_TEXT"});
    const c=await f.upload([{text:"SYNTHETIC_DENIED_TEXT"},{text:"permitted",path:"other.md"}]);
    expect(c).toMatchObject({http:200,partial:true,missing:[]});expect(c.results[0]).toMatchObject({ok:false,status:"refused",reason:"guard-rejected",ruleCodes:expect.arrayContaining(["fixture.denied"])});expect(c.results[1]).toMatchObject({ok:true,status:"current"});
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions WHERE localState='absent-locally'")!.n).toBe(0);
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM text_pushes WHERE state='open'")!.n).toBe(0);expect(f.count("versions")).toBe(2);
    const retry=await f.call("/v1/commit",{pushId:c.pushId});expect(retry.results).toEqual(c.results);
  });

  it.each([false,true])("checks exact twin access before ordinary promotion (hidden=%s)",async hidden=>{
    const f=fixture(),current=await f.catalog.save(FRANK,{content:"readable current",path:"note.md",folderId:f.folderId,collection:f.collection});
    const proposed=await f.catalog.save(FRANK,{content:"proposal",path:"note.md",folderId:f.folderId,collection:f.collection});if(!current.ok||!proposed.ok)throw Error("fixture");
    if(hidden){f.catalog.db.run("UPDATE versions SET privacy_class='partner-private' WHERE noteId=? AND ver=?",[proposed.noteId,proposed.ver]);f.catalog.db.run("DELETE FROM version_classes WHERE noteId=? AND ver=?",[proposed.noteId,proposed.ver]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,?,'partner-private')",[proposed.noteId,proposed.ver]);}
    const before=f.count("versions"),c=await f.upload([{text:"proposal",ver:1},{text:"other",path:"other.md"}]);
    expect(c.http).toBe(200);
    if(hidden){expect(c.results[0]).toMatchObject({ok:false,status:"refused",reason:"review"});expect(f.catalog.db.get<{currentVer:number}>("SELECT currentVer FROM notes WHERE noteId=?",[current.noteId])!.currentVer).toBe(1);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM events WHERE kind='version.promote'")!.n).toBe(0);}
    else expect(c.results[0]).toMatchObject({ok:true,status:"current",ver:2});
    expect(c.results[1]).toMatchObject({ok:true,status:"current"});expect(f.count("versions")).toBe(before+1);
  });

  it("declares proposals partial on the server",async()=>{const f=fixture();await f.upload([{text:"initial"}]);const c=await f.upload([{text:"unknown base"}]);expect(c.results[0].status).toBe("proposed-edit");expect(c.partial).toBe(true);});

  it.each([['stage',false],['stage',true],['transaction',false],['transaction',true]] as const)("reports every withheld move honestly with a %s refusal (refusal first=%s)",async(mode,refusalFirst)=>{
    const f=fixture(true),first=await f.upload([{text:"move first",path:"old-a.md"},{text:"move second",path:"old-b.md"},{text:"old current",path:"blocked.md"}]);
    if(mode==='stage') f.catalog.denyRules.contentPatterns.push({code:"fixture.denied",pattern:"SYNTHETIC_DENIED_MOVE"});
    else {
      const proposal=await f.catalog.save(FRANK,{content:"SYNTHETIC_DENIED_MOVE",path:"blocked.md",folderId:f.folderId,collection:f.collection});if(!proposal.ok)throw Error("fixture");
      f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=? AND ver=?",[proposal.noteId,proposal.ver]);
      f.catalog.db.run("DELETE FROM version_classes WHERE noteId=? AND ver=?",[proposal.noteId,proposal.ver]);
      f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,?,'frank-private')",[proposal.noteId,proposal.ver]);
    }
    const moves=[{text:"move first",path:"new-a.md"},{text:"move second",path:"new-b.md"}],blocked={text:"SYNTHETIC_DENIED_MOVE",path:"blocked.md",ver:1};
    const before=f.count('versions'),second=await f.upload([...(refusalFirst?[blocked,...moves]:[...moves,blocked]),{text:"unrelated admitted",path:"neighbor.md"}]);
    expect(second).toMatchObject({http:200,partial:true,missing:[]});
    expect(second.results.find((r:any)=>r.relPath==='blocked.md')).toMatchObject({ok:false,status:'refused'});
    for(const [n,path] of ['new-a.md','new-b.md'].entries()) {
      const result=second.results.find((r:any)=>r.relPath===path);
      expect(result).toMatchObject({ok:false,status:'held',reason:'move-deferred'});
      for(const field of ['noteId','ver','cite','sha256']) expect(result).not.toHaveProperty(field);
      const read=await f.catalog.read(FRANK,first.results[n].cite);expect(read.ok&&read.path).toBe(n?'old-b.md':'old-a.md');
    }
    expect(second.results.find((r:any)=>r.relPath==='neighbor.md')).toMatchObject({ok:true,status:'current'});expect(f.count('versions')).toBe(before+1);
    expect((await f.call('/v1/commit',{pushId:second.pushId})).results).toEqual(second.results);
    const clean=await f.upload([...moves,{text:"unrelated admitted",path:"neighbor.md",ver:1}]);expect(clean.partial).toBe(false);
    for(const [n,path] of ['new-a.md','new-b.md'].entries()) {expect(clean.results[n]).toMatchObject({ok:true,status:'current',noteId:first.results[n].noteId,ver:1});const read=await f.catalog.read(FRANK,clean.results[n].cite);expect(read.ok&&read.path).toBe(path);}
    const edited=await f.upload([{text:"move first edited",path:"new-a.md",ver:1},moves[1]!,{text:"unrelated admitted",path:"neighbor.md",ver:1}]);
    expect(edited.results[0]).toMatchObject({ok:true,status:'current',noteId:first.results[0].noteId,ver:2});
  });

  it("defers destination proofs while another item is missing and never upgrades that receipt on replay",async()=>{
    const f=fixture(true),first=await f.upload([{text:"move pending",path:"old.md"}]);
    const d=await f.call('/v1/manifest/diff',f.manifest([f.entry('move pending','new.md'),f.entry('not uploaded','pending.md')]));
    const partial=await f.call('/v1/commit',{pushId:d.pushId});expect(partial).toMatchObject({partial:true,missing:[1]});
    expect(partial.results[0]).toMatchObject({ok:false,status:'held',reason:'move-deferred'});expect(partial.results[0]).not.toHaveProperty('ver');
    await f.call('/v1/batch',{pushId:d.pushId,items:[{n:1,content:'not uploaded'}]});
    const completed=await f.call('/v1/commit',{pushId:d.pushId});expect(completed).toMatchObject({partial:true,missing:[]});expect(completed.results[0]).toEqual(partial.results[0]);
    const read=await f.catalog.read(FRANK,first.results[0].cite);expect(read.ok&&read.path).toBe('old.md');
  });

  it("denies every push route to connector grants without durable writes",async()=>{
    const f=fixture(),cc=f.cc,before=[f.count("text_pushes"),f.count("values_"),f.count("blob_refs")];
    for(const [path,body,method] of [["/v1/manifest/diff",f.manifest([f.entry("connector")]),"POST"],["/v1/batch",{pushId:"unknown",items:[{n:0,content:"connector"}]},"POST"],["/v1/upload/unknown/0","connector","PUT"],["/v1/commit",{pushId:"unknown"},"POST"]] as const) expect(await f.call(path,body,cc,method)).toMatchObject({http:403,error:"device-required"});
    expect([f.count("text_pushes"),f.count("values_"),f.count("blob_refs")]).toEqual(before);expect(f.blobStore.objects.size).toBe(0);
    expect(()=>new TextPush(f.catalog).diff({...FRANK,clientClass:"connector"},sha256Hex(cc),f.manifest([]))).toThrow("not-found");
  });
});
