// Executable owner ceremony. Production callers use Windows CurrentUser DPAPI; no secret is
// printed, sent to the enrollment endpoint, or stored in an unprotected file.
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateServiceKey, bundleHash, signAcceptance, type PolicyBundle } from '../../../../packages/core/src/policy/acceptance.ts';
import { mintToken, parseToken, type TokenKind as GrantKind } from '../../../../packages/core/src/auth/tokens.ts';
import { signEnrollment, verifyEnrollment, type SignedEnrollment, type EnrollmentClaims } from '../../../../packages/core/src/auth/enrollment.ts';
import { signRuntimeRelease, type SignedRuntimeRelease, type RuntimeReleaseClaims } from '../../../../packages/core/src/auth/runtime-release.ts';
import { importPublicKey } from '../../../../packages/core/src/policy/acceptance.ts';
import { canonicalJson } from '../../../../packages/core/src/primitives/canonical.ts';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { fromBase64Url, toBase64Url } from '../../../../packages/core/src/primitives/base64url.ts';
import { loadReferenceAdmissionRules } from '../../../../packages/core/src/admission/reference-policy.ts';
import { inspectArchiveRoot, scanArchiveCensus, archiveChildEnv } from './source.ts';
import { parseRuntimeConfig } from '../../../../apps/api/src/cloudflare/runtime-config.ts';
import { archiveRootKey, canonicalArchiveOrigin, loadArchiveRegistration, type ArchiveRegistrationDescriptor, type ArchiveTrustConfig } from './registration.ts';
import { issueArchiveEnrollmentArtifact, installArchiveEnrollment, buildEnrollmentClaims, type ArchiveEnrollmentArtifact } from './enrollment.ts';
import { readEnrollmentInput } from './enrollment-command.ts';
import { HelperClient, dpapi, helperPath } from '../fs/windows-helper.ts';
import { helperCommand, type Io } from '../kl.ts';

