import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mintToken } from '../packages/core/src/auth/tokens.ts';
import { sha256Hex } from '../packages/core/src/primitives/sha256.ts';
import { versionCitation } from '../packages/core/src/primitives/citation.ts';
import { PushJournal } from '../cli/kl/src/archive/journal.ts';
import { archiveRetryDelay, runArchiveWorkflow } from '../cli/kl/src/archive/workflow.ts';
import { assertArchiveContext } from '../cli/kl/src/archive/command.ts';
import type { ArchiveRegistration } from '../cli/kl/src/archive/registration.ts';
import type { ArchiveScan } from '../cli/kl/src/archive/source.ts';
import { generateFixtures } from '../fixtures/gen.ts';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(large = false) {
  const parent=resolve('.review','archive-client'); await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'run-')); if(!root.startsWith(parent+sep))throw Error('fixture-escape');roots.push(root);
  const bytes=large ? new TextEncoder().encode('# Synthetic\n'+'x'.repeat((1<<20)+1))
    : new Uint8Array([239,187,191,...new TextEncoder().encode('# Synthetic\r\nArchive byte check.\r\n')]);
  const file={relPath:'note.md',bytes,sha256:sha256Hex(bytes),size:bytes.length,mtime:'2026-10-12T10:00:00.000Z',capturedAt:'2026-10-12T10:01:00.000Z',gitTracked:false,identity:{volumeSerial:'node-dev:1',fileId:'node-ino:2'},changeTime:'1'};
  const scan:ArchiveScan={files:[file],heldLocal:[],skipped:[],readErrors:[],complete:true};
  // Trusted composition fixture, not an enrollment bypass on the command-line surface.
  const registration:ArchiveRegistration={schema:'kl-archive-registration/v1',identityScheme:'node-stat-v1',root:join(root,'source'),identity:file.identity,
    folderId:'folder:fixture',device:'fixture-device',collectionId:'team',privacyClass:'team',apiOrigin:'http://127.0.0.1:8787',libraryRepo:root,
    privacyCensusHash:'1'.repeat(64),approvalReceiptId:'fixture-receipt',policyHash:'2'.repeat(64),policyEpoch:1,registrationEpoch:1,
    issuedAt:'2026-10-12T00:00:00.000Z',expiresAt:'2026-10-13T00:00:00.000Z',denyRules:generateFixtures().denyRules};
  const journalPath=join(root,'kl.sqlite'); let journal=new PushJournal(journalPath);
  let staged=false;let uploads=0;let readbacks=0;let corruption=false;let custody='verified';let wrongHash=false;
  let failManifest=false;let badMissing=false;let expireOnce=false;let reuse=false;let reuseMetadata:unknown;let commitReuse:unknown;
  let overrideReuse=false;let commitDedup:boolean|undefined;let refuseStage=false;
  let commits=0;const snapshots:string[]=[];const received:Uint8Array[]=[];const redirects:unknown[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    redirects.push(init?.redirect);
    const req=new Request(input,init);const path=new URL(req.url).pathname;
    if(path==='/v1/manifest/diff'){
      const body=await req.json() as {snapshotId:string};snapshots.push(body.snapshotId);
      if(failManifest)throw Error('synthetic response lost after open');
      if(expireOnce){expireOnce=false;staged=false;return new Response(null,{status:410});}
      return Response.json({pushId:'0000000001',missing:staged||reuse?[]:[{n:badMissing?99:0,relPath:file.relPath,sha256:file.sha256,size:file.size}],
        ...(reuseMetadata!==undefined?{reusable:reuseMetadata}:reuse?{reusable:[{n:0,relPath:file.relPath,sha256:file.sha256,size:file.size}]}:{})});
    }
    if(path==='/v1/batch'){
      const body=await req.json() as {items:{n:number;contentBase64:string}[]};
      uploads++;received.push(new Uint8Array(Buffer.from(body.items[0]!.contentBase64,'base64')));
      if(refuseStage)return Response.json({results:[{ok:false,n:0,status:'rejected',ruleCodes:['digest-mismatch']}]});
      staged=true;
      return Response.json({results:[{ok:true,n:0,status:'staged'}]});
    }
    if(path==='/v1/upload/0000000001/0'){
      uploads++;received.push(new Uint8Array(await req.arrayBuffer()));staged=true;
      return Response.json({ok:true,n:0,status:'staged'});
    }
    if(path==='/v1/commit'){commits++;return Response.json({pushId:'0000000001',partial:false,results:[{ok:true,n:0,relPath:file.relPath,noteId:'0000000002',ver:1,
      sha256:wrongHash?'0'.repeat(64):file.sha256,cite:versionCitation('0000000002',1,file.sha256),status:'current',deduped:commitDedup??(!reuse&&uploads===0),custody,
      ...(overrideReuse?{reused:commitReuse}:reuse?{reused:true}:{})}]});}
    if(path==='/v1/version/0000000002@1/bytes'){
      readbacks++;return new Response(corruption?new Uint8Array(file.size):new Uint8Array(bytes),{headers:{'x-kl-sha256':file.sha256}});
    }
    return new Response(null,{status:404});
  };
  const token=mintToken(n=>crypto.getRandomValues(new Uint8Array(n))).token;
  return {root,journalPath,file,scan,registration,received,snapshots,redirects,fetcher,
    run:(transport=fetcher)=>runArchiveWorkflow({registration,scan,journal,token,fetch:transport,mode:'push',now:()=> '2026-10-12T11:00:00.000Z'}),
    reload:()=>{journal.close();journal=new PushJournal(journalPath);},close:()=>journal.close(),
    corrupt:(v:boolean)=>{corruption=v;},receivedOnly:()=>{custody='received';},wrongHash:()=>{wrongHash=true;},badMissing:()=>{badMissing=true;},
    loseManifest:(v:boolean)=>{failManifest=v;},expireNext:()=>{expireOnce=true;},get uploads(){return uploads;},get readbacks(){return readbacks;},get commits(){return commits;},
    reuse:()=>{reuse=true;},reuseMetadata:(v:unknown)=>{reuseMetadata=v;},commitReuse:(v:unknown)=>{overrideReuse=true;commitReuse=v;},
    commitDedup:(v:boolean)=>{commitDedup=v;},refuseStage:()=>{refuseStage=true;}};
}

