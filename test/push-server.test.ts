import { describe,it,expect,vi } from "vitest";
import { createApiHandler } from "../apps/api/src/handler.ts";
import { TextPush } from "../packages/core/src/catalog/push.ts";
import { sha256Hex, RateLimiter, Catalog } from "@kl/core";
import { newCatalog,issueToken,FRANK } from "./helpers/load.ts";
import { SCHEMA_VERSION } from "../packages/core/src/catalog/schema.ts";

function fixture(moveEligible = true) {
  const initial=newCatalog();
  const catalog=new Catalog({db:initial.catalog.db,blobStore:initial.blobStore,mirror:initial.mirror,clock:initial.clock,random:initial.catalog.random,denyRules:initial.catalog.denyRules,moveEligibility:()=>moveEligible});
  const env={...initial,catalog};
  catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)",["folder:push-fixture","fixture-device","fixture-volume","fixture-root","0".repeat(64),"frank","col:synth-desk"]);
  // The synthetic receipt issuer belongs to the original fixture catalog; both
  // façades share this database, while only this façade overrides move evidence.
  const issue=(principal:string,kind:"kl-device"|"cc-bearer"|"cx-bearer",extra:string[]=[],seed?:string)=>issueToken(initial.catalog,principal,kind,extra,seed);
  const token=issue("frank","kl-device");
  let api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)});
  const request=(path:string,body:unknown, t=token,method="POST")=>api(new Request(`https://fixture.local${path}`,{method,headers:{authorization:`Bearer ${t}`,"content-type":"application/json"},body:method==="PUT" ? body as string : JSON.stringify(body)}));
  const call=async(path:string,body:unknown,t=token)=>{const r=await request(path,body,t);return {status:r.status,...await r.json() as any};};
  let seq=0;
  const entry=(text:string,relPath="note.md",ver?:number)=>({relPath,sha256:sha256Hex(text),size:new TextEncoder().encode(text).length,mtime:"2026-10-01T12:00:00.000Z",gitTracked:false,...(ver===undefined?{}:{lastKnownVer:ver})});
  const manifest=(entries:unknown[],extra:object={})=>({snapshotId:`fixture-${++seq}`,folderId:"folder:push-fixture",device:"fixture-device",collection:"col:synth-desk",identity:{volumeSerial:"fixture-volume",rootFileId:"fixture-root"},scanComplete:true,heldLocal:{},entries,...extra});
  const push=async(text:string,relPath="note.md",ver?:number)=>{const d=await call("/v1/manifest/diff",manifest([entry(text,relPath,ver)])); expect(d.status).toBe(200); const s=await call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:text}]});expect(s.results[0].ok).toBe(true);return call("/v1/commit",{pushId:d.pushId});};
  return {...env,token,issue,call,request,entry,manifest,push,restart:()=>{api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)});}};
}

