// Local-only, main-pinned packaging. No credential discovery, network, or deployment.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Loader } from 'esbuild';
import { bootstrapGit } from './cloud-bootstrap.ts';
import { parseRuntimeConfig,readRuntimeConfig,runtimeConfigBindings,type RuntimeConfig } from '../apps/api/src/cloudflare/runtime-config.ts';
import { bundleHash,importPublicKey,verifyAcceptance } from '../packages/core/src/policy/acceptance.ts';
import { parseRehearsalInventory } from '../apps/api/src/cloudflare/recovery-rehearsal.ts';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const FILES=['worker.mjs','wrangler.active.jsonc','wrangler.closed.jsonc'] as const;
const PINS={wrangler:'4.150.0',esbuild:'0.28.2',miniflare:'4.20260730.0','@cloudflare/workers-types':'5.20261006.1'};
const GENERATED=['packages/core/src/evidence/design-spec.generated.ts','packages/contracts/src/validators.generated.ts'];
const GENERATORS=['scripts/build-spec.ts','scripts/build-contracts.ts'];
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
function fail(code:string):never{throw Error(code);}
export interface RuntimePackageIdentity {reviewedCommit:string;accountId:string;workerName:string;bucketName:string;environment:'staging'|'production';purpose?:'runtime'|'scope-probe'|'recovery-rehearsal';decoyBucketName?:string;rehearsalInventorySha256?:string}
export interface RuntimePackageInput extends RuntimePackageIdentity {runtimeConfigPath:string;out:string;rehearsalInventoryPath?:string}
export interface RuntimePackagePins {reviewedCommit:string;manifestSha256:string}
function identity(input:RuntimePackageIdentity):void{
  if(!/^[a-f0-9]{40}$/.test(input.reviewedCommit)||!/^[a-f0-9]{32}$/.test(input.accountId)||
    !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(input.workerName)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucketName)||
    !['staging','production'].includes(input.environment)||!['runtime','scope-probe','recovery-rehearsal'].includes(input.purpose??'runtime')||
    (input.purpose==='scope-probe'?(input.environment!=='staging'||input.decoyBucketName!=='kl-scope-decoy-staging'||input.bucketName===input.decoyBucketName):input.decoyBucketName!==undefined)||
    (input.purpose==='recovery-rehearsal'?(input.environment!=='staging'||input.workerName!=='kl-api-staging'||input.bucketName!=='kl-archive-staging'||!/^[a-f0-9]{64}$/.test(input.rehearsalInventorySha256??'')):input.rehearsalInventorySha256!==undefined))fail('runtime-package-identity-invalid');
}
function normalizedIdentity(input:RuntimePackageIdentity){return {reviewedCommit:input.reviewedCommit,accountId:input.accountId,workerName:input.workerName,bucketName:input.bucketName,
  environment:input.environment,purpose:input.purpose??'runtime',...(input.purpose==='scope-probe'?{decoyBucketName:input.decoyBucketName}:{}),...(input.purpose==='recovery-rehearsal'?{rehearsalInventorySha256:input.rehearsalInventorySha256}:{})};}