describe('persistent device upload/readback orchestration',()=>{
  it('round-trips BOM/CRLF bytes and records readback separately from source removal',async()=>{
    const f=await fixture();try{
      const receipt=await f.run();expect(receipt.partial).toBe(false);expect(receipt.items[0]!.stage).toBe('READBACK_OK');
      expect(receipt.removalAuthorized).toBe(false);expect(f.received[0]).toEqual(f.file.bytes);expect(f.readbacks).toBe(1);
      expect(f.redirects.every(value=>value==='error')).toBe(true);
    }finally{f.close();}
  });
  it('corrupt readback keeps the run pending; a fresh journal resumes without resending uploaded bytes',async()=>{
    const f=await fixture();try{
      f.corrupt(true);const failed=await f.run();expect(failed.partial).toBe(true);expect(failed.items[0]!.stage).toBe('CUSTODY_OK');
      expect(failed.counts.readbackVerified).toBe(0);expect(failed.counts.pushed).toBe(1);
      const failedDb=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(failedDb.prepare("SELECT count(*) AS n FROM archive_steps WHERE phase='readback' AND state='ok'").get()!.n).toBe(0);
        expect(failedDb.prepare("SELECT count(*) AS n FROM archive_steps WHERE phase='readback' AND state='failed'").get()!.n).toBe(3);
        expect(failedDb.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);
      }finally{failedDb.close();}
      f.reload();f.corrupt(false);
      const fixed=await f.run();expect(fixed.partial).toBe(false);expect(fixed.snapshotId).toBe(failed.snapshotId);expect(f.uploads).toBe(1);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(1);
        expect(db.prepare("SELECT count(*) AS n FROM archive_runs WHERE state='complete'").get()!.n).toBe(1);
      }finally{db.close();}
    }finally{f.close();}
  });
  it('lost manifest responses preserve one durable snapshot identity across process-style reopen',async()=>{
    const f=await fixture();try{
      f.loseManifest(true);await expect(f.run()).rejects.toThrow('archive-transport-or-response-failed');expect(f.uploads).toBe(0);
      f.reload();f.loseManifest(false);expect((await f.run()).partial).toBe(false);expect(new Set(f.snapshots).size).toBe(1);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare("SELECT count(*) AS n FROM archive_steps WHERE phase='manifest' AND state='failed'").get()!.n).toBe(3);
      }finally{db.close();}
    }finally{f.close();}
  });
  it('received-only custody cannot become CUSTODY_OK or trigger a readback success claim',async()=>{
    const f=await fixture();try{f.receivedOnly();const r=await f.run();expect(r.partial).toBe(true);expect(r.items[0]!.stage).toBe('COMMITTED');expect(r.counts.custodyVerified).toBe(0);expect(f.readbacks).toBe(0);}finally{f.close();}
  });
  it('expired pending upload starts a new durable snapshot and resends all required bytes',async()=>{
    const f=await fixture();try{
      f.corrupt(true);const first=await f.run();f.reload();f.corrupt(false);f.expireNext();
      const second=await f.run();expect(second.partial).toBe(false);expect(second.snapshotId).not.toBe(first.snapshotId);expect(f.uploads).toBe(2);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare("SELECT count(*) AS n FROM archive_runs WHERE state='expired'").get()!.n).toBe(1);
      }finally{db.close();}
    }finally{f.close();}
  });
  it('refuses a mismatched commit hash before reading or checkpointing its cited version',async()=>{
    const f=await fixture();try{f.wrongHash();await expect(f.run()).rejects.toThrow('invalid-server-response');expect(f.readbacks).toBe(0);}finally{f.close();}
  });
  it('never uploads an entry outside its locally admitted manifest',async()=>{
    const f=await fixture();try{f.badMissing();await expect(f.run()).rejects.toThrow('invalid-server-response');expect(f.uploads).toBe(0);}finally{f.close();}
  });
  it.each(['incomplete scan','held local note'])('%s alone stays partial even if every admitted file verifies',async reason=>{
    const f=await fixture();try{
      if(reason==='incomplete scan') f.scan.complete=false;
      else f.scan.heldLocal.push({relPath:'withheld.md',ruleCodes:['student.content']});
      const r=await f.run();expect(r.partial).toBe(true);expect(r.counts.heldLocal).toBe(reason==='held local note'?1:0);expect(r.counts.readbackVerified).toBe(1);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare('SELECT ver FROM archive_versions').all()).toEqual([{ver:1}]);
        expect(db.prepare('SELECT state FROM archive_runs').all()).toEqual([{state:'complete'}]);
      }finally{db.close();}
    }finally{f.close();}
  });
  it('accounts reused bytes separately from an already-existing destination version and defaults old servers to false',async()=>{
    const f=await fixture();try{
      f.reuse();const receipt=await f.run();
      expect(receipt).toMatchObject({partial:false,removalAuthorized:false,counts:{pushed:1,deduplicated:0,reused:1,reusedBytes:f.file.size,readbackVerified:1},
        items:[{reused:true,deduped:false,stage:'READBACK_OK'}]});
      expect(f.uploads).toBe(0);
    }finally{f.close();}
    const legacy=await fixture();try{
      expect(await legacy.run()).toMatchObject({counts:{reused:0,reusedBytes:0},items:[{reused:false}]});
    }finally{legacy.close();}
  });
  it('reused content still needs exact readback before checkpoints and resumes from the same snapshot',async()=>{
    const f=await fixture();try{
      f.reuse();f.corrupt(true);const failed=await f.run();
      expect(failed).toMatchObject({partial:true,counts:{reused:1,reusedBytes:f.file.size,readbackVerified:0},items:[{reused:true,stage:'CUSTODY_OK',reason:'readback-failed'}]});
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);
        expect(db.prepare("SELECT count(*) AS n FROM archive_runs WHERE state='complete'").get()!.n).toBe(0);
      }finally{db.close();}
      f.reload();f.corrupt(false);const resumed=await f.run();
      expect(resumed.snapshotId).toBe(failed.snapshotId);expect(resumed.partial).toBe(false);expect(f.uploads).toBe(0);
    }finally{f.close();}
  });
  it.each(['not-array','out-of-range','wrong-path','wrong-hash','wrong-size','duplicate','overlap'])('rejects untrusted reusable metadata (%s) before upload or commit',async(kind)=>{
    const f=await fixture();try{
      const entry={n:0,relPath:f.file.relPath,sha256:f.file.sha256,size:f.file.size};
      const cases:Record<string,unknown>={'not-array':{},'out-of-range':[{...entry,n:99}], 'wrong-path':[{...entry,relPath:'unrelated.md'}],
        'wrong-hash':[{...entry,sha256:'0'.repeat(64)}],'wrong-size':[{...entry,size:entry.size+1}],duplicate:[entry,entry],overlap:[entry]};
      if(kind!=='overlap')f.reuse();f.reuseMetadata(cases[kind]);
      await expect(f.run()).rejects.toThrow('invalid-server-response');expect(f.uploads).toBe(0);expect(f.commits).toBe(0);
    }finally{f.close();}
  });
  it('rejects a non-boolean commit reuse claim before readback or checkpoints',async()=>{
    const f=await fixture();try{
      f.reuse();f.commitReuse('true');await expect(f.run()).rejects.toThrow('invalid-server-response');expect(f.readbacks).toBe(0);
    }finally{f.close();}
  });
  it.each(['batch','single upload','refused stage'])('neutralizes requested reuse claims (%s) without interrupting verified progress',async kind=>{
    const f=await fixture(kind==='single upload');try{
      f.commitReuse(true);if(kind==='refused stage')f.refuseStage();
      const r=await f.run();
      expect(r).toMatchObject({partial:false,removalAuthorized:false,counts:{pushed:1,reused:0,reusedBytes:0,readbackVerified:1},
        items:[{reused:false,stage:'READBACK_OK'}]});
      expect(f.uploads).toBe(1);expect(f.received[0]).toEqual(f.file.bytes);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{expect(db.prepare('SELECT ver FROM archive_versions').all()).toEqual([{ver:1}]);}finally{db.close();}
    }finally{f.close();}
  });
  it.each([false,undefined])('records a bounded mismatch for an offered item with reuse claim %s',async claim=>{
    const f=await fixture();try{
      f.reuse();f.commitReuse(claim);const r=await f.run();
      expect(r).toMatchObject({partial:false,removalAuthorized:false,counts:{reused:0,reusedBytes:0,readbackVerified:1},
        items:[{reused:false,stage:'READBACK_OK',accountingMismatch:'reuse-plan-mismatch'}]});
      expect(f.uploads).toBe(0);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare('SELECT ver FROM archive_versions').all()).toEqual([{ver:1}]);
        const row=db.prepare("SELECT receipt FROM archive_runs WHERE state='complete'").get()!;
        expect(JSON.parse(String(row.receipt)).items[0].accountingMismatch).toBe('reuse-plan-mismatch');
      }finally{db.close();}
    }finally{f.close();}
  });
  it('keeps an accounting mismatch visible beside a failed exact readback',async()=>{
    const f=await fixture();try{
      f.reuse();f.commitReuse(false);f.corrupt(true);const r=await f.run();
      expect(r).toMatchObject({partial:true,removalAuthorized:false,counts:{reused:0,reusedBytes:0,readbackVerified:0},
        items:[{stage:'CUSTODY_OK',reason:'readback-failed',accountingMismatch:'reuse-plan-mismatch'}]});
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{expect(db.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);}finally{db.close();}
    }finally{f.close();}
  });
  it('counts an existing destination once when the server claims both deduplication and reuse',async()=>{
    const f=await fixture();try{
      f.reuse();f.commitDedup(true);const r=await f.run();
      expect(r).toMatchObject({partial:false,counts:{pushed:0,deduplicated:1,reused:0,reusedBytes:0,readbackVerified:1},
        items:[{deduped:true,reused:false,stage:'READBACK_OK'}]});
      expect(f.uploads).toBe(0);
    }finally{f.close();}
  });
  it('preserves an existing reuse receipt on resume when the diff no longer advertises an offer',async()=>{
    const f=await fixture();try{
      f.reuse();f.corrupt(true);const failed=await f.run();f.reload();f.corrupt(false);f.reuseMetadata([]);
      const resumed=await f.run();expect(resumed.snapshotId).toBe(failed.snapshotId);
      expect(resumed).toMatchObject({partial:false,counts:{reused:1,reusedBytes:f.file.size,readbackVerified:1}});expect(f.uploads).toBe(0);
      expect(resumed.items[0]).not.toHaveProperty('accountingMismatch');
    }finally{f.close();}
  });
  it.each(['batch','raw upload'])('keeps prior %s bytes out of reuse accounting after a journal reopen',async kind=>{
    const f=await fixture(kind==='raw upload');try{
      f.commitReuse(true);f.corrupt(true);const first=await f.run();
      expect(first).toMatchObject({partial:true,counts:{reused:0,reusedBytes:0},items:[{stage:'CUSTODY_OK'}]});
      expect(f.uploads).toBe(1);f.reload();f.corrupt(false);
      const resumed=await f.run();
      expect(resumed.snapshotId).toBe(first.snapshotId);expect(f.uploads).toBe(1);
      expect(resumed).toMatchObject({partial:false,removalAuthorized:false,counts:{reused:0,reusedBytes:0,readbackVerified:1},items:[{stage:'READBACK_OK',reused:false}]});
    }finally{f.close();}
  });
  it.each(['batch','raw upload'])('recovers legacy %s accounting when per-item upload markers are absent',async kind=>{
    const f=await fixture(kind==='raw upload');try{
      f.commitReuse(true);f.corrupt(true);const first=await f.run();
      // Model an existing pending journal from the older client: it stored raw
      // item indices, but batch intents did not include their item membership.
      const legacy=new DatabaseSync(f.journalPath);try{
        legacy.prepare("DELETE FROM archive_steps WHERE phase='upload-plan'").run();
        expect(legacy.prepare('SELECT count(*) AS n FROM archive_steps WHERE phase=?').get(kind==='batch'?'batch':'upload')!.n).toBe(1);
      }finally{legacy.close();}
      f.reload();f.corrupt(false);const resumed=await f.run();
      expect(resumed.snapshotId).toBe(first.snapshotId);expect(f.uploads).toBe(1);
      expect(resumed).toMatchObject({partial:false,removalAuthorized:false,counts:{reused:0,reusedBytes:0,readbackVerified:1},items:[{reused:false,stage:'READBACK_OK'}]});
    }finally{f.close();}
  });
  it.each(['batch','raw upload'])('durably marks each %s before the transport can observe its bytes',async kind=>{
    const f=await fixture(kind==='raw upload');try{
      let checked=false;
      const transport:typeof fetch=async(input,init)=>{
        const path=new URL(String(input)).pathname;
        if(path==='/v1/batch'||path.startsWith('/v1/upload/')){
          const observer=new DatabaseSync(f.journalPath,{readOnly:true});try{
            expect(observer.prepare("SELECT item FROM archive_steps WHERE phase='upload-plan' ORDER BY item").all()).toEqual([{item:0}]);
          }finally{observer.close();}
          checked=true;
        }
        return f.fetcher(input,init);
      };
      expect((await f.run(transport)).partial).toBe(false);expect(checked).toBe(true);expect(f.uploads).toBe(1);
    }finally{f.close();}
  });
  it('does not carry an expired snapshot upload marker into a fresh true-reuse run',async()=>{
    const f=await fixture();try{
      f.commitReuse(true);f.corrupt(true);const first=await f.run();expect(f.uploads).toBe(1);
      f.reload();f.corrupt(false);f.expireNext();f.reuse();
      const second=await f.run();expect(second.snapshotId).not.toBe(first.snapshotId);expect(f.uploads).toBe(1);
      expect(second).toMatchObject({partial:false,counts:{reused:1,reusedBytes:f.file.size,readbackVerified:1},items:[{reused:true}]});
    }finally{f.close();}
  });
  it('preserves a pending reuse failure without readback proof or a destination checkpoint',async()=>{
    const f=await fixture();try{
      f.reuse();const transport:typeof fetch=async(input,init)=>new URL(String(input)).pathname==='/v1/commit'
        ? Response.json({pushId:'0000000001',partial:true,results:[{ok:false,n:0,relPath:f.file.relPath,status:'pending',reason:'reuse-failed'}]})
        : f.fetcher(input,init);
      const r=await f.run(transport);
      expect(r).toMatchObject({partial:true,removalAuthorized:false,counts:{reused:0,reusedBytes:0,readbackVerified:0},
        items:[{status:'pending',reason:'reuse-failed',stage:'UNPROVEN',reused:false}]});
      expect(f.readbacks).toBe(0);
      const db=new DatabaseSync(f.journalPath,{readOnly:true});try{
        expect(db.prepare('SELECT count(*) AS n FROM archive_versions').get()!.n).toBe(0);
        expect(db.prepare('SELECT state FROM archive_runs').all()).toEqual([{state:'pending'}]);
      }finally{db.close();}
    }finally{f.close();}
  });
  it('partial scans and withheld notes stay visible even if every admitted file verifies',async()=>{
    const f=await fixture();try{f.scan.complete=false;f.scan.heldLocal.push({relPath:'withheld.md',ruleCodes:['student.content']});f.scan.readErrors.push({relPath:'unreadable.txt',code:'source-unavailable'});
      const r=await f.run();expect(r.partial).toBe(true);expect(r.counts.heldLocal).toBe(1);expect(r.counts.readErrors).toBe(1);expect(r.counts.readbackVerified).toBe(1);
    }finally{f.close();}
  });
});

