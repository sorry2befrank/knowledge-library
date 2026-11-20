import { it,expect } from 'vitest';
import { MemoryObjectStore,type ObjectStore } from '../packages/core/src/catalog/blobs.ts';
import { generateServiceKey } from '../packages/core/src/policy/acceptance.ts';
import { signRuntimeRelease } from '../packages/core/src/auth/runtime-release.ts';
import { acceptProbeRelease,readProbeReceipt,runSyntheticProbe as runProbe,protectedProbeStore,PROBE_BYTES } from '../apps/api/src/cloudflare/synthetic-probe.ts';
import { RuntimeSafety } from '../apps/api/src/cloudflare/runtime-safety.ts';
import { R2ObjectStore } from '../apps/api/src/cloudflare/r2-store.ts';
const version='00000000-0000-4000-8000-000000000001',nonce='1'.repeat(64),hash='2'.repeat(64);
const runSyntheticProbe=(a:ObjectStore,d:ObjectStore,n:string,v:string,h:string)=>runProbe(a,d,n,v,h,async()=>{});
class Locked extends MemoryObjectStore{
  attempts:string[]=[];
  override async put(k:string,b:Uint8Array,o?:{onlyIfAbsent?:boolean}){this.attempts.push('put:'+k);if(!o?.onlyIfAbsent&&this.objects.has(k)&&/^(ledger|anchors|authz)\//.test(k))throw Error('put: Object protected by policy (10069)');return super.put(k,b,o);}
  override async delete(k:string){this.attempts.push('delete:'+k);if(/^(ledger|anchors|authz)\//.test(k))throw Error('delete: Object protected by policy (10069)');return super.delete(k);}
  override async list():Promise<string[]>{throw Error('listing-forbidden');}
}
async function fixture(){
  const key=await generateServiceKey(),now=new Date().toISOString(),kv=new Map<string,unknown>();
  const trust={approval:{keyId:key.keyId,publicKeyB64:key.publicKeyB64},audience:{origin:'https://probe.invalid',environment:'staging' as const,libraryId:'probe'},now:()=>now};
  const archive=new Locked(),decoy=new Locked(),proofs=new MemoryObjectStore();
  const context={archive,decoy,trust,versionId:version,pause:async()=>{},port:{proofs,get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,structuredClone(v));},sync:async()=>{}}};
  const packet=await signRuntimeRelease({purpose:'kl-runtime-release/v1',audience:trust.audience,versionId:version,revision:1,previousReleaseHash:null,mode:'active',nonce,issuedAt:now,expiresAt:new Date(Date.parse(now)+600_000).toISOString()},key.keyId,key.privateKey);
  return {context,packet,kv,key};
}
it('checks three locks with fixed bytes, leaves locked markers, and cleans both unique mutable controls without listing',async()=>{
  const a=new Locked(),d=new Locked();const result=await runSyntheticProbe(a,d,nonce,version,hash);
  expect(result).toMatchObject({lockEnforcementPassed:true,locks:{tested:3,overwriteDenied:3,deleteDenied:3,originalsIntact:3},stagingControl:{readWriteAccessible:true,markerRemoved:true},sameAccountBinding:{readWriteAccessible:true,markerRemoved:true}});
  expect([...a.objects.keys()].sort()).toEqual(['anchors','authz','ledger'].map(p=>p+'/_lock-probe/'+nonce+'.json'));
  for(const b of a.objects.values())expect(b).toEqual(PROBE_BYTES);expect(d.objects.size).toBe(0);
  expect(d.attempts).toEqual(['put:values/kl-synthetic-probe/'+nonce,'delete:values/kl-synthetic-probe/'+nonce]);
  expect(JSON.stringify(result)).not.toContain(nonce);expect(JSON.stringify(result)).not.toContain('values/');
});
it('reports absent retention protection as a failed lock result instead of claiming success',async()=>{
  const result=await runSyntheticProbe(new MemoryObjectStore(),new MemoryObjectStore(),nonce,version,hash);
  expect(result.lockEnforcementPassed).toBe(false);expect(result.locks).toEqual({tested:3,overwriteDenied:0,deleteDenied:0,originalsIntact:0});
});
it('retains only the documented lock denial through the actual guarded R2 adapter and scrubs other provider errors',async()=>{
  const safety=new RuntimeSafety({get:async()=>undefined,put:async()=>{},delete:async()=>true,sync:async()=>{},abort:()=>{},waitUntil:()=>{}});
  const objects=new Map<string,Uint8Array>();let failure='';
  const binding={async put(k:string,b:ArrayBuffer,o:{onlyIf?:{etagDoesNotMatch:string}}){if(failure)throw Error(failure);if(objects.has(k)){if(o.onlyIf)return null;throw Error('put: Object protected by policy (10069)');}objects.set(k,new Uint8Array(b));return {};},
    async get(k:string){const b=objects.get(k);return b?{arrayBuffer:async()=>new Uint8Array(b).buffer}:null;},async delete(){if(failure)throw Error(failure);throw Error('delete: Object protected by policy (10069)');},async list(){throw Error('forbidden');}};
  const store=protectedProbeStore(safety,new R2ObjectStore(binding));await store.put('marker',PROBE_BYTES,{onlyIfAbsent:true});
  await expect(store.put('marker',PROBE_BYTES)).rejects.toThrow('put: Object locked by bucket policy (10069)');
  await expect(store.delete('marker')).rejects.toThrow('delete: Object locked by bucket policy (10069)');
  failure='put: private-provider-detail (10058)';await expect(store.put('marker',PROBE_BYTES)).rejects.toThrow('archive-unavailable');
});
it.each([
  {name:'temporary overwrite failure',phase:'put',error:new Error('temporary upstream failure')},
  {name:'temporary delete failure',phase:'delete',error:new Error('temporary upstream failure')},
  {name:'ordinary permission denial',phase:'put',error:new Error('put: Access denied (10003)')},
  {name:'rate limit',phase:'delete',error:new Error('delete: Too many requests (10058)')},
  {name:'embedded code without provider format',phase:'put',error:new Error('network problem mentioning (10069)')},
  {name:'wrong operation code',phase:'put',error:new Error('delete: Object protected by policy (10069)')},
  {name:'nonexception object',phase:'put',error:{message:'put: Object protected by policy (10069)'}},
])('does not certify retention after $name',async({phase,error})=>{
  class Faulty extends MemoryObjectStore{
    override async put(k:string,b:Uint8Array,o?:{onlyIfAbsent?:boolean}){
      if(!o?.onlyIfAbsent&&this.objects.has(k)&&/^(ledger|anchors|authz)\//.test(k))throw phase==='put'?error:new Error('put: Object protected by policy (10069)');
      return super.put(k,b,o);
    }
    override async delete(k:string){if(/^(ledger|anchors|authz)\//.test(k))throw phase==='delete'?error:new Error('delete: Object protected by policy (10069)');return super.delete(k);}
  }
  await expect(runSyntheticProbe(new Faulty(),new MemoryObjectStore(),nonce,version,hash)).rejects.toThrow('probe-lock-inconclusive');
});
it('never overwrites or removes a collided marker or accepts arbitrary keys',async()=>{
  const a=new Locked(),d=new Locked(),k='ledger/_lock-probe/'+nonce+'.json';a.objects.set(k,new TextEncoder().encode('unrelated'));
  await expect(runSyntheticProbe(a,d,nonce,version,hash)).rejects.toThrow('probe-collision');expect(a.attempts).toEqual(['put:'+k]);
  await expect(runSyntheticProbe(a,d,'../outside',version,hash)).rejects.toThrow('probe-refused');expect(d.objects.size).toBe(0);
});
it('runs only after pinned signed exact-version staging approval and identical retry never repeats storage mutations',async()=>{
  const f=await fixture();await expect(readProbeReceipt(f.context)).rejects.toThrow();
  await expect(acceptProbeRelease({...f.packet,sig:'A'.repeat(86)},f.context)).rejects.toThrow();expect(f.context.archive.attempts).toEqual([]);
  await expect(acceptProbeRelease(f.packet,{...f.context,versionId:'00000000-0000-4000-8000-000000000002'})).rejects.toThrow();
  await expect(acceptProbeRelease(f.packet,{...f.context,trust:{...f.context.trust,audience:{...f.context.trust.audience,environment:'production'}}})).rejects.toThrow();
  const state=await acceptProbeRelease(f.packet,f.context),before=f.context.archive.attempts.length;
  expect((await readProbeReceipt(f.context)).lockEnforcementPassed).toBe(true);
  await expect(acceptProbeRelease(f.packet,f.context)).resolves.toEqual(state);expect(f.context.archive.attempts.length).toBe(before);
});
it('refuses changed same-version reruns and result corruption; signed closure hides results',async()=>{
  const f=await fixture(),state=await acceptProbeRelease(f.packet,f.context);
  const next=await signRuntimeRelease({...f.packet.claims,revision:2,previousReleaseHash:state.releaseHash,nonce:'3'.repeat(64)},f.key.keyId,f.key.privateKey);
  await expect(acceptProbeRelease(next,f.context)).rejects.toThrow('probe-refused');
  const key='archive-synthetic-probe/'+version,value=f.kv.get(key) as object;f.kv.set(key,{...value,privateContent:'forbidden'});
  await expect(readProbeReceipt(f.context)).rejects.toThrow();f.kv.set(key,value);
  const closed=await signRuntimeRelease({...next.claims,mode:'closed'},f.key.keyId,f.key.privateKey);
  await acceptProbeRelease(closed,f.context);await expect(readProbeReceipt(f.context)).rejects.toThrow();
});
it('does not rerun a reserved native version after KV rollback and a fresh signed activation nonce',async()=>{
  const f=await fixture();let snapshot=new Map<string,unknown>();const put=f.context.port.put;
  f.context.port.put=async(k,v)=>{await put(k,v);if(k==='archive-owner-runtime-release'&&snapshot.size===0)snapshot=new Map([...f.kv].map(([key,value])=>[key,structuredClone(value)]));};
  const active=await acceptProbeRelease(f.packet,f.context);
  const close=await signRuntimeRelease({...f.packet.claims,revision:2,previousReleaseHash:active.releaseHash,mode:'closed',nonce:'3'.repeat(64)},f.key.keyId,f.key.privateKey);
  const closed=await acceptProbeRelease(close,f.context),before=f.context.archive.attempts.length,decoyBefore=f.context.decoy.attempts.length;
  f.kv.clear();for(const[k,v]of snapshot)f.kv.set(k,v);
  const again=await signRuntimeRelease({...f.packet.claims,revision:3,previousReleaseHash:closed.releaseHash,nonce:'4'.repeat(64)},f.key.keyId,f.key.privateKey);
  let uncertain=false;await expect(acceptProbeRelease(again,{...f.context,onUncertain:()=>{uncertain=true;}})).rejects.toThrow('probe-run-uncertain');
  expect(uncertain).toBe(true);expect(f.context.archive.attempts.length).toBe(before);expect(f.context.decoy.attempts.length).toBe(decoyBefore);
});
it('requires immutable reservation readback before effects and refuses missing reservation on completed retry',async()=>{
  const f=await fixture(),proofs=f.context.port.proofs,get=proofs.get.bind(proofs);
  proofs.get=async k=>k.startsWith('anchors/probe-run/')?undefined:get(k);
  await expect(acceptProbeRelease(f.packet,f.context)).rejects.toThrow('probe-run-uncertain');expect(f.context.archive.attempts).toEqual([]);
  proofs.get=get;let uncertain=false;
  await expect(acceptProbeRelease(f.packet,{...f.context,onUncertain:()=>{uncertain=true;}})).rejects.toThrow('probe-run-uncertain');expect(uncertain).toBe(true);
  const done=await fixture();await acceptProbeRelease(done.packet,done.context);done.context.port.proofs.objects.delete('anchors/probe-run/'+version+'.json');
  await expect(acceptProbeRelease(done.packet,done.context)).rejects.toThrow('probe-run-uncertain');await expect(readProbeReceipt(done.context)).rejects.toThrow();
});
