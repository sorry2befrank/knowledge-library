// Initial owner-provisioning artifact. Its zero-binding config reserves a Worker only.
// Archive enrollment and the catalog runtime require a separately reviewed release.
import { DurableObject } from 'cloudflare:workers';
import type { Request as WorkerRequest, Response as WorkerResponse } from '@cloudflare/workers-types/experimental/index.ts';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};
const HEALTH = JSON.stringify({ phase: 'bootstrap', ready: false, archiveAvailable: false });
const UNAVAILABLE = JSON.stringify({ error: 'archive-unavailable', phase: 'bootstrap', ready: false, archiveAvailable: false });

function unavailable(method: string): Response {
  return new Response(method === 'HEAD' ? null : UNAVAILABLE, { status: 503, headers: HEADERS });
}

// No DO migration is performed by the bootstrap config. If a later reviewed closed
// version binds this class, even direct calls refuse without touching storage.
export class LibraryDO extends DurableObject<CloudBootstrapEnv> {
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    return unavailable(request.method) as WorkerResponse;
  }
}

export default {
  fetch(request: Request): Response {
    // Public health reports only this artifact's phase, not account configuration,
    // token validity, data-store state, or downstream service availability.
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url.length <= 4096) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && url.search === '') {
        return new Response(request.method === 'HEAD' ? null : HEALTH, { status: 200, headers: HEADERS });
      }
    }
    // Do not inspect headers, bindings, or bodies, and do not log request data.
    return unavailable(request.method);
  },
};