it('respects bounded service retry windows, including dated Retry-After values',()=>{
  const now=Date.parse('2026-10-12T12:00:00Z');
  expect(archiveRetryDelay(429,'60',0,now)).toBe(60_000);
  expect(archiveRetryDelay(503,'Mon, 12 Oct 2026 12:00:02 GMT',0,now)).toBe(2000);
  expect(archiveRetryDelay(429,'999999999',0,now)).toBe(60_000);
  expect(archiveRetryDelay(429,'invalid',1,now)).toBe(2000);
  expect(archiveRetryDelay(429,' ',0,now)).toBe(1000);
  expect(archiveRetryDelay(503,null,0,now)).toBe(100);
});

it('refuses Orrery and headless contexts before any effect, including an empty ARMILLARY variable',()=>{
  expect(()=>assertArchiveContext({},'D:/fixture','powershell.exe')).not.toThrow();
  for(const [env,cwd,parent] of [[{ARMILLARY_ROLE:''},'D:/fixture','powershell.exe'],[{},join('D:/','orrery','work'),'powershell.exe'],[{},'D:/fixture','claude --print prompt'],[{},'D:/fixture','claude -p prompt'],[{},'D:/fixture','']] as const)
    expect(()=>assertArchiveContext(env,cwd,parent)).toThrow();
});
