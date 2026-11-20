// Explicitly opt-in owner enrollment. Never enabled by an incoming flag/header.
import { verifyEnrollment, EnrollmentRefused, ApplyRefused, RateLimiter, type Catalog, type EnrollmentTrust } from '@kl/core/worker';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: {'content-type':'application/json','cache-control':'no-store'} });

async function boundedInput(req: Request): Promise<unknown> {
  if (!req.body) throw new EnrollmentRefused('enrollment-invalid');
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined, size = 0;
  const chunks: Uint8Array[] = [];
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new EnrollmentRefused('enrollment-body-timeout')); void reader.cancel().catch(() => {});
  }, 10_000); });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 32_768) { void reader.cancel().catch(() => {}); throw new EnrollmentRefused('enrollment-too-large'); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const c of chunks) { bytes.set(c,offset); offset += c.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function createEnrollmentHandler(catalog: Catalog, trust: EnrollmentTrust): (request: Request) => Promise<Response> {
  // Snapshot configuration so a mutable input cannot redirect authority mid-verification.
  const configured = { ...trust, approval:{...trust.approval}, policy:{...trust.policy}, audience:{...trust.audience} };
  const limiter = new RateLimiter(10);
  return async req => {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/v1/enroll' || url.search || url.origin !== configured.audience.origin)
      return reply(404,{error:'not-found'});
    if (!limiter.allow('enrollment',Date.parse(configured.now()))) return reply(429,{error:'rate-limited'});
    try {
      const body = await boundedInput(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).sort().join('|') !== 'acceptance|approval') throw new EnrollmentRefused('enrollment-invalid');
      const input = body as {approval:unknown;acceptance:unknown};
      const grant = await verifyEnrollment(input.approval,input.acceptance,configured);
      const result = catalog.enroll(grant);
      const seq = result.result.authzSeq;
      if (typeof seq !== 'number') throw new ApplyRefused('enrollment-checkpoint-missing');
      await catalog.acknowledgeEnrollment(seq);
      return reply(200,{state:'active',enrollmentHash:grant.hash,receiptId:grant.claims.receiptId,authzSeq:seq});
    } catch (e) {
      if (e instanceof EnrollmentRefused) return reply(e.code === 'enrollment-too-large' ? 413 : 403,{error:e.code});
      if (e instanceof ApplyRefused) return reply(e.code === 'enrollment-checkpoint-pending' ? 503 : 409,{error:e.code});
      return reply(400,{error:'enrollment-invalid'});
    }
  };
}