export interface OwnerEnrollmentInput {
  schema: 'kl-owner-input/v1'; audience: EnrollmentClaims['audience']; root: string; libraryRepo: string;
  folderId: string; device: string; collectionId: string; principal: string; privacyClass: 'team' | 'frank-private';
  approvalReceiptId: string; policyReceiptId: string; policyEpoch: number; registrationEpoch: number;
  policyBundle: PolicyBundle; censusUtf8: string;
}
/** Trusted test composition only. The CLI always creates Windows DPAPI protection itself. */
export interface OwnerProtection { protect(bytes: Uint8Array): Promise<Uint8Array>; unprotect(bytes: Uint8Array): Promise<Uint8Array> }
interface StoredKey { privatePkcs8: string; publicKeyB64: string; keyId: string }
interface OwnerSecrets {
  schema: 'kl-owner-secrets/v1'; configHash: string; artifactHash: string; stateKey: string; preparedAt: string;
  keys: Record<'approval' | 'enrollment' | 'policy', StoredKey>;
  tokens: { kind: GrantKind; token: string; hash: string; expiresAt: string }[];
  helperArgv: string[];
}
interface OwnerIntent { schema: 'kl-owner-intent/v1'; approval: SignedEnrollment; acceptance: ArchiveEnrollmentArtifact['policyAcceptance'] }
function fail(code: string): never { throw new Error(code); }
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value);
const json = (value: unknown) => canonicalJson(value) + '\n';
const encode = (value: unknown) => new TextEncoder().encode(json(value));
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function checkConfig(value: unknown): OwnerEnrollmentInput {
  const c = JSON.parse(json(value)) as OwnerEnrollmentInput;
  if (!exact(c, ['schema','audience','root','libraryRepo','folderId','device','collectionId','principal','privacyClass','approvalReceiptId','policyReceiptId','policyEpoch','registrationEpoch','policyBundle','censusUtf8']) ||
      c.schema !== 'kl-owner-input/v1' || !['team','frank-private'].includes(c.privacyClass) || !isAbsolute(c.root) || !isAbsolute(c.libraryRepo) ||
      ![c.folderId,c.device,c.collectionId,c.principal,c.approvalReceiptId,c.policyReceiptId].every(id) ||
      !Number.isSafeInteger(c.policyEpoch) || c.policyEpoch < 1 || !Number.isSafeInteger(c.registrationEpoch) || c.registrationEpoch < 1 ||
      typeof c.censusUtf8 !== 'string' || Buffer.byteLength(c.censusUtf8) > 4 * 1024 * 1024 ||
      !exact(c.audience, ['origin','environment','libraryId']) || !id(c.audience.libraryId) || !['staging','production'].includes(c.audience.environment) ||
      canonicalArchiveOrigin(c.audience.origin) !== c.audience.origin || !c.audience.origin.startsWith('https://')) fail('owner-config-invalid');
  return c;
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function exclusive(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function protectedWrite(path: string, value: unknown, protection: OwnerProtection): Promise<void> {
  const plain = encode(value);
  if (plain.length > 512_000) { plain.fill(0); fail('owner-state-too-large'); }
  try { const cipher = await protection.protect(plain); if (!cipher.length) fail('owner-protection-failed'); await exclusive(path, encode({ schema:'kl-owner-dpapi/v1', cipher:Buffer.from(cipher).toString('base64') })); }
  finally { plain.fill(0); }
}
async function protectedRead<T>(path: string, protection: OwnerProtection): Promise<T> {
  const wrapper = await readEnrollmentInput(path, 16 * 1024 * 1024);
  if (!exact(wrapper, ['schema','cipher']) || wrapper.schema !== 'kl-owner-dpapi/v1' || typeof wrapper.cipher !== 'string' ||
      Buffer.from(wrapper.cipher, 'base64').toString('base64') !== wrapper.cipher) fail('owner-protected-state-invalid');
  const plain = await protection.unprotect(new Uint8Array(Buffer.from(wrapper.cipher, 'base64')));
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(plain)) as T; } finally { plain.fill(0); }
}
function outside(state: string, root: string): boolean {
  const d = relative(archiveRootKey(root), archiveRootKey(state));
  return !!d && (d === '..' || d.startsWith('..\\') || d.startsWith('../') || isAbsolute(d));
}
async function exportKey(key: Awaited<ReturnType<typeof generateServiceKey>>): Promise<StoredKey> {
  return { privatePkcs8:toBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',key.privateKey))), publicKeyB64:key.publicKeyB64, keyId:key.keyId };
}
async function privateKey(key: StoredKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8',fromBase64Url(key.privatePkcs8) as BufferSource,'Ed25519',false,['sign']);
}

/** Input census/policy and approval identifiers are reviewed owner facts, never inferred here. */
export async function prepareOwnerEnrollment(input: { config: unknown; stateDir: string; protectedDir:string; helperArgv: string[]; protection: OwnerProtection; secureDirectory?:(path:string)=>Promise<void>; now?: string }): Promise<void> {
  const c = checkConfig(input.config), state = input.stateDir, protectedDir=input.protectedDir, at = input.now ?? new Date().toISOString();
  if (!isAbsolute(state) || !outside(state,c.root) || !outside(c.root,state) || !outside(state,c.libraryRepo) || !outside(c.libraryRepo,state)) fail('owner-state-overlap');
  if(!isAbsolute(protectedDir)||[state,c.root,c.libraryRepo].some(path=>!outside(protectedDir,path)||!outside(path,protectedDir)))fail('owner-credential-overlap');
  await inspectArchiveRoot(dirname(state)); if (await exists(state)) fail('owner-state-exists');
  await inspectArchiveRoot(dirname(protectedDir));if(await exists(protectedDir))fail('owner-credentials-exist');
  helperCommand(input.helperArgv);
  const identity = await inspectArchiveRoot(c.root), census = JSON.parse(c.censusUtf8);
  if (census.schema !== 'kl-privacy-census/v1' || census.root !== c.root || census.device !== c.device || census.collectionId !== c.collectionId ||
      census.privacyClass !== c.privacyClass || canonicalJson(census.identity) !== canonicalJson(identity)) fail('owner-census-mismatch');
  const approvalKey = await generateServiceKey(), enrollmentKey = await generateServiceKey(), policyKey = await generateServiceKey();
  const acceptance = await signAcceptance(policyKey.privateKey, {policyHash:bundleHash(c.policyBundle),epoch:c.policyEpoch,receiptId:c.policyReceiptId,keyId:policyKey.keyId});
  if(Object.hasOwn(census,'orreryRegistered')&&typeof census.orreryRegistered!=='boolean')fail('owner-census-mismatch');
  const denyRules=await loadReferenceAdmissionRules(c.policyBundle,acceptance,{publicKey:policyKey.publicKey,keyId:policyKey.keyId,minEpoch:c.policyEpoch});
  const measured=await scanArchiveCensus({root:c.root,identity,collectionId:c.collectionId,libraryRepo:c.libraryRepo,denyRules},
    {now:at,maxSnapshotBytes:3*1024*1024,maxTextBytes:3*1024*1024});
  if(!measured.complete||measured.readErrors.length)fail('owner-census-incomplete');
  c.censusUtf8=json({schema:'kl-privacy-census/v1',root:c.root,device:c.device,identity,collectionId:c.collectionId,privacyClass:c.privacyClass,
    at,...measured,...(Object.hasOwn(census,'orreryRegistered')?{orreryRegistered:census.orreryRegistered}:{})});
  const expiresAt = new Date(Date.parse(at) + 30 * 86_400_000).toISOString();
  const descriptor: ArchiveRegistrationDescriptor = {schema:'kl-archive-registration/v1',identityScheme:'node-stat-v1',root:c.root,identity,
    folderId:c.folderId,device:c.device,collectionId:c.collectionId,privacyClass:c.privacyClass,apiOrigin:c.audience.origin,libraryRepo:c.libraryRepo,
    privacyCensusHash:sha256Hex(c.censusUtf8),approvalReceiptId:c.approvalReceiptId,policyHash:acceptance.policyHash,policyEpoch:c.policyEpoch,
    registrationEpoch:c.registrationEpoch,issuedAt:at,expiresAt};
  const artifact = await issueArchiveEnrollmentArtifact({descriptor,censusUtf8:c.censusUtf8,policyBundle:c.policyBundle,policyAcceptance:acceptance,enrollmentKey});
  const pins: ArchiveTrustConfig = {schema:'kl-archive-trust/v1',device:c.device,
    enrollment:{publicKeyB64:enrollmentKey.publicKeyB64,keyId:enrollmentKey.keyId,minEpoch:c.registrationEpoch},
    policy:{publicKeyB64:policyKey.publicKeyB64,keyId:policyKey.keyId,minEpoch:c.policyEpoch}};
  const tokens = (['kl-device','cc-bearer','cx-bearer'] as const).map(kind => ({kind,...mintToken(n=>crypto.getRandomValues(new Uint8Array(n))),expiresAt}));
  const secrets: OwnerSecrets = {schema:'kl-owner-secrets/v1',configHash:sha256Hex(canonicalJson(c)),artifactHash:sha256Hex(canonicalJson(artifact)),stateKey:archiveRootKey(state),preparedAt:at,
    keys:{approval:await exportKey(approvalKey),enrollment:await exportKey(enrollmentKey),policy:await exportKey(policyKey)},tokens,helperArgv:[...input.helperArgv]};
  const runtimeBytes=encode({schema:'kl-owner-runtime/v1',audience:c.audience,
    approval:{keyId:approvalKey.keyId,publicKeyB64:approvalKey.publicKeyB64},policy:{keyId:policyKey.keyId,publicKeyB64:policyKey.publicKeyB64,minEpoch:c.policyEpoch,policyHash:acceptance.policyHash},
    policyBundle:c.policyBundle,policyAcceptance:acceptance});
  if(runtimeBytes.length>40_000)fail('owner-runtime-config-too-large');
  parseRuntimeConfig(new TextDecoder().decode(runtimeBytes));
  await mkdir(state,{mode:0o700});
  await mkdir(protectedDir,{mode:0o700});await input.secureDirectory?.(protectedDir);
  await protectedWrite(join(protectedDir,'owner.dpapi'),secrets,input.protection);
  await exclusive(join(state,'owner-input.json'),encode(c));await exclusive(join(state,'owner-artifact.json'),encode(artifact));
  await installArchiveEnrollment({artifact,trustedPins:pins,stateDir:join(state,'archive'),root:c.root,device:c.device,apiOrigin:c.audience.origin,now:at});
  await exclusive(join(state,'runtime-config.json'),runtimeBytes);
  await exclusive(join(state,'owner-session.json'),encode({schema:'kl-owner-session/v1',stateDir:join(state,'archive'),tokenStore:join(protectedDir,'tokens.dpapi'),apiOrigin:c.audience.origin,root:c.root}));
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.body) fail('owner-receipt-invalid');
  const reader=response.body.getReader(); let size=0;const chunks:Uint8Array[]=[];
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('owner-receipt-timeout'));void reader.cancel().catch(()=>{});},5_000);});
  try { while(true){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;if(size>16_384){void reader.cancel().catch(()=>{});fail('owner-receipt-invalid');}chunks.push(part.value);} }
  finally {clearTimeout(timer);reader.releaseLock();}
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('owner-receipt-invalid');}
}
async function publishSame(path: string, bytes: Uint8Array): Promise<void> {
  if (await exists(path)) { const previous=await readEnrollmentInput(path,4*1024*1024);if(canonicalJson(previous)!==canonicalJson(JSON.parse(new TextDecoder().decode(bytes))))fail('owner-publication-conflict');return; }
  const pending=path+'.pending';
  if (await exists(pending)) fail('owner-publication-incomplete');
  await exclusive(pending,bytes);await link(pending,path);await unlink(pending);
}

