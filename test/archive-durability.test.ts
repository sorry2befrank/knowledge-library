import {describe,it,expect} from 'vitest';
import {Catalog,openNodeSqlite,installBaseline,authenticate,sha256Hex} from '@kl/core';
import {enrollmentFixture} from './helpers/enrollment.ts';
import {sealArchive,verifyArchiveFreshness,restoreArchive} from '../packages/core/src/catalog/durability.ts';

async function fixture(){
  const f=await enrollmentFixture();
  const c={store:f.mirror,libraryId:'library-fixture',minPolicyEpoch:1};
  const scratch=()=>new Catalog({db:openNodeSqlite(),blobStore:f.blobStore,mirror:f.mirror,denyRules:f.denyRules,clock:f.catalog.clock});
  const activate=async()=>{f.catalog.enroll(f.grant);await f.catalog.drainOutbox();};
  return {...f,c,scratch,activate};
}
describe('locked exports and closed recovery',()=>{
  it('allows only exact fixed retention markers alongside actual authorization checkpoints',async()=>{
    const f=await fixture(),key='authz/_lock-probe/'+'a'.repeat(64)+'.json';
    await f.mirror.put(key,new TextEncoder().encode('kl-retention-probe/v1\n'));
    await f.activate();await sealArchive(f.catalog,f.c);const restored=f.scratch();await restoreArchive(restored,f.c);
    await f.mirror.put(key,new TextEncoder().encode('{"seq":1}'));await expect(verifyArchiveFreshness(f.catalog,f.c)).rejects.toThrow();
    f.mirror.objects.delete(key);await f.mirror.put('authz/unknown.json',new Uint8Array());await expect(verifyArchiveFreshness(f.catalog,f.c)).rejects.toThrow();
  });
  it('allows only genuine virgin or baseline-only genesis',async()=>{
    const f=await fixture();await verifyArchiveFreshness(f.catalog,f.c);
    installBaseline(f.catalog,{scopeId:'global',privacy:'team'});
    await verifyArchiveFreshness(f.catalog,f.c);expect(await sealArchive(f.catalog,f.c)).toBeUndefined();
    await f.activate();await expect(verifyArchiveFreshness(f.catalog,f.c)).rejects.toThrow('unproven');
    await sealArchive(f.catalog,f.c);await verifyArchiveFreshness(f.catalog,f.c);
  });
  it('seals enrollment, exact bytes and search projections; restores with read-only tokens',async()=>{
    const f=await fixture();await f.activate();
    const actor={principal:f.claims.principal,clientClass:'kl-device' as const};
    const note=await f.catalog.save(actor,{content:'# Synthetic orchard\nApricot telescope.',collection:'col:fixture',folderId:'folder:fixture',path:'note.md'});
    expect(note.ok).toBe(true);if(!note.ok)throw Error('fixture');await f.catalog.drainOutbox();
    const seal=await sealArchive(f.catalog,f.c);expect(seal?.eventSeq).toBe(f.catalog.head().seq);
    await verifyArchiveFreshness(f.catalog,f.c);
    const restored=f.scratch();await restoreArchive(restored,f.c);
    expect(restored.head()).toEqual(f.catalog.head());
    const cc=f.tokens.find(t=>t.kind==='cc-bearer')!;
    const auth=authenticate(restored.db,cc.token,f.catalog.clock.now());expect(auth.ok).toBe(true);
    const read=await restored.read({principal:f.claims.principal,clientClass:'connector'},note.cite);
    expect(read).toMatchObject({ok:true,sha256:sha256Hex('# Synthetic orchard\nApricot telescope.')});
    const hits=restored.search({principal:f.claims.principal,clientClass:'connector'},'apricot');
    expect(hits.hits.length).toBe(1);
    await expect(restoreArchive(restored,f.c)).rejects.toThrow('unproven');
  });
  it('never acknowledges an export without uncached readback or accepts corrupt snapshot bytes',async()=>{
    const f=await fixture();await f.activate();f.mirror.failWhenGet=k=>k.startsWith('snap/');
    await expect(sealArchive(f.catalog,f.c)).rejects.toThrow();
    expect((await f.mirror.list('anchors/')).length).toBe(0);
    f.mirror.failWhenGet=null;await sealArchive(f.catalog,f.c);
    const key=(await f.mirror.list('snap/'))[0]!;f.mirror.objects.set(key,new TextEncoder().encode('{}'));
    const restored=f.scratch();await expect(restoreArchive(restored,f.c)).rejects.toThrow('unproven');
    expect(restored.head().seq).toBe(0);
  });
  it('refuses an old catalog or snapshot after a newer narrowing checkpoint',async()=>{
    const f=await fixture();await f.activate();await sealArchive(f.catalog,f.c);
    const old=f.scratch();await restoreArchive(old,f.c);
    const token=f.tokens.find(t=>t.kind==='cc-bearer')!;
    const revoke=f.catalog.apply({principal:'system',clientClass:'kl-device'},{kind:'system'},
      {kind:'token.revoke',tokenHash:token.hash,reason:'owner'});
    await f.catalog.acknowledge((revoke.result as {authzSeq:number}).authzSeq);
    await expect(verifyArchiveFreshness(old,f.c)).rejects.toThrow('unproven');
    const empty=f.scratch();await expect(restoreArchive(empty,f.c)).rejects.toThrow('unproven');
    expect(empty.head().seq).toBe(0);
    await sealArchive(f.catalog,f.c);await restoreArchive(empty,f.c);
    expect(authenticate(empty.db,token.token,f.catalog.clock.now()).ok).toBe(false);
  });
  it('fails closed on missing anchors, wrong library, policy rollback and bounded dump overflow',async()=>{
    const f=await fixture();await f.activate();await sealArchive(f.catalog,f.c);
    await expect(verifyArchiveFreshness(f.catalog,{...f.c,libraryId:'other-library'})).rejects.toThrow();
    await expect(verifyArchiveFreshness(f.catalog,{...f.c,minPolicyEpoch:2})).rejects.toThrow();
    const g=await fixture();await g.activate();await expect(sealArchive(g.catalog,{...g.c,maxSnapshotBytes:1})).rejects.toThrow();
    const key=(await f.mirror.list('anchors/'))[0]!;f.mirror.objects.delete(key);
    await expect(verifyArchiveFreshness(f.catalog,f.c)).rejects.toThrow();
  });
});
