import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeSafety, SAFETY_HOLD_KEY,PENDING_EFFECT_KEY, boundedRequest } from '../apps/api/src/cloudflare/runtime-safety.ts';
import { parseRuntimeConfig,readRuntimeConfig,runtimeConfigBindings } from '../apps/api/src/cloudflare/runtime-config.ts';
import { enrollmentFixture } from './helpers/enrollment.ts';
import { boundedArchiveBucket } from '../apps/api/src/cloudflare/runtime-bucket.ts';

afterEach(()=>vi.useRealTimers());
it('rejects oversized native objects before buffering and mismatched read sizes before use',async()=>{
  let read=false,cancelled=false,size=9;let byteCount=9;
  const bucket=boundedArchiveBucket({get:async()=>({size,body:{cancel:async()=>{cancelled=true;}},arrayBuffer:async()=>{read=true;return new ArrayBuffer(byteCount);}}),
    put:async()=>({}),delete:async()=>{},list:async()=>({objects:[],truncated:false})},8);
  await expect(bucket.get('synthetic')).rejects.toThrow('archive-object-too-large');expect(read).toBe(false);expect(cancelled).toBe(true);
  size=8;byteCount=7;await expect((await bucket.get('synthetic'))!.arrayBuffer()).rejects.toThrow('archive-object-size-mismatch');
  await expect(async()=>bucket.put('synthetic',new ArrayBuffer(9),{sha256:'synthetic'})).rejects.toThrow('archive-object-too-large');
});
it('persists a hold before reset and never releases a timed-out writer even if its I/O later finishes',async()=>{
  vi.useFakeTimers(); const writes:string[]=[]; const kv=new Map<string,unknown>();
  const port={get:async(key:string)=>kv.get(key),put:async(key:string,value:unknown)=>{writes.push('hold');kv.set(key,value);},delete:async(key:string)=>kv.delete(key),sync:async()=>{writes.push('flush');},abort:()=>{writes.push('abort');},waitUntil:(_:Promise<unknown>)=>{}};
  const guard=new RuntimeSafety(port,20); await guard.load();
  let finish!:(v:string)=>void;let released=false;
  const operation=guard.run(()=>new Promise<string>(r=>{finish=r;})).then(()=>{released=true;});
  await vi.advanceTimersByTimeAsync(21);
  expect(writes).toEqual(['hold','flush','abort']);expect(guard.held).toBe(true);
  expect(kv.get(SAFETY_HOLD_KEY)).toEqual({schema:'kl-runtime-hold/v1',reason:'deadline'});
  finish('late');await Promise.resolve();await Promise.resolve();expect(released).toBe(false);
  expect(()=>guard.check()).toThrow('archive-unavailable');
  const restarted=new RuntimeSafety(port);await restarted.load();expect(restarted.held).toBe(true);
  void operation;
});
it('keeps the in-memory gate closed when persisting the hold fails and does not reset before persistence',async()=>{
  vi.useFakeTimers();let aborted=false;
  const guard=new RuntimeSafety({get:async()=>undefined,put:async()=>{throw Error('private storage message');},delete:async()=>false,sync:async()=>{},abort:()=>{aborted=true;},waitUntil:()=>{}},10);
  await guard.load();void guard.run(()=>new Promise(()=>{}));await vi.advanceTimersByTimeAsync(11);
  expect(guard.held).toBe(true);expect(aborted).toBe(false);
});
it('flushes pending intent before effects and retains it across failures and restart',async()=>{
  const kv=new Map<string,unknown>(),steps:string[]=[];
  const port={get:async(k:string)=>kv.get(k),put:async(k:string,v:unknown)=>{kv.set(k,v);steps.push('put');},delete:async(k:string)=>{steps.push('delete');return kv.delete(k);},sync:async()=>{steps.push('sync');},abort:()=>{},waitUntil:()=>{}};
  const guard=new RuntimeSafety(port);await guard.load();
  await guard.mutation(async()=>{expect(kv.has(PENDING_EFFECT_KEY)).toBe(true);expect(steps).toEqual(['put','sync']);steps.push('sealed');});
  expect(steps).toEqual(['put','sync','sealed','delete','sync']);expect(kv.has(PENDING_EFFECT_KEY)).toBe(false);
  await expect(guard.mutation(async()=>{throw Error('write failed');})).rejects.toThrow('archive-unavailable');
  expect(kv.has(PENDING_EFFECT_KEY)).toBe(true);expect(guard.held).toBe(true);
  const restarted=new RuntimeSafety(port);await restarted.load();expect(restarted.held).toBe(true);
});
it('keeps unknown startup state closed when storage refuses the hold lookup',async()=>{
  const guard=new RuntimeSafety({get:async()=>{throw Error('private storage diagnostic');},put:async()=>{},delete:async()=>false,
    sync:async()=>{},abort:()=>{},waitUntil:()=>{}});
  await expect(guard.load()).rejects.toThrow('archive-unavailable');
  expect(guard.held).toBe(true);expect(()=>guard.check()).toThrow('archive-unavailable');
});
it('bounds a stalled startup lookup and never accepts its later empty answer',async()=>{
  vi.useFakeTimers();let finish!:(value:unknown)=>void;let aborted=false;const kv=new Map<string,unknown>();
  const guard=new RuntimeSafety({get:()=>new Promise(resolve=>{finish=resolve;}),put:async(k,v)=>{kv.set(k,v);},delete:async()=>false,
    sync:async()=>{},abort:()=>{aborted=true;},waitUntil:()=>{}},20);
  let completed=false;void guard.load().then(()=>{completed=true;});
  await vi.advanceTimersByTimeAsync(21);
  expect(guard.held).toBe(true);expect(aborted).toBe(true);expect(kv.has(SAFETY_HOLD_KEY)).toBe(true);
  finish(undefined);await Promise.resolve();await Promise.resolve();
  expect(completed).toBe(false);expect(()=>guard.check()).toThrow('archive-unavailable');
});
it('cancels a stalled request body before the write queue and rejects byte overflow',async()=>{
  vi.useFakeTimers();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const request=new Request('https://runtime.invalid/mcp',{method:'POST',body:stream,duplex:'half'} as RequestInit);
  const pending=boundedRequest(request,16,10);const rejection=expect(pending).rejects.toThrow('request-timeout');
  await vi.advanceTimersByTimeAsync(11);await rejection;expect(cancelled).toBe(true);
  await expect(boundedRequest(new Request('https://runtime.invalid/mcp',{method:'POST',body:'x'.repeat(17)}),16)).rejects.toThrow('request-too-large');
});
it('requires pinned signed-policy config with distinct owner and policy keys and refuses unknown configuration fields',async()=>{
  const f=await enrollmentFixture();try{
    const config={schema:'kl-owner-runtime/v1',audience:f.claims.audience,approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},
      policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
    const parsed=parseRuntimeConfig(JSON.stringify(config));expect(parsed).toEqual(config);
    const bindings=runtimeConfigBindings(parsed);expect(readRuntimeConfig(bindings)).toEqual(config);
    expect(()=>readRuntimeConfig({...bindings,RUNTIME_CONFIG_COUNT:'0'})).toThrow('runtime-config-invalid');
    expect(()=>readRuntimeConfig({...bindings,RUNTIME_CONFIG_8:'ignored-extra'})).toThrow('runtime-config-invalid');
    expect(()=>readRuntimeConfig({...bindings,RUNTIME_CONFIG_1:'x'.repeat(5001)})).toThrow('runtime-config-invalid');
    const larger={...parsed,policyBundle:{files:{...parsed.policyBundle.files,padding:'🍃'.repeat(2000)}}};
    const split=runtimeConfigBindings(larger);expect(Number(split.RUNTIME_CONFIG_COUNT)).toBeGreaterThan(1);
    for(const [k,v] of Object.entries(split))if(k!=='RUNTIME_CONFIG_COUNT')expect(new TextEncoder().encode(v).length).toBeLessThanOrEqual(5000);
    expect(readRuntimeConfig(split)).toEqual(larger);
    expect(()=>runtimeConfigBindings({...larger,policyBundle:{files:{padding:'x'.repeat(40_001)}}})).toThrow('runtime-config-invalid');
    expect(()=>parseRuntimeConfig(JSON.stringify({...config,secret:'not-allowed'}))).toThrow('runtime-config-invalid');
    expect(()=>parseRuntimeConfig(JSON.stringify({...config,approval:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64}}))).toThrow('runtime-config-invalid');
    expect(()=>parseRuntimeConfig(JSON.stringify({...config,policy:{...config.policy,minEpoch:0}}))).toThrow('runtime-config-invalid');
  }finally{f.db.close();}
});
