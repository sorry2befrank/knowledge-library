// Map the workerd host module to the baseline-matched published host-class declaration.
// Keep Worker globals out of the Node test project; this is not a runtime shim.
declare module 'cloudflare:workers' {
  export const DurableObject: typeof import('@cloudflare/workers-types/experimental/index.ts').CloudflareWorkersModule.DurableObject;
}