/** Retry uses the same protected intent; an expired uncertain submission is never silently reissued. */
export async function submitOwnerEnrollment(input: { stateDir:string; protectedDir:string; protection:OwnerProtection; fetch:typeof fetch; now?:string }): Promise<void> {
  const state=input.stateDir, at=input.now??new Date().toISOString();await inspectArchiveRoot(state);
  const secrets=await protectedRead<OwnerSecrets>(join(input.protectedDir,'owner.dpapi'),input.protection);
  if(secrets.schema!=='kl-owner-secrets/v1'||secrets.stateKey!==archiveRootKey(state))fail('owner-protected-state-invalid');
  const c=checkConfig(await readEnrollmentInput(join(state,'owner-input.json'),12*1024*1024));
  const artifact=await readEnrollmentInput(join(state,'owner-artifact.json'),12*1024*1024) as ArchiveEnrollmentArtifact;
  if(sha256Hex(canonicalJson(c))!==secrets.configHash||sha256Hex(canonicalJson(artifact))!==secrets.artifactHash)fail('owner-approved-input-changed');
  if(!isAbsolute(input.protectedDir)||[state,c.root,c.libraryRepo].some(path=>!outside(input.protectedDir,path)||!outside(path,input.protectedDir)))fail('owner-credential-overlap');
  const registration=await loadArchiveRegistration({stateDir:join(state,'archive'),root:c.root,device:c.device,apiOrigin:c.audience.origin,now:at});
  const intentPath=join(input.protectedDir,'intent.dpapi');let intent:OwnerIntent;
  if(await exists(intentPath)) intent=await protectedRead<OwnerIntent>(intentPath,input.protection);
  else {
    const claims=buildEnrollmentClaims(artifact,{registration,audience:c.audience,principal:c.principal,receiptId:c.approvalReceiptId,
      nonce:sha256Hex(crypto.getRandomValues(new Uint8Array(32))),tokens:secrets.tokens.map(({kind,hash,expiresAt})=>({kind,hash,expiresAt})),
      issuedAt:at,expiresAt:new Date(Date.parse(at)+10*60_000).toISOString()});
    intent={schema:'kl-owner-intent/v1',approval:await signEnrollment(claims,secrets.keys.approval.keyId,await privateKey(secrets.keys.approval)),acceptance:artifact.policyAcceptance};
    await protectedWrite(intentPath,intent,input.protection);
  }
  if(intent.schema!=='kl-owner-intent/v1'||Date.parse(intent.approval.claims.expiresAt)<=Date.parse(at))fail('owner-intent-expired');
  // DPAPI proves Windows-user ownership; still bind a recovered intent to this exact registration.
  const checked=buildEnrollmentClaims(artifact,{registration,audience:c.audience,principal:c.principal,receiptId:c.approvalReceiptId,
    nonce:intent.approval.claims.nonce,tokens:secrets.tokens.map(({kind,hash,expiresAt})=>({kind,hash,expiresAt})),
    issuedAt:intent.approval.claims.issuedAt,expiresAt:intent.approval.claims.expiresAt});
  if(canonicalJson(checked)!==canonicalJson(intent.approval.claims))fail('owner-intent-mismatch');
  await verifyEnrollment(intent.approval,intent.acceptance,{approval:secrets.keys.approval,
    policy:{publicKey:await importPublicKey(secrets.keys.policy.publicKeyB64),keyId:secrets.keys.policy.keyId,minEpoch:c.policyEpoch,policyHash:bundleHash(c.policyBundle)},audience:c.audience,now:()=>at});
  for(const t of secrets.tokens){const parsed=parseToken(t.token);if(!parsed.ok||parsed.hash!==t.hash)fail('owner-protected-state-invalid');}
  const expectedHash=sha256Hex(canonicalJson(intent.approval.claims));
  const response=await input.fetch(c.audience.origin+'/v1/enroll',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{'content-type':'application/json'},body:JSON.stringify({approval:intent.approval,acceptance:intent.acceptance})});
  if(!response.ok||response.redirected||(response.url&&response.url!==c.audience.origin+'/v1/enroll'))fail('owner-enrollment-refused');
  const receipt=await boundedResponse(response);
  if(!exact(receipt,['state','enrollmentHash','receiptId','authzSeq'])||receipt.state!=='active'||receipt.enrollmentHash!==expectedHash||
    receipt.receiptId!==c.approvalReceiptId||!Number.isSafeInteger(receipt.authzSeq)||(receipt.authzSeq as number)<1)fail('owner-receipt-invalid');
  await publishSame(join(state,'activation.json'),encode(receipt));
  const storePath=join(input.protectedDir,'tokens.dpapi');
  if(await exists(storePath)) {
    const existing=await readEnrollmentInput(storePath,1_048_576);
    if(!exact(existing,['version','entries'])||existing.version!==1||!exact(existing.entries,['device','cc','cx']))fail('owner-token-store-conflict');
    for(const t of secrets.tokens){const entry=existing.entries[t.kind==='kl-device'?'device':t.kind==='cc-bearer'?'cc':'cx'];
      if(typeof entry!=='string'||!entry||Buffer.from(entry,'base64').toString('base64')!==entry)fail('owner-token-store-conflict');
      const plain=await input.protection.unprotect(new Uint8Array(Buffer.from(entry,'base64')));
      try{if(sha256Hex(plain)!==t.hash)fail('owner-token-store-conflict');}finally{plain.fill(0);}}
  } else {
    const entries:Record<string,string>={};
    for(const t of secrets.tokens){const plain=new TextEncoder().encode(t.token);try{entries[t.kind==='kl-device'?'device':t.kind==='cc-bearer'?'cc':'cx']=Buffer.from(await input.protection.protect(plain)).toString('base64');}finally{plain.fill(0);}}
    await publishSame(storePath,encode({version:1,entries}));
  }
  const command=helperCommand(secrets.helperArgv),storeArgument=helperCommand([storePath]);
  await publishSame(join(state,'claude-mcp.json'),encode({mcpServers:{'knowledge-library':{type:'http',url:c.audience.origin+'/mcp',headersHelper:command+' token print cc --json --store '+storeArgument}}}));
  await publishTextSame(join(state,'codex-mcp.toml'),'[mcp_servers.knowledge-library]\nurl = '+JSON.stringify(c.audience.origin+'/mcp')+'\nhttp_headers_helper = '+JSON.stringify(command+' token print cx --json --store '+storeArgument)+'\n');
}

