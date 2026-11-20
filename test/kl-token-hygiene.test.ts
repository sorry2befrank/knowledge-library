// S2e item A: a token is printed by `kl token print` and by nothing else; the mcp-config snippet names the helper and carries no token.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mintToken, seededRng } from "@kl/core";
import { startHarness, kl, KL_PATH, type Harness } from "./helpers/s2e-harness.ts";

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const forms = (t: string) => [t, Buffer.from(t).toString("base64"), Buffer.from(t).toString("base64url"), t.slice(-12)];
const leaks = (text: string, t: string) => forms(t).filter((f) => text.includes(f));

describe("token hygiene", () => {
  it("every command, including mcp-config, keeps the configured tokens out of stdout and stderr; kl token print is the one positive control", async () => {
    const env = { KL_TOKEN_CC: h.tokens.cc, KL_TOKEN_CX: h.tokens.cx, KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    const runs: [string[], { isTTY?: boolean }][] = [
      [["version"], {}], [["search", "--as", "cc", "--json", "rate", "card"], {}], [["search", "--as", "cx", "--json", "rate", "card"], {}], [["search", "--as", "device", "rate", "card"], { isTTY: true }],
      [["read", "--as", "cc", "--json", h.teamCite], {}], [["read", "--as", "cx", "--json", h.teamCite], {}], [["read", "--as", "device", h.teamCite], { isTTY: true }], [["read", "--as", "cc", "--json", "kl:0000000000@1"], {}],
      [["status", "--as", "cc", "--json"], {}], [["status", "--as", "device"], { isTTY: true }], [["mcp-config", "claude"], {}], [["mcp-config", "codex"], {}], [["mcp-config", "codex", "--url", "https://kl.example.invalid"], {}],
      [["read", "--as", "device", "--json", h.teamCite], { isTTY: true }], [["read", "--as", "device", h.teamCite], { isTTY: false }], [["search", "--as", "cc", "--json", "rate", "card"], { isTTY: true }], [["nonsense"], {}],
      [["search", "--as", "cc", "--json", "rate", "card"], {}],
    ];
    for (const [argv, opts] of runs) {
      const r = await kl(argv, env, opts);
      for (const t of Object.values(h.tokens)) { expect(leaks(r.out, t), `${argv.join(" ")} stdout`).toEqual([]); expect(leaks(r.err, t), `${argv.join(" ")} stderr`).toEqual([]); }
    }
    // an unreachable server and a refused token (401) do not echo the token either
    const u = await kl(["search", "--as", "cc", "--json", "x"], { KL_TOKEN_CC: h.tokens.cc, KL_API: "http://127.0.0.1:1" });
    expect(u.code).toBe(1); for (const t of Object.values(h.tokens)) expect(leaks(u.out + u.err, t)).toEqual([]);
    const rng = seededRng("hygiene-stranger"); const stranger = mintToken((n) => rng.bytes(n)).token;
    const refused = await kl(["search", "--as", "cc", "--json", "x"], { KL_TOKEN_CC: stranger, KL_API: h.url });
    expect(refused.code).toBe(1); expect(refused.err).toMatch(/unauthorized/); expect(leaks(refused.out + refused.err, stranger)).toEqual([]);
    // positive control: the one printing path does contain the token
    const p = await kl(["token", "print", "cc", "--json"], env);
    expect(p.code).toBe(0); expect(p.out).toBe(`{"Authorization":"Bearer ${h.tokens.cc}"}\n`); expect(leaks(p.out, h.tokens.cc)).toContain(h.tokens.cc); expect(p.err).toBe("");
    const px = await kl(["token", "print", "cx", "--json"], env);
    expect(JSON.parse(px.out)).toEqual({ Authorization: `Bearer ${h.tokens.cx}` });
  });
  it("the mcp-config snippet parses, names the absolute kl token print cc|cx --json helper, takes the URL from KL_API or --url, and contains no token", async () => {
    const env = { KL_TOKEN_CC: h.tokens.cc, KL_TOKEN_CX: h.tokens.cx, KL_API: h.url };
    const c = await kl(["mcp-config", "claude"], env);
    expect(c.code).toBe(0); expect(c.err).toBe("");
    const doc = JSON.parse(c.out) as { mcpServers: Record<string, { type: string; url: string; headersHelper: string }> };
    const srv = doc.mcpServers["knowledge-library"]!;
    expect(srv.type).toBe("http"); expect(srv.url).toBe(`${h.url}/mcp`); expect(srv.headersHelper).toBe(`${KL_PATH} token print cc --json`); expect(KL_PATH.startsWith("/")).toBe(true);
    expect(c.out).not.toContain("klb_");
    const x = await kl(["mcp-config", "codex", "--url", "https://kl.example.invalid/"], env);
    expect(x.code).toBe(0); expect(x.err).toBe("");
    const lines = x.out.trim().split("\n");
    expect(lines[0]).toBe("[mcp_servers.knowledge-library]");
    const kv = Object.fromEntries(lines.slice(1).map((l) => { const m = /^(\w+) = "(.*)"$/.exec(l)!; return [m[1], m[2]]; }));
    expect(kv).toEqual({ url: "https://kl.example.invalid/mcp", http_headers_helper: `${KL_PATH} token print cx --json` });
    expect(x.out).not.toContain("klb_");
    // --url wins over KL_API; with neither, there is no hard-coded host
    const none = await kl(["mcp-config", "claude"], { KL_TOKEN_CC: h.tokens.cc });
    expect(none.code).toBe(2); expect(none.out).toBe(""); expect(none.err).toMatch(/no server URL/);
    const custom = await kl(["mcp-config", "claude", "--url", "https://custom.example.invalid"], env);
    expect((JSON.parse(custom.out) as typeof doc).mcpServers["knowledge-library"]!.url).toBe("https://custom.example.invalid/mcp");
    // the helper path is the running kl, never a relative or guessed path
    const rel = await kl(["mcp-config", "claude"], env, { klPath: "" });
    expect(rel.code).toBe(1); expect(rel.out).toBe("");
  });
});
