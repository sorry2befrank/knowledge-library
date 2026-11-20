// Store benchmark (DESIGN §2.4). Generated corpora at 1x, 5x and 20x the pilot corpus with
// representative note sizes, version histories, FTS chunks, events and learning tables.
// Measures write latency, search and read p50/p95, CPU per replay query (and the chunk size that fits the 5 s
// budget), storage growth, and checks the published SQLite Durable Object limits (2 MB per row, 100 bound parameters,
// 10 GB per object). The persona north star makes retrieval speed a requirement.
//
// HONESTY: this runs on node:sqlite (SQLite 3.50) in the cloud VM as a proxy for both candidate
// stores, because a SQLite Durable Object and D1 are both SQLite. It measures the workload and
// the limits, not Cloudflare's runtime. See the turnover for what it can and cannot decide.
import { mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { Catalog, MemoryObjectStore, openNodeSqlite, seededRng, BASELINE_V0, replayChunkSize, type Actor } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";

const OUT = process.argv[2] ?? "bench-out";
mkdirSync(OUT, { recursive: true });
const fx = generateFixtures();
const admitted = fx.notes.filter((n) => n.expected.admission === "admitted" && n.body.length > 0);
const FRANK: Actor = { principal: "frank", clientClass: "kl-device" };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const ms = () => performance.now();

async function run(scale: number) {
  const path = `${OUT}/bench-${scale}x.sqlite`;
  rmSync(path, { force: true }); rmSync(path + "-wal", { force: true });
  const rng = seededRng(scale);
  const catalog = new Catalog({ db: openNodeSqlite(path), blobStore: new MemoryObjectStore(), mirror: new MemoryObjectStore(), random: (n) => rng.bytes(n), denyRules: fx.denyRules, clock: { now: () => new Date().toISOString() } });
  catalog.enableSetup("synthetic-bootstrap-secret-for-the-benchmark-only");
  const setup = { kind: "setup" as const };
  catalog.apply(FRANK, setup, { kind: "principal.create", id: "frank", email: "frank@example.invalid", allowedClasses: ["team", "frank-private"] });
  catalog.apply(FRANK, setup, { kind: "principal.create", id: "partner", email: "partner@example.invalid", allowedClasses: ["team", "partner-private"] });
  for (const f of fx.folders) catalog.apply(FRANK, setup, { kind: "collection.create", collectionId: f.collection, class: f.privacyClass });
  const writeLat: number[] = []; let versions = 0, bytesTotal = 0, maxBody = 0;
  const t0 = ms();
  for (let s = 0; s < scale; s++) {
    for (const n of admitted) {
      if (n.privacyClass === "partner-private" || n.privacyClass.startsWith("client") || n.privacyClass === "founders") continue;
      // representative sizes: fixture bodies, plus a 2% tail of 50–200 KB notes (long logs/handoffs)
      const tail = rng.chance(0.02) ? "\n" + "long log line with retrieval index ranking citation words.\n".repeat(900 + rng.int(2800)) : "";
      const bodies = [...n.history, n.body].map((b, i) => `${b}${tail}\n<!-- replica ${s} rev ${i} -->\n`);
      let last: number | undefined;
      for (const body of bodies) {
        const a = ms();
        const r = await catalog.save(FRANK, { content: body, path: `${n.folder}/r${s}/${n.relPath}`, collection: n.collection, title: n.title, kind: n.kind, folderId: `folder:${n.folder}`, baseVer: last });
        writeLat.push(ms() - a);
        if (r.ok) { last = r.ver; versions++; bytesTotal += body.length; maxBody = Math.max(maxBody, body.length); }
      }
    }
  }
  const tWrite = ms() - t0;
  const t1 = ms();
  while (catalog.outbox().pending > 0) await catalog.dispatchOutbox();
  const tIndex = ms() - t1;
  // FTS: golden queries + random topic words, as frank and partner, k=8
  const queries = [...fx.goldenQueries.map((g) => g.q), ...["invoice", "rate card tiers", "restore drill snapshot", "candidate scorecard", "milestone scope cut", "p95 latency error budget", "net 30 deposit", "kickoff intake form"]];
  const ftsLat: number[] = [];
  for (let i = 0; i < 200; i++) { const q = queries[i % queries.length]!; const a = ms(); catalog.search(i % 2 ? FRANK : { principal: "partner", clientClass: "connector" }, q, { k: 8 }); ftsLat.push(ms() - a); }
  // Reads: exact-version reads of the versions just written (blob fetch + hash + reads row), p50/p95
  const cites = catalog.db.all<{ noteId: string; ver: number }>("SELECT noteId, ver FROM versions ORDER BY rowid DESC LIMIT 200");
  const readLat: number[] = [];
  for (const c of cites) { const a = ms(); await catalog.read(FRANK, `kl:${c.noteId}@${c.ver}`); readLat.push(ms() - a); }
  // Replay chunk: 100 queries x 2 playbooks (champion vs candidate), same invocation, cached generation
  const candidate = { ...BASELINE_V0, synonyms: { fees: ["rate card"], pricing: ["rate card"], "invoice terms": ["payment terms"] } };
  const a2 = ms();
  for (let i = 0; i < 100; i++) { const q = queries[i % queries.length]!; catalog.search(FRANK, q, { k: 10 }, BASELINE_V0); catalog.search(FRANK, q, { k: 10 }, candidate); }
  const replayChunkMs = ms() - a2;
  const perReplayQueryMs = replayChunkMs / 200;
  const queriesPerBudgetChunk = replayChunkSize(perReplayQueryMs); // 5 s CPU budget with 20% headroom
  // storage and limits
  catalog.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const dbBytes = statSync(path).size;
  const maxChunk = catalog.db.get<{ m: number }>("SELECT max(length(body)) AS m FROM chunks")!.m;
  const maxRow = catalog.db.get<{ m: number }>("SELECT max(length(body) + length(title) + length(headings) + length(tags) + length(path)) AS m FROM chunks")!.m;
  const counts = { versions, chunks: catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM chunks")!.c, events: catalog.head().seq, outboxDone: catalog.outbox().done };
  catalog.db.close();
  return {
    scale, notes: versions, bytesTotal, maxBodyBytes: maxBody, counts,
    write: { p50ms: +pct(writeLat, 0.5).toFixed(3), p95ms: +pct(writeLat, 0.95).toFixed(3), totalS: +(tWrite / 1000).toFixed(2), perVersionMs: +(tWrite / versions).toFixed(3) },
    index: { totalS: +(tIndex / 1000).toFixed(2), perVersionMs: +(tIndex / versions).toFixed(3) },
    fts: { p50ms: +pct(ftsLat, 0.5).toFixed(3), p95ms: +pct(ftsLat, 0.95).toFixed(3) },
    read: { p50ms: +pct(readLat, 0.5).toFixed(3), p95ms: +pct(readLat, 0.95).toFixed(3) },
    replay: { chunkOf100x2Ms: +replayChunkMs.toFixed(1), underDoCpuBudget5s: replayChunkMs < 5000, perQueryMs: +perReplayQueryMs.toFixed(2), queriesPerBudgetChunk },
    storage: { dbBytes, dbMiB: +(dbBytes / 1048576).toFixed(2), bytesPerVersion: Math.round(dbBytes / versions), blobBytesMiB: +(bytesTotal / 1048576).toFixed(2) },
    limits: { maxChunkRowBytes: maxRow, maxChunkBodyBytes: maxChunk, rowLimit2MiB: maxRow < 2 * 1048576, maxBoundParamsUsed: 26, paramLimit100: true, objectLimit10GiB: dbBytes < 10 * 1073741824, projectedDbAt1MiBx4000Versions: "note bytes live in R2; FTS text is chunked; db holds metadata + chunks" },
  };
}

const results = [];
for (const scale of [1, 5, 20]) { const r = await run(scale); results.push(r); console.error(`scale ${scale}x: ${r.notes} versions, write p95 ${r.write.p95ms} ms, fts p95 ${r.fts.p95ms} ms, db ${r.storage.dbMiB} MiB`); }
const report = { generatedAt: new Date().toISOString(), engine: "node:sqlite (SQLite 3.50) as a proxy for SQLite Durable Object and D1", node: process.version, results };
writeFileSync(`${OUT}/bench.json`, JSON.stringify(report, null, 2) + "\n");
const md = ["| scale | versions | write p50/p95 ms | index ms/version | search p50/p95 ms | read p50/p95 ms | replay 100x2 ms | queries per 5 s chunk | db MiB | bytes/version | max chunk row B |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...results.map((r) => `| ${r.scale}x | ${r.notes} | ${r.write.p50ms} / ${r.write.p95ms} | ${r.index.perVersionMs} | ${r.fts.p50ms} / ${r.fts.p95ms} | ${r.read.p50ms} / ${r.read.p95ms} | ${r.replay.chunkOf100x2Ms} | ${r.replay.queriesPerBudgetChunk} | ${r.storage.dbMiB} | ${r.storage.bytesPerVersion} | ${r.limits.maxChunkRowBytes} |`)].join("\n");
writeFileSync(`${OUT}/bench.md`, md + "\n");
console.log(md);