async function publishTextSame(path:string,text:string):Promise<void>{
  // Store a bounded JSON envelope as the durable comparison source for exact TOML recovery.
  await publishSame(path+'.receipt.json',encode({text}));
  if(await exists(path)){
    const {readFile}=await import('node:fs/promises');const st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>16_384||await readFile(path,'utf8')!==text)fail('owner-publication-conflict');return;
  }
  const pending=path+'.pending';if(await exists(pending))fail('owner-publication-incomplete');
  await exclusive(pending,new TextEncoder().encode(text));await link(pending,path);await unlink(pending);
}

export interface OwnerReleaseRequest {schema:'kl-owner-release-request/v1';versionId:string;revision:number;previousReleaseHash:string|null;mode:'active'|'closed'}
/** Explicit reviewed provider version; remote responses can neither select a version nor supply trust. */
export async function submitOwnerRelease(input:{stateDir:string;protectedDir:string;request:unknown;protection:OwnerProtection;fetch:typeof fetch;now?:string}):Promise<void>{
  const request=JSON.parse(canonicalJson(input.request)) as OwnerReleaseRequest,at=input.now??new Date().toISOString();
  if(!exact(request,['schema','versionId','revision','previousReleaseHash','mode'])||request.schema!=='kl-owner-release-request/v1'||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.versionId)||
    !Number.isSafeInteger(request.revision)||request.revision<1||!['active','closed'].includes(request.mode)||
    !(request.previousReleaseHash===null||/^[a-f0-9]{64}$/.test(request.previousReleaseHash)))fail('owner-release-request-invalid');
  await inspectArchiveRoot(input.stateDir);await inspectArchiveRoot(input.protectedDir);
  const secrets=await protectedRead<OwnerSecrets>(join(input.protectedDir,'owner.dpapi'),input.protection);
  const c=checkConfig(await readEnrollmentInput(join(input.stateDir,'owner-input.json'),12*1024*1024));
  if(secrets.schema!=='kl-owner-secrets/v1'||secrets.stateKey!==archiveRootKey(input.stateDir)||secrets.configHash!==sha256Hex(canonicalJson(c)))fail('owner-approved-input-changed');
  const intentPath=join(input.protectedDir,'release-'+request.revision+'.dpapi');let packet:SignedRuntimeRelease;
  if(await exists(intentPath)){
    packet=await protectedRead<SignedRuntimeRelease>(intentPath,input.protection);
    if(packet.claims.versionId!==request.versionId||packet.claims.revision!==request.revision||packet.claims.previousReleaseHash!==request.previousReleaseHash||
      packet.claims.mode!==request.mode||canonicalJson(packet.claims.audience)!==canonicalJson(c.audience))fail('owner-release-intent-conflict');
    if(Date.parse(packet.claims.expiresAt)<=Date.parse(at))fail('owner-release-intent-expired');
    const checked=await signRuntimeRelease(packet.claims,secrets.keys.approval.keyId,await privateKey(secrets.keys.approval));
    if(canonicalJson(checked)!==canonicalJson(packet)||Date.parse(packet.claims.issuedAt)>Date.parse(at))fail('owner-release-intent-invalid');
  }else{
    const claims:RuntimeReleaseClaims={purpose:'kl-runtime-release/v1',audience:c.audience,versionId:request.versionId,revision:request.revision,
      previousReleaseHash:request.previousReleaseHash,mode:request.mode,nonce:sha256Hex(crypto.getRandomValues(new Uint8Array(32))),issuedAt:at,expiresAt:new Date(Date.parse(at)+600_000).toISOString()};
    packet=await signRuntimeRelease(claims,secrets.keys.approval.keyId,await privateKey(secrets.keys.approval));
    await protectedWrite(intentPath,packet,input.protection);
  }
  const endpoint=c.audience.origin+'/v1/runtime/release',expectedHash=sha256Hex(canonicalJson(packet));
  const call=async(init:RequestInit)=>{const response=await input.fetch(endpoint,{...init,redirect:'error',signal:AbortSignal.timeout(20_000)});
    if(!response.ok||response.redirected||(response.url&&response.url!==endpoint))fail('owner-release-refused');return boundedResponse(response);};
  const current=await call({method:'GET'});
  const validState=(v:unknown):v is {schema:string;revision:number;releaseHash:string;versionId:string;mode:string}=>exact(v,['schema','revision','releaseHash','versionId','mode'])&&
    v.schema==='kl-runtime-release-state/v1'&&Number.isSafeInteger(v.revision)&&(v.revision as number)>0&&typeof v.releaseHash==='string'&&/^[a-f0-9]{64}$/.test(v.releaseHash)&&
    typeof v.versionId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.versionId)&&['active','closed'].includes(String(v.mode));
  if(current!==null&&!validState(current))fail('owner-release-receipt-invalid');
  if(current===null ? request.revision!==1||request.previousReleaseHash!==null :
    current.releaseHash!==expectedHash&&(current.revision!==request.revision-1||current.releaseHash!==request.previousReleaseHash))fail('owner-release-state-conflict');
  const receipt=await call({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)});
  if(!validState(receipt)||receipt.releaseHash!==expectedHash||receipt.versionId!==request.versionId||receipt.revision!==request.revision||receipt.mode!==request.mode)fail('owner-release-receipt-invalid');
  await publishSame(join(input.stateDir,'release-'+request.revision+'.json'),encode(receipt));
}

