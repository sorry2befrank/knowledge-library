// S2e item A: Frank's simple local read path. Reads add no approval and change neither access nor client class;
// each command runs under exactly one token kind, and the device kind serves Frank's own terminal only (DESIGN §9.3, A37).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mintToken, seededRng } from "@kl/core";
import { startHarness, kl, type Harness } from "./helpers/s2e-harness.ts";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const MISSING = "kl:0000000000@1";

describe("device token: readable output for Frank only", () => {
  it("with only a device token, kl read --json and kl search --json exit non-zero with empty stdout, and --as device refuses a non-terminal stdout", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    for (const argv of [["read", "--as", "device", "--json", h.teamCite], ["search", "--as", "device", "--json", "rate", "card"], ["status", "--as", "device", "--json"]]) {
      const r = await kl(argv, env, { isTTY: true });
      expect(r.code).not.toBe(0); expect(r.out).toBe(""); expect(r.err).toMatch(/--json is not available with --as device/);
    }
    // no fallback from the device token to a vendor kind: --as cc with only a device token is "no cc token"
    for (const as of ["cc", "cx"]) {
      const r = await kl(["read", "--as", as, "--json", h.teamCite], env);
      expect(r.code).toBe(1); expect(r.out).toBe(""); expect(r.err).toMatch(new RegExp(`no ${as} token`));
    }
    // a pipe is not Frank's terminal
    const piped = await kl(["read", "--as", "device", h.teamCite], env, { isTTY: false });
    expect(piped.code).not.toBe(0); expect(piped.out).toBe(""); expect(piped.err).toMatch(/stdout is not one/);
    const unknownTty = await kl(["read", "--as", "device", h.teamCite], { ...env }, { isTTY: undefined as unknown as boolean });
    expect(unknownTty.code).not.toBe(0); expect(unknownTty.out).toBe("");
  });
  it("positive control: a readable kl read --as device on a terminal returns a team note, and kl search --as device lists it", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    const r = await kl(["read", "--as", "device", h.teamCite], env, { isTTY: true });
    expect(r.code).toBe(0); expect(r.err).toBe("");
    expect(r.out.startsWith(`${h.teamCite}  `)).toBe(true);
    expect(() => JSON.parse(r.out)).toThrow(); // readable, never a JSON document
    expect(r.out.length).toBeGreaterThan(h.teamCite.length + 20);
    const s = await kl(["search", "--as", "device", "rate", "card"], env, { isTTY: true });
    expect(s.code).toBe(0); expect(s.err).toBe(""); expect(s.out).toMatch(/\d+ of \d+ hit\(s\)\n$/); expect(s.out).toMatch(/kl:[A-Z0-9]{10}@\d+/);
    const st = await kl(["status", "--as", "device"], env, { isTTY: true });
    expect(st.code).toBe(0); expect(st.err).toBe(""); expect(st.out).toMatch(/^generation: \d+$/m);
  });
});

describe("vendor-class tokens: --json is exactly structuredContent", () => {
  it("with a cc token, kl read returns a note whose class allows claude-code, and the output is one JSON document equal to structuredContent", async () => {
    const env = { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url };
    const r = await kl(["read", "--as", "cc", "--json", h.teamCite], env);
    expect(r.code).toBe(0); expect(r.err).toBe("");
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect(doc.cite).toBe(h.teamCite); expect(typeof doc.text).toBe("string"); expect(doc.completeness).toBe("complete");
    expect(r.out.trim().split("\n").length).toBe(1); // one document, nothing else
    expect(Object.keys(doc).sort()).toEqual(["cite", "completeness", "focus", "freshness", "generation", "next", "nonce", "role", "sha256", "status", "supersededBy", "text", "title", "truncated"]);
    const s = await kl(["search", "--as", "cc", "--json", "rate", "card"], env);
    expect(s.code).toBe(0); const sd = JSON.parse(s.out); expect(sd.hits.length).toBeGreaterThan(0); expect(sd.jsonrpc).toBeUndefined(); expect(sd.result).toBeUndefined();
    const st = await kl(["status", "--as", "cx", "--json"], { KL_TOKEN_CX: h.tokens.cx, KL_API: h.url });
    expect(st.code).toBe(0); expect(JSON.parse(st.out).completeness).toBe("complete");
  });
  it("with a cc token, a client: note whose clients_ok lacks claude-code is refused exactly like a nonexistent cite (stdout, stderr and exit code byte-identical)", async () => {
    const env = { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url };
    const denied = await kl(["read", "--as", "cc", "--json", h.clientCite], env);
    const missing = await kl(["read", "--as", "cc", "--json", MISSING], env);
    expect(denied.code).not.toBe(0); expect(denied.out).toBe("");
    expect(denied).toEqual(missing);
    expect(denied.err).toMatch(/not-found/);
    // the same through the codex kind
    const cx = { KL_TOKEN_CX: h.tokens.cx, KL_API: h.url };
    expect(await kl(["read", "--as", "cx", "--json", h.clientCite], cx)).toEqual(await kl(["read", "--as", "cx", "--json", MISSING], cx));
    // positive control: the device kind, whose class is in clients_ok, reads the client note on a terminal
    const dev = await kl(["read", "--as", "device", h.clientCite], { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { isTTY: true });
    expect(dev.code).toBe(0); expect(dev.out).toContain("readable by the device only");
    // and the search side never lists it for cc
    const s = await kl(["search", "--as", "cc", "--json", "client", "q", "synthetic", "device"], env);
    expect(s.code).toBe(0); expect((JSON.parse(s.out).hits as { cite: string }[]).some((x) => x.cite === h.clientCite)).toBe(false);
  });
  it("a 401, a refused connection and a not-found each leave stdout empty, say why on stderr, and exit non-zero", async () => {
    const rng = seededRng("unknown-token"); const stranger = mintToken((n) => rng.bytes(n)).token; // well-formed, never issued
    const u = await kl(["search", "--as", "cc", "--json", "rate", "card"], { KL_TOKEN_CC: stranger, KL_API: h.url });
    expect(u.code).toBe(1); expect(u.out).toBe(""); expect(u.err).toMatch(/unauthorized/);
    const closed = await (await import("@kl/api")).serve(async () => new Response("x")); const deadUrl = `http://127.0.0.1:${closed.port}`; await closed.close();
    const c = await kl(["read", "--as", "cc", "--json", h.teamCite], { KL_TOKEN_CC: h.tokens.cc, KL_API: deadUrl });
    expect(c.code).toBe(1); expect(c.out).toBe(""); expect(c.err).toMatch(/cannot reach/);
    const n = await kl(["read", "--as", "cc", "--json", MISSING], { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url });
    expect(n.code).toBe(1); expect(n.out).toBe(""); expect(n.err).toMatch(/not-found/);
    // a read never changes access: the client note stays refused for cc after every call above
    const after = await kl(["read", "--as", "cc", "--json", h.clientCite], { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url });
    expect(after.code).toBe(1); expect(after.out).toBe("");
  });
});