function outside(child:string,parent:string){const r=relative(parent,child);return !!r&&(r==='..'||r.startsWith('..'+sep)||isAbsolute(r));}
function ordinary(path:string,kind:'file'|'directory'):void{
  const stat=lstatSync(path);if(stat.isSymbolicLink()||(kind==='file'?(!stat.isFile()||stat.nlink!==1):!stat.isDirectory()))fail('runtime-package-path-invalid');
  for(let p=dirname(path);;p=dirname(p)){if(lstatSync(p).isSymbolicLink())fail('runtime-package-path-invalid');if(dirname(p)===p)break;}
}
function rawConfig(path:string):{bytes:Buffer;config:RuntimeConfig}{
  ordinary(path,'file');const stat=lstatSync(path);if(stat.size>40_000)fail('runtime-config-invalid');
  const bytes=readFileSync(path);return {bytes,config:parseRuntimeConfig(bytes.toString('utf8'))};
}
async function approvedConfig(config:RuntimeConfig,input:RuntimePackageIdentity):Promise<void>{
  const u=new URL(config.audience.origin);
  if(config.audience.environment!==input.environment||!new RegExp('^'+input.workerName+'\\.[a-z0-9-]+\\.workers\\.dev$').test(u.hostname))fail('runtime-package-audience-invalid');
  const checked=await verifyAcceptance(config.policyAcceptance,bundleHash(config.policyBundle),{publicKey:await importPublicKey(config.policy.publicKeyB64),keyId:config.policy.keyId,minEpoch:config.policy.minEpoch});
  if(!checked.ok)fail('runtime-package-policy-invalid');
}
export function makeRuntimeConfig(input:RuntimePackageIdentity,config:RuntimeConfig,mode:'active'|'closed'){
  identity(input);
  return {name:input.workerName,account_id:input.accountId,main:'worker.mjs',no_bundle:true,find_additional_modules:false,
    compatibility_date:'2026-07-30',workers_dev:true,preview_urls:false,send_metrics:false,upload_source_maps:false,
    observability:{enabled:false,logs:{enabled:false},traces:{enabled:false}},
    vars:{RUNTIME_MODE:input.purpose==='scope-probe'||input.purpose==='recovery-rehearsal'?'closed':mode,...runtimeConfigBindings(config)},version_metadata:{binding:'VERSION'},
    durable_objects:{bindings:[{name:'LIBRARY',class_name:'LibraryDO'}]},migrations:[{tag:'archive-runtime-v1',new_sqlite_classes:['LibraryDO']}],
    r2_buckets:[{binding:'ARCHIVE',bucket_name:input.bucketName},...(input.purpose==='scope-probe'?[{binding:'DECOY',bucket_name:input.decoyBucketName}]:[])]};
}
function clean(repo:string,commit:string):void{
  const names=bootstrapGit(['config','--includes','--list','--name-only'],repo).split(/\r?\n/);
  if(names.some(n=>/^filter\./i.test(n)))fail('runtime-package-git-filter');
  if(bootstrapGit(['status','--porcelain','--untracked-files=all'],repo))fail('runtime-package-source-dirty');
  for(const ref of ['HEAD','refs/heads/main','refs/remotes/origin/main'])if(bootstrapGit(['rev-parse','--verify',ref],repo)!==commit)fail('runtime-package-main-mismatch');
  const index=bootstrapGit(['ls-files','-v','-z'],repo).split('\0').filter(Boolean);
  if(!index.length||index.some(row=>!row.startsWith('H ')))fail('runtime-package-index-flags');
}
function committed(repo:string,commit:string,path:string,bytes:Buffer):void{
  const source=bootstrapGit(['show',`${commit}:${path}`],repo,{trim:false});
  if(bytes.toString('utf8').replaceAll('\r\n','\n')!==source.replaceAll('\r\n','\n'))fail('runtime-package-source-mismatch');
}
function write(path:string,bytes:Uint8Array|string):void{
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}