async function windowsProtection(env:Record<string,string|undefined>):Promise<OwnerProtection & {close():Promise<void>}> {
  if(process.platform!=='win32')fail('owner-windows-required');
  const client=new HelperClient(helperPath(env));
  const operation=async(direction:'protect'|'unprotect',bytes:Uint8Array)=>{const result=await dpapi(client,direction,bytes);if(!result.ok)fail('owner-protection-failed');return result.bytes;};
  return {protect:bytes=>operation('protect',bytes),unprotect:bytes=>operation('unprotect',bytes),close:()=>client.stop()};
}
function credentialDirectory(state:string,env:Record<string,string|undefined>):string{
  const local=env.LOCALAPPDATA;
  if(!local||!isAbsolute(local)||!isAbsolute(state)||!/^c:[\\/]/i.test(local))fail('owner-credential-location-invalid');
  return join(local,'kl','owner',sha256Hex(archiveRootKey(state)));
}
export async function secureWindowsOwnerDirectory(path:string,verifyOnly=false):Promise<void>{
  if(process.platform!=='win32')fail('owner-windows-required');
  await inspectArchiveRoot(path);
  const system=process.env.SystemRoot;
  if(!system||!isAbsolute(system))fail('owner-acl-unavailable');
  const script=`$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$target = $env:KL_OWNER_CREDENTIAL_DIRECTORY
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($env:KL_OWNER_ACL_VERIFY -ne '1') {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($identity in @($sid, $systemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($target, $acl)
}
$checked = [IO.Directory]::GetAccessControl($target)
if (-not $checked.AreAccessRulesProtected -or $checked.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner-acl-invalid' }
$rules = @($checked.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'owner-acl-invalid' }
foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or $rule.PropagationFlags -ne 'None') { throw 'owner-acl-invalid' }
}
`;
  try{await promisify(execFile)(join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],
    // Use framework APIs with module autoload disabled: a stripped child
    // environment must not discover modules to protect a credential directory.
    // One finite attempt still requires every ACL write/readback check.
    {windowsHide:true,timeout:60_000,maxBuffer:16_384,env:{...archiveChildEnv(),KL_OWNER_CREDENTIAL_DIRECTORY:path,KL_OWNER_ACL_VERIFY:verifyOnly?'1':'0'}});}
  catch(error){
    const failure=error as {killed?:unknown;code?:unknown};
    if(failure?.killed===true&&failure.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')fail('owner-acl-timeout');
    fail('owner-acl-process-failed');
  }
}
async function prepareCredentialParent(path:string,env:Record<string,string|undefined>):Promise<void>{
  const local=env.LOCALAPPDATA!;await inspectArchiveRoot(local);
  for(const dir of [join(local,'kl'),dirname(path)]){if(!await exists(dir))await mkdir(dir);await inspectArchiveRoot(dir);}
  await secureWindowsOwnerDirectory(dirname(path));
}
export async function ownerEnrollmentCommand(mode:'owner-prepare'|'owner-enroll'|'owner-release',args:string[],io:Io):Promise<number> {
  let protection:Awaited<ReturnType<typeof windowsProtection>>|undefined;
  try {
    if((mode==='owner-prepare'&&(args.length!==3||args[1]!=='--state'))||(mode==='owner-enroll'&&(args.length!==2||args[0]!=='--state'))||
      (mode==='owner-release'&&(args.length!==4||args[0]!=='--state'||args[2]!=='--request'))){io.stderr('usage: kl owner-prepare <reviewed-config.json> --state <new-directory> | kl owner-enroll --state <directory> | kl owner-release --state <directory> --request <reviewed-release.json>\n');return 2;}
    const stateDir=mode==='owner-prepare'?args[2]!:args[1]!,protectedDir=credentialDirectory(stateDir,io.env);
    if(!/^d:[\\/]/i.test(stateDir))fail('owner-state-location-invalid');
    protection=await windowsProtection(io.env);
    if(mode==='owner-prepare'){
      await prepareCredentialParent(protectedDir,io.env);
      await prepareOwnerEnrollment({config:await readEnrollmentInput(args[0]!,12*1024*1024),stateDir,protectedDir,helperArgv:[...(io.klArgv??[])],protection,secureDirectory:secureWindowsOwnerDirectory});
    }else{
      await inspectArchiveRoot(protectedDir);await secureWindowsOwnerDirectory(protectedDir,true);
      if(mode==='owner-release')await submitOwnerRelease({stateDir,protectedDir,protection,fetch:io.fetch,request:await readEnrollmentInput(args[3]!,8_192)});
      else await submitOwnerEnrollment({stateDir,protectedDir,protection,fetch:io.fetch});
    }
    io.stdout(mode==='owner-prepare'?'Protected owner enrollment prepared. Runtime configuration is ready for reviewed deployment.\n':mode==='owner-release'?'Owner release verified for the exact reviewed service version.\n':'Enrollment verified. Protected client credentials and token-free MCP configurations are ready.\n');return 0;
  }catch(error){const code=error instanceof Error&&/^[a-z][a-z0-9-]{1,80}$/.test(error.message)?error.message:'owner-enrollment-failed';io.stderr('kl '+mode+': '+code+'; secrets were not printed.\n');return 1;}
  finally {await protection?.close();}
}
