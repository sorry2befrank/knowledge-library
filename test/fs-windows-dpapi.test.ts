// S2e item C: DPAPI token storage (DESIGN §9.3) on Windows, at an injectable path under a fresh mkdtemp folder.
// The real %LOCALAPPDATA%\kl is never read or written. On any other platform the file is skipped (listed in the turnover).
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mintToken, seededRng } from "@kl/core";
import { main as klMain, type Io } from "@kl/cli";
import { nativeLabel, onWindows, newTemp, HELPER } from "./helpers/s2e-windows-harness.ts";

const L = nativeLabel();
const DPAPI_HEADER = "01000000d08c9ddf0115d1118c7a00c04fc297eb";
const fake = (seed: string) => { const rng = seededRng(seed); return mintToken((n) => rng.bytes(n)).token; };
/** An environment with every KL_TOKEN_* variable and KL_TOKEN_FILE unset. */
const cleanEnv = (store: string, extra: Record<string, string> = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^KL_TOKEN_/.test(k) && k !== "KL_TOKEN_FILE") env[k] = v;
  return { ...env, KL_TOKEN_STORE: store, KL_FS_HELPER: HELPER, ...extra };
};
async function kl(argv: string[], env: Record<string, string | undefined>, stdin?: string) {
  let out = "", err = "";
  const io: Io = { stdout: (s) => (out += s), stderr: (s) => (err += s), env, fetch, platform: "win32", stdin: stdin === undefined ? undefined : () => Promise.resolve(stdin) };
  return { code: await klMain(argv, io), out, err };
}
const forms = (t: string) => [t, Buffer.from(t).toString("base64"), Buffer.from(t).toString("base64url"), Buffer.from(t).toString("hex"), Buffer.from(t, "utf16le").toString("base64")];

describe.skipIf(!onWindows)("DPAPI token store", () => {
  test(`D01 kl token store writes a CurrentUser DPAPI blob at the injected path; kl token print cc --json prints exactly the header; the file holds no form of the token; the decoded blob starts with the DPAPI header${L}`, async () => {
    const tmp = newTemp(), store = join(tmp, "kl", "tokens.dpapi"), T = fake("dpapi-T");
    try {
      const s = await kl(["token", "store", "cc"], cleanEnv(store), T + "\n");
      assert.equal(s.code, 0, s.err); assert.equal(s.out, "");
      assert.equal(existsSync(store), true);
      const p = await kl(["token", "print", "cc", "--json"], cleanEnv(store));
      assert.equal(p.code, 0, p.err); assert.equal(p.out, `{"Authorization":"Bearer ${T}"}\n`); assert.equal(p.err, "");
      const raw = readFileSync(store, "utf8");
      for (const f of forms(T)) assert.equal(raw.includes(f), false, `the store contains a form of the token: ${f.slice(0, 8)}…`);
      const container = JSON.parse(raw) as { version: number; entries: Record<string, string> };
      assert.equal(container.version, 1);
      const blob = Buffer.from(container.entries.cc!, "base64");
      assert.equal(blob.subarray(0, 20).toString("hex"), DPAPI_HEADER);
      // a token that is not a kl token, or one passed any other way than stdin, is refused and nothing changes
      const bad = await kl(["token", "store", "cx"], cleanEnv(store), "not-a-token\n");
      assert.equal(bad.code, 1); assert.equal(bad.out, ""); assert.match(bad.err, /not a kl token/);
      const arg = await kl(["token", "store", "cx", T], cleanEnv(store), T);
      assert.equal(arg.code, 2); assert.equal(arg.out, "");
      assert.equal(JSON.stringify(JSON.parse(readFileSync(store, "utf8"))), JSON.stringify(container));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  test(`D02 after one byte of the blob is flipped, kl token print exits non-zero with empty stdout${L}`, async () => {
    const tmp = newTemp(), store = join(tmp, "tokens.dpapi"), T = fake("dpapi-flip");
    try {
      assert.equal((await kl(["token", "store", "device"], cleanEnv(store), T)).code, 0);
      const container = JSON.parse(readFileSync(store, "utf8")) as { version: number; entries: Record<string, string> };
      const blob = Buffer.from(container.entries.device!, "base64");
      blob[blob.length - 5] = blob[blob.length - 5]! ^ 0x55; // inside the ciphertext/MAC, not the header
      container.entries.device = blob.toString("base64");
      writeFileSync(store, JSON.stringify(container));
      const p = await kl(["token", "print", "device", "--json"], cleanEnv(store));
      assert.notEqual(p.code, 0); assert.equal(p.out, ""); assert.match(p.err, /cannot be decrypted/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  test(`D03 precedence: the stored token T wins over KL_TOKEN_CC=T2; without a stored entry the environment is used; KL_TOKEN_FILE is refused on Windows${L}`, async () => {
    const tmp = newTemp(), store = join(tmp, "tokens.dpapi"), T = fake("dpapi-T"), T2 = fake("dpapi-T2"), file = join(tmp, "tokens.json");
    try {
      assert.equal((await kl(["token", "store", "cc"], cleanEnv(store), T)).code, 0);
      const both = await kl(["token", "print", "cc", "--json"], cleanEnv(store, { KL_TOKEN_CC: T2 }));
      assert.equal(both.code, 0); assert.equal(both.out, `{"Authorization":"Bearer ${T}"}\n`);
      const envOnly = await kl(["token", "print", "cx", "--json"], cleanEnv(store, { KL_TOKEN_CX: T2 }));
      assert.equal(envOnly.code, 0); assert.equal(envOnly.out, `{"Authorization":"Bearer ${T2}"}\n`);
      writeFileSync(file, JSON.stringify({ cc: T2 }));
      const refusedFile = await kl(["token", "print", "cc", "--json"], cleanEnv(store, { KL_TOKEN_FILE: file }));
      assert.equal(refusedFile.code, 1); assert.equal(refusedFile.out, ""); assert.match(refusedFile.err, /KL_TOKEN_FILE is refused on Windows/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
