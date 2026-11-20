import { describe, it, expect } from "vitest";
import { blobKey, type Catalog, type OutboxRow } from "@kl/core";
import { generateFixtures } from "../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK_CONNECTOR } from "./helpers/load.ts";

const fx = generateFixtures();

async function state(c: Catalog) {
  const chunks = c.db.all<{ noteId: string; ver: number; c: number }>("SELECT noteId, ver, count(*) AS c FROM chunks GROUP BY noteId, ver");
  const dup = c.db.get<{ c: number }>("SELECT count(*) AS c FROM (SELECT noteId, ver, n FROM chunks GROUP BY noteId, ver, n HAVING count(*) > 1)")!.c;
  const versions = c.db.get<{ c: number }>("SELECT count(*) AS c FROM versions")!.c;
  const indexed = c.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody = 'indexed'")!.c;
  const mirrors = (await c.mirror.list("m/")).length;
  const customs = c.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody = 'received'")!.c;
  return { chunkedVersions: chunks.length, dup, versions, indexed, received: customs, mirrors, outbox: c.outbox() };
}

describe("outbox crash matrix (A5 subset): crash after every external step, then converge", () => {
  it("refuses changed object bytes at indexing time and retries only after exact bytes return", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    const body = "# Verified archive\nThe cobalt observatory is ready.\n";
    const saved = await catalog.save(FRANK_CONNECTOR, { content: body });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("synthetic save failed");
    expect(saved.custody).toBe("verified");
    const key = blobKey(saved.sha256);
    await blobStore.put(key, new TextEncoder().encode("Injected violet corruption must never enter search."));
    const failed = await catalog.dispatchOutbox();
    expect(failed.retried).toBe(1);
    expect(catalog.db.get("SELECT custody FROM versions WHERE noteId = ? AND ver = ?", [saved.noteId, saved.ver]))
      .toMatchObject({ custody: "verified" });
    expect(catalog.db.get("SELECT count(*) AS c FROM chunks")!).toMatchObject({ c: 0 });
    expect(catalog.search(FRANK_CONNECTOR, "violet").hits).toEqual([]);
    expect(catalog.db.get("SELECT state, lastError FROM outbox WHERE step = 'index.version'"))
      .toMatchObject({ state: "pending", lastError: `corrupt-object: ${saved.sha256}` });
    await blobStore.put(key, new TextEncoder().encode(body));
    await catalog.dispatchOutbox({ ignoreBackoff: true });
    const hits = catalog.search(FRANK_CONNECTOR, "cobalt").hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ noteId: saved.noteId, ver: saved.ver });
    expect(await catalog.read(FRANK_CONNECTOR, hits[0]!.cite)).toMatchObject({ ok: true, text: body });
    expect(catalog.outbox().pending).toBe(0);
  });
  it("every crash point converges to the same end state with no duplicate logical versions or chunks", async () => {
    // Reference run with no crashes.
    // deferCustody: the inline post-commit check cannot run during the load, so custody.verify rows are PENDING in the matrix (S1c B4).
    const ref = newCatalog(fx);
    await loadFixtures(ref.catalog, fx, (n) => n.folder === "synth-desk" && n.kind === "decision", { dispatch: false, deferCustody: ref.blobStore });
    const pendingSteps = ref.catalog.outbox().pending;
    expect(new Set(ref.catalog.db.all<{ step: string }>("SELECT DISTINCT step FROM outbox WHERE state = 'pending'").map((r) => r.step))).toEqual(new Set(["custody.verify", "index.version", "mirror.meta"]));
    expect(ref.catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions WHERE custody = 'received'")!.c).toBe(ref.catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions")!.c);
    await ref.catalog.drainOutbox();
    const want = await state(ref.catalog);
    expect(want.outbox.pending).toBe(0); expect(want.dup).toBe(0); expect(want.indexed).toBe(want.versions); expect(want.received).toBe(0);
    // Crash after the effect of step i, for a spread of i across the whole queue, then redispatch.
    const points = [1, 2, 3, 7, Math.floor(pendingSteps / 2), pendingSteps - 1, pendingSteps];
    for (const p of points) {
      const run = newCatalog(fx);
      await loadFixtures(run.catalog, fx, (n) => n.folder === "synth-desk" && n.kind === "decision", { dispatch: false, deferCustody: run.blobStore });
      const first = await run.catalog.dispatchOutbox({ crashAfterEffect: (_row: OutboxRow, nth) => nth === p, ignoreBackoff: true });
      expect(first.crashed).toBe(true);
      expect(run.catalog.outbox().pending).toBeGreaterThan(0); // completion was never recorded for the crashed step
      await run.catalog.drainOutbox();
      const got = await state(run.catalog);
      expect(got, `crash point ${p}`).toEqual(want);
    }
  });
  it("a crash between blob write and apply() leaves a blob without a row; the retried save converges to one version", async () => {
    const { catalog, blobStore } = newCatalog(fx);
    // Simulate: BlobWriter wrote, then the process died before apply(): write the blob through the guard+writer path, skip apply, then save for real.
    const g = catalog.guard({ content: "orphan then saved", requestId: "r".repeat(32) });
    await catalog.blobs.put(g.admitted!);
    expect(blobStore.objects.size).toBe(1);
    const r = await catalog.save(FRANK_CONNECTOR, { content: "orphan then saved" });
    expect(r.ok && r.ver === 1).toBe(true);
    expect(blobStore.objects.size).toBe(1); // put-if-absent: no second blob
    expect(catalog.db.get<{ c: number }>("SELECT count(*) AS c FROM versions")!.c).toBe(1);
  });
  it("a storage failure leaves the step pending with its error and retries later", async () => {
    const { catalog, mirror } = newCatalog(fx);
    await catalog.save(FRANK_CONNECTOR, { content: "# flaky\nbody" });
    mirror.failWhen = (k) => k.startsWith("m/");
    await catalog.dispatchOutbox();
    const row = catalog.db.get<{ state: string; lastError: string; attempts: number; nextAttemptAt: string }>("SELECT state, lastError, attempts, nextAttemptAt FROM outbox WHERE step = 'mirror.meta'")!;
    expect(row.state).toBe("pending"); expect(row.lastError).toMatch(/injected/); expect(row.attempts).toBe(1); expect(row.nextAttemptAt).toBeTruthy();
    expect((await catalog.dispatchOutbox()).ran).toBe(0); // backoff: not retried before nextAttemptAt
    mirror.failWhen = null;
    await catalog.drainOutbox();
    expect(catalog.outbox()).toEqual({ pending: 0, done: 3, hardAlarms: 0 });
  });
});
