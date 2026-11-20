// Generated binding names resolve to the pinned platform module without injecting
// all Workers globals into this mixed Node/Workers TypeScript project.
import type { R2Bucket as PlatformR2Bucket, DurableObjectNamespace as PlatformNamespace, WorkerVersionMetadata as PlatformVersionMetadata, Rpc } from '@cloudflare/workers-types/experimental/index.ts';
declare global {
  type R2Bucket=PlatformR2Bucket;
  type WorkerVersionMetadata=PlatformVersionMetadata;
  type DurableObjectNamespace<T extends Rpc.DurableObjectBranded|undefined=undefined>=PlatformNamespace<T>;
}
