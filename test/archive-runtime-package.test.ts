import { expect,it } from 'vitest';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,linkSync,cpSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrapGit } from '../scripts/cloud-bootstrap.ts';
import { packageArchiveRuntime,verifyArchiveRuntimePackage,runtimePackageArguments } from '../scripts/archive-runtime-package.ts';
import { enrollmentFixture } from './helpers/enrollment.ts';
const rehearsalInventory=(f:Awaited<ReturnType<typeof enrollmentFixture>>)=>({
  schema:'kl-rehearsal-inventory/v1',phase:'discard',libraryId:f.claims.audience.libraryId,principal:f.claims.principal,collectionId:f.claims.folder.collectionId,folderId:f.claims.folder.folderId,
  noteId:'synthetic-note',version:1,tokens:f.tokens.map(t=>({kind:t.kind,hash:t.hash})),pin:{snapshotHash:'a'.repeat(64),eventSeq:10,eventHash:'b'.repeat(64),authzSeq:1}
});

const names=['wrangler','esbuild','miniflare','@cloudflare/workers-types'];
async function fixture(){
  const parent=mkdtempSync(join(tmpdir(),'kl-runtime-package-')),repo=join(parent,'repo');mkdirSync(repo);
  const f=await enrollmentFixture(),env={schema:'kl-owner-runtime/v1',audience:{...f.claims.audience,origin:'https://kl-runtime-synthetic.synthetic.workers.dev'},
    approval:{keyId:f.approvalKey.keyId,publicKeyB64:f.approvalKey.publicKeyB64},policy:{keyId:f.policyKey.keyId,publicKeyB64:f.policyKey.publicKeyB64,minEpoch:1,policyHash:f.acceptance.policyHash},policyBundle:f.bundle,policyAcceptance:f.acceptance};
  const runtimeConfigPath=join(parent,'runtime.json');writeFileSync(runtimeConfigPath,JSON.stringify(env));
  mkdirSync(join(repo,'apps/api/src/cloudflare'),{recursive:true});writeFileSync(join(repo,'apps/api/src/cloudflare/archive-worker.ts'),"export class LibraryDO {}\nexport default {fetch(){return new Response('synthetic');}};\n");
  const packages:Record<string,unknown>={};for(const name of names){const pkg=JSON.parse(readFileSync(resolve('node_modules',name,'package.json'),'utf8'));
    mkdirSync(join(repo,'node_modules',name),{recursive:true});writeFileSync(join(repo,'node_modules',name,'package.json'),JSON.stringify({version:pkg.version}));
    packages['node_modules/'+name]={version:pkg.version,integrity:'sha512-c3ludGhldGlj'};}
  writeFileSync(join(repo,'.gitignore'),'node_modules/\n');writeFileSync(join(repo,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
  bootstrapGit(['init','--quiet','--initial-branch=main'],repo);bootstrapGit(['config','user.name','Synthetic Reviewer'],repo);bootstrapGit(['config','user.email','reviewer@example.invalid'],repo);
  bootstrapGit(['add','.'],repo);bootstrapGit(['commit','--quiet','-m','synthetic reviewed source'],repo);
  const reviewedCommit=bootstrapGit(['rev-parse','HEAD'],repo);bootstrapGit(['update-ref','refs/remotes/origin/main',reviewedCommit],repo);
  const input={reviewedCommit,accountId:'a'.repeat(32),workerName:'kl-runtime-synthetic',bucketName:'kl-runtime-synthetic',environment:'staging' as const,runtimeConfigPath,out:join(parent,'package')};
  return {parent,repo,f,input,cleanup(){f.db.close();const rel=relative(tmpdir(),resolve(parent));if(!rel.startsWith('kl-runtime-package-')||isAbsolute(rel))throw Error('unsafe-fixture-cleanup');rmSync(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}

it('packages reviewed main once into one bundle and compatible active/closed configs, then verifies independent pins',async()=>{
  const x=await fixture();try{
    const pins=await packageArchiveRuntime(x.input,x.repo);expect(await verifyArchiveRuntimePackage(x.input.out,x.input,pins)).toEqual(pins);
    const active=JSON.parse(readFileSync(join(x.input.out,'wrangler.active.jsonc'),'utf8')),closed=JSON.parse(readFileSync(join(x.input.out,'wrangler.closed.jsonc'),'utf8'));
    expect(active.main).toBe('worker.mjs');expect(closed.main).toBe(active.main);expect(closed.durable_objects).toEqual(active.durable_objects);expect(closed.migrations).toEqual(active.migrations);
    expect(active.vars.RUNTIME_MODE).toBe('active');expect(closed.vars.RUNTIME_MODE).toBe('closed');
    const manifest=JSON.parse(readFileSync(join(x.input.out,'manifest.json'),'utf8'));
    expect(manifest.files['worker.mjs']).toBe(createHash('sha256').update(readFileSync(join(x.input.out,'worker.mjs'))).digest('hex'));
    expect(Object.keys(manifest.inputInventory)).toEqual(['apps/api/src/cloudflare/archive-worker.ts']);
    await expect(packageArchiveRuntime(x.input,x.repo)).rejects.toThrow('runtime-package-output-exists');
    await expect(verifyArchiveRuntimePackage(x.input.out,x.input,{...pins,manifestSha256:'f'.repeat(64)})).rejects.toThrow('runtime-package-pin-mismatch');
    writeFileSync(join(x.input.out,'worker.mjs'),'tampered');await expect(verifyArchiveRuntimePackage(x.input.out,x.input,pins)).rejects.toThrow('runtime-package-file-changed');
  }finally{x.cleanup();}
});
it('refuses dirty, non-main, in-repo and linked inputs before any output publication',async()=>{
  const x=await fixture();try{
    writeFileSync(join(x.repo,'unreviewed.txt'),'synthetic');await expect(packageArchiveRuntime(x.input,x.repo)).rejects.toThrow('runtime-package-source-dirty');rmSync(join(x.repo,'unreviewed.txt'));
    await expect(packageArchiveRuntime({...x.input,reviewedCommit:'f'.repeat(40)},x.repo)).rejects.toThrow('runtime-package-main-mismatch');
    await expect(packageArchiveRuntime({...x.input,out:join(x.repo,'package')},x.repo)).rejects.toThrow('runtime-package-owner-state-inside-repo');
    linkSync(x.input.runtimeConfigPath,join(x.parent,'linked.json'));await expect(packageArchiveRuntime(x.input,x.repo)).rejects.toThrow('runtime-package-path-invalid');
    expect(existsSync(x.input.out)).toBe(false);
  }finally{x.cleanup();}
});
it('refuses unknown or deploy-like arguments and requires exact explicit package identity',()=>{
  expect(()=>runtimePackageArguments(['--deploy','yes'])).toThrow('runtime-package-arguments-invalid');
  expect(()=>runtimePackageArguments([])).toThrow('runtime-package-arguments-invalid');
});

it('rehearses the actual complete Worker bundle and regenerated contracts from a clean committed source copy',async()=>{
  const x=await fixture();try{
    for(const folder of ['apps/api/src','packages/core','packages/contracts','schemas','vendor'])cpSync(resolve(folder),join(x.repo,folder),{recursive:true});
    for(const file of ['package.json','package-lock.json','tsconfig.json','.gitignore','scripts/build-spec.ts','scripts/build-contracts.ts','docs/DESIGN.md']){
      mkdirSync(join(x.repo,file,'..'),{recursive:true});cpSync(resolve(file),join(x.repo,file));
    }
    for(const name of ['ajv','ajv-formats','fast-deep-equal','fast-uri','json-schema-traverse','require-from-string','esbuild',`@esbuild/${process.platform}-${process.arch}`]){
      cpSync(resolve('node_modules',name),join(x.repo,'node_modules',name),{recursive:true});
    }
    mkdirSync(join(x.repo,'node_modules/@kl'),{recursive:true});
    for(const name of ['core','contracts'])symlinkSync(join(x.repo,'packages',name),join(x.repo,'node_modules/@kl',name),'junction');
    bootstrapGit(['add','.'],x.repo);bootstrapGit(['commit','--quiet','-m','synthetic full runtime rehearsal'],x.repo);
    x.input.reviewedCommit=bootstrapGit(['rev-parse','HEAD'],x.repo);bootstrapGit(['update-ref','refs/remotes/origin/main',x.input.reviewedCommit],x.repo);
    writeFileSync(join(x.repo,'packages/core/src/evidence/design-spec.generated.ts'),'invalid stale generated output');
    const pins=await packageArchiveRuntime(x.input,x.repo);
    expect(await verifyArchiveRuntimePackage(x.input.out,x.input,pins)).toEqual(pins);
    const m=JSON.parse(readFileSync(join(x.input.out,'manifest.json'),'utf8'));
    expect(m.inputInventory['packages/core/src/evidence/design-spec.generated.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(m.inputInventory['packages/contracts/src/validators.generated.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(m.inputInventory['scripts/build-spec.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(m.inputInventory['scripts/build-contracts.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(x.input.out,'worker.mjs'),'utf8')).toContain('archive-runtime');
    expect(Object.keys(m.inputInventory).some(path=>path.includes('synthetic-probe'))).toBe(false);
    const probe={...x.input,out:join(x.parent,'scope-probe'),purpose:'scope-probe' as const,decoyBucketName:'kl-scope-decoy-staging'};
    const probePins=await packageArchiveRuntime(probe,x.repo);
    expect(await verifyArchiveRuntimePackage(probe.out,probe,probePins)).toEqual(probePins);
    const probeManifest=JSON.parse(readFileSync(join(probe.out,'manifest.json'),'utf8'));
    expect(probeManifest.inputInventory['apps/api/src/cloudflare/synthetic-probe-worker.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(m.inputInventory).some(path=>path.includes('recovery-rehearsal'))).toBe(false);
    const runtime=JSON.parse(readFileSync(x.input.runtimeConfigPath,'utf8'));runtime.audience.origin='https://kl-api-staging.synthetic.workers.dev';writeFileSync(x.input.runtimeConfigPath,JSON.stringify(runtime));
    const rehearsalInventoryPath=join(x.parent,'rehearsal.json');writeFileSync(rehearsalInventoryPath,JSON.stringify(rehearsalInventory(x.f)));
    const rehearsal={...x.input,workerName:'kl-api-staging',bucketName:'kl-archive-staging',out:join(x.parent,'rehearsal'),purpose:'recovery-rehearsal' as const,rehearsalInventoryPath,rehearsalInventorySha256:createHash('sha256').update(readFileSync(rehearsalInventoryPath)).digest('hex')};
    const rehearsalPins=await packageArchiveRuntime(rehearsal,x.repo);expect(await verifyArchiveRuntimePackage(rehearsal.out,rehearsal,rehearsalPins)).toEqual(rehearsalPins);
    const rehearsalManifest=JSON.parse(readFileSync(join(rehearsal.out,'manifest.json'),'utf8'));
    expect(rehearsalManifest.inputInventory['apps/api/src/cloudflare/recovery-rehearsal-worker.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(rehearsalManifest.inputInventory).some(path=>path.includes('synthetic-probe')||path.endsWith('/archive-worker.ts'))).toBe(false);
    const configuration=JSON.parse(readFileSync(join(rehearsal.out,'wrangler.active.jsonc'),'utf8'));
    expect(configuration.vars.RUNTIME_MODE).toBe('closed');expect(configuration.r2_buckets).toEqual([{binding:'ARCHIVE',bucket_name:'kl-archive-staging'}]);
    expect(Object.keys(configuration.vars).some(k=>k.includes('REHEARSAL'))).toBe(false);
  }finally{x.cleanup();}
},90_000);

it('binds the temporary scope probe to staging and its dedicated decoy, preventing runtime substitution',async()=>{
  const x=await fixture();try{
    writeFileSync(join(x.repo,'apps/api/src/cloudflare/synthetic-probe-worker.ts'),"export class LibraryDO {}\nexport default {fetch(){return new Response('synthetic scope probe');}};\n");
    bootstrapGit(['add','.'],x.repo);bootstrapGit(['commit','--quiet','-m','synthetic probe source'],x.repo);
    x.input.reviewedCommit=bootstrapGit(['rev-parse','HEAD'],x.repo);bootstrapGit(['update-ref','refs/remotes/origin/main',x.input.reviewedCommit],x.repo);
    const probe={...x.input,purpose:'scope-probe' as const,decoyBucketName:'kl-scope-decoy-staging'};
    await expect(packageArchiveRuntime({...probe,environment:'production'},x.repo)).rejects.toThrow('runtime-package-identity-invalid');
    await expect(packageArchiveRuntime({...probe,decoyBucketName:'some-production-bucket'},x.repo)).rejects.toThrow('runtime-package-identity-invalid');
    const pins=await packageArchiveRuntime(probe,x.repo);
    await expect(verifyArchiveRuntimePackage(x.input.out,x.input,pins)).rejects.toThrow('runtime-package-manifest-invalid');
    expect(await verifyArchiveRuntimePackage(x.input.out,probe,pins)).toEqual(pins);
    const active=JSON.parse(readFileSync(join(x.input.out,'wrangler.active.jsonc'),'utf8'));
    expect(active.vars.RUNTIME_MODE).toBe('closed');expect(active.r2_buckets).toEqual([{binding:'ARCHIVE',bucket_name:x.input.bucketName},{binding:'DECOY',bucket_name:'kl-scope-decoy-staging'}]);
  }finally{x.cleanup();}
});

it('binds destructive rehearsal to the exact staging resources and external inventory, with no runtime substitution',async()=>{
  const x=await fixture();try{
    const file=join(x.repo,'apps/api/src/cloudflare/recovery-rehearsal-worker.ts');writeFileSync(file,"declare const __KL_REHEARSAL_INVENTORY__:string; export class LibraryDO {} export default {fetch(){return new Response(__KL_REHEARSAL_INVENTORY__);}};");
    bootstrapGit(['add','.'],x.repo);bootstrapGit(['commit','--quiet','-m','synthetic rehearsal source'],x.repo);x.input.reviewedCommit=bootstrapGit(['rev-parse','HEAD'],x.repo);bootstrapGit(['update-ref','refs/remotes/origin/main',x.input.reviewedCommit],x.repo);
    const runtime=JSON.parse(readFileSync(x.input.runtimeConfigPath,'utf8'));runtime.audience.origin='https://kl-api-staging.synthetic.workers.dev';writeFileSync(x.input.runtimeConfigPath,JSON.stringify(runtime));
    const rehearsalInventoryPath=join(x.parent,'rehearsal.json');writeFileSync(rehearsalInventoryPath,JSON.stringify(rehearsalInventory(x.f)));
    const input={...x.input,purpose:'recovery-rehearsal' as const,workerName:'kl-api-staging',bucketName:'kl-archive-staging',rehearsalInventoryPath,rehearsalInventorySha256:createHash('sha256').update(readFileSync(rehearsalInventoryPath)).digest('hex')};
    for(const change of [{environment:'production' as const},{workerName:'kl-api-prod'},{bucketName:'kl-archive-prod'},{decoyBucketName:'kl-scope-decoy-staging'},{rehearsalInventorySha256:undefined}])await expect(packageArchiveRuntime({...input,...change},x.repo)).rejects.toThrow('runtime-package-identity-invalid');
    await expect(packageArchiveRuntime({...input,rehearsalInventorySha256:'f'.repeat(64)},x.repo)).rejects.toThrow('runtime-rehearsal-input-invalid');
    const pins=await packageArchiveRuntime(input,x.repo);expect(await verifyArchiveRuntimePackage(input.out,input,pins)).toEqual(pins);
    await expect(verifyArchiveRuntimePackage(input.out,{...input,purpose:'runtime',rehearsalInventorySha256:undefined},pins)).rejects.toThrow('runtime-package-manifest-invalid');
    await expect(verifyArchiveRuntimePackage(input.out,{...input,rehearsalInventorySha256:'f'.repeat(64)},pins)).rejects.toThrow('runtime-package-manifest-invalid');
    writeFileSync(join(x.repo,'apps/api/src/cloudflare/archive-worker.ts'),"import './recovery-rehearsal-worker.ts';export default {};");
    bootstrapGit(['add','.'],x.repo);bootstrapGit(['commit','--quiet','-m','synthetic accidental runtime import'],x.repo);x.input.reviewedCommit=bootstrapGit(['rev-parse','HEAD'],x.repo);bootstrapGit(['update-ref','refs/remotes/origin/main',x.input.reviewedCommit],x.repo);
    await expect(packageArchiveRuntime({...x.input,workerName:'kl-api-staging',out:join(x.parent,'contaminated')},x.repo)).rejects.toThrow('runtime-package-rehearsal-in-runtime');
  }finally{x.cleanup();}
});

it('refuses incompatible rollback configuration even when a caller supplies its changed manifest digest',async()=>{
  const x=await fixture();try{
    await packageArchiveRuntime(x.input,x.repo);
    const file=join(x.input.out,'wrangler.closed.jsonc'),config=JSON.parse(readFileSync(file,'utf8'));
    config.durable_objects.bindings[0].class_name='DifferentDO';writeFileSync(file,JSON.stringify(config));
    const manifestFile=join(x.input.out,'manifest.json'),manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
    manifest.files['wrangler.closed.jsonc']=createHash('sha256').update(readFileSync(file)).digest('hex');writeFileSync(manifestFile,JSON.stringify(manifest));
    const pins={reviewedCommit:x.input.reviewedCommit,manifestSha256:createHash('sha256').update(readFileSync(manifestFile)).digest('hex')};
    await expect(verifyArchiveRuntimePackage(x.input.out,x.input,pins)).rejects.toThrow('runtime-package-config-drift');
  }finally{x.cleanup();}
});
