import { expect,it } from 'vitest';
import { generateServiceKey } from '../packages/core/src/policy/acceptance.ts';
import {MemoryObjectStore} from '../packages/core/src/catalog/blobs.ts';
import {canonicalJson} from '../packages/core/src/primitives/canonical.ts';
import {sha256Hex} from '../packages/core/src/primitives/sha256.ts';
import { acceptRuntimeRelease,runtimeIsReleased,runtimeReleaseState,signRuntimeRelease,type RuntimeReleaseClaims,type RuntimeReleaseTrust,RUNTIME_RELEASE_KEY } from '../packages/core/src/auth/runtime-release.ts';
const version='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
async function fixture(){
  const key=await generateServiceKey(),otherKey=await generateServiceKey();let now='2026-10-18T17:00:00.000Z';
  const audience={origin:'https://release.invalid',environment:'staging' as const,libraryId:'release-fixture'};
  const trust:RuntimeReleaseTrust={approval:{keyId:key.keyId,publicKeyB64:key.publicKeyB64},audience,now:()=>now};
  const claims:RuntimeReleaseClaims={purpose:'kl-runtime-release/v1',audience,versionId:version,revision:1,previousReleaseHash:null,
    mode:'active',nonce:'1'.repeat(64),issuedAt:now,expiresAt:'2026-10-18T17:10:00.000Z'};
  const kv=new Map<string,unknown>();let synced=0;
  const port={proofs:new MemoryObjectStore(),get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,structuredClone(v));},sync:async()=>{synced++;}};
  return {key,otherKey,trust,claims,port,kv,get synced(){return synced;},time:(t:string)=>{now=t;},sign:(c=claims)=>signRuntimeRelease(c,key.keyId,key.privateKey)};
}
it('starts closed, flushes activation, retains accepted state beyond issuance expiry, and checks the native provider version',async()=>{
  const f=await fixture();expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);
  const packet=await f.sign();await expect(acceptRuntimeRelease(packet,f.port,f.trust,other)).rejects.toThrow('runtime-release-refused');
  expect(f.kv.size).toBe(0);const accepted=await acceptRuntimeRelease(packet,f.port,f.trust,version);
  expect(accepted.mode).toBe('active');expect(f.synced).toBe(1);expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(true);
  expect(await runtimeIsReleased(f.port,f.trust,other)).toBe(false);expect(await runtimeIsReleased(f.port,f.trust,'')).toBe(false);
  f.time('2026-10-18T18:00:00.000Z');expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(true);
  await expect(acceptRuntimeRelease(packet,f.port,f.trust,version)).rejects.toThrow('runtime-release-refused');
});
it('requires the pinned signature and exact audience, purpose, time, and field set',async()=>{
  const f=await fixture(),packet=await f.sign();
  const forged=await signRuntimeRelease(f.claims,f.key.keyId,f.otherKey.privateKey);
  await expect(acceptRuntimeRelease(forged,f.port,f.trust,version)).rejects.toThrow();
  await expect(acceptRuntimeRelease({...packet,extra:true},f.port,f.trust,version)).rejects.toThrow();
  await expect(acceptRuntimeRelease(await f.sign({...f.claims,audience:{...f.claims.audience,environment:'production'}}),f.port,f.trust,version)).rejects.toThrow();
  await expect(f.sign({...f.claims,purpose:'wrong' as 'kl-runtime-release/v1'})).rejects.toThrow();
  f.time('2026-10-18T16:59:59.000Z');await expect(acceptRuntimeRelease(packet,f.port,f.trust,version)).rejects.toThrow();
  expect(f.kv.size).toBe(0);
});
it('requires a consecutive signed compare-and-swap and cannot replay an old activation after closure',async()=>{
  const f=await fixture(),packet=await f.sign();const active=await acceptRuntimeRelease(packet,f.port,f.trust,version);
  expect(await acceptRuntimeRelease(packet,f.port,f.trust,version)).toEqual(active);expect(f.synced).toBe(1);
  await expect(acceptRuntimeRelease(await f.sign({...f.claims,revision:3,previousReleaseHash:active.releaseHash,mode:'closed'}),f.port,f.trust,version)).rejects.toThrow();
  const close=await f.sign({...f.claims,revision:2,previousReleaseHash:active.releaseHash,mode:'closed',nonce:'2'.repeat(64)});
  const closed=await acceptRuntimeRelease(close,f.port,f.trust,version);expect(closed.mode).toBe('closed');
  expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);
  await expect(acceptRuntimeRelease(packet,f.port,f.trust,version)).rejects.toThrow();
  await expect(acceptRuntimeRelease(await f.sign({...f.claims,revision:3,previousReleaseHash:active.releaseHash}),f.port,f.trust,version)).rejects.toThrow();
});
it('rejects corrupt persisted records, failed flushes, and missing fresh readback without acknowledging activation',async()=>{
  const f=await fixture(),packet=await f.sign();f.kv.set(RUNTIME_RELEASE_KEY,{...packet,sig:'x'.repeat(86)});
  expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);await expect(acceptRuntimeRelease(packet,f.port,f.trust,version)).rejects.toThrow();f.kv.clear();
  await expect(acceptRuntimeRelease(packet,{...f.port,sync:async()=>{throw Error('flush-failed');}},f.trust,version)).rejects.toThrow();
  f.kv.clear();await expect(acceptRuntimeRelease(packet,{...f.port,get:async()=>undefined},f.trust,version)).rejects.toThrow();
});
it('retains closed authority after local rollback and refuses missing/corrupt immutable release proof',async()=>{
  const f=await fixture(),active=await f.sign();const first=await acceptRuntimeRelease(active,f.port,f.trust,version);
  const close=await f.sign({...f.claims,revision:2,previousReleaseHash:first.releaseHash,mode:'closed'});
  await acceptRuntimeRelease(close,f.port,f.trust,version);
  f.kv.set(RUNTIME_RELEASE_KEY,active);expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);
  expect((await runtimeReleaseState(f.port,f.trust))?.mode).toBe('closed');
  f.kv.clear();expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);
  const key=[...f.port.proofs.objects.keys()].sort()[0]!;f.port.proofs.objects.delete(key);
  await expect(runtimeReleaseState(f.port,f.trust)).rejects.toThrow();
});
it('reserves the final bounded-history revision for closure',async()=>{
  const f=await fixture();let previousReleaseHash:string|null=null;
  const prefix='anchors/runtime-release/'+sha256Hex(canonicalJson(f.trust.audience))+'/';
  for(let revision=1;revision<64;revision++){
    const packet=await f.sign({...f.claims,revision,previousReleaseHash});
    previousReleaseHash=sha256Hex(canonicalJson(packet));
    await f.port.proofs.put(prefix+String(revision).padStart(6,'0')+'-'+previousReleaseHash+'.json',new TextEncoder().encode(canonicalJson(packet)));
    f.kv.set(RUNTIME_RELEASE_KEY,packet);
  }
  expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(true);
  await expect(acceptRuntimeRelease(await f.sign({...f.claims,revision:64,previousReleaseHash}),f.port,f.trust,version)).rejects.toThrow('runtime-release-refused');
  const closed=await acceptRuntimeRelease(await f.sign({...f.claims,revision:64,previousReleaseHash,mode:'closed'}),f.port,f.trust,version);
  expect(closed.mode).toBe('closed');expect(await runtimeIsReleased(f.port,f.trust,version)).toBe(false);
  await expect(acceptRuntimeRelease(await f.sign({...f.claims,revision:65,previousReleaseHash:closed.releaseHash}),f.port,f.trust,version)).rejects.toThrow();
});
