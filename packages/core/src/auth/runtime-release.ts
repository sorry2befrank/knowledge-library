// Owner-signed operational gate, separate from enrollment and bearer tokens.
// The caller serializes acceptance with normal requests. Recovered/other-version
// namespaces start closed; no configuration flag or public status grants access.
import { canonicalJson } from '../primitives/canonical.ts';
import { sha256Hex } from '../primitives/sha256.ts';
import { fromBase64Url, toBase64Url } from '../primitives/base64url.ts';
import { importPublicKey } from '../policy/acceptance.ts';
import type { EnrollmentClaims } from './enrollment.ts';
import type { ObjectStore } from '../catalog/blobs.ts';

export const RUNTIME_RELEASE_KEY='archive-owner-runtime-release';
export interface RuntimeReleaseClaims {
  purpose:'kl-runtime-release/v1'; audience:EnrollmentClaims['audience'];
  versionId:string; revision:number; previousReleaseHash:string|null;
  mode:'active'|'closed'; nonce:string; issuedAt:string; expiresAt:string;
}
export interface SignedRuntimeRelease {claims:RuntimeReleaseClaims;keyId:string;sig:string}
export interface RuntimeReleaseTrust {approval:{keyId:string;publicKeyB64:string};audience:EnrollmentClaims['audience'];now():string}
export interface RuntimeReleasePort {get(key:string):Promise<unknown>;put(key:string,value:unknown):Promise<void>;sync():Promise<void>;proofs:ObjectStore}
export interface RuntimeReleaseState {schema:'kl-runtime-release-state/v1';revision:number;releaseHash:string;versionId:string;mode:'active'|'closed'}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(v);
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function refuse():never{throw Error('runtime-release-refused');}
function validate(c:unknown):asserts c is RuntimeReleaseClaims {
  if(!exact(c,['purpose','audience','versionId','revision','previousReleaseHash','mode','nonce','issuedAt','expiresAt']))refuse();
  const r=c as unknown as RuntimeReleaseClaims;
  if(r.purpose!=='kl-runtime-release/v1'||!uuid(r.versionId)||!Number.isSafeInteger(r.revision)||r.revision<1||
    !(r.previousReleaseHash===null||hash(r.previousReleaseHash))||!['active','closed'].includes(r.mode)||!hash(r.nonce)||
    !iso(r.issuedAt)||!iso(r.expiresAt)||Date.parse(r.expiresAt)<=Date.parse(r.issuedAt)||Date.parse(r.expiresAt)-Date.parse(r.issuedAt)>900_000||
    !exact(r.audience,['origin','environment','libraryId'])||!['staging','production'].includes(r.audience.environment)||!id(r.audience.libraryId))refuse();
  try{const u=new URL(r.audience.origin);if(u.origin!==r.audience.origin||u.protocol!=='https:'||u.username||u.password)refuse();}catch{refuse();}
}
function bytes(claims:RuntimeReleaseClaims,keyId:string):Uint8Array{return new TextEncoder().encode(canonicalJson({claims,keyId}));}
export async function signRuntimeRelease(claims:RuntimeReleaseClaims,keyId:string,key:CryptoKey):Promise<SignedRuntimeRelease>{
  const copy=JSON.parse(canonicalJson(claims));validate(copy);if(!id(keyId))refuse();
  return {claims:copy,keyId,sig:toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519',key,bytes(copy,keyId) as BufferSource)))};
}
async function verify(input:unknown,trust:RuntimeReleaseTrust,live:boolean):Promise<SignedRuntimeRelease>{
  try{
    const raw=canonicalJson(input);if(new TextEncoder().encode(raw).length>8192)refuse();
    const packet=JSON.parse(raw) as SignedRuntimeRelease;
    if(!exact(packet,['claims','keyId','sig'])||packet.keyId!==trust.approval.keyId||!id(packet.keyId)||
      typeof packet.sig!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(packet.sig))refuse();
    validate(packet.claims);if(canonicalJson(packet.claims.audience)!==canonicalJson(trust.audience))refuse();
    if(!await crypto.subtle.verify('Ed25519',await importPublicKey(trust.approval.publicKeyB64),fromBase64Url(packet.sig) as BufferSource,bytes(packet.claims,packet.keyId) as BufferSource))refuse();
    if(live){const now=trust.now();if(!iso(now)||Date.parse(packet.claims.issuedAt)>Date.parse(now)||Date.parse(packet.claims.expiresAt)<=Date.parse(now))refuse();}
    return packet;
  }catch{refuse();}
}
function state(packet:SignedRuntimeRelease):RuntimeReleaseState {
  return {schema:'kl-runtime-release-state/v1',revision:packet.claims.revision,releaseHash:sha256Hex(canonicalJson(packet)),versionId:packet.claims.versionId,mode:packet.claims.mode};
}
export async function runtimeReleaseState(port:RuntimeReleasePort,trust:RuntimeReleaseTrust):Promise<RuntimeReleaseState|null>{
  // This independent immutable history prevents a same-version DO rollback from
  // resurrecting a prior active grant after a later closure. Unknown/forked
  // history is closed, including when the local KV projection is intact.
  const prefix='anchors/runtime-release/'+sha256Hex(canonicalJson(trust.audience))+'/';
  const keys=(await port.proofs.list(prefix)).sort();if(keys.length>64||new Set(keys).size!==keys.length)refuse();
  let previous:RuntimeReleaseState|null=null;
  for(const name of keys){
    if(!name.startsWith(prefix)||!/^\d{6}-[a-f0-9]{64}\.json$/.test(name.slice(prefix.length)))refuse();
    const raw=await port.proofs.get(name);if(!raw||raw.length>8192)refuse();
    let saved:SignedRuntimeRelease;try{saved=await verify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),trust,false);}catch{refuse();}
    const next=state(saved);
    if(name!==prefix+String(next.revision).padStart(6,'0')+'-'+next.releaseHash+'.json'||next.revision!==(previous?.revision??0)+1||saved.claims.previousReleaseHash!==(previous?.releaseHash??null))refuse();
    previous=next;
  }
  return previous;
}
/** Issuance expires quickly; an accepted record remains until a later signed
 * revision, but only its exact native provider version may serve data. */
