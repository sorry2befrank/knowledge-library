import { it,expect } from 'vitest';
import { Catalog,authenticate,sha256Hex } from '@kl/core';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { sealArchive,restoreArchive } from '../packages/core/src/catalog/durability.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';
import { acceptRehearsalRelease,readRehearsalReceipt,parseRehearsalInventory,REHEARSAL_CONTENT,type RehearsalInventory } from '../apps/api/src/cloudflare/recovery-rehearsal.ts';

async function fixture(){
  const f=await enrollmentFixture();f.catalog.enroll(f.grant);await f.catalog.drainOutbox();
  const note=await f.catalog.save({principal:f.claims.principal,clientClass:'kl-device'},{content:REHEARSAL_CONTENT,collection:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,path:'synthetic.md'});
  if(!note.ok)throw Error('fixture');await f.catalog.drainOutbox();const durability={store:f.mirror,libraryId:f.claims.audience.libraryId,minPolicyEpoch:1};
  const seal=(await sealArchive(f.catalog,durability))!;
  const inventory:RehearsalInventory={schema:'kl-rehearsal-inventory/v1',phase:'discard',libraryId:durability.libraryId,principal:f.claims.principal,collectionId:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,noteId:note.noteId,version:1,tokens:f.tokens.map(t=>({kind:t.kind,hash:t.hash})),pin:{snapshotHash:seal.snapshotHash,eventSeq:seal.eventSeq,eventHash:seal.eventHash,authzSeq:seal.authzSeq}};
  const kv=new Map<string,unknown>();let uncertain=false;
  const context={catalog:f.catalog,durability,inventory,versionId:'00000000-0000-4000-8000-000000000021',trust:{approval:f.trust.approval,audience:f.claims.audience,now:()=>f.catalog.clock.now()},onUncertain:()=>{uncertain=true;},
    port:{proofs:f.mirror,get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,structuredClone(v));},sync:async()=>{}}};
  const signed=async(revision=1,previousReleaseHash:string|null=null,mode:'active'|'closed'='active')=>signRuntimeRelease({purpose:'kl-runtime-release/v1',audience:context.trust.audience,versionId:context.versionId,revision,previousReleaseHash,mode,nonce:sha256Hex('nonce:'+revision),issuedAt:f.catalog.clock.now(),expiresAt:new Date(Date.parse(f.catalog.clock.now())+600_000).toISOString()},f.approvalKey.keyId,f.approvalKey.privateKey);
  return {...f,note,seal,context,kv,signed,get uncertain(){return uncertain;}};
}
it('removes only the exactly pinned synthetic projection after sealed revocation; original bytes and revoked denial restore',async()=>{
  const f=await fixture();try{
    const retained=new Map(f.mirror.objects),token=f.tokens.find(t=>t.kind==='cc-bearer')!;const packet=await f.signed();
    await acceptRehearsalRelease(packet,f.context);const receipt=await readRehearsalReceipt(f.context);
    expect(receipt).toMatchObject({revoked:1,projectionEmpty:true,counts:{notes:1,versions:1,tokens:3}});
    expect(f.catalog.head().seq).toBe(0);expect(f.db.all('SELECT * FROM tokens')).toEqual([]);
    for(const [key,bytes] of retained)expect(f.mirror.objects.get(key)).toEqual(bytes);
    expect(f.kv.size).toBe(2); // release mirror and receipt survive the catalog reset
    const restored=new Catalog({db:f.db,blobStore:f.blobStore,mirror:f.mirror,clock:f.catalog.clock,denyRules:f.denyRules});
    await restoreArchive(restored,f.context.durability);
    expect(authenticate(f.db,token.token,f.catalog.clock.now())).toMatchObject({ok:false});
    expect(authenticate(f.db,f.tokens.find(t=>t.kind==='cx-bearer')!.token,f.catalog.clock.now()).ok).toBe(true);
    expect(await restored.read({principal:f.claims.principal,clientClass:'connector'},f.note.cite)).toMatchObject({ok:true,text:expect.stringContaining('Synthetic acceptance fixture')});
    expect(restored.search({principal:f.claims.principal,clientClass:'connector'},'acceptance').hits.length).toBe(1);
    const head=restored.head();await acceptRehearsalRelease(packet,f.context);expect(restored.head()).toEqual(head);
  }finally{f.db.close();}
});
it.each(['pin','token','extra-note','unknown-table','unknown-fts','bytes','pending','wrong-signature','production'] as const)('refuses %s before clearing any catalog rows',async(kind)=>{
  const f=await fixture();try{
    let packet=await f.signed();
    if(kind==='pin')f.context.inventory.pin.eventHash='0'.repeat(64);
    if(kind==='token')f.context.inventory.tokens[1]!.hash='0'.repeat(64);
    if(kind==='extra-note'){const r=await f.catalog.save({principal:f.claims.principal,clientClass:'kl-device'},{content:'# Other synthetic\nDo not clear.',collection:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,path:'other.md'});expect(r.ok).toBe(true);await f.catalog.drainOutbox();await sealArchive(f.catalog,f.context.durability);}
    if(kind==='unknown-table')f.db.exec('CREATE TABLE unrelated(id TEXT)');
    if(kind==='unknown-fts')f.db.exec('CREATE VIRTUAL TABLE fts_unrelated USING fts5(body)');
    if(kind==='bytes'){const key=[...f.blobStore.objects.keys()].find(k=>k.startsWith('blobs/'))!;f.blobStore.objects.set(key,new TextEncoder().encode('different'));}
    if(kind==='pending')f.db.run("UPDATE outbox SET state='pending' WHERE id=(SELECT min(id) FROM outbox)");
    if(kind==='wrong-signature')packet={...packet,sig:'A'.repeat(86)};
    if(kind==='production')f.context.trust.audience={...f.context.trust.audience,environment:'production'};
    const head=f.catalog.head();await expect(acceptRehearsalRelease(packet,f.context)).rejects.toThrow();expect(f.catalog.head()).toEqual(head);expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(3);
  }finally{f.db.close();}
});
it('rolls back every SQL deletion if the clear transaction fails, retaining the sealed revocation',async()=>{
  const f=await fixture();try{
    const run=f.db.run.bind(f.db);f.db.run=(query,params)=>{if(query==='DELETE FROM notes')throw Error('synthetic-clear-failure');return run(query,params);};
    await expect(acceptRehearsalRelease(await f.signed(),f.context)).rejects.toThrow('synthetic-clear-failure');
    expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM notes')?.n).toBe(1);expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(3);
    expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM tokens WHERE revokedAt IS NOT NULL')?.n).toBe(1);
    expect(f.catalog.head().seq).toBe(f.seal.eventSeq+1);
  }finally{f.db.close();}
});
it('rejects tampered or missing completed receipts even while the release mirror remains valid',async()=>{
  const f=await fixture();try{
    const packet=await f.signed();await acceptRehearsalRelease(packet,f.context);
    const key='archive-recovery-rehearsal/'+f.context.versionId,value=f.kv.get(key) as {after:{snapshotHash:string}};
    const original=structuredClone(value);value.after.snapshotHash='e'.repeat(64);
    await expect(readRehearsalReceipt(f.context)).rejects.toThrow();
    f.kv.set(key,original);f.mirror.objects.delete('anchors/recovery-rehearsal-result/'+f.context.versionId+'.json');
    await expect(acceptRehearsalRelease(packet,f.context)).rejects.toThrow('uncertain');
  }finally{f.db.close();}
});
it('uses retained once-only evidence to refuse a DO rollback even with a new signed release',async()=>{
  const f=await fixture();try{
    const first=await acceptRehearsalRelease(await f.signed(),f.context);f.kv.delete('archive-recovery-rehearsal/'+f.context.versionId);
    const close=await acceptRehearsalRelease(await f.signed(2,first.releaseHash,'closed'),f.context);
    await expect(acceptRehearsalRelease(await f.signed(3,close.releaseHash),f.context)).rejects.toThrow('uncertain');expect(f.uncertain).toBe(true);
  }finally{f.db.close();}
});
it('never clears the source catalog after checkpoint or seal failure and never retries a reserved failed run',async()=>{
  for(const prefix of ['authz/','snap/']){const f=await fixture();try{
    f.mirror.failWhen=k=>k.startsWith(prefix);const packet=await f.signed();await expect(acceptRehearsalRelease(packet,f.context)).rejects.toThrow();
    expect(f.db.get<{n:number}>('SELECT count(*) AS n FROM notes')?.n).toBe(1);f.mirror.failWhen=null;
    await expect(acceptRehearsalRelease(packet,f.context)).rejects.toThrow('uncertain');expect(f.uncertain).toBe(true);
  }finally{f.db.close();}}
});
it('requires a complete external pin and exactly three distinct token identities',async()=>{
  const f=await fixture();try{
    expect(parseRehearsalInventory(JSON.stringify(f.context.inventory))).toEqual(f.context.inventory);
    for(const change of [{pin:null},{phase:'inspect'},{tokens:[f.context.inventory.tokens[0]]},{extra:'caller-selector'}])expect(()=>parseRehearsalInventory(JSON.stringify({...f.context.inventory,...change}))).toThrow();
  }finally{f.db.close();}
});
