import { describe, it, expect } from "vitest";
import { mintToken, parseToken, authenticate, seededRng, sha256Hex, RateLimiter, type Catalog } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, issueToken, FRANK } from "./helpers/load.ts";

const fx = generateFixtures();
const issue = (c: Catalog, principal: string, kind: "kl-device" | "cc-bearer", extra: string[] = []) => issueToken(c, principal, kind, extra);

describe("bearer tokens (S1 auth, DESIGN §9.3)", () => {
  it("klb_ format: prefix + 43 base64url + CRC32 suffix; the scanner regex matches it", () => {
    const rng = seededRng(1);
    const { token, hash } = mintToken((n) => rng.bytes(n));
    expect(token).toMatch(/^klb_[A-Za-z0-9_-]{49}$/);
    expect(/\bklb_[A-Za-z0-9_-]{43}/.test(token)).toBe(true);
    expect(hash).toBe(sha256Hex(token));
    expect(parseToken(token)).toEqual({ ok: true, hash });
    expect(parseToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toEqual({ ok: false, reason: "crc" });
    expect(parseToken("klb_short")).toEqual({ ok: false, reason: "format" });
  });
  it("authenticates, checks principal status on every request, expiry and revocation", () => {
    const { catalog, clock } = newCatalog(fx);
    const device = issue(catalog, "frank", "kl-device");
    const cc = issue(catalog, "partner", "cc-bearer", ["save"]);
    const a = authenticate(catalog.db, device, clock.now());
    expect(a).toMatchObject({ ok: true, principal: "frank", clientClass: "kl-device", scopes: ["ingest", "focus-exec", "pull", "request-approval"] });
    expect(authenticate(catalog.db, cc, clock.now())).toMatchObject({ ok: true, principal: "partner", scopes: ["read", "save"], tokenKind: "cc-bearer" });
    expect(authenticate(catalog.db, `klb_${"A".repeat(49)}`, clock.now())).toMatchObject({ ok: false });
    // revoke via the system path the guard uses
    catalog.apply(FRANK, { kind: "system" }, { kind: "token.revoke", tokenHash: sha256Hex(cc), reason: "guard-hit" });
    expect(authenticate(catalog.db, cc, clock.now())).toEqual({ ok: false, reason: "revoked" });
    // expiry
    expect(authenticate(catalog.db, device, "2027-06-01T00:00:00.000Z")).toEqual({ ok: false, reason: "expired" });
    // principal revoked: token row intact, request refused
    catalog.db.run("UPDATE principals SET status='revoked' WHERE id='frank'");
    expect(authenticate(catalog.db, device, clock.now())).toEqual({ ok: false, reason: "principal-revoked" });
  });
  it("a klb_ token pasted into a save is revoked automatically (A8)", async () => {
    const { catalog, clock } = newCatalog(fx);
    const cc = issue(catalog, "frank", "cc-bearer");
    expect(authenticate(catalog.db, cc, clock.now()).ok).toBe(true);
    const r = await catalog.save({ principal: "frank", clientClass: "claude-code" }, { content: `here is my token ${cc} oops` });
    expect(r).toMatchObject({ ok: false, status: "rejected" });
    expect(authenticate(catalog.db, cc, clock.now())).toEqual({ ok: false, reason: "revoked" });
  });
  it("rate limiter: 60 per minute per principal", () => {
    const rl = new RateLimiter(60);
    for (let i = 0; i < 60; i++) expect(rl.allow("frank", 0)).toBe(true);
    expect(rl.allow("frank", 1000)).toBe(false);
    expect(rl.allow("partner", 1000)).toBe(true);
    expect(rl.allow("frank", 61_000)).toBe(true);
  });
});
