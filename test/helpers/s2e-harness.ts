// S2e item A: a loopback kl-api with the synthetic vault, tokens of every kind, and a kl runner that captures stdout, stderr and the exit code.
import { createApiHandler, serve } from "@kl/api";
import { main as klMain, type Io } from "@kl/cli";
import { type Catalog } from "@kl/core";
import { generateFixtures } from "../../fixtures/gen.ts";
import { newCatalog, loadFixtures, FRANK, issueToken, type LoadReport } from "./load.ts";

export interface Harness {
  catalog: Catalog; report: LoadReport; url: string; close: () => Promise<void>;
  tokens: { device: string; cc: string; cx: string };
  /** A cite of an admitted team note (synth-desk). */
  teamCite: string;
  /** A cite of a client-class note whose clients_ok lacks claude-code and codex (kl-device only). */
  clientCite: string;
}

export const KL_PATH = "/opt/kl/bin/kl";

export async function startHarness(): Promise<Harness> {
  const fx = generateFixtures();
  const { catalog } = newCatalog(fx);
  const report = await loadFixtures(catalog, fx, (n) => n.folder === "synth-desk");
  const teamNote = fx.notes.find((n) => n.folder === "synth-desk" && n.privacyClass === "team" && report.admitted.has(n.noteId))!;
  catalog.apply(FRANK, { kind: "setup" }, { kind: "collection.create", collectionId: "col:client-q", class: "client:q", clients_ok: ["kl-device"], decision_row: { client: "Client Q", decidedAt: "2026-10-05", receiptId: "rcpt-synthetic" } });
  catalog.db.run("UPDATE principals SET allowed_classes = ? WHERE id = 'frank'", [JSON.stringify(["team", "frank-private", "client:q"])]); // the same setup the S1c A3 tests use
  const saved = await catalog.save(FRANK, { content: "# Client Q\nA synthetic client note readable by the device only.", collection: "col:client-q", path: "client-q/note.md" });
  if (!saved.ok) throw new Error(`client note not saved: ${JSON.stringify(saved)}`);
  await catalog.drainOutbox();
  const tokens = { device: issueToken(catalog, "frank", "kl-device"), cc: issueToken(catalog, "frank", "cc-bearer"), cx: issueToken(catalog, "frank", "cx-bearer") };
  const srv = await serve(createApiHandler({ catalog }));
  return { catalog, report, url: `http://127.0.0.1:${srv.port}`, close: srv.close, tokens, teamCite: report.admitted.get(teamNote.noteId)!.cite, clientCite: saved.cite };
}

export interface Run { code: number; out: string; err: string }
/** Run kl in-process with the given environment; isTTY defaults to false (a pipe), klPath to KL_PATH. */
export async function kl(argv: string[], env: Record<string, string | undefined>, opts: { isTTY?: boolean; klPath?: string; fetch?: typeof fetch } = {}): Promise<Run> {
  let out = "", err = "";
  const io: Io = { stdout: (s) => (out += s), stderr: (s) => (err += s), env, fetch: opts.fetch ?? fetch, isTTY: opts.isTTY ?? false, klPath: opts.klPath ?? KL_PATH };
  const code = await klMain(argv, io);
  return { code, out, err };
}