describe("text push durable server protocol",()=>{
  it.each(["open","commit"])("refuses an empty manifest %s when reference policy becomes unavailable",async phase=>{
    const f=fixture();await f.push("absence needs a ready policy");
    const empty=phase==="commit"?await f.call("/v1/manifest/diff",f.manifest([])):undefined;
    f.catalog.denyRules.referencePolicy=true; // An unbound policy is unavailable; no real policy is loaded.
    const before=f.catalog.head().seq;
    const result=phase==="open"
      ?await f.call("/v1/manifest/diff",f.manifest([]))
      :await f.call("/v1/commit",{pushId:empty!.pushId});
    expect(result).toMatchObject({status:"rejected",ok:false,ruleCodes:["policy.unavailable"]});
    expect(f.catalog.head().seq).toBe(before);
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("present");
  });

  it("never persists caller-defined held codes or raw credentials in manifest metadata",async()=>{
    const f=fixture();
    for(const code of [f.token,"unknown.rule","secret.credential.unknown"]){
      const before=f.catalog.head().seq;
      const result=await f.call("/v1/manifest/diff",f.manifest([],{heldLocal:{[code]:1}}));
      expect(JSON.stringify(f.catalog.db.all("SELECT text FROM values_")).includes(code)).toBe(false);
      expect(JSON.stringify(f.catalog.db.all("SELECT * FROM events")).includes(f.token)).toBe(false);
      expect(f.blobStore.objects.size).toBe(0);
      expect(result.status).toBe(400);
      expect(f.catalog.head().seq).toBe(before);
    }
    const held={"student.path":2,"destination.not-allowed":1,"secret.gitleaks":1,[f.catalog.denyRules.contentPatterns[0]!.code]:1};
    const manifest=f.manifest([],{heldLocal:held}),accepted=await f.call("/v1/manifest/diff",manifest);
    expect(accepted.status).toBe(200);
    expect((await f.call("/v1/manifest/diff",manifest)).pushId).toBe(accepted.pushId);
    const committed=await f.call("/v1/commit",{pushId:accepted.pushId});
    expect(committed.partial).toBe(true);expect(committed.counts.heldLocal).toBe(5);
    for(const extra of [
      {device:f.token},{collection:f.token},{folderId:`folder:${f.token}`},
      {identity:{volumeSerial:f.token,rootFileId:"fixture-root"}},
      {identity:{volumeSerial:"fixture-volume",rootFileId:f.token}},
    ]) expect((await f.call("/v1/manifest/diff",f.manifest([],extra))).status).toBe(404);
    // Snapshot identifiers are hashed; unknown wire fields are never copied to the manifest.
    const opaque=await f.call("/v1/manifest/diff",f.manifest([],{snapshotId:f.token,ignored:f.token}));
    expect(opaque.status).toBe(200);
    expect(JSON.stringify(f.catalog.db.all("SELECT text FROM values_")).includes(f.token)).toBe(false);
    expect(JSON.stringify(f.catalog.db.all("SELECT * FROM events")).includes(f.token)).toBe(false);
    expect(JSON.stringify(f.catalog.db.all("SELECT * FROM text_pushes")).includes(f.token)).toBe(false);
    expect(f.blobStore.objects.size).toBe(0);
  });

  it("stages without publishing, survives lost diff/upload/commit replies, and publishes once with verified exact bytes",async()=>{
    const f=fixture(),text="# Synthetic archive\r\nByte exact café ✓\r\n";
    const manifest=f.manifest([f.entry(text)]),d=await f.call("/v1/manifest/diff",manifest);
    expect((await f.call("/v1/manifest/diff",manifest)).pushId).toBe(d.pushId);
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:text}]});
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(0);
    f.restart(); expect((await f.call("/v1/manifest/diff",manifest)).missing).toEqual([]);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.status).toBe(200);expect(c.partial).toBe(false);expect(c.results[0].custody).toBe("verified");
    const retry=await f.call("/v1/commit",{pushId:d.pushId});expect(retry.results).toEqual(c.results);
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(1);
    expect(Buffer.compare(Buffer.from((await f.catalog.blobs.get(c.results[0].sha256))!),Buffer.from(text))).toBe(0);
    expect((await f.catalog.read(FRANK,c.results[0].cite)).ok).toBe(true);
    expect(f.catalog.verifyChain().ok).toBe(true);
  });

  it("rejects digest and guard violations; a partial commit never publishes an unverified item",async()=>{
    const f=fixture(),a="Synthetic valid note",b="Another intended note";
    const d=await f.call("/v1/manifest/diff",f.manifest([f.entry(a),f.entry(b,"two.md")]));
    const staged=await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:a},{n:1,content:"different bytes"}]});
    expect(staged.results[1]).toMatchObject({ok:false,ruleCodes:["digest-mismatch"]});
    const partial=await f.call("/v1/commit",{pushId:d.pushId});expect(partial.partial).toBe(true);expect(partial.results).toHaveLength(1);expect(partial.missing).toEqual([1]);
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:1,content:b}]});
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.partial).toBe(false);expect(c.results).toHaveLength(2);
    const secret=f.token; const denied=await f.call("/v1/manifest/diff",f.manifest([f.entry(secret,"secret.md")]));
    const s=await f.call("/v1/batch",{pushId:denied.pushId,items:[{n:0,content:secret}]});expect(s.results[0].ok).toBe(false);
    expect(await f.catalog.blobs.has(sha256Hex(secret))).toBe(false);
  });

  it("does not reveal private folder sessions or hashes to another principal, grant, or mismatched device",async()=>{
    const f=fixture(),d=await f.call("/v1/manifest/diff",f.manifest([f.entry("private pending")]));
    const other=f.issue("partner","kl-device");
    const rotated=f.issue("frank","kl-device",[],"rotated-fixture-grant");
    for(const token of [other,rotated]) expect((await f.call("/v1/commit",{pushId:d.pushId},token)).error).toBe("not-found");
    expect((await f.call("/v1/manifest/diff",f.manifest([],{device:"different-device"}))).error).toBe("not-found");
    expect((await f.call("/v1/manifest/diff",f.manifest([],{identity:{volumeSerial:"wrong",rootFileId:"fixture-root"}}))).error).toBe("not-found");
  });

  it("rechecks token revocation after asynchronous storage reads before any catalog commit",async()=>{
    const f=fixture(),d=await f.call("/v1/manifest/diff",f.manifest([f.entry("revoked during storage read")]));
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:"revoked during storage read"}]});
    const original=f.blobStore.get.bind(f.blobStore);let revoked=false;
    const race=vi.spyOn(f.blobStore,"get").mockImplementation(async key=>{const bytes=await original(key);if(!revoked){revoked=true;f.catalog.apply(FRANK,{kind:"system"},{kind:"token.revoke",tokenHash:sha256Hex(f.token),reason:"owner"});}return bytes;});
    const c=await f.call("/v1/commit",{pushId:d.pushId});race.mockRestore();
    expect(c.error).toBe("not-found");expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(0);
  });

  it("preserves concurrent edits as siblings and unknown bases as proposed edits",async()=>{
    const f=fixture(),first=await f.push("first version"); const original=first.results[0];
    const diff=await f.call("/v1/manifest/diff",f.manifest([f.entry("stale branch","note.md",1)]));
    // The folder push lane is serialized; an independent catalog edit can still
    // race a captured manifest and must retain the original sibling semantics.
    const newer=await f.catalog.save(FRANK,{content:"second version",path:"note.md",folderId:"folder:push-fixture",collection:"col:synth-desk",baseVer:1});expect(newer.ok && newer.ver).toBe(2);
    await f.call("/v1/batch",{pushId:diff.pushId,items:[{n:0,content:"stale branch"}]});
    const branch=await f.call("/v1/commit",{pushId:diff.pushId});expect(branch.results[0].status).toBe("sibling");expect(branch.partial).toBe(true);
    const proposal=await f.push("unspecified base");expect(proposal.results[0].status).toBe("proposed-edit");
    expect(f.catalog.db.get<{currentVer:number}>("SELECT currentVer FROM notes WHERE noteId=?",[original.noteId])!.currentVer).toBe(2);
  });

  it("records absence only after a complete scan and preserves bytes; unique exact moves keep identity",async()=>{
    const f=fixture(),first=await f.push("same moved contents");
    const move=await f.call("/v1/manifest/diff",f.manifest([f.entry("same moved contents","renamed.md")]));expect(move.exactMoves).toHaveLength(1);
    const c=await f.call("/v1/commit",{pushId:move.pushId});expect(c.status).toBe(200);expect(c.results[0].noteId).toBe(first.results[0].noteId);
    const incomplete=await f.call("/v1/manifest/diff",f.manifest([],{scanComplete:false}));expect(incomplete.vanished).toEqual([]);await f.call("/v1/commit",{pushId:incomplete.pushId});
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("present");
    const absent=await f.call("/v1/manifest/diff",f.manifest([]));expect(absent.vanished).toHaveLength(1);await f.call("/v1/commit",{pushId:absent.pushId});
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("absent-locally");expect((await f.catalog.read(FRANK,first.results[0].cite)).ok).toBe(true);
  });

  it("treats exact-hash renames as questions when live protection evidence is unavailable or focus-held",async()=>{
    const denied=fixture(false);await denied.push("move requires proof");
    const d=await denied.call("/v1/manifest/diff",denied.manifest([denied.entry("move requires proof","renamed.md")]));
    expect(d.exactMoves).toEqual([]);expect(d.moveQuestions).toHaveLength(1);
    const held=fixture(true);await held.push("held version");held.catalog.db.run("UPDATE versions SET localState='focus-held'");
    const h=await held.call("/v1/manifest/diff",held.manifest([held.entry("held version","renamed.md")]));
    expect(h.exactMoves).toEqual([]);expect(h.moveQuestions).toHaveLength(1);
  });

  it("records an identical reappearing path as present, without erasing a focus-held state",async()=>{
    const f=fixture();await f.push("reappearing bytes");
    const absent=await f.call("/v1/manifest/diff",f.manifest([]));await f.call("/v1/commit",{pushId:absent.pushId});
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("absent-locally");
    const present=await f.call("/v1/manifest/diff",f.manifest([f.entry("reappearing bytes")]));expect(present.missing).toEqual([]);await f.call("/v1/commit",{pushId:present.pushId});
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("present");
    f.catalog.db.run("UPDATE versions SET localState='focus-held'");
    const held=await f.call("/v1/manifest/diff",f.manifest([]));await f.call("/v1/commit",{pushId:held.pushId});
    expect(f.catalog.db.get<{localState:string}>("SELECT localState FROM versions")!.localState).toBe("focus-held");
  });

  it("keeps held versions visibly held through deduplication and committed-receipt replay",async()=>{
    const f=fixture(),first=await f.push("held after publication");
    f.catalog.db.run("UPDATE versions SET held=1");
    const replay=await f.call("/v1/commit",{pushId:first.pushId});expect(replay.results[0].status).toBe("held");expect(replay.partial).toBe(true);
    const again=await f.call("/v1/manifest/diff",f.manifest([f.entry("held after publication")]));
    const dedup=await f.call("/v1/commit",{pushId:again.pushId});expect(dedup.results[0].status).toBe("held");expect(dedup.partial).toBe(true);
  });

  it("defers a partial snapshot move until a fresh complete snapshot can prove the destination",async()=>{
    const f=fixture(),first=await f.push("move alongside pending note");
    const d=await f.call("/v1/manifest/diff",f.manifest([f.entry("move alongside pending note","renamed.md"),f.entry("new note","second.md")]));
    const partial=await f.call("/v1/commit",{pushId:d.pushId});expect(partial.partial).toBe(true);
    expect(partial.results[0]).toMatchObject({ok:false,status:"held",reason:"move-deferred"});expect(partial.results[0]).not.toHaveProperty("ver");
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:1,content:"new note"}]});
    const finished=await f.call("/v1/commit",{pushId:d.pushId});expect(finished.partial).toBe(true);expect(finished.results[0]).toEqual(partial.results[0]);
    const before=await f.catalog.read(FRANK,first.results[0].cite);expect(before.ok&&before.path).toBe("note.md");
    const next=await f.call("/v1/manifest/diff",f.manifest([f.entry("move alongside pending note","renamed.md"),f.entry("new note","second.md",1)]));
    const moved=await f.call("/v1/commit",{pushId:next.pushId});expect(moved.partial).toBe(false);expect(moved.results[0]).toMatchObject({ok:true,status:"current",noteId:first.results[0].noteId,ver:1});
    const read=await f.catalog.read(FRANK,first.results[0].cite);expect(read.ok && read.path).toBe("renamed.md");
  });

  it("rejects snapshot substitution, unsafe paths, unsupported text types, and oversized manifests before staging",async()=>{
    const f=fixture(),m=f.manifest([f.entry("initial manifest")]);await f.call("/v1/manifest/diff",m);
    expect((await f.call("/v1/manifest/diff",{...m,entries:[f.entry("changed manifest")]})).error).toBe("snapshot-conflict");
    for(const relPath of ["../outside.md","C:/private.md","nested\\note.md","binary.png"]) expect((await f.call("/v1/manifest/diff",f.manifest([f.entry("text",relPath)]))).status).toBe(400);
    expect((await f.call("/v1/manifest/diff",f.manifest([{...f.entry("text"),size:16*1024*1024+1}]))).status).toBe(400);
  });

  it("keeps same-named paths in two registered folders separate and refuses ambiguous legacy writes",async()=>{
    const f=fixture(),first=await f.push("first folder note");
    f.catalog.db.run("INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)",["folder:second-fixture","fixture-device","fixture-volume","second-root","0".repeat(64),"frank","col:synth-desk"]);
    const d=await f.call("/v1/manifest/diff",f.manifest([f.entry("second folder note")],{folderId:"folder:second-fixture",identity:{volumeSerial:"fixture-volume",rootFileId:"second-root"}}));
    expect(d.missing).toHaveLength(1);
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:"second folder note"}]});
    const second=await f.call("/v1/commit",{pushId:d.pushId});expect(second.status).toBe(200);expect(second.results[0].noteId).not.toBe(first.results[0].noteId);
    const firstAgain=await f.call("/v1/manifest/diff",f.manifest([f.entry("first folder note")]));expect(firstAgain.unchanged[0].noteId).toBe(first.results[0].noteId);
    const legacy=await f.catalog.save(FRANK,{content:"ambiguous update",path:"note.md",collection:"col:synth-desk"});expect(legacy).toMatchObject({ok:false,reason:"ambiguous-folder-path"});
  });

  it("migrates a legacy unscoped alias without changing its historical note identity or bytes",async()=>{
    const f=fixture(),old=await f.push("legacy bytes");
    f.catalog.db.exec("DROP INDEX aliases_folder_live; ALTER TABLE aliases DROP COLUMN folderId; CREATE UNIQUE INDEX aliases_live ON aliases(collectionId,path_h,COALESCE(owner,'')) WHERE valid_to IS NULL;");
    f.catalog.db.run("UPDATE meta SET value='2' WHERE key='schema_version'");
    const migrated=new Catalog({db:f.catalog.db,blobStore:f.blobStore,mirror:f.mirror,clock:f.clock,random:f.catalog.random,denyRules:f.catalog.denyRules});
    expect(migrated.db.get<{value:string}>("SELECT value FROM meta WHERE key='schema_version'")!.value).toBe(String(SCHEMA_VERSION));
    const read=await migrated.read(FRANK,old.results[0].cite);expect(read.ok && read.text).toBe("legacy bytes");
    const saved=await migrated.save(FRANK,{content:"legacy bytes",path:"note.md",collection:"col:synth-desk",folderId:"folder:push-fixture"});expect(saved.ok && saved.noteId).toBe(old.results[0].noteId);
  });

  it("refuses an unscoped legacy write when two folders each hold an accessible private shadow alias",async()=>{
    const f=fixture(),partner={principal:"partner",clientClass:"kl-device" as const};
    for(const [folderId,content] of [["folder:shadow-one","one"],["folder:shadow-two","two"]]) {
      const hidden=await f.catalog.save(FRANK,{content:`hidden original ${content}`,folderId,path:"shared.md",collection:"col:synth-desk"});expect(hidden.ok).toBe(true);if(!hidden.ok)throw new Error("fixture");
      f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=?",[hidden.noteId]);
      f.catalog.db.run("DELETE FROM version_classes WHERE noteId=?",[hidden.noteId]);f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'frank-private')",[hidden.noteId]);
      const shadow=await f.catalog.save(partner,{content:`visible shadow ${content}`,folderId,path:"shared.md",collection:"col:synth-desk"});expect(shadow.ok).toBe(true);
    }
    const result=await f.catalog.save(partner,{content:"ambiguous shadow update",path:"shared.md",collection:"col:synth-desk"});
    expect(result).toMatchObject({ok:false,reason:"ambiguous-folder-path"});
  });

  it("retains the pending fence after a storage outage, retries missing only, and releases on expiry",async()=>{
    const f=fixture(),manifest=f.manifest([f.entry("pending content")]),d=await f.call("/v1/manifest/diff",manifest);
    f.blobStore.failWhen=()=>true;const s=await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:"pending content"}]});expect(s.results[0].ok).toBe(false);
    expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs")!.pendingRefs).toContain(d.pushId);
    f.blobStore.failWhen=null;expect((await f.call("/v1/manifest/diff",manifest)).missing).toHaveLength(1);
    f.clock.set("2026-11-10T12:00:00.000Z");new TextPush(f.catalog).expire();
    expect(f.catalog.db.get<{pendingRefs:string}>("SELECT pendingRefs FROM blob_refs")!.pendingRefs).toBe("[]");
    const expired=await f.call("/v1/manifest/diff",manifest);expect(expired.error).toBe("push-expired");expect(expired.status).toBe(410);
  });

  it("rolls back every catalog version and outbox effect if the second version fails mid-commit",async()=>{
    const f=fixture(),entries=[f.entry("atomic first"),f.entry("atomic second","second.md")];
    const d=await f.call("/v1/manifest/diff",f.manifest(entries));
    await f.call("/v1/batch",{pushId:d.pushId,items:[{n:0,content:"atomic first"},{n:1,content:"atomic second"}]});
    const original=f.catalog.db.run.bind(f.catalog.db);let inserts=0;
    const injected=vi.spyOn(f.catalog.db,"run").mockImplementation((sql,params)=>{if(sql.startsWith("INSERT INTO versions(") && ++inserts===2)throw new Error("synthetic second version failure"); return original(sql,params);});
    expect((await f.call("/v1/commit",{pushId:d.pushId})).status).toBe(503);injected.mockRestore();
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM versions")!.n).toBe(0);
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM outbox WHERE step='custody.verify'")!.n).toBe(0);
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.partial).toBe(false);expect(c.results).toHaveLength(2);
  });

  it("guards an exact 16 MiB single upload and preserves BOM, CRLF, and a final UTF-8 codepoint",async()=>{
    const prefix="\uFEFF# Unicode note\r\n",suffix="\r\ncafé ✓",size=16*1024*1024;
    const f=fixture(),text=prefix+"a".repeat(size-new TextEncoder().encode(prefix+suffix).length)+suffix,d=await f.call("/v1/manifest/diff",f.manifest([f.entry(text)]));
    const r=await f.request(`/v1/upload/${d.pushId}/0`,text,f.token,"PUT");expect(r.status).toBe(200);expect(await r.json()).toMatchObject({ok:true,status:"staged"});
    const c=await f.call("/v1/commit",{pushId:d.pushId});expect(c.status).toBe(200);expect(c.results[0].custody).toBe("verified");
    expect(Buffer.compare(Buffer.from((await f.catalog.blobs.get(c.results[0].sha256))!),Buffer.from(text))).toBe(0);
  },120000);
});
