import { hex } from "./sha256.ts";

export type RandomBytes = (n: number) => Uint8Array;

/** Opaque 128-bit ids rendered as 32 hex: operationId, requestId, queryId, caseId, candidateId... */
export function mintId(randomBytes: RandomBytes): string {
  return hex(randomBytes(16));
}
export const ID32 = /^[0-9a-f]{32}$/;
