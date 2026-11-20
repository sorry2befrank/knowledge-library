// S2e item C, the Linux half: kl token store refuses outside Windows and creates no file; the Windows token-file refusal
// and the Linux KL_TOKEN_FILE fallback are the platform seam, injected through Io.platform.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken, seededRng } from "@kl/core";
import { main as klMain, type Io } from "@kl/cli";
import { HelperClient } from "../cli/kl/src/fs/windows-helper.ts";

const fake = () => { const rng = seededRng("token-store-linux"); return mintToken((n) => rng.bytes(n)).token; };
async function kl(argv: string[], env: Record<string, string | undefined>, opts: { platform?: string; stdin?: string } = {}) {
  let out = "", err = "";
  const io: Io = { stdout: (s) => (out += s), stderr: (s) => (err += s), env, fetch, platform: opts.platform ?? "linux", stdin: opts.stdin === undefined ? undefined : () => Promise.resolve(opts.stdin!) };
  return { code: await klMain(argv, io), out, err };
}

describe("kl token store on Linux", () => {
  it.each([
    ["null entries", { version: 1, entries: null }],
    ["array entries", { version: 1, entries: [] }],
    ["empty entry", { version: 1, entries: { cc: "" } }],
    ["null entry", { version: 1, entries: { cc: null } }],
    ["false entry", { version: 1, entries: { cc: false } }],
    ["zero entry", { version: 1, entries: { cc: 0 } }],
    ["object entry", { version: 1, entries: { cc: {} } }],
    ["invalid base64", { version: 1, entries: { cc: "!" } }],
    ["unknown kind", { version: 1, entries: { other: "AA==" } }],
    ["wrong version", { version: 2, entries: {} }],
  ])("Windows corrupt-store shape %s refuses before helper use and never falls back to a populated environment", async (_name, container) => {
    const tmp = mkdtempSync(join(tmpdir(), "kl-")), store = join(tmp, "tokens.dpapi");
    const request = vi.spyOn(HelperClient.prototype, "request").mockResolvedValue({ ok: false, code: "dpapi-unprotect-failed", effect: "none" });
    try {
      writeFileSync(store, JSON.stringify(container));
      let thrown: unknown;
      const result = await kl(["token", "print", "cc", "--json"], { KL_TOKEN_CC: fake(), KL_TOKEN_STORE: store }, { platform: "win32" }).catch(error => { thrown = error; return undefined; });
      expect(thrown, "invalid store shape must produce a refusal result").toBeUndefined();
      expect(result?.code).toBe(1);
      expect(result?.out).toBe("");
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); rmSync(tmp, { recursive: true, force: true }); }
  });
  it("a valid present store with no entry for the requested kind may use the environment", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kl-")), store = join(tmp, "tokens.dpapi"), token = fake();
    const request = vi.spyOn(HelperClient.prototype, "request").mockResolvedValue({ ok: false, code: "dpapi-unprotect-failed", effect: "none" });
    try {
      writeFileSync(store, JSON.stringify({ version: 1, entries: {} }));
      const result = await kl(["token", "print", "cc", "--json"], { KL_TOKEN_CC: token, KL_TOKEN_STORE: store }, { platform: "win32" });
      expect(result.code).toBe(0); expect(result.out).toBe(`{"Authorization":"Bearer ${token}"}\n`);
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); rmSync(tmp, { recursive: true, force: true }); }
  });
  it("exits non-zero, prints nothing on stdout and creates no file, even with a valid token on stdin", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kl-")), store = join(tmp, "kl", "tokens.dpapi");
    try {
      const r = await kl(["token", "store", "cc"], { KL_TOKEN_STORE: store }, { stdin: fake() + "\n" });
      expect(r.code).toBe(1); expect(r.out).toBe(""); expect(r.err).toMatch(/Windows only/);
      expect(existsSync(store)).toBe(false); expect(existsSync(join(tmp, "kl"))).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  it("Linux keeps KL_TOKEN_<KIND> and the KL_TOKEN_FILE fallback; the Windows seam refuses KL_TOKEN_FILE before reading it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kl-")), file = join(tmp, "tokens.json"), T = fake();
    try {
      writeFileSync(file, JSON.stringify({ cx: T }));
      const linux = await kl(["token", "print", "cx", "--json"], { KL_TOKEN_FILE: file });
      expect(linux.code).toBe(0); expect(linux.out).toBe(`{"Authorization":"Bearer ${T}"}\n`);
      const env = await kl(["token", "print", "cc", "--json"], { KL_TOKEN_CC: T });
      expect(env.code).toBe(0); expect(env.out).toBe(`{"Authorization":"Bearer ${T}"}\n`);
      // the Windows seam, modelled: KL_TOKEN_FILE is refused before any store or helper is touched (no helper exists here)
      const win = await kl(["token", "print", "cx", "--json"], { KL_TOKEN_FILE: file, KL_TOKEN_STORE: join(tmp, "none.dpapi") }, { platform: "win32" });
      expect(win.code).toBe(1); expect(win.out).toBe(""); expect(win.err).toMatch(/KL_TOKEN_FILE is refused on Windows/);
      // and with no store entry, the environment variable is used without touching the helper
      const winEnv = await kl(["token", "print", "cc", "--json"], { KL_TOKEN_CC: T, KL_TOKEN_STORE: join(tmp, "none.dpapi") }, { platform: "win32" });
      expect(winEnv.code).toBe(0); expect(winEnv.out).toBe(`{"Authorization":"Bearer ${T}"}\n`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