/** repo parameter is a trusted test seam. The executable always uses its own checkout. */
export async function packageArchiveRuntime(input:RuntimePackageInput,repo=ROOT):Promise<RuntimePackagePins>{
  identity(input);repo=realpathSync(repo);
  if(!isAbsolute(input.out)||!isAbsolute(input.runtimeConfigPath))fail('runtime-package-absolute-path-required');
  const out=resolve(input.out),parent=dirname(out);ordinary(parent,'directory');
  if(!outside(realpathSync(parent),repo)||!outside(realpathSync(dirname(input.runtimeConfigPath)),repo))fail('runtime-package-owner-state-inside-repo');
  if(existsSync(out))fail('runtime-package-output-exists');
  clean(repo,input.reviewedCommit);
  const runtime=rawConfig(input.runtimeConfigPath);await approvedConfig(runtime.config,input);
  let rehearsalBytes:Buffer|undefined;
  if(input.purpose==='recovery-rehearsal'){
    if(!input.rehearsalInventoryPath||!isAbsolute(input.rehearsalInventoryPath)||!outside(realpathSync(dirname(input.rehearsalInventoryPath)),repo))fail('runtime-rehearsal-input-invalid');
    ordinary(input.rehearsalInventoryPath,'file');if(lstatSync(input.rehearsalInventoryPath).size>8192)fail('runtime-rehearsal-input-invalid');
    rehearsalBytes=readFileSync(input.rehearsalInventoryPath);
    if(sha(rehearsalBytes)!==input.rehearsalInventorySha256||parseRehearsalInventory(rehearsalBytes.toString('utf8')).libraryId!==runtime.config.audience.libraryId)fail('runtime-rehearsal-input-invalid');
  }else if(input.rehearsalInventoryPath!==undefined)fail('runtime-rehearsal-input-invalid');
  const lockBytes=readFileSync(join(repo,'package-lock.json')),lock=JSON.parse(lockBytes.toString('utf8'));
  committed(repo,input.reviewedCommit,'package-lock.json',lockBytes);
  for(const [name,version] of Object.entries(PINS)){
    const entry=lock.packages?.['node_modules/'+name];
    if(entry?.version!==version||typeof entry.integrity!=='string'||!entry.integrity.startsWith('sha512-')||
      JSON.parse(readFileSync(join(repo,'node_modules',name,'package.json'),'utf8')).version!==version)fail('runtime-package-dependency-drift');
  }
  const inventory:Record<string,string>={},generated:Record<string,string>={};
  const reviewedInputs={name:'reviewed-inputs',setup(builder:import('esbuild').PluginBuild){
      builder.onLoad({filter:/\.(?:[cm]?[jt]s|json)$/},args=>{
        ordinary(args.path,'file');const path=relative(repo,args.path).replaceAll('\\','/');
        if(path.startsWith('../')||isAbsolute(path))fail('runtime-package-external-input');
        if(input.purpose!=='scope-probe'&&/synthetic-probe/i.test(path))fail('runtime-package-probe-in-runtime');
        if(input.purpose!=='recovery-rehearsal'&&/recovery-rehearsal/i.test(path))fail('runtime-package-rehearsal-in-runtime');
        const bytes=readFileSync(args.path);inventory[path]=sha(bytes);
        if(GENERATED.includes(path)){if(generated[path]!==sha(bytes))fail('runtime-package-generated-unverified');}
        else if(!path.startsWith('node_modules/'))committed(repo,input.reviewedCommit,path,bytes);
        else {
          const key=Object.keys(lock.packages??{}).filter(k=>k.startsWith('node_modules/')&&path.startsWith(k+'/')).sort((a,b)=>b.length-a.length)[0];
          if(!key||typeof lock.packages[key].integrity!=='string'||!lock.packages[key].integrity.startsWith('sha512-')||
            JSON.parse(readFileSync(join(repo,key,'package.json'),'utf8')).version!==lock.packages[key].version)fail('runtime-package-dependency-drift');
        }
        const ext=args.path.split('.').at(-1)!;const loader:Loader=ext==='json'?'json':ext.endsWith('ts')?'ts':'js';
        return {contents:bytes,loader};
      });
    }};
  // Only these two generated modules can bypass a direct Git blob comparison.
  // Review their full import graph first, then run the reviewed local generators
  // without inherited credentials/Node preload hooks. They perform no network I/O.
  if(GENERATORS.some(path=>existsSync(join(repo,path)))){
    if(!GENERATORS.every(path=>existsSync(join(repo,path))))fail('runtime-package-generator-missing');
    await build({absWorkingDir:repo,entryPoints:GENERATORS,outdir:'.review/generator-inspection',bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['esbuild'],
      sourcemap:false,legalComments:'none',metafile:true,plugins:[reviewedInputs]});
    const design=readFileSync(join(repo,'docs/DESIGN.md'));committed(repo,input.reviewedCommit,'docs/DESIGN.md',design);inventory['docs/DESIGN.md']=sha(design);
    for(const path of GENERATED){ordinary(dirname(join(repo,path)),'directory');if(existsSync(join(repo,path)))ordinary(join(repo,path),'file');}
    const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','TEMP','TMP']);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>allowed.has(key.toUpperCase())&&value!==undefined));
    for(const path of GENERATORS)try{execFileSync(process.execPath,[join(repo,path)],{cwd:repo,env,timeout:30_000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{fail('runtime-package-generator-failed');}
    for(const path of GENERATED){ordinary(join(repo,path),'file');generated[path]=sha(readFileSync(join(repo,path)));}
  }
  const entryPoint=input.purpose==='scope-probe'?'apps/api/src/cloudflare/synthetic-probe-worker.ts':input.purpose==='recovery-rehearsal'?'apps/api/src/cloudflare/recovery-rehearsal-worker.ts':'apps/api/src/cloudflare/archive-worker.ts';
  const built=await build({absWorkingDir:repo,entryPoints:[entryPoint],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],
    sourcemap:false,legalComments:'none',metafile:true,plugins:[reviewedInputs],...(rehearsalBytes?{define:{__KL_REHEARSAL_INVENTORY__:JSON.stringify(rehearsalBytes.toString('utf8'))}}:{})});
  if(built.outputFiles?.length!==1||!built.metafile||Object.keys(built.metafile.inputs).some(path=>!(path in inventory)))fail('runtime-package-input-unreviewed');
  clean(repo,input.reviewedCommit);
  for(const [path,digest] of Object.entries(inventory))if(sha(readFileSync(join(repo,path)))!==digest)fail('runtime-package-source-changed');
  if(sha(readFileSync(join(repo,'package-lock.json')))!==sha(lockBytes)||sha(rawConfig(input.runtimeConfigPath).bytes)!==sha(runtime.bytes))fail('runtime-package-input-changed');
  if(rehearsalBytes&&sha(readFileSync(input.rehearsalInventoryPath!))!==sha(rehearsalBytes))fail('runtime-package-input-changed');
  const files:Record<string,Uint8Array|string>={'worker.mjs':built.outputFiles[0]!.contents,
    'wrangler.active.jsonc':json(makeRuntimeConfig(input,runtime.config,'active')),'wrangler.closed.jsonc':json(makeRuntimeConfig(input,runtime.config,'closed'))};
  const manifest={schema:'kl-runtime-package/v1',...normalizedIdentity(input),
    lockfileSha256:sha(lockBytes),runtimeConfigSha256:sha(runtime.bytes),toolchain:PINS,inputInventory:Object.fromEntries(Object.entries(inventory).sort(([a],[b])=>a.localeCompare(b))),
    files:Object.fromEntries(Object.entries(files).map(([path,data])=>[path,sha(data)]))};
  mkdirSync(out,{mode:0o700});for(const [name,data] of Object.entries(files))write(join(out,name),data);write(join(out,'manifest.json'),json(manifest));
  const pins={reviewedCommit:input.reviewedCommit,manifestSha256:sha(readFileSync(join(out,'manifest.json')))};
  await verifyArchiveRuntimePackage(out,input,pins);return pins;
}

/** Independent approval pins are supplied by the caller, never recomputed as approval. */
export async function verifyArchiveRuntimePackage(out:string,input:RuntimePackageIdentity,pins:RuntimePackagePins):Promise<RuntimePackagePins>{
  identity(input);if(!exact(pins,['reviewedCommit','manifestSha256'])||pins.reviewedCommit!==input.reviewedCommit||!/^[a-f0-9]{64}$/.test(pins.manifestSha256))fail('runtime-package-pin-invalid');
  ordinary(out,'directory');if(readdirSync(out).sort().join('|')!==[...FILES,'manifest.json'].sort().join('|'))fail('runtime-package-inventory-invalid');
  for(const f of [...FILES,'manifest.json'])ordinary(join(out,f),'file');
  const raw=readFileSync(join(out,'manifest.json'));if(sha(raw)!==pins.manifestSha256)fail('runtime-package-pin-mismatch');
  const m=JSON.parse(raw.toString('utf8'));
  if(!exact(m,['schema',...Object.keys(normalizedIdentity(input)),'lockfileSha256','runtimeConfigSha256','toolchain','inputInventory','files'])||
    m.schema!=='kl-runtime-package/v1'||Object.entries(normalizedIdentity(input)).some(([k,v])=>m[k]!==v)||
    !/^[a-f0-9]{64}$/.test(String(m.lockfileSha256))||!/^[a-f0-9]{64}$/.test(String(m.runtimeConfigSha256))||JSON.stringify(m.toolchain)!==JSON.stringify(PINS)||
    !exact(m.files,[...FILES])||!m.inputInventory||typeof m.inputInventory!=='object'||!Object.keys(m.inputInventory).length)fail('runtime-package-manifest-invalid');
  for(const f of FILES)if(sha(readFileSync(join(out,f)))!==(m.files as Record<string,string>)[f])fail('runtime-package-file-changed');
  let approved:RuntimeConfig|undefined;
  for(const mode of ['active','closed'] as const){
    const config=JSON.parse(readFileSync(join(out,`wrangler.${mode}.jsonc`),'utf8')),runtime=readRuntimeConfig(config.vars);
    await approvedConfig(runtime,input);
    if(JSON.stringify(config)!==JSON.stringify(makeRuntimeConfig(input,runtime,mode)))fail('runtime-package-config-drift');
    if(approved&&JSON.stringify(approved)!==JSON.stringify(runtime))fail('runtime-package-policy-drift');approved=runtime;
  }
  return pins;
}

export function runtimePackageArguments(args:string[]):RuntimePackageInput{
  const required=['commit','account','worker','bucket','environment','runtime-config','out'],keys=[...required,'purpose','decoy-bucket','rehearsal-inventory','rehearsal-inventory-sha256'],v:Record<string,string>={};
  for(let i=0;i<args.length;i+=2){const name=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--')||!name||!keys.includes(name)||name in v||!value||value.startsWith('--'))fail('runtime-package-arguments-invalid');v[name]=value;}
  if(required.some(k=>!v[k]))fail('runtime-package-arguments-invalid');
  const input={reviewedCommit:v.commit!,accountId:v.account!,workerName:v.worker!,bucketName:v.bucket!,environment:v.environment as 'staging'|'production',runtimeConfigPath:v['runtime-config']!,out:v.out!,
    purpose:(v.purpose??'runtime') as RuntimePackageIdentity['purpose'],...(v['decoy-bucket']?{decoyBucketName:v['decoy-bucket']}:{}),
    ...(v['rehearsal-inventory']?{rehearsalInventoryPath:v['rehearsal-inventory']}:{}),...(v['rehearsal-inventory-sha256']?{rehearsalInventorySha256:v['rehearsal-inventory-sha256']}:{})};identity(input);return input;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await packageArchiveRuntime(runtimePackageArguments(process.argv.slice(2)))));}
  catch(error){console.error(error instanceof Error&&/^runtime-[a-z-]+$/.test(error.message)?error.message:'runtime-package-failed');process.exitCode=1;}
}
