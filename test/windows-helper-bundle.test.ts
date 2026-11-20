import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { windowsHelperBundle } from "../scripts/hash-windows-helper.ts";

describe("Windows helper runtime bundle identity", () => {
  for (const suffix of [".exe", ".dll", ".deps.json", ".runtimeconfig.json"]) {
    it(`binds ${suffix} bytes even when other runtime files are unchanged`, () => {
      const dir = mkdtempSync(join(tmpdir(), "kl-bundle-"));
      try {
        for (const ext of [".exe", ".dll", ".deps.json", ".runtimeconfig.json"]) writeFileSync(join(dir, `kl-fs${ext}`), `synthetic ${ext}`);
        const executable = join(dir, "kl-fs.exe"), before = windowsHelperBundle(executable);
        expect(windowsHelperBundle(executable)).toEqual(before);
        writeFileSync(join(dir, `kl-fs${suffix}`), `changed ${suffix}`);
        expect(windowsHelperBundle(executable).sha256).not.toBe(before.sha256);
        unlinkSync(join(dir, `kl-fs${suffix}`));
        expect(() => windowsHelperBundle(executable)).toThrow();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
