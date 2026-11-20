import { describe,it,expect,vi } from 'vitest';
import { createApiHandler } from '../apps/api/src/handler.ts';
import { Catalog,RateLimiter,sha256Hex } from '@kl/core';
import { blobKey } from '../packages/core/src/catalog/blobs.ts';
import { newCatalog,issueToken,FRANK,PARTNER } from './helpers/load.ts';

function fixture(){
  const e=newCatalog();let catalog=e.catalog;
  for(const id of ['source','destination'])catalog.db.run('INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES(?,?,?,?,?,?,?)',[`folder:${id}`,'device','volume',id,'0'.repeat(64),'frank','col:synth-desk']);
  const token=issueToken(catalog,'frank','kl-device');let api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)});
  const call=async(path:string,body:unknown)=>{const r=await api(new Request(`https://fixture.local${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}));return {http:r.status,...await r.json() as any};};
  const manifest=(text:string)=>({snapshotId:'safety-snapshot',folderId:'folder:destination',collection:'col:synth-desk',device:'device',identity:{volumeSerial:'volume',rootFileId:'destination'},scanComplete:true,heldLocal:{},entries:[{relPath:'copy.md',sha256:sha256Hex(text),size:new TextEncoder().encode(text).length,mtime:'2026-10-01T12:00:00.000Z',gitTracked:false}]});
  return {...e,get catalog(){return catalog;},call,manifest,restart(){catalog=new Catalog({db:catalog.db,blobStore:e.blobStore,mirror:e.mirror,clock:e.clock,random:catalog.random,denyRules:catalog.denyRules});api=createApiHandler({catalog,rateLimiter:new RateLimiter(10000)});}};
}

describe('independent fallback lineage boundary',()=>{
  it.each(['admission','missing-storage'] as const)('must not discard narrower source classes after %s fallback',async fault=>{
    const f=fixture(),text='Private synthetic source with no content policy signals';
    const s=await f.catalog.save(FRANK,{content:text,path:'source.md',folderId:'folder:source',collection:'col:synth-desk'});expect(s.ok).toBe(true);if(!s.ok)throw Error('fixture');
    f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=?",[s.noteId]);
    f.catalog.db.run('DELETE FROM version_classes WHERE noteId=?',[s.noteId]);
    f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'frank-private')",[s.noteId]);
    const manifest=f.manifest(text),d=await f.call('/v1/manifest/diff',manifest);expect(d.reusable).toHaveLength(1);
    if(fault==='missing-storage')f.blobStore.objects.delete(blobKey(s.sha256));
    const first=await f.call('/v1/commit',{pushId:d.pushId});expect(first.http).toBe(200);expect(first.results[0]).toMatchObject({ok:false,status:'pending',reason:'reuse-failed'});expect(JSON.stringify(first)).not.toContain(s.noteId);
    f.restart();const next=await f.call('/v1/manifest/diff',manifest);expect(next.missing).toHaveLength(1);expect(JSON.stringify(next)).not.toContain(s.noteId);
    const batch=await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text}]});
    expect(batch.results[0]).toMatchObject({ok:false,status:'held'});
    const result=await f.call('/v1/commit',{pushId:d.pushId});
    const classes=f.catalog.db.all<{class:string}>("SELECT c.class FROM version_classes c JOIN notes n ON n.noteId=c.noteId WHERE n.folderId='folder:destination'");
    const reads=await Promise.all(result.results.filter((r:any)=>r.ok).map((r:any)=>f.catalog.read(PARTNER,r.cite)));
    expect(reads.some(r=>r.ok)).toBe(false);
    expect(classes.every(c=>c.class!=='team')).toBe(true);
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);
  });
});

describe('independent fallback source lifetime',()=>{
  it.each([
    ['class','before-upload'],['withdrawn','before-upload'],
    ['class','before-commit'],['withdrawn','before-commit'],
  ] as const)('refuses %s source changed %s',async(change,timing)=>{
    const f=fixture(),text='Lifetime-bound fallback source';
    const s=await f.catalog.save(FRANK,{content:text,path:'source.md',folderId:'folder:source',collection:'col:synth-desk'});if(!s.ok)throw Error('fixture');
    const manifest=f.manifest(text),d=await f.call('/v1/manifest/diff',manifest);expect(d.reusable).toHaveLength(1);
    f.blobStore.objects.delete(blobKey(s.sha256));
    const first=await f.call('/v1/commit',{pushId:d.pushId});expect(first.results[0]).toMatchObject({ok:false,status:'pending',reason:'reuse-failed'});
    f.restart();expect((await f.call('/v1/manifest/diff',manifest)).missing).toHaveLength(1);
    const narrow=()=>{
      if(change==='withdrawn')f.catalog.db.run("UPDATE notes SET status='withdrawn' WHERE noteId=?",[s.noteId]);
      else {
        f.catalog.db.run("UPDATE versions SET privacy_class='frank-private' WHERE noteId=?",[s.noteId]);
        f.catalog.db.run('DELETE FROM version_classes WHERE noteId=?',[s.noteId]);
        f.catalog.db.run("INSERT INTO version_classes(noteId,ver,class) VALUES (?,1,'frank-private')",[s.noteId]);
      }
    };
    if(timing==='before-upload')narrow();
    const batch=await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text}]});
    if(timing==='before-commit'){expect(batch.results[0]).toMatchObject({ok:true,status:'staged'});f.restart();narrow();}
    const commit=await f.call('/v1/commit',{pushId:d.pushId});
    expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);
    expect(commit.results?.filter((r:any)=>r.ok)??[]).toEqual([]);
  });
});

describe('independent fallback transaction rechecks',()=>{
  it.each(['push.stage','push.commit'] as const)('checks the source inside %s after outer checks passed',async operation=>{
    const f=fixture(),text='Transactional fallback source';
    const s=await f.catalog.save(FRANK,{content:text,path:'source.md',folderId:'folder:source',collection:'col:synth-desk'});if(!s.ok)throw Error('fixture');
    const d=await f.call('/v1/manifest/diff',f.manifest(text));f.blobStore.objects.delete(blobKey(s.sha256));
    expect((await f.call('/v1/commit',{pushId:d.pushId})).results[0]).toMatchObject({reason:'reuse-failed'});
    if(operation==='push.commit')expect((await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text}]})).results[0].ok).toBe(true);
    const apply=f.catalog.apply.bind(f.catalog);let intercepted=false;
    const spy=vi.spyOn(f.catalog,'apply').mockImplementation((actor,authority,op)=>{
      if(op.kind===operation&&!intercepted){intercepted=true;f.catalog.db.run("UPDATE notes SET status='withdrawn' WHERE noteId=?",[s.noteId]);}
      return apply(actor,authority,op);
    });
    try{
      if(operation==='push.stage')expect((await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text}]})).results[0]).toMatchObject({ok:false,status:'refused'});
      const committed=await f.call('/v1/commit',{pushId:d.pushId});expect(committed.results[0]).toMatchObject({ok:false,status:'refused'});
      expect(intercepted).toBe(true);expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM notes WHERE folderId='folder:destination'")!.n).toBe(0);
      expect(f.catalog.db.get<{pendingRefs:string}>('SELECT pendingRefs FROM blob_refs WHERE sha256=?',[s.sha256])!.pendingRefs).toBe('[]');
    }finally{spy.mockRestore();}
  });
});


it('treats an invalid restored base checkpoint as an item refusal, not a neighbor rollback',async()=>{
  const f=fixture();const current=await f.catalog.save(FRANK,{content:'current destination',path:'copy.md',folderId:'folder:destination',collection:'col:synth-desk'});expect(current.ok).toBe(true);
  const text='new local bytes',neighbor='independent bytes',manifest=f.manifest(text);
  Object.assign(manifest.entries[0]!,{lastKnownVer:99});
  manifest.entries.push({...manifest.entries[0]!,relPath:'neighbor.md',sha256:sha256Hex(neighbor),size:new TextEncoder().encode(neighbor).length});delete (manifest.entries[1] as any).lastKnownVer;
  const d=await f.call('/v1/manifest/diff',manifest);
  await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text},{n:1,content:neighbor}]});
  const c=await f.call('/v1/commit',{pushId:d.pushId});
  expect(c.http).toBe(200);expect(c.results).toEqual(expect.arrayContaining([expect.objectContaining({n:0,ok:false,status:'refused'}),expect.objectContaining({n:1,ok:true})]));
});
