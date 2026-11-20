// Synthetic executable ceremony using actual CurrentUser DPAPI and Windows ACLs.
// The real LocalAppData/kl profile, real project data and the network are never used.
import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { Catalog, MemoryObjectStore, openNodeSqlite, loadReferenceAdmissionRules, importPublicKey, authenticate, sha256Hex } from '@kl/core';
import { createApiHandler } from '../apps/api/src/handler.ts';
import { createArchiveFixture } from './helpers/archive-registration.ts';
import { main, type Io } from '../cli/kl/src/kl.ts';
import { archiveRootKey } from '../cli/kl/src/archive/registration.ts';
import { inspectArchiveRoot } from '../cli/kl/src/archive/source.ts';
import { secureWindowsOwnerDirectory,type OwnerEnrollmentInput } from '../cli/kl/src/archive/owner-enrollment.ts';

// The owner wrapper pins this self-contained build, so a global .NET install is unnecessary.
const helper=resolve('cli/kl-fs/bin/Release/net8.0/win-x64/publish/kl-fs.exe');
if(process.env.KL_OWNER_NATIVE_REQUIRED==='true'&&(process.platform!=='win32'||!existsSync(helper)))throw Error('required-native-owner-helper-unavailable');
it.runIf(process.platform==='win32'&&existsSync(helper))('runs owner prepare, enrollment and both exact-store MCP helpers with real Windows DPAPI',async()=>{
  const now=new Date().toISOString(),f=await createArchiveFixture({apiOrigin:'https://native-owner.invalid',now});
  // Runner TEMP may be a junction or an 8.3 alias. Resolve only this trusted
  // synthetic fixture location; production source paths still refuse aliases.
  const tempRoot=await realpath(tmpdir());await inspectArchiveRoot(tempRoot);
  const local=await mkdtemp(join(tempRoot,'kl-owner-native-')),stateDir=join(f.baseDir,'native-owner'),configPath=join(f.baseDir,'owner-input.json');
  const protectedDir=join(local,'kl','owner',sha256Hex(archiveRootKey(stateDir)));
  const config:OwnerEnrollmentInput={schema:'kl-owner-input/v1',audience:{origin:f.descriptor.apiOrigin,environment:'staging',libraryId:'synthetic-native-library'},
    root:f.root,libraryRepo:f.libraryRepo,folderId:f.descriptor.folderId,device:f.descriptor.device,collectionId:f.descriptor.collectionId,
    principal:'synthetic-native-owner',privacyClass:'team',approvalReceiptId:f.descriptor.approvalReceiptId,policyReceiptId:f.acceptance.receiptId,
    policyEpoch:1,registrationEpoch:1,policyBundle:f.bundle,censusUtf8:await readFile(join(f.stateDir,'census',f.descriptor.privacyCensusHash+'.json'),'utf8')};
  let stdout='',stderr='';let transport:typeof fetch=async()=>{throw Error('network-forbidden');};
  const io:Io={stdout:s=>stdout+=s,stderr:s=>stderr+=s,env:{LOCALAPPDATA:local,KL_FS_HELPER:helper},fetch:(...args)=>transport(...args),
    platform:'win32',klArgv:[process.execPath,resolve('cli/kl/src/kl.ts')]};
  let db:ReturnType<typeof openNodeSqlite>|undefined;
  try{
    await writeFile(configPath,JSON.stringify(config));expect(await main(['owner-prepare',configPath,'--state',stateDir],io),stderr).toBe(0);
    expect(stdout).not.toMatch(/privatePkcs8|Bearer|klb_/);expect(stderr).toBe('');
    const envelope=JSON.parse(await readFile(join(protectedDir,'owner.dpapi'),'utf8'));
    expect(Buffer.from(envelope.cipher,'base64').toString('hex').startsWith('01000000d08c9ddf0115d1118c7a00c04fc297eb')).toBe(true);
    const runtime=JSON.parse(await readFile(join(stateDir,'runtime-config.json'),'utf8')),publicKey=await importPublicKey(runtime.policy.publicKeyB64);
    const denyRules=await loadReferenceAdmissionRules(runtime.policyBundle,runtime.policyAcceptance,{publicKey,keyId:runtime.policy.keyId,minEpoch:1});
    db=openNodeSqlite();const catalog=new Catalog({db,blobStore:new MemoryObjectStore(),mirror:new MemoryObjectStore(),denyRules,clock:{now:()=>new Date().toISOString()}});
    const handler=createApiHandler({catalog,enrollmentTrust:{audience:runtime.audience,approval:runtime.approval,policy:{...runtime.policy,publicKey},now:()=>new Date().toISOString()}});
    transport=(async(url,init)=>handler(new Request(url,init))) as typeof fetch;
    stdout='';stderr='';expect(await main(['owner-enroll','--state',stateDir],io),stderr).toBe(0);expect(stdout).not.toMatch(/privatePkcs8|Bearer|klb_/);
    for(const kind of ['cc','cx'] as const){stdout='';stderr='';
      expect(await main(['token','print',kind,'--json','--store',join(protectedDir,'tokens.dpapi')],io),stderr).toBe(0);
      const token=String(JSON.parse(stdout).Authorization).slice(7);
      expect(authenticate(db,token,new Date().toISOString())).toMatchObject({ok:true,tokenKind:kind+'-bearer',collectionIds:[config.collectionId]});
      expect(await readFile(join(protectedDir,'tokens.dpapi'),'utf8')).not.toContain(token);
    }
  }finally{
    db?.close();await f.cleanup();
    const under=relative(tempRoot,resolve(local));
    if(!under||under.startsWith('..')||isAbsolute(under)||!basename(local).startsWith('kl-owner-native-'))throw Error('native-cleanup-scope');
    await rm(local,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},180_000);

it.runIf(process.platform==='win32')('refuses inherited owner-directory ACLs with a fixed process-failure diagnostic',async()=>{
  const tempRoot=await realpath(tmpdir());await inspectArchiveRoot(tempRoot);
  const local=await mkdtemp(join(tempRoot,'kl-owner-native-acl-'));
  try{await expect(secureWindowsOwnerDirectory(local,true)).rejects.toThrow('owner-acl-process-failed');}
  finally{
    const under=relative(tempRoot,resolve(local));
    if(!under||under.startsWith('..')||isAbsolute(under)||!basename(local).startsWith('kl-owner-native-acl-'))throw Error('native-cleanup-scope');
    await rm(local,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},90_000);
