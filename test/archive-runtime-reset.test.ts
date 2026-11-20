import { expect,it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';

it('pinned workerd abort resets the object only after the KV hold persists and reopens with writes refused',async()=>{
  const built=await build({entryPoints:['test/helpers/runtime-safety-worker.ts'],bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',external:['cloudflare:workers']});
  const runtime=new Miniflare({name:'runtime-safety-probe',modules:true,script:built.outputFiles![0]!.text,compatibilityDate:'2026-07-30',durableObjects:{PROBE:{className:'SafetyProbe',useSQLite:true}}});
  try{
    expect(await (await runtime.dispatchFetch('https://safety.invalid/state')).json()).toMatchObject({held:false,wrote:false});
    const hung=await runtime.dispatchFetch('https://safety.invalid/hang');expect(hung.status).toBeGreaterThanOrEqual(500);expect(await hung.text()).toContain('archive-runtime-held');
    const state=await (await runtime.dispatchFetch('https://safety.invalid/state')).json();
    expect(state).toEqual({held:true,hold:{schema:'kl-runtime-hold/v1',reason:'deadline'},wrote:false});
    const denied=await runtime.dispatchFetch('https://safety.invalid/write');expect(denied.status).toBe(503);await denied.arrayBuffer();
    expect(await (await runtime.dispatchFetch('https://safety.invalid/state')).json()).toMatchObject({held:true,wrote:false});
  }finally{await runtime.dispose();}
},30_000);
