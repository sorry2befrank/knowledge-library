import type { EnrollmentClaims } from '../../../../packages/core/src/auth/enrollment.ts';
import type { AcceptanceRecord, PolicyBundle } from '../../../../packages/core/src/policy/acceptance.ts';

/** Owner-local artifact: contains the approved private policy, never bearer tokens. */
export interface RuntimeConfig {
  schema:'kl-owner-runtime/v1';
  audience:EnrollmentClaims['audience'];
  approval:{keyId:string;publicKeyB64:string};
  policy:{keyId:string;publicKeyB64:string;minEpoch:number;policyHash:string};
  policyBundle:PolicyBundle;
  policyAcceptance:AcceptanceRecord;
}
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[])=>plain(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(v);
const key=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const RUNTIME_CONFIG_MAX_BYTES=40_000;
const enc=new TextEncoder();
/** Fixed binding names keep the private policy within Cloudflare's per-variable
 * limit. Exact count + empty unused slots forbid silent truncation/extra chunks. */
export function readRuntimeConfig(bindings:Record<string,unknown>):RuntimeConfig{
  const count=bindings.RUNTIME_CONFIG_COUNT;
  if(typeof count!=='string'||!/^[1-8]$/.test(count))throw Error('runtime-config-invalid');
  const chunks:string[]=[];
  for(let n=1;n<=8;n++){
    const value=bindings[`RUNTIME_CONFIG_${n}`];
    if(typeof value!=='string'||enc.encode(value).length>5000||
      (n<=Number(count)?value.length===0:value!==''))throw Error('runtime-config-invalid');
    if(n<=Number(count))chunks.push(value);
  }
  return parseRuntimeConfig(chunks.join(''));
}
/** Owner packaging only: no secrets are returned, but private policy still makes
 * these values owner-local artifacts, never console output or public source. */
export function runtimeConfigBindings(config:RuntimeConfig):Record<string,string>{
  const raw=JSON.stringify(config);parseRuntimeConfig(raw);
  const chunks:string[]=[];let part='',size=0;
  for(const char of raw){const bytes=enc.encode(char).length;if(size+bytes>5000){chunks.push(part);part='';size=0;}part+=char;size+=bytes;}
  if(part)chunks.push(part);if(chunks.length>8)throw Error('runtime-config-invalid');
  return Object.fromEntries([['RUNTIME_CONFIG_COUNT',String(chunks.length)],...Array.from({length:8},(_,i)=>[`RUNTIME_CONFIG_${i+1}`,chunks[i]??''])]);
}
export function parseRuntimeConfig(raw:string):RuntimeConfig {
  try {
    if(typeof raw!=='string'||enc.encode(raw).length>RUNTIME_CONFIG_MAX_BYTES)throw Error();
    const v:unknown=JSON.parse(raw);
    if(!exact(v,['schema','audience','approval','policy','policyBundle','policyAcceptance']))throw Error();
    const c=v as RuntimeConfig;
    if(c.schema!=='kl-owner-runtime/v1'||!exact(c.audience,['origin','environment','libraryId'])||!id(c.audience.libraryId)||
      !['staging','production'].includes(c.audience.environment))throw Error();
    const url=new URL(c.audience.origin);
    if(url.origin!==c.audience.origin||url.protocol!=='https:'||url.username||url.password)throw Error();
    if(!exact(c.approval,['keyId','publicKeyB64'])||!id(c.approval.keyId)||!key(c.approval.publicKeyB64)||
      !exact(c.policy,['keyId','publicKeyB64','minEpoch','policyHash'])||!id(c.policy.keyId)||!key(c.policy.publicKeyB64)||
      !hash(c.policy.policyHash)||!Number.isSafeInteger(c.policy.minEpoch)||c.policy.minEpoch<1||
      c.approval.keyId===c.policy.keyId||c.approval.publicKeyB64===c.policy.publicKeyB64)throw Error();
    if(!exact(c.policyBundle,['files'])||!plain(c.policyBundle.files)||
      !exact(c.policyAcceptance,['policyHash','epoch','receiptId','sig','keyId'])||
      c.policyAcceptance.policyHash!==c.policy.policyHash||c.policyAcceptance.keyId!==c.policy.keyId||
      !Number.isSafeInteger(c.policyAcceptance.epoch)||c.policyAcceptance.epoch<c.policy.minEpoch||
      !id(c.policyAcceptance.receiptId)||typeof c.policyAcceptance.sig!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(c.policyAcceptance.sig))throw Error();
    return c;
  }catch{throw Error('runtime-config-invalid');}
}
