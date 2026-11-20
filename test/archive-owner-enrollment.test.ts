import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Catalog, MemoryObjectStore, openNodeSqlite, loadReferenceAdmissionRules, importPublicKey, authenticate, sha256Hex, verifyEnrollment } from '@kl/core';
import { createApiHandler } from '../apps/api/src/handler.ts';
import { prepareOwnerEnrollment, submitOwnerEnrollment, submitOwnerRelease, secureWindowsOwnerDirectory, type OwnerEnrollmentInput, type OwnerProtection, type OwnerReleaseRequest } from '../cli/kl/src/archive/owner-enrollment.ts';
import { acceptRuntimeRelease, runtimeReleaseState, type RuntimeReleasePort } from '../packages/core/src/auth/runtime-release.ts';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { main, type Io } from '../cli/kl/src/kl.ts';
import { HelperClient } from '../cli/kl/src/fs/windows-helper.ts';

const at='2026-10-18T12:00:00.000Z';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0))await fn();});
async function protection():Promise<OwnerProtection>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return {async protect(bytes){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes as BufferSource);return new Uint8Array(Buffer.concat([iv,new Uint8Array(cipher)]));},
    async unprotect(bytes){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12) as BufferSource));}};
}
async function fixture(){
  const f=await createArchiveFixture({apiOrigin:'https://enrollment.invalid',now:at});cleanup.push(f.cleanup);
  const stateDir=join(f.baseDir,'owner'),protectedDir=join(f.baseDir,'credentials');const p=await protection();
  const config:OwnerEnrollmentInput={schema:'kl-owner-input/v1',audience:{origin:f.descriptor.apiOrigin,environment:'staging',libraryId:'fixture-library'},
    root:f.root,libraryRepo:f.libraryRepo,folderId:f.descriptor.folderId,device:f.descriptor.device,collectionId:f.descriptor.collectionId,
    principal:'fixture-owner',privacyClass:'team',approvalReceiptId:f.descriptor.approvalReceiptId,policyReceiptId:f.acceptance.receiptId,
    policyEpoch:1,registrationEpoch:1,policyBundle:f.bundle,censusUtf8:await readFile(join(f.stateDir,'census',f.descriptor.privacyCensusHash+'.json'),'utf8')};
  const prepare=(patch:Partial<Parameters<typeof prepareOwnerEnrollment>[0]>={})=>prepareOwnerEnrollment({config,stateDir,protectedDir,helperArgv:[process.execPath,resolve('cli/kl/src/kl.ts')],protection:p,now:at,...patch});
  async function secretFile(name:string){const w=JSON.parse(await readFile(join(protectedDir,name),'utf8'));return JSON.parse(new TextDecoder().decode(await p.unprotect(Buffer.from(w.cipher,'base64'))));}
  async function server(){
    const runtime=JSON.parse(await readFile(join(stateDir,'runtime-config.json'),'utf8'));
    const publicKey=await importPublicKey(runtime.policy.publicKeyB64);
    const denyRules=await loadReferenceAdmissionRules(runtime.policyBundle,runtime.policyAcceptance,{publicKey,keyId:runtime.policy.keyId,minEpoch:runtime.policy.minEpoch});
    const db=openNodeSqlite();cleanup.push(async()=>db.close());
    const catalog=new Catalog({db,blobStore:new MemoryObjectStore(),mirror:new MemoryObjectStore(),denyRules,clock:{now:()=>at}});
    const api=createApiHandler({catalog,enrollmentTrust:{audience:runtime.audience,approval:runtime.approval,policy:{...runtime.policy,publicKey},now:()=>at}});
    const requests:Request[]=[];
    const fetcher=(async(url,init)=>{const request=new Request(url,init);requests.push(request.clone());return api(request);}) as typeof fetch;
    return {db,catalog,fetcher,requests,runtime};
  }
  const submit=(fetcher:typeof fetch,patch:Partial<Parameters<typeof submitOwnerEnrollment>[0]>={})=>submitOwnerEnrollment({stateDir,protectedDir,protection:p,fetch:fetcher,now:at,...patch});
  return {...f,config,stateDir,protectedDir,protection:p,prepare,submit,secretFile,server};
}
async function absent(path:string){await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'});}

describe('protected owner enrollment ceremony',()=>{
  it('prepares distinct pins, enrolls through the real API, then publishes exact protected class credentials and token-free configs',async()=>{
    const f=await fixture();await f.prepare();
    await absent(join(f.protectedDir,'tokens.dpapi'));
    const secrets=await f.secretFile('owner.dpapi'),server=await f.server();
    expect(secrets.config).toBeUndefined();expect(secrets.artifact).toBeUndefined();
    expect((await readFile(join(f.protectedDir,'owner.dpapi'))).length).toBeLessThan(16_384);
    await absent(join(f.stateDir,'owner.dpapi'));await absent(join(f.stateDir,'tokens.dpapi'));
    expect(new Set(Object.values(secrets.keys).map((k:any)=>k.keyId)).size).toBe(3);
    await f.submit(server.fetcher);
    const store=JSON.parse(await readFile(join(f.protectedDir,'tokens.dpapi'),'utf8'));
    for(const t of secrets.tokens){const short=t.kind==='kl-device'?'device':t.kind==='cc-bearer'?'cc':'cx';
      const token=new TextDecoder().decode(await f.protection.unprotect(Buffer.from(store.entries[short],'base64')));
      expect(sha256Hex(token)).toBe(t.hash);
      expect(authenticate(server.db,token,at)).toMatchObject({ok:true,tokenKind:t.kind,collectionIds:[f.config.collectionId]});
      for(const name of ['owner.dpapi','runtime-config.json','activation.json','tokens.dpapi','claude-mcp.json','codex-mcp.toml'])
        expect(await readFile(join(name.endsWith('.dpapi')?f.protectedDir:f.stateDir,name),'utf8')).not.toContain(t.token);
      expect(await server.requests[0]!.clone().text()).not.toContain(t.token);
    }
    const claude=JSON.parse(await readFile(join(f.stateDir,'claude-mcp.json'),'utf8'));
    expect(claude.mcpServers['knowledge-library'].headersHelper).toContain(' token print cc --json --store ');
    expect(await readFile(join(f.stateDir,'codex-mcp.toml'),'utf8')).toContain(' token print cx --json --store ');
    const helper=vi.spyOn(HelperClient.prototype,'request').mockImplementation(async(op,body)=>{
      expect(op).toBe('dpapi-unprotect');const bytes=await f.protection.unprotect(Buffer.from(String(body!.data),'base64'));
      return {ok:true,value:Buffer.from(bytes).toString('base64'),effect:'none'};
    });
    for(const kind of ['cc','cx'] as const){let stdout='',stderr='';
      const io:Io={stdout:s=>stdout+=s,stderr:s=>stderr+=s,env:{KL_TOKEN_CC:'wrong-environment',KL_TOKEN_CX:'wrong-environment'},fetch,platform:'win32'};
      expect(await main(['token','print',kind,'--json','--store',join(f.protectedDir,'tokens.dpapi')],io)).toBe(0);
      expect(JSON.parse(stdout).Authorization).toBe('Bearer '+secrets.tokens.find((t:any)=>t.kind===kind+'-bearer').token);expect(stderr).toBe('');
    }
    expect(helper).toHaveBeenCalledTimes(2);
  });
  it('retries a lost response using the identical persisted grant without minting new tokens',async()=>{
    const f=await fixture();await f.prepare();const server=await f.server();
    const lost=(async(url,init)=>{await server.fetcher(url,init);throw Error('synthetic response loss');}) as typeof fetch;
    await expect(f.submit(lost)).rejects.toThrow('synthetic response loss');
    await absent(join(f.protectedDir,'tokens.dpapi'));const before=await readFile(join(f.protectedDir,'intent.dpapi'),'utf8');
    await f.submit(server.fetcher);expect(await readFile(join(f.protectedDir,'intent.dpapi'),'utf8')).toBe(before);
    expect(server.db.get<{n:number}>('SELECT count(*) AS n FROM tokens')?.n).toBe(3);
    expect(await server.requests[0]!.text()).toBe(await server.requests[1]!.text());
  });
  it.each(['hash','receipt','pending','redirect','oversized'] as const)('does not publish credentials after a %s receipt',async mode=>{
    const f=await fixture();await f.prepare();const server=await f.server();
    const bad=(async(url,init)=>{const response=await server.fetcher(url,init),body=await response.json() as any;
      if(mode==='hash')body.enrollmentHash='0'.repeat(64);if(mode==='receipt')body.receiptId='other';if(mode==='pending')body.state='pending';
      if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://other.invalid'}});
      if(mode==='oversized')body.extra='x'.repeat(20_000);return Response.json(body);}) as typeof fetch;
    await expect(f.submit(bad)).rejects.toThrow(/owner-(receipt-invalid|enrollment-refused)/);
    await absent(join(f.protectedDir,'tokens.dpapi'));await absent(join(f.stateDir,'claude-mcp.json'));
  });
  it('refuses an expired uncertain intent before another network request',async()=>{
    const f=await fixture();await f.prepare();const server=await f.server();
    await expect(f.submit((async()=>{throw Error('synthetic offline');}) as typeof fetch)).rejects.toThrow('synthetic offline');
    const network=vi.fn(server.fetcher);
    await expect(f.submit(network,{now:'2026-10-18T12:11:00.000Z'})).rejects.toThrow('owner-intent-expired');expect(network).not.toHaveBeenCalled();
  });
  it('refuses conflicting protected token stores on replay',async()=>{
    const f=await fixture();await f.prepare();const server=await f.server();await f.submit(server.fetcher);
    await writeFile(join(f.protectedDir,'tokens.dpapi'),JSON.stringify({version:1,entries:{}}));
    await expect(f.submit(server.fetcher)).rejects.toThrow('owner-token-store-conflict');
  });
  it('refuses census mismatch, source overlap, reused state, and unprotected writes',async()=>{
    const f=await fixture();
    await expect(f.prepare({config:{...f.config,censusUtf8:f.config.censusUtf8.replace('fixture-device','other-device')}})).rejects.toThrow('owner-census-mismatch');
    await absent(f.stateDir);await expect(f.prepare({stateDir:join(f.root,'owner')})).rejects.toThrow('owner-state-overlap');
    await f.prepare();await expect(f.prepare()).rejects.toThrow('owner-state-exists');
    const secret=await f.secretFile('owner.dpapi'),raw=await readFile(join(f.protectedDir,'owner.dpapi'),'utf8');
    for(const key of Object.values(secret.keys) as {privatePkcs8:string}[])expect(raw).not.toContain(key.privatePkcs8);
  });
  it('cancels a stalled receipt body without publishing credentials',async()=>{
    const f=await fixture();await f.prepare();const cancelled=vi.fn();
    const stalled=(async()=>new Response(new ReadableStream({cancel:cancelled}))) as typeof fetch;
    await expect(f.submit(stalled)).rejects.toThrow('owner-receipt-timeout');expect(cancelled).toHaveBeenCalledOnce();await absent(join(f.protectedDir,'tokens.dpapi'));
  });
  it('preserves the explicitly reviewed private classification',async()=>{
    const f=await fixture();const census=JSON.parse(f.config.censusUtf8);census.privacyClass='frank-private';
    await f.prepare({config:{...f.config,privacyClass:'frank-private',censusUtf8:JSON.stringify(census)}});
    const server=await f.server();await f.submit(server.fetcher);
    const request=await server.requests[0]!.json() as any;expect(request.approval.claims.folder.privacyClass).toBe('frank-private');
  });
  it.each([false,true])('retains signed census Orrery registration %s in the server folder row',async orreryRegistered=>{
    const f=await fixture(),census=JSON.parse(f.config.censusUtf8);census.orreryRegistered=orreryRegistered;
    await f.prepare({config:{...f.config,censusUtf8:JSON.stringify(census)}});const server=await f.server();await f.submit(server.fetcher);
    const packet=await server.requests[0]!.json() as any;
    expect(packet.approval.claims.folder.orreryRegistered).toBe(orreryRegistered);
    expect(server.db.get('SELECT orrery_registered FROM folders WHERE folderId=?',[f.config.folderId])).toEqual({orrery_registered:orreryRegistered?1:0});
    packet.approval.claims.folder.orreryRegistered=!orreryRegistered;
    await expect(verifyEnrollment(packet.approval,packet.acceptance,{audience:server.runtime.audience,approval:server.runtime.approval,
      policy:{...server.runtime.policy,publicKey:await importPublicKey(server.runtime.policy.publicKeyB64)},now:()=>at})).rejects.toThrow('enrollment-signature-invalid');
  });
  it('measures current content instead of trusting supplied admission results and rejects changed owner input',async()=>{
    const f=await fixture(),before=await readFile(join(f.root,'overview.md'));
    const census=JSON.parse(f.config.censusUtf8);census.contentAdmission='measured';census.files=[{relPath:'invented.md'}];
    await f.prepare({config:{...f.config,censusUtf8:JSON.stringify(census)}});
    const approved=JSON.parse(await readFile(join(f.stateDir,'owner-input.json'),'utf8')),measured=JSON.parse(approved.censusUtf8);
    expect(measured.contentAdmission).toBe('measured');expect(measured.files.map((v:any)=>v.relPath)).toEqual(['overview.md']);
    expect(measured.files[0].sha256).toBe(sha256Hex(before));expect(measured.complete).toBe(true);expect(measured.readErrors).toEqual([]);
    expect(await readFile(join(f.root,'overview.md'))).toEqual(before);
    approved.principal='different-owner';await writeFile(join(f.stateDir,'owner-input.json'),JSON.stringify(approved));
    const network=vi.fn();await expect(f.submit(network)).rejects.toThrow('owner-approved-input-changed');expect(network).not.toHaveBeenCalled();
  });
  it('refuses a folder beyond the first-pilot text limit before creating owner state',async()=>{
    const f=await fixture();await writeFile(join(f.root,'oversized.md'),Buffer.alloc(3*1024*1024+1,97));
    await expect(f.prepare()).rejects.toThrow('owner-census-incomplete');await absent(f.stateDir);await absent(f.protectedDir);
  });
  it.runIf(process.platform==='win32')('applies and verifies a protected Windows owner ACL before any secret write',async()=>{
    const f=await fixture();await f.prepare({secureDirectory:secureWindowsOwnerDirectory});
    await secureWindowsOwnerDirectory(f.protectedDir,true);
  });
});

describe('explicit protected store credential helper',()=>{
  it('never substitutes an environment token when the selected store is missing',async()=>{
    let stdout='',stderr='';const io:Io={stdout:s=>stdout+=s,stderr:s=>stderr+=s,env:{KL_TOKEN_CC:'synthetic-wrong-environment'},fetch,platform:'win32'};
    const result=await main(['token','print','cc','--json','--store',resolve('.review/does-not-exist.dpapi')],io);
    expect(result).toBe(1);expect(stdout).toBe('');expect(stderr).not.toContain('synthetic-wrong-environment');
  });
  it('rejects ambiguous helper options before reading tokens',async()=>{
    let stdout='';const io:Io={stdout:s=>stdout+=s,stderr:()=>{},env:{KL_TOKEN_CC:'synthetic-wrong-environment'},fetch,platform:'win32'};
    expect(await main(['token','print','cc','--json','--store','relative.dpapi'],io)).toBe(2);
    expect(await main(['token','print','cc','--json','--unexpected'],io)).toBe(2);expect(stdout).toBe('');
  });
  it('routes owner commands with fixed usage errors and no secret-shaped output',async()=>{
    let stdout='',stderr='';const io:Io={stdout:s=>stdout+=s,stderr:s=>stderr+=s,env:{},fetch};
    expect(await main(['owner-prepare'],io)).toBe(2);expect(await main(['owner-enroll','--wrong'],io)).toBe(2);
    expect(stdout).toBe('');expect(stderr).toContain('reviewed-config.json');expect(stderr).not.toMatch(/Bearer|privatePkcs8|klb_/);
  });
});

describe('exact-version owner runtime release',()=>{
  const versionId='11111111-1111-4111-8111-111111111111';
  async function releaseFixture(){
    const f=await fixture();await f.prepare();
    const runtime=JSON.parse(await readFile(join(f.stateDir,'runtime-config.json'),'utf8'));
    const saved=new Map<string,unknown>(),port:RuntimeReleasePort & {proofs:MemoryObjectStore}={proofs:new MemoryObjectStore(),async get(k){return saved.get(k);},async put(k,v){saved.set(k,v);},async sync(){}};
    const trust={approval:runtime.approval,audience:runtime.audience,now:()=>at};const packets:unknown[]=[];
    const fetcher=(async(_url,init)=>{
      if(init?.method==='GET')return Response.json(await runtimeReleaseState(port,trust));
      const packet=JSON.parse(String(init?.body));packets.push(packet);
      return Response.json(await acceptRuntimeRelease(packet,port,trust,versionId));
    }) as typeof fetch;
    const request:OwnerReleaseRequest={schema:'kl-owner-release-request/v1',versionId,revision:1,previousReleaseHash:null,mode:'active'};
    const release=(r=request,fetchOverride=fetcher)=>submitOwnerRelease({stateDir:f.stateDir,protectedDir:f.protectedDir,request:r,protection:f.protection,fetch:fetchOverride,now:at});
    return {...f,request,fetcher,release,packets,port,trust};
  }
  it('activates the exact reviewed native version and supports a separately signed closing revision',async()=>{
    const f=await releaseFixture();await f.release();const first=await runtimeReleaseState(f.port,f.trust);
    expect(first).toMatchObject({versionId,mode:'active',revision:1});
    await f.release({...f.request,revision:2,previousReleaseHash:first!.releaseHash,mode:'closed'});
    expect(await runtimeReleaseState(f.port,f.trust)).toMatchObject({versionId,mode:'closed',revision:2});
    await absent(join(f.protectedDir,'tokens.dpapi'));
    expect(JSON.stringify(f.packets)).not.toMatch(/privatePkcs8|Bearer|klb_/);
  });
  it('retries a lost release response with the same signed intent',async()=>{
    const f=await releaseFixture();const lost=(async(url,init)=>{const res=await f.fetcher(url,init);if(init?.method==='POST')throw Error('synthetic response loss');return res;}) as typeof fetch;
    await expect(f.release(f.request,lost)).rejects.toThrow('synthetic response loss');await absent(join(f.stateDir,'release-1.json'));
    const before=await readFile(join(f.protectedDir,'release-1.dpapi'),'utf8');await f.release();
    expect(await readFile(join(f.protectedDir,'release-1.dpapi'),'utf8')).toBe(before);expect(f.packets[0]).toEqual(f.packets[1]);
    await expect(f.release({...f.request,mode:'closed'})).rejects.toThrow('owner-release-intent-conflict');
  });
  it('rejects a forged release receipt and incorrect current-state chain',async()=>{
    const f=await releaseFixture();const forged=(async(url,init)=>{const response=await f.fetcher(url,init);if(init?.method==='POST'){const value=await response.json() as any;value.releaseHash='0'.repeat(64);return Response.json(value);}return response;}) as typeof fetch;
    await expect(f.release(f.request,forged)).rejects.toThrow('owner-release-receipt-invalid');await absent(join(f.stateDir,'release-1.json'));
    const changed=(async()=>Response.json({schema:'kl-runtime-release-state/v1',revision:99,releaseHash:'0'.repeat(64),versionId,mode:'active'})) as typeof fetch;
    await expect(f.release(f.request,changed)).rejects.toThrow('owner-release-state-conflict');
  });
});
