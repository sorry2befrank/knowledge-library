// The Windows conformance gate (S2e item C). Usage: node test/fs-windows-gate.ts conformance.json test/fs-windows-manifest.json [helper-sha256]
// Fails unless: the platform was win32; every native test carried implementation windows-native and the helper hash;
// every manifest ID is established (its test ran and passed; zero pending, zero todo) or held with a reason (its test is
// absent or failed with held:<reason>); a difference declared in test/fs-windows-differences.json counts as differs, never as
// established; no other test was skipped. Prints the established, held and differs lists.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Assertion { fullName: string; status: string; failureMessages?: string[] }
interface Report { numPendingTests: number; numTodoTests: number; numFailedTests: number; testResults: { name: string; assertionResults: Assertion[] }[] }
interface Manifest { ids: Record<string, { property: string; status: "established" | "held" | "differs"; reason?: string }> }
type Differences = Record<string, { difference: string }>;

/** vitest prefixes the describe name; the id is the upper-case token with digits right before the test name, the tag is at the end. */
const TAG = /(?:^|\s)([A-Z]+\d+[A-Z]?) [^[\]]*\[(\w+):([\w-]+):([0-9a-f]{64}|missing)\]$/;

export function gate(report: Report, manifest: Manifest, differences: Differences, expectedHash?: string): { ok: boolean; established: string[]; held: Record<string, string>; differs: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const tagged = new Map<string, Assertion & { platform: string; impl: string; hash: string }>();
  let skipped = 0;
  for (const file of report.testResults) for (const a of file.assertionResults) {
    if (["skipped", "pending", "todo", "disabled"].includes(a.status)) skipped++;
    const m = TAG.exec(a.fullName.trim());
    if (!m) continue;
    const [, id, platform, impl, hash] = m as unknown as [string, string, string, string, string];
    if (tagged.has(id)) problems.push(`${id}: more than one native test carries this id`);
    tagged.set(id, { ...a, platform, impl, hash });
  }
  if (tagged.size === 0) problems.push("no native test ran (no tagged test in the report)");
  for (const [id, t] of tagged) {
    if (t.platform !== "win32") problems.push(`${id}: platform ${t.platform}, not win32`);
    if (t.impl !== "windows-native") problems.push(`${id}: implementation ${t.impl}, not windows-native`);
    if (t.hash === "missing") problems.push(`${id}: no helper executable was hashed`);
    if (expectedHash && t.hash !== expectedHash) problems.push(`${id}: helper hash ${t.hash} is not the built helper's ${expectedHash}`);
    if (!(id in manifest.ids)) problems.push(`${id}: not in the manifest`);
  }
  const established: string[] = [], held: Record<string, string> = {}, differs: Record<string, string> = {};
  for (const [id, entry] of Object.entries(manifest.ids)) {
    const t = tagged.get(id);
    const heldMessage = t?.failureMessages?.find((m) => /held:/.test(m))?.match(/held:([^\n]*)/)?.[1]?.trim();
    if (entry.status === "established") {
      if (!t) problems.push(`${id}: manifest says established but no test ran`);
      else if (t.status !== "passed") problems.push(`${id}: manifest says established but the test ${heldMessage ? `was held (${heldMessage})` : `did not pass (${t.status}: ${(t.failureMessages ?? []).join(" | ").slice(0, 300)})`}`);
      else if (id in differences) problems.push(`${id}: a declared difference cannot be established`);
      else established.push(id);
    } else if (entry.status === "held") {
      if (!entry.reason) problems.push(`${id}: held without a reason`);
      if (t && t.status === "passed") problems.push(`${id}: manifest says held but the test established it; update the manifest`);
      else if (t && t.status !== "passed" && !heldMessage) problems.push(`${id}: manifest says held but the test failed for another reason: ${(t.failureMessages ?? []).join(" | ").slice(0, 300)}`);
      else held[id] = entry.reason ?? heldMessage ?? "";
    } else if (entry.status === "differs") {
      if (!(id in differences)) problems.push(`${id}: manifest says differs but test/fs-windows-differences.json has no entry`);
      else if (!t) problems.push(`${id}: manifest says differs but no test ran`);
      else differs[id] = differences[id]!.difference;
    }
  }
  if (report.numPendingTests !== 0 || report.numTodoTests !== 0 || skipped !== 0) problems.push(`skipped/pending/todo tests in the run: ${report.numPendingTests}/${report.numTodoTests}/${skipped}`);
  return { ok: problems.length === 0, established, held, differs, problems };
}

const isMain = process.argv[1] && /fs-windows-gate\.ts$/.test(process.argv[1]);
if (isMain) {
  const [reportPath, manifestPath, expectedHash] = process.argv.slice(2);
  if (!reportPath || !manifestPath) { console.error("usage: node test/fs-windows-gate.ts <conformance.json> <manifest.json> [helper-sha256]"); process.exit(2); }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const differences = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fs-windows-differences.json"), "utf8")) as Differences;
  const r = gate(report, manifest, differences, expectedHash);
  console.log(`established (${r.established.length}): ${r.established.join(", ") || "none"}`);
  console.log(`held (${Object.keys(r.held).length}):`); for (const [id, why] of Object.entries(r.held)) console.log(`  ${id}: ${why}`);
  console.log(`differs (${Object.keys(r.differs).length}):`); for (const [id, why] of Object.entries(r.differs)) console.log(`  ${id}: ${why}`);
  if (!r.ok) { console.error("gate: FAILED"); for (const p of r.problems) console.error(`  ${p}`); process.exit(1); }
  console.log("gate: ok");
}
