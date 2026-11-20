// Bind the managed implementation and launch configuration as well as the .NET apphost.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export function windowsHelperBundle(executable: string): { sha256: string; files: { name: string; bytes: number; sha256: string }[] } {
  if (!/\.exe$/i.test(executable)) throw new Error("Expected a Windows helper executable");
  const stem = basename(executable).slice(0, -4);
  const files = [".exe", ".dll", ".deps.json", ".runtimeconfig.json"].map((suffix) => {
    const name = stem + suffix;
    const bytes = readFileSync(join(dirname(executable), name));
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const manifest = JSON.stringify({ schema: "kl-fs-runtime-bundle/v1", files });
  return { sha256: createHash("sha256").update(manifest).digest("hex"), files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/hash-windows-helper.ts <kl-fs.exe>");
  console.log(windowsHelperBundle(process.argv[2]!).sha256);
}
