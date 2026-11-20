// kl-auth, S1 scope: bearer-token introspection and self-revocation. OAuth (workers-oauth-provider),
// Cloudflare Access, consent, PKCE and the passkey approval page /approve are later sessions (DESIGN §9.2–9.3).
import { Catalog, authenticate, mintToken, tokenExpiry, tokenScopes, clientClassFor, mintId, type RandomBytes, type TokenKind } from "@kl/core";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function createAuthHandler(deps: { catalog: Catalog; random?: RandomBytes }): (req: Request) => Promise<Response> {
  const { catalog } = deps;
  const random = deps.random ?? ((n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; });
  return async (req) => {
    const url = new URL(req.url);
    const requestId = mintId(random);
    if (url.pathname.startsWith("/approve")) return json(501, { error: "not-in-s1", detail: "the passkey approval page is a later session; no consequential action can be approved yet", requestId });
    if (url.pathname === "/oauth/authorize" || url.pathname === "/oauth/token") return json(501, { error: "not-in-s1", detail: "OAuth is a later session; S1 uses klb_ bearer tokens", requestId });
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    const auth = m ? authenticate(catalog.db, m[1]!, catalog.clock.now()) : ({ ok: false, reason: "format" } as const);
    if (url.pathname === "/v1/whoami" && req.method === "GET") {
      if (!auth.ok) return json(401, { error: "unauthorized", reason: auth.reason, requestId });
      return json(200, { principal: auth.principal, clientClass: auth.clientClass, scopes: auth.scopes, tokenKind: auth.tokenKind, ...(auth.collectionIds === undefined ? {} : { collectionIds: auth.collectionIds }), requestId });
    }
    if (url.pathname === "/v1/tokens/revoke" && req.method === "POST") {
      // A principal may revoke its own presented token (narrowing). Rotation of other tokens is receipt-gated.
      if (!auth.ok) return json(401, { error: "unauthorized", reason: auth.reason, requestId });
      const r = catalog.apply({ principal: auth.principal, clientClass: auth.clientClass }, { kind: "system" }, { kind: "token.revoke", tokenHash: auth.tokenHash, reason: "owner" });
      // Acknowledged only after the authz checkpoint is written; a checkpoint failure is a server error, not a success.
      try { await catalog.acknowledge((r.result as { authzSeq: number }).authzSeq); } catch (e) { return json(503, { error: "checkpoint-unavailable", detail: (e as Error).message, requestId }); }
      return json(200, { revoked: true, requestId });
    }
    if (url.pathname === "/v1/tokens/issue" && req.method === "POST") {
      // Only in setup mode, with the bootstrap secret (constant-time compared in apply()). Setup seals itself after the
      // first owner (kl-device) token. After that, token issue needs an owner receipt, which S1 cannot produce.
      const body = (await req.json().catch(() => ({}))) as { principal?: string; kind?: TokenKind; scopes?: string[] };
      if (!catalog.inSetupMode()) return json(403, { error: "receipt-required", detail: "token issue needs an owner approval receipt after setup", requestId });
      if (!body.principal || !body.kind) return json(400, { error: "invalid-args", requestId });
      const secret = req.headers.get("x-kl-bootstrap-secret") ?? "";
      const { token, hash } = mintToken(random);
      const kind = body.kind;
      try {
        catalog.apply({ principal: body.principal, clientClass: "kl-device" }, { kind: "setup", bootstrapSecret: secret }, { kind: "token.issue", tokenHash: hash, principal: body.principal, tokenKind: kind, scopes: tokenScopes(kind, body.scopes ?? []), clientClass: clientClassFor(kind), expiresAt: tokenExpiry(kind, catalog.clock.now()) });
      } catch (e) { return json(403, { error: (e as Error).message.split(":")[0], requestId }); }
      return json(200, { token, tokenHash: hash, kind, requestId }); // the only time the token is ever returned
    }
    return json(404, { error: "not-found" });
  };
}