export async function acceptRuntimeRelease(input:unknown,port:RuntimeReleasePort,trust:RuntimeReleaseTrust,nativeVersionId:string):Promise<RuntimeReleaseState>{
  const packet=await verify(input,trust,true);if(!uuid(nativeVersionId)||packet.claims.versionId!==nativeVersionId)refuse();
  const next=state(packet),old=await runtimeReleaseState(port,trust);
  if(old?.releaseHash===next.releaseHash){
    const mirror=await port.get(RUNTIME_RELEASE_KEY);if(mirror===undefined||state(await verify(mirror,trust,false)).releaseHash!==next.releaseHash)refuse();return old;
  }
  const oldMirror=await port.get(RUNTIME_RELEASE_KEY);
  if(oldMirror!==undefined&&state(await verify(oldMirror,trust,false)).revision>(old?.revision??0))refuse();
  // Reserve the final slot for closure, so exhausting the history cannot strand
  // an active grant that the owner is no longer able to close.
  if(next.revision>64||(next.revision===64&&next.mode!=='closed'))refuse();
  if(packet.claims.revision!==(old?.revision??0)+1||packet.claims.previousReleaseHash!==(old?.releaseHash??null))refuse();
  // Caller holds the single operation gate over read, write, flush and readback.
  const proofKey='anchors/runtime-release/'+sha256Hex(canonicalJson(trust.audience))+'/'+String(next.revision).padStart(6,'0')+'-'+next.releaseHash+'.json';
  const proofBytes=new TextEncoder().encode(canonicalJson(packet));
  await port.proofs.put(proofKey,proofBytes,{onlyIfAbsent:true});
  const proofReadback=await port.proofs.get(proofKey);if(!proofReadback||sha256Hex(proofReadback)!==sha256Hex(proofBytes))refuse();
  await port.put(RUNTIME_RELEASE_KEY,packet);await port.sync();
  const mirror=await port.get(RUNTIME_RELEASE_KEY);if(mirror===undefined||state(await verify(mirror,trust,false)).releaseHash!==next.releaseHash)refuse();
  const readback=await runtimeReleaseState(port,trust);if(readback?.releaseHash!==next.releaseHash)refuse();return readback;
}
export async function runtimeIsReleased(port:RuntimeReleasePort,trust:RuntimeReleaseTrust,nativeVersionId:string):Promise<boolean>{
  try{
    const saved=await runtimeReleaseState(port,trust),mirror=await port.get(RUNTIME_RELEASE_KEY);
    return uuid(nativeVersionId)&&saved?.versionId===nativeVersionId&&saved.mode==='active'&&mirror!==undefined&&state(await verify(mirror,trust,false)).releaseHash===saved.releaseHash;
  }catch{return false;}
}
