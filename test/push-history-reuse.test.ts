import { describe,it,expect,vi } from "vitest";
import { createApiHandler } from "../apps/api/src/handler.ts";
import { Catalog,RateLimiter,sha256Hex } from "@kl/core";
import { TextPush } from "../packages/core/src/catalog/push.ts";
import { blobKey } from "../packages/core/src/catalog/blobs.ts";
import { newCatalog,issueToken,FRANK } from "./helpers/load.ts";

function fixture() {
  const env=newCatalog();let catalog=env.catalog;
  for(const folder of ["source","destination"]) catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)",[`folder:${folder}`,"fixture-device","fixture-volume",folder,"0".repeat(64),"frank","col:synth-desk"]);
  const token=issueToken(catalog,"frank","kl-device");let api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)}),seq=0,payloadRequests=0,payloadBytes=0;
  const call=async(path:string,body:unknown)=>{if(path==="/v1/batch"){payloadRequests++;payloadBytes+=new TextEncoder().encode(JSON.stringify(body)).length;}const response=await api(new Request(`https://fixture.local${path}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)}));return {httpStatus:response.status,...await response.json() as any};};
  const entry=(text:string,relPath="note.md",lastKnownVer?:number)=>({relPath,sha256:sha256Hex(text),size:new TextEncoder().encode(text).length,mtime:"2026-10-01T12:00:00.000Z",gitTracked:false,...(lastKnownVer===undefined?{}:{lastKnownVer})});
  const manifest=(text:string,folder="destination",lastKnownVer?:number)=>({snapshotId:`reuse-${++seq}`,folderId:`folder:${folder}`,collection:"col:synth-desk",device:"fixture-device",identity:{volumeSerial:"fixture-volume",rootFileId:folder},scanComplete:true,heldLocal:{},entries:[entry(text,"note.md",lastKnownVer)]});
  const save=async(text:string,folder="source",baseVer?:number,collection="col:synth-desk")=>{const r=await catalog.save(FRANK,{content:text,path:"note.md",folderId:`folder:${folder}`,collection,baseVer});expect(r.ok).toBe(true);if(!r.ok)throw new Error("fixture save");return r;};
  return {...env,get catalog(){return catalog;},token,call,entry,manifest,save,get payloadRequests(){return payloadRequests;},get payloadBytes(){return payloadBytes;},restart:()=>{catalog=new Catalog({db:catalog.db,blobStore:env.blobStore,mirror:env.mirror,clock:env.clock,random:catalog.random,denyRules:catalog.denyRules});api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)});}};
}

describe("permission-safe push history reuse",()=>{
  it("reverts historical bytes as a new destination version without payload upload",async()=>{
    const f=fixture(),text="Historical original café ✓\r\n",first=await f.save(text,"destination"),second=await f.save("Newer destination content","destination",first.ver);
    const m=f.manifest(text,"destination",second.ver),d=await f.call("/v1/manifest/diff",m);
    expect(d.missing).toEqual([]);expect(d.unchanged).toEqual([]);expect(d.reusable).toEqual([{n:0,relPath:"note.md",sha256:first.sha256,size:new TextEncoder().encode(text).length}]);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.httpStatus).toBe(200);expect(c.results[0]).toMatchObject({noteId:first.noteId,ver:3,reused:true,deduped:false,status:"current",custody:"verified"});expect(c.counts).toMatchObject({reused:1,deduplicated:0});expect(c.reusedBytes).toBe(new TextEncoder().encode(text).length);
    expect(f.payloadRequests).toBe(0);expect(f.payloadBytes).toBe(0);expect((await f.catalog.read(FRANK,first.cite)).ok).toBe(true);expect((await f.catalog.read(FRANK,c.results[0].cite))).toMatchObject({ok:true,text});
  });

  it("copies another folder's bytes to a new identity, survives restart/replay, and distinguishes unchanged",async()=>{
    const f=fixture(),text="Same collection copy",source=await f.save(text),before=f.catalog.db.all("SELECT * FROM versions WHERE noteId=?",[source.noteId]),m=f.manifest(text),d=await f.call("/v1/manifest/diff",m);
    expect(d.missing).toEqual([]);expect(d.unchanged).toEqual([]);expect(JSON.stringify(d.reusable)).not.toContain(source.noteId);f.restart();expect((await f.call("/v1/manifest/diff",m)).reusable).toEqual(d.reusable);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.results[0]).toMatchObject({reused:true,deduped:false,ver:1,custody:"verified"});expect(c.results[0].noteId).not.toBe(source.noteId);expect(f.catalog.db.all("SELECT * FROM versions WHERE noteId=?",[source.noteId])).toEqual(before);f.restart();expect((await f.call("/v1/commit",{pushId:d.pushId})).results).toEqual(c.results);
    const again=await f.call("/v1/manifest/diff",f.manifest(text));expect(again.unchanged[0].noteId).toBe(c.results[0].noteId);expect(again.reusable).toEqual([]);const unchanged=await f.call("/v1/commit",{pushId:again.pushId});expect(unchanged.results[0]).toMatchObject({reused:false,deduped:true});expect(unchanged.counts.reused).toBe(0);expect(unchanged.reusedBytes).toBe(0);expect(f.payloadBytes).toBe(0);
  });

  it.each(["hidden","cross-collection","held","focus-held","proposed-edit","received","withdrawn","purge-pending","deleting"])("keeps %s-only matches missing before upload",async restriction=>{
    const f=fixture(),text="Unavailable source bytes",source=await f.save(text,"source",undefined,restriction==="cross-collection"?"col:atlas-notes":"col:synth-desk");
    if(restriction==="hidden"){f.catalog.db.run("UPDATE versions SET privacy_class='partner-private' WHERE noteId=?",[source.noteId]);f.catalog.db.run("DELETE FROM version_classes WHERE noteId=?",[source.noteId]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'partner-private')",[source.noteId]);f.catalog.db.run("UPDATE principals SET allowed_classes='[\"team\"]' WHERE id='frank'");}
    if(restriction==="held")f.catalog.db.run("UPDATE versions SET held=1 WHERE noteId=?",[source.noteId]);
    if(restriction==="focus-held")f.catalog.db.run("UPDATE versions SET localState='focus-held' WHERE noteId=?",[source.noteId]);
    if(restriction==="proposed-edit")f.catalog.db.run("UPDATE versions SET vstatus='proposed-edit' WHERE noteId=?",[source.noteId]);
    if(restriction==="received")f.catalog.db.run("UPDATE versions SET custody='received' WHERE noteId=?",[source.noteId]);
    if(restriction==="withdrawn"||restriction==="purge-pending")f.catalog.db.run("UPDATE notes SET status=? WHERE noteId=?",[restriction,source.noteId]);
    if(restriction==="deleting")f.catalog.db.run("UPDATE blob_refs SET state='deleting' WHERE sha256=?",[source.sha256]);
    const d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.httpStatus).toBe(200);expect(d.missing).toHaveLength(1);expect(d.reusable??[]).toEqual([]);expect(d.unchanged).toEqual([]);expect(JSON.stringify(d)).not.toContain(source.noteId);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.results).toEqual([]);expect(c.missing).toEqual([0]);
  });

  it("carries an eligible narrower source into destination admission even without a recent read",async()=>{
    const f=fixture(),text="Narrow source lineage",source=await f.save(text);f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=?",[source.noteId]);f.catalog.db.run("DELETE FROM version_classes WHERE noteId=?",[source.noteId]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'frank-private')",[source.noteId]);
    const d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.missing).toEqual([]);const before=f.catalog.db.all("SELECT * FROM versions ORDER BY noteId,ver");const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.httpStatus).toBe(200);expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);expect(c.partial).toBe(true);expect(f.catalog.db.all("SELECT * FROM versions ORDER BY noteId,ver")).toEqual(before);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes")!.n).toBe(1);
  });

  it("runs the current content policy again before committing reusable bytes",async()=>{
    const f=fixture(),text="Synthetic newly forbidden phrase",source=await f.save(text),d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.reusable).toHaveLength(1);
    f.catalog.denyRules.contentPatterns.push({code:"secret.synthetic-policy",pattern:"newly forbidden phrase"});
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.httpStatus).toBe(200);expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);expect(c.missing).toEqual([0]);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);expect(f.payloadBytes).toBe(0);expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs WHERE sha256=?",[source.sha256])!.pendingRefs).toBe("[]");
  });

  it("applies the device client restriction to an exact source's own class set",async()=>{
    const f=fixture(),text="Source with a restricted client class",source=await f.save(text);f.catalog.db.run("UPDATE principals SET allowed_classes='[\"team\",\"frank-private\",\"client:examplecorp\"]' WHERE id='frank'");f.catalog.db.run("UPDATE collections SET clients_ok='[\"connector\"]',decision_row='{}' WHERE collectionId='col:client-examplecorp'");f.catalog.db.run("UPDATE versions SET privacy_class='client:examplecorp+team' WHERE noteId=?",[source.noteId]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'client:examplecorp')",[source.noteId]);
    const d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.missing).toHaveLength(1);expect(d.reusable).toEqual([]);expect(JSON.stringify(d)).not.toContain(source.noteId);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.results).toEqual([]);expect(c.partial).toBe(true);
  });

  it("replans after a real catalog event during storage read without double counting or leaking fences",async()=>{
    const f=fixture(),text="Retry a permitted source",source=await f.save(text),d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.reusable).toHaveLength(1);
    const original=f.blobStore.get.bind(f.blobStore);let changed=false;const applySpy=vi.spyOn(f.catalog,"apply");const spy=vi.spyOn(f.blobStore,"get").mockImplementation(async key=>{const bytes=await original(key);if(!changed&&key===blobKey(source.sha256)){changed=true;f.catalog.apply(FRANK,{kind:"system"},{kind:"version.custody",noteId:source.noteId,ver:source.ver,custody:"indexed",reason:"indexed"});}return bytes;});
    try {const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.httpStatus).toBe(200);expect(c.results[0]).toMatchObject({reused:true,deduped:false,custody:"verified"});expect(applySpy.mock.calls.filter(args=>args[2].kind==="push.commit")).toHaveLength(2);expect(f.catalog.db.get("SELECT refcount,pendingRefs,state FROM blob_refs WHERE sha256=?",[source.sha256])).toEqual({refcount:2,pendingRefs:"[]",state:"live"});expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(1);} finally {spy.mockRestore();applySpy.mockRestore();}
  });

  it("resumes a failed reuse through an explicit upload and records it as transferred",async()=>{
    const f=fixture(),text="Explicit upload repairs missing source storage",source=await f.save(text),m=f.manifest(text),d=await f.call("/v1/manifest/diff",m);expect(d.reusable).toHaveLength(1);f.blobStore.objects.delete(blobKey(source.sha256));const failed=await f.call("/v1/commit",{pushId:d.pushId});expect(failed.httpStatus).toBe(200);expect(failed.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);f.restart();
    const retry=await f.call("/v1/manifest/diff",m);expect(retry.reusable).toEqual([]);expect(retry.missing).toEqual([{n:0,...m.entries[0]}]);
    const staged=await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:text}]});expect(staged.results[0].ok).toBe(true);const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.results[0]).toMatchObject({reused:false,deduped:false,custody:"verified"});expect(c.counts.reused).toBe(0);expect(f.payloadRequests).toBe(1);expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs WHERE sha256=?",[source.sha256])!.pendingRefs).toBe("[]");
  });

  it.each(["withdrawal","revocation","class","held","expired"])("refuses a source %s while awaiting stored bytes",async change=>{
    const f=fixture(),text="Race guarded bytes",source=await f.save(text),d=await f.call("/v1/manifest/diff",f.manifest(text));expect(d.missing).toEqual([]);
    const original=f.blobStore.get.bind(f.blobStore);let changed=false,fenced=false;const spy=vi.spyOn(f.blobStore,"get").mockImplementation(async key=>{const bytes=await original(key);if(!changed&&key===blobKey(source.sha256)){changed=true;fenced=f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs WHERE sha256=?",[source.sha256])!.pendingRefs.includes(`push:${d.pushId}:0`);if(change==="withdrawal")f.catalog.db.run("UPDATE notes SET status='withdrawn' WHERE noteId=?",[source.noteId]);if(change==="held")f.catalog.db.run("UPDATE versions SET held=1 WHERE noteId=?",[source.noteId]);if(change==="class")f.catalog.db.run("UPDATE principals SET allowed_classes='[]' WHERE id='frank'");if(change==="revocation")f.catalog.apply(FRANK,{kind:"system"},{kind:"token.revoke",tokenHash:sha256Hex(f.token),reason:"owner"});if(change==="expired")f.catalog.db.run("UPDATE text_pushes SET expiresAt='2026-10-01T00:00:00.000Z' WHERE pushId=?",[d.pushId]);}return bytes;});
    const c=await f.call("/v1/commit",{pushId:d.pushId});spy.mockRestore();expect(fenced).toBe(true);if(change==="withdrawal"||change==="held"){expect(c.httpStatus).toBe(200);expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);}else expect(c.httpStatus).not.toBe(200);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);
  });

  it("isolates the post-await source recheck before preparing any destination version",async()=>{
    const f=fixture(),text="Post-await isolated source check",source=await f.save(text),d=await f.call("/v1/manifest/diff",f.manifest(text));
    expect(d.reusable).toHaveLength(1);
    const original=f.blobStore.get.bind(f.blobStore),prepare=vi.spyOn(f.catalog,"prepareSave"),apply=vi.spyOn(f.catalog,"apply");let changed=false;
    const get=vi.spyOn(f.blobStore,"get").mockImplementation(async key=>{
      const bytes=await original(key);
      if(!changed&&key===blobKey(source.sha256)){changed=true;f.catalog.db.run("UPDATE versions SET held=1 WHERE noteId=? AND ver=?",[source.noteId,source.ver]);}
      return bytes;
    });
    try {
      const c=await f.call("/v1/commit",{pushId:d.pushId});
      expect(changed).toBe(true);expect(c.httpStatus).toBe(200);
      expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);
      // A transactional refusal alone cannot satisfy this assertion: the earlier
      // layer must stop content preparation after the storage await.
      expect(prepare).not.toHaveBeenCalled();
      const commits=apply.mock.calls.map(args=>args[2]).filter(op=>op.kind==="push.commit");
      expect(commits).toHaveLength(1);expect(commits[0]).toMatchObject({items:[{n:0,reuseFailed:true}]});
      expect(commits[0]!.kind==="push.commit" && commits[0]!.items[0]).not.toHaveProperty("version");
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes")!.n).toBe(1);
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(1);
    } finally {get.mockRestore();prepare.mockRestore();apply.mockRestore();}
  });

  it("isolates the transaction source recheck after preparation has succeeded",async()=>{
    const f=fixture(),text="Transaction isolated source check",source=await f.save(text),d=await f.call("/v1/manifest/diff",f.manifest(text));
    expect(d.reusable).toHaveLength(1);
    const original=f.catalog.apply.bind(f.catalog),prepare=vi.spyOn(f.catalog,"prepareSave");let changed=false;
    const apply=vi.spyOn(f.catalog,"apply").mockImplementation((actor,authority,op)=>{
      if(op.kind==="push.commit"&&!changed){
        expect(op.items).toHaveLength(1);expect(op.items[0]).toMatchObject({n:0,reused:true,reuseSource:{noteId:source.noteId,ver:source.ver}});
        expect(op.items[0]).toHaveProperty("version");
        // Direct mutation deliberately leaves the event generation unchanged,
        // after the post-await check, at the transaction boundary.
        f.catalog.db.run("UPDATE versions SET held=1 WHERE noteId=? AND ver=?",[source.noteId,source.ver]);changed=true;
      }
      return original(actor,authority,op);
    });
    try {
      const c=await f.call("/v1/commit",{pushId:d.pushId});
      expect(changed).toBe(true);expect(prepare).toHaveBeenCalledTimes(1);expect(c.httpStatus).toBe(200);
      expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes")!.n).toBe(1);
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(1);
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM aliases WHERE folderId='folder:destination'")!.n).toBe(0);
    } finally {prepare.mockRestore();apply.mockRestore();}
  });

  it.each(["missing","corrupt"])("refuses %s stored bytes, releases the fence, and requests upload on retry",async fault=>{
    const f=fixture(),text="Custody readback required",source=await f.save(text),m=f.manifest(text),d=await f.call("/v1/manifest/diff",m);expect(d.missing).toEqual([]);if(fault==="missing")f.blobStore.objects.delete(blobKey(source.sha256));else f.blobStore.objects.set(blobKey(source.sha256),new TextEncoder().encode("corrupted"));
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.httpStatus).toBe(200);expect(c.results).toEqual([{ok:false,status:"pending",reason:"reuse-failed",n:0,relPath:"note.md"}]);expect(c.missing).toEqual([0]);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs WHERE sha256=?",[source.sha256])!.pendingRefs).toBe("[]");
    const retry=await f.call("/v1/manifest/diff",m);expect(retry.reusable).toEqual([]);expect(retry.missing).toEqual([{n:0,...m.entries[0]}]);
    f.clock.set("2026-11-10T00:00:00.000Z");new TextPush(f.catalog).expire();expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs WHERE sha256=?",[source.sha256])!.pendingRefs).toBe("[]");
  });
});
