import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../apps/api/src/handler.ts';
import { RateLimiter, sha256Hex } from '@kl/core';
import { FRANK, issueToken, newCatalog } from './helpers/load.ts';

// Independently authored synthetic review probes. The direct class edits model
// older accepted versions whose access class differs from the current version.
function fixture(collection='col:synth-desk') {
  const f = newCatalog();
  const folder = 'folder:independent-destination';
  f.catalog.db.run('INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)',
    [folder, 'review-device', 'review-volume', 'review-root', '0'.repeat(64), 'frank', collection]);
  const token = issueToken(f.catalog, 'frank', 'kl-device');
  const api = createApiHandler({catalog:f.catalog,rateLimiter:new RateLimiter(10000)});
  let sequence = 0;
  const call = async (path:string,body:unknown) => {
    const response = await api(new Request(`https://synthetic.invalid${path}`, {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
    return {http:response.status,...await response.json() as Record<string,any>} as {http:number} & Record<string,any>;
  };
  const entry = (text:string,path='copy.md',base?:number) => ({relPath:path,sha256:sha256Hex(text),size:Buffer.byteLength(text),mtime:'2026-10-01T12:00:00.000Z',gitTracked:false,...(base === undefined ? {} : {lastKnownVer:base})});
  const diff = (entries:ReturnType<typeof entry>[]) => call('/v1/manifest/diff',{snapshotId:`independent-${++sequence}`,folderId:folder,device:'review-device',collection,identity:{volumeSerial:'review-volume',rootFileId:'review-root'},scanComplete:true,heldLocal:{},entries});
  const save = async (text:string,path='source.md',base?:number) => {
    const result = await f.catalog.save(FRANK,{content:text,path,folderId:'folder:independent-source',collection,baseVer:base});
    expect(result.ok).toBe(true); if (!result.ok) throw Error('synthetic-setup-failed'); return result;
  };
  const classes = (noteId:string,ver:number,values:string[]) => {
    f.catalog.db.run('UPDATE versions SET privacy_class=? WHERE noteId=? AND ver=?',[values.slice().sort().join('+'),noteId,ver]);
    f.catalog.db.run('DELETE FROM version_classes WHERE noteId=? AND ver=?',[noteId,ver]);
    for (const value of values) f.catalog.db.run('INSERT INTO version_classes(noteId,ver,class) VALUES (?,?,?)',[noteId,ver,value]);
  };
  return {...f,folder,call,entry,diff,save,classes};
}

describe('independent archived-content reuse review',()=>{
  it('does not reveal a hidden old version through a readable current version',async()=>{
    const f=fixture(),old=await f.save('old hidden synthetic bytes');
    await f.save('readable current synthetic bytes','source.md',old.ver);
    f.classes(old.noteId,old.ver,['partner-private','team']);
    const d=await f.diff([f.entry('old hidden synthetic bytes')]);
    expect(d.http).toBe(200);expect(d.missing).toHaveLength(1);expect(d.reusable??[]).toEqual([]);expect(d.unchanged).toEqual([]);
    expect(JSON.stringify(d)).not.toContain(old.noteId);
  });

  it('can reuse a readable old version even when its current version is hidden',async()=>{
    const f=fixture(),text='readable historical synthetic bytes',old=await f.save(text);
    const current=await f.save('hidden current synthetic bytes','source.md',old.ver);
    f.classes(current.noteId,current.ver,['partner-private','team']);
    const d=await f.diff([f.entry(text)]);
    expect(d.http).toBe(200);expect(d.missing).toEqual([]);expect(d.reusable).toEqual([{n:0,relPath:'copy.md',sha256:old.sha256,size:Buffer.byteLength(text)}]);
    expect(JSON.stringify(d)).not.toContain(old.noteId);
    const c=await f.call('/v1/commit',{pushId:d.pushId});
    expect(c.http).toBe(200);expect(c.results).toHaveLength(1);expect(c.results[0]).toMatchObject({ok:true,reused:true,deduped:false,status:'current'});
    expect(c.results[0].noteId).not.toBe(old.noteId);
    expect((await f.catalog.read(FRANK,old.cite)).ok).toBe(true);
  });

  it('withholds a readable narrow source without manufacturing a client read or a rerouted note',async()=>{
    const f=fixture(),text='narrow source synthetic bytes',source=await f.save(text);
    f.classes(source.noteId,source.ver,['frank-private','team']);
    const beforeReads=f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM reads')!.n;
    const d=await f.diff([f.entry(text)]);
    expect(d.missing).toEqual([]);expect(d.reusable).toHaveLength(1);
    const c=await f.call('/v1/commit',{pushId:d.pushId});
    expect(c.http).toBe(200);expect(c.partial).toBe(true);expect(c.results).toEqual([{ok:false,status:'pending',reason:'reuse-failed',n:0,relPath:'copy.md'}]);
    expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM notes')!.n).toBe(1);
    expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM versions')!.n).toBe(1);
    expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM reads')!.n).toBe(beforeReads);
  });

  it('does not broaden known narrow lineage when failed reuse falls back to an upload',async()=>{
    const f=fixture(),text='narrow source cannot escape through upload fallback',source=await f.save(text);
    f.classes(source.noteId,source.ver,['frank-private','team']);
    const d=await f.diff([f.entry(text)]);expect(d.reusable).toHaveLength(1);
    const first=await f.call('/v1/commit',{pushId:d.pushId});
    expect(first.results).toEqual([{ok:false,status:'pending',reason:'reuse-failed',n:0,relPath:'copy.md'}]);
    const before=f.catalog.db.all('SELECT * FROM versions ORDER BY noteId,ver');
    const upload=await f.call('/v1/batch',{pushId:d.pushId,items:[{n:0,content:text}]});
    expect(upload.http).toBe(200);expect(upload.results[0]).toMatchObject({ok:false,status:'held',reason:'review'});
    const c=await f.call('/v1/commit',{pushId:d.pushId});
    expect(c.http).toBe(200);expect(c.results).toEqual([expect.objectContaining({ok:false,status:'held',reason:'review',n:0})]);
    expect(f.catalog.db.all('SELECT * FROM versions ORDER BY noteId,ver')).toEqual(before);
    expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM notes')!.n).toBe(1);
    expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM aliases WHERE folderId=?',[f.folder])!.n).toBe(0);
  });

  it('rechecks exact source access after a storage await even without an event-generation change',async()=>{
    const f=fixture(),text='source becomes hidden during reuse',source=await f.save(text);
    const d=await f.diff([f.entry(text)]);expect(d.reusable).toHaveLength(1);
    const original=f.blobStore.get.bind(f.blobStore);let changed=false;
    const spy=vi.spyOn(f.blobStore,'get').mockImplementation(async key=>{const bytes=await original(key);if(!changed&&key.startsWith('blobs/')){changed=true;f.classes(source.noteId,source.ver,['partner-private','team']);}return bytes;});
    try {
      const c=await f.call('/v1/commit',{pushId:d.pushId});
      expect(changed).toBe(true);expect((c.results??[]).filter((row:any)=>row.ok)).toEqual([]);
      expect(f.catalog.db.get<{n:number}>('SELECT count(*) AS n FROM notes WHERE folderId=?',[f.folder])!.n).toBe(0);
    } finally {spy.mockRestore();}
  });

  it('counts two destinations independently when both reuse one historical blob',async()=>{
    const f=fixture(),text='one archived blob for independent destinations',source=await f.save(text);
    const d=await f.diff([f.entry(text,'first.md'),f.entry(text,'second.md')]);
    expect(d.missing).toEqual([]);expect(d.reusable).toHaveLength(2);
    const c=await f.call('/v1/commit',{pushId:d.pushId});
    expect(c.http).toBe(200);expect(c.partial).toBe(false);expect(c.results).toHaveLength(2);
    expect(new Set(c.results.map((row:any)=>row.noteId)).size).toBe(2);
    expect(c.results.every((row:any)=>row.reused===true&&row.deduped===false&&row.noteId!==source.noteId)).toBe(true);
    const blob=f.catalog.db.get<{refcount:number;pendingRefs:string;state:string}>('SELECT refcount,pendingRefs,state FROM blob_refs WHERE sha256=?',[source.sha256])!;
    expect(blob).toMatchObject({refcount:3,pendingRefs:'[]',state:'live'});
    expect((await f.call('/v1/commit',{pushId:d.pushId})).results).toEqual(c.results);
    expect(f.catalog.db.get<{refcount:number}>('SELECT refcount FROM blob_refs WHERE sha256=?',[source.sha256])!.refcount).toBe(3);
  });

  it('does not promote an inaccessible destination proposal while reusing a different readable source',async()=>{
    const f=fixture(),text='readable source matching hidden destination proposal';
    const target=await f.catalog.save(FRANK,{content:'readable destination current',path:'copy.md',folderId:f.folder,collection:'col:synth-desk'});
    expect(target.ok).toBe(true);if(!target.ok)throw Error('synthetic-target-setup');
    const proposal=await f.catalog.save(FRANK,{content:text,path:'copy.md',folderId:f.folder,collection:'col:synth-desk'});
    expect(proposal.ok).toBe(true);if(!proposal.ok)throw Error('synthetic-proposal-setup');
    expect(proposal.status).toBe('proposed-edit');
    f.classes(proposal.noteId,proposal.ver,['partner-private','team']);
    await f.save(text);
    const d=await f.diff([f.entry(text,'copy.md',target.ver)]);expect(d.reusable).toHaveLength(1);
    await f.call('/v1/commit',{pushId:d.pushId});
    const current=f.catalog.db.get<{currentVer:number}>('SELECT currentVer FROM notes WHERE noteId=?',[target.noteId])!.currentVer;
    expect(current).not.toBe(proposal.ver);
    expect(f.catalog.db.get<{vstatus:string}>('SELECT vstatus FROM versions WHERE noteId=? AND ver=?',[proposal.noteId,proposal.ver])!.vstatus).toBe('proposed-edit');
  });

  it('does not drop a broader source-class requirement when a destination proposal has matching bytes',async()=>{
    const f=fixture('inbox:frank'),text='shared bytes with additional source class requirement';
    const target=await f.catalog.save(FRANK,{content:'private destination current',path:'copy.md',folderId:f.folder,collection:'inbox:frank'});
    expect(target.ok).toBe(true);if(!target.ok)throw Error('synthetic-target-setup');
    const proposal=await f.catalog.save(FRANK,{content:text,path:'copy.md',folderId:f.folder,collection:'inbox:frank'});
    expect(proposal.ok).toBe(true);if(!proposal.ok)throw Error('synthetic-proposal-setup');
    expect(proposal.status).toBe('proposed-edit');
    const source=await f.save(text);f.classes(source.noteId,source.ver,['frank-private','team']);
    const d=await f.diff([f.entry(text,'copy.md',target.ver)]);expect(d.reusable).toHaveLength(1);
    const versionsBefore=f.catalog.db.all('SELECT * FROM versions ORDER BY noteId,ver');
    const c=await f.call('/v1/commit',{pushId:d.pushId});
    expect(c.http).toBe(200);expect(c.partial).toBe(true);
    expect(c.results).toEqual([{ok:false,status:'pending',reason:'reuse-failed',n:0,relPath:'copy.md'}]);
    expect(c.missing).toEqual([0]);
    expect(f.catalog.db.get<{currentVer:number}>('SELECT currentVer FROM notes WHERE noteId=?',[target.noteId])!.currentVer).toBe(target.ver);
    expect(f.catalog.db.all('SELECT * FROM versions ORDER BY noteId,ver')).toEqual(versionsBefore);
    expect(f.catalog.db.get<{vstatus:string}>('SELECT vstatus FROM versions WHERE noteId=? AND ver=?',[proposal.noteId,proposal.ver])!.vstatus).toBe('proposed-edit');
  });
});
