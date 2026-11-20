// S2e item A: synthetic-harness latency of the kl read path. Run: node cli/kl/bench/latency.ts [runs]
// A loopback kl-api with the synthetic vault; kl search, kl read and kl version timed from process spawn to exit,
// and a direct in-process fetch of the same request. No target is set; the numbers describe this container only.
import { spawn } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createApiHandler, serve } from "@kl/api";
import { generateFixtures } from "../../../fixtures/gen.ts";
import { newCatalog, loadFixtures, issueToken } from "../../../test/helpers/load.ts";

const RUNS = Number(process.argv[2] ?? 100);
const WARMUPS = 5;
const KL = resolve("cli/kl/src/kl.ts");

const fx = generateFixtures();
const { catalog } = newCatalog(fx);
const report = await loadFixtures(catalog, fx);
const cc = issueToken(catalog, "frank", "cc-bearer");
const srv = await serve(createApiHandler({ catalog }));
const url = `http://127.0.0.1:${srv.port}`;
const env = { ...process.env, KL_TOKEN_CC: cc, KL_API: url, NODE_OPTIONS: "--no-warnings=ExperimentalWarning" };

// a fixed list: 18 queries from fixture titles/tags plus 2 with no hits; 19 real cites plus 1 not found
const admitted = [...report.admitted.values()];
const titles = fx.notes.filter((n) => report.admitted.has(n.noteId)).map((n) => n.title.split(/\s+/).slice(0, 2).join(" "));
const queries = [...titles.filter((t, i) => i % 7 === 0).slice(0, 18), "zzqx-no-such-term", "qqvv-also-nothing"];
const cites = [...admitted.filter((_, i) => i % 11 === 0).slice(0, 19).map((a) => a.cite), "kl:0000000000@1"];

let unexpectedExits = 0;
function run(args: string[], expectCode: number): Promise<number> {
  return new Promise((res, rej) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(process.execPath, [KL, ...args], { env, stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", rej);
    p.on("exit", (code) => { if (code !== expectCode) unexpectedExits++; res(Number(process.hrtime.bigint() - t0) / 1e6); });
  });
}
async function direct(name: string, args: Record<string, unknown>): Promise<number> {
  const t0 = process.hrtime.bigint();
  const r = await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${cc}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  await r.text();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
async function series(label: string, f: (i: number) => Promise<number>): Promise<string> {
  for (let i = 0; i < WARMUPS; i++) await f(i);
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) xs.push(await f(i));
  return `| ${label} | ${xs.length} | ${pct(xs, 50).toFixed(1)} | ${pct(xs, 95).toFixed(1)} | ${Math.max(...xs).toFixed(1)} |`;
}

const rows = [
  await series("kl version (process-start floor)", () => run(["version"], 0)),
  await series("kl search --as cc --json", (i) => run(["search", "--as", "cc", "--json", queries[i % queries.length]!], 0)),
  await series("kl read --as cc --json", (i) => run(["read", "--as", "cc", "--json", cites[i % cites.length]!], cites[i % cites.length] === "kl:0000000000@1" ? 1 : 0)),
  await series("in-process fetch library_search", (i) => direct("library_search", { q: queries[i % queries.length] })),
  await series("in-process fetch library_read", (i) => direct("library_read", { ref: cites[i % cites.length] })),
];
await srv.close();
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const container = (() => { try { return readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? "unknown"; } catch { return "unknown"; } })();
console.log(`synthetic-harness latency (ms), spawn to exit; ${WARMUPS} discarded warm-ups then N timed runs; notes loaded: ${report.admitted.size}; queries: ${queries.length} (2 with no hits); cites: ${cites.length} (1 not found)`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}; RAM ${(totalmem() / 2 ** 30).toFixed(1)} GiB; Node ${process.version}; container: ${container}; commit: ${commit}`);
console.log("| measure | N | p50 | p95 | max |\n|---|---|---|---|---|");
for (const r of rows) console.log(r);
console.log(`unexpected exit codes: ${unexpectedExits}`);
if (unexpectedExits) process.exit(1);
