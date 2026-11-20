import { describe, it, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main, helperCommand, type Io } from "../cli/kl/src/kl.ts";

describe("MCP helper commands", () => {
  it("quotes a literal backslash in a POSIX filename", () => {
    expect(helperCommand([String.raw`/opt/kl\name/kl.ts`], "linux")).toBe(String.raw`'/opt/kl\name/kl.ts'`);
  });
  it("keeps spaced executable paths in one quoted argument", async () => {
    const executable = process.platform === "win32" ? "C:\\Program Files\\Library\\kl.exe" : "/opt/Library Tools/kl";
    let out = "";
    const io: Io = { stdout: s => { out += s; }, stderr: () => {}, env: {}, fetch, klPath: executable };
    expect(await main(["mcp-config", "claude", "--url", "https://example.invalid"], io)).toBe(0);
    const command = JSON.parse(out).mcpServers["knowledge-library"].headersHelper;
    const quoted = process.platform === "win32" ? `"${executable}"` : `'${executable}'`;
    expect(command).toBe(`${quoted} token print cc --json`);
  });

  it("runs each generated helper from a spaced source path without exposing a token in its config", () => {
    const root = mkdtempSync(fileURLToPath(new URL("../cli/kl/src/.kl-helper-command-", import.meta.url)));
    // The fresh source directory preserves workspace package resolution. Its relative
    // helper dependency is copied too; the explicit absent store never reaches a real profile.
    const script = join(root, "source with spaces kl.ts");
    const helperDirectory = join(root, "fs"), helper = join(helperDirectory, "windows-helper.ts");
    mkdirSync(helperDirectory);
    copyFileSync(new URL("../cli/kl/src/kl.ts", import.meta.url), script);
    copyFileSync(new URL("../cli/kl/src/fs/windows-helper.ts", import.meta.url), helper);
    const token = "synthetic-helper-token-value";
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, KL_TOKEN_STORE: join(root, "absent.dpapi"), KL_TOKEN_CC: token, KL_TOKEN_CX: token };
    try {
      for (const client of ["claude", "codex"]) {
        const config = spawnSync(process.execPath, [script, "mcp-config", client, "--url", "https://example.invalid"], { env, encoding: "utf8", timeout: 5000, windowsHide: true });
        expect(config.status, config.stderr).toBe(0);
        expect(config.stdout).not.toContain(token);
        const command: string = client === "claude" ? JSON.parse(config.stdout).mcpServers["knowledge-library"].headersHelper : JSON.parse(config.stdout.split("\n").find(line => line.startsWith("http_headers_helper = "))!.slice("http_headers_helper = ".length));
        const result = spawnSync(command, { shell: true, env, encoding: "utf8", timeout: 5000, windowsHide: true });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ Authorization: `Bearer ${token}` });
      }
    } finally {
      expect(resolve(script).startsWith(resolve(root) + (process.platform === "win32" ? "\\" : "/"))).toBe(true);
      expect(resolve(helper).startsWith(resolve(root) + (process.platform === "win32" ? "\\" : "/"))).toBe(true);
      unlinkSync(script);
      unlinkSync(helper);
      rmdirSync(helperDirectory);
      rmdirSync(root);
    }
  });

  it("refuses relative and control-bearing helper paths before producing a snippet", async () => {
    const paths = ["relative-kl", "/absolute\ncommand", ""];
    if (process.platform === "win32") paths.push("C:\\%UNTRUSTED%\\kl.exe", "C:\\!UNTRUSTED!\\kl.exe");
    for (const klPath of paths) {
      let out = "", err = "";
      const code = await main(["mcp-config", "claude", "--url", "https://example.invalid"], { stdout: s => { out += s; }, stderr: s => { err += s; }, env: {}, fetch, klPath });
      expect(code).toBe(1); expect(out).toBe(""); expect(err).toContain("cannot be quoted safely");
    }
  });
});
