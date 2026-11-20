// S2e item B: native refusal tests. Each asserts its specific FsCode and pairs it with a positive control in the same run;
// a property is established only when both pass. Every file lives under a fresh mkdtemp folder. Nothing here changes
// machine state. On any other platform the file is skipped (listed in the turnover); the gate accepts win32 only.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FileGuard, FsPath } from "@kl/core";
import { bytes, text, value, refused } from "./helpers/fs-contract.ts";
import { WindowsHarness, nativeLabel, onWindows, held, HELPER, HELPER_DEBUG, newTemp } from "./helpers/s2e-windows-harness.ts";

const L = nativeLabel();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function guard(h: WindowsHarness, p: FsPath): Promise<FileGuard> {
  const s = value(await h.fs.inspect(p));
  assert(s.identity && s.parents);
  return { identity: s.identity, parents: { scope: p.scope, parents: s.parents } };
}
async function tree(h: WindowsHarness) {
  const scope = h.seedScope("native");
  const src = h.path(scope, "work", "note.md"), heldCopy = h.path(scope, "held", "copy.md");
  await h.seedDirectory(h.path(scope, "work")); await h.seedDirectory(h.path(scope, "held"));
  await h.seedFile(src, bytes("original"));
  return { scope, src, heldCopy };
}
/** A PowerShell holder: opens the file with the given FileShare and keeps it open until its stdin closes. */
function holder(path: string, share: string): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const script = `$f=[IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','${share}'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $f.Close()`;
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const rl = createInterface({ input: p.stdout });
    rl.on("line", (line) => { if (line.trim() === "ready") resolve({ close: () => new Promise((r) => { p.once("exit", () => r()); p.stdin.write("\n"); p.stdin.end(); }) }); });
    p.on("error", reject);
    p.on("exit", (code) => reject(new Error(`holder exited early (${code})`)));
  });
}
/** A second process tries to write the file; returns whether the write succeeded. */
function externalWrite(path: string, content: string): boolean {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `try { [IO.File]::WriteAllText('${path.replace(/'/g, "''")}','${content}'); exit 0 } catch { exit 3 }`], { windowsHide: true });
  return r.status === 0;
}
/** Run a helper process with one request, collecting its stdout lines until `until` matches, then kill it. */
function runHelperUntil(exe: string, request: Record<string, unknown>, until: (line: string) => boolean, timeoutMs = 20000): Promise<{ lines: string[]; proc: ChildProcess; exited: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines: string[] = [];
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`helper did not reach the expected line; got ${JSON.stringify(lines)}`)); }, timeoutMs);
    createInterface({ input: proc.stdout }).on("line", (line) => { lines.push(line); if (until(line)) { clearTimeout(timer); resolve({ lines, proc, exited }); } });
    proc.on("exit", () => { clearTimeout(timer); resolve({ lines, proc, exited }); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.stdin.write(JSON.stringify({ id: 1, ...request }) + "\n");
  });
}

describe.skipIf(!onWindows)("kl-fs native properties", () => {
  const withHarness = (id: string, name: string, fn: (h: WindowsHarness) => Promise<void>) => test(`${id} ${name}${L}`, async () => { const h = new WindowsHarness(); try { await fn(h); } finally { await h.dispose(); } });

  withHarness("N01", "exclusive open: refused in-use while a PowerShell holder shares read, write and delete; the same open succeeds without the holder", async (h) => {
    const { src } = await tree(h), g = await guard(h, src);
    const hold = await holder(h.host(src), "ReadWrite, Delete");
    try { refused(await h.fs.openExclusive(src, g, "read-delete"), "in-use"); } finally { await hold.close(); }
    const ok = value(await h.fs.openExclusive(src, g, "read-delete"));
    value(await h.fs.close(ok));
  });
  withHarness("N02", "editor write after verify: a second process's write fails while the helper holds the verified handle and the bytes equal the hashed bytes; the write succeeds after the handle closes", async (h) => {
    const { src } = await tree(h), g = await guard(h, src);
    const hd = value(await h.fs.openExclusive(src, g, "read-delete"));
    const digest = value(await h.fs.hash(hd));
    assert.equal(externalWrite(h.host(src), "edited by another process"), false);
    assert.equal(value(await h.fs.hash(hd)).sha256, digest.sha256);
    assert.equal(sha256(await h.bytes(src)), digest.sha256); // through the held handle: no other opener can read it either
    value(await h.fs.close(hd));
    assert.equal(sha256(readFileSync(h.host(src))), digest.sha256);
    assert.equal(externalWrite(h.host(src), "edited by another process"), true);
    assert.equal(text(await h.bytes(src)), "edited by another process");
  });
  withHarness("N03", "non-replacing rename: placement onto an existing file fails already-exists and the destination is unchanged; a control adapter on fs.renameSync replaces it", async (h) => {
    const { scope, heldCopy } = await tree(h), dest = h.path(scope, "work", "existing.md");
    await h.seedFile(dest, bytes("kept"));
    const hd = value(await h.fs.createNew(heldCopy, await h.parentGuard(heldCopy)));
    value(await h.fs.appendCreated(hd, bytes("staged")));
    refused(await h.fs.renameNoReplace(hd, dest, await h.parentGuard(dest)), "already-exists");
    assert.equal(text(await h.bytes(dest)), "kept");
    value(await h.fs.close(hd));
    // positive control: the same placement through a control adapter built on fs.renameSync replaces the destination, so the refusal above is the helper's doing
    const staged2 = h.path(scope, "held", "staged2.md"); await h.seedFile(staged2, bytes("control"));
    renameSync(h.host(staged2), h.host(dest));
    assert.equal(text(await h.bytes(dest)), "control");
  });
  withHarness("N04", "source swap and parent swap are refused identity-changed and parent-changed; the open succeeds when nothing is swapped", async (h) => {
    const { scope, src } = await tree(h), g = await guard(h, src);
    const ok = value(await h.fs.openExclusive(src, g, "read-delete")); value(await h.fs.close(ok)); // positive control first
    value(await h.replaceFile(src, bytes("original")));
    refused(await h.fs.openExclusive(src, g, "read-delete"), "identity-changed");
    const g2 = await guard(h, src);
    value(await h.replaceDirectory(h.path(scope, "work")));
    refused(await h.fs.openExclusive(src, g2, "read-delete"), "parent-changed");
    assert.equal(text(await h.bytes(src)), "original");
  });
  withHarness("N05", "destination race: a file created while the adapter pauses before placement makes placement fail already-exists and that file is unchanged; placement succeeds with no racing file", async (h) => {
    const { scope, heldCopy } = await tree(h), dest = h.path(scope, "work", "restored.md");
    const hd = value(await h.fs.createNew(heldCopy, await h.parentGuard(heldCopy)));
    value(await h.fs.appendCreated(hd, bytes("complete")));
    h.beforeNext("renameNoReplace", () => writeFileSync(h.host(dest), "racer"));
    refused(await h.fs.renameNoReplace(hd, dest, await h.parentGuard(dest)), "already-exists");
    assert.equal(text(await h.bytes(dest)), "racer");
    rmSync(h.host(dest));
    assert.deepEqual(value(await h.fs.renameNoReplace(hd, dest, await h.parentGuard(dest))), value(await h.fs.statHandle(hd)).identity);
    value(await h.fs.close(hd));
    assert.equal(text(await h.bytes(dest)), "complete"); assert.equal(await h.exists(heldCopy), false);
  });
  withHarness("N06", "hard link: the count is 1 before fs.linkSync and 2 after, and the open is refused hard-linked", async (h) => {
    const { scope, src } = await tree(h);
    assert.equal(value(await h.fs.inspect(src)).hardLinks, 1);
    const g = await guard(h, src);
    linkSync(h.host(src), h.host(h.path(scope, "work", "alias.md")));
    assert.equal(value(await h.fs.inspect(src)).hardLinks, 2);
    refused(await h.fs.openExclusive(src, g, "read-delete"), "hard-linked");
  });
  withHarness("N07", "reparse point: a junction in any parent makes the open refuse reparse; the path opens without the junction", async (h) => {
    const { scope } = await tree(h);
    const real = h.path(scope, "real"); await h.seedDirectory(real);
    const note = h.path(scope, "real", "n.md"); await h.seedFile(note, bytes("x"));
    const g = await guard(h, note);
    const ok = value(await h.fs.openExclusive(note, g, "read")); value(await h.fs.close(ok));
    const viaJunction = h.path(scope, "link", "n.md");
    await h.makeReparse(h.path(scope, "link")); // a junction at <scope>/link pointing elsewhere
    rmSync(h.host(h.path(scope, "link")), { recursive: false }); // drop the junction (not its target) …
    spawnSync("cmd.exe", ["/c", "mklink", "/J", h.host(h.path(scope, "link")), h.host(real)], { windowsHide: true }); // … and point one at real/
    const s = value(await h.fs.inspect(viaJunction));
    assert.equal(s.anyReparseComponent, true);
    assert.deepEqual(s.identity, g.identity);
    refused(await h.fs.openExclusive(viaJunction, { identity: g.identity, parents: { scope, parents: [g.parents.parents[0]!, { segments: ["link"], identity: s.parents![1]!.identity }] } }, "read"), "reparse");
  });
  withHarness("N08", "ChangeTime: a same-size edit with mtime restored by fs.utimesSync moves ChangeTime; size and mtime are equal before and after", async (h) => {
    const { src } = await tree(h), host = h.host(src);
    const t = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(host, t, t);
    const before = value(await h.fs.inspect(src));
    writeFileSync(host, "modified"); // 8 bytes, the same size as "original"
    utimesSync(host, t, t);
    const after = value(await h.fs.inspect(src));
    assert.equal(before.bytes, after.bytes); assert.equal(before.times.modified, after.times.modified);
    assert.equal(statSync(host).mtimeMs, t.getTime());
    assert.notEqual(before.times.changed, after.times.changed);
    assert(after.times.changed !== null && before.times.changed !== null && after.times.changed > before.times.changed);
  });
  test(`N09 kill between steps: the Debug helper paused after each of steps 1–4 is killed; its report shows step n done and n+1 not started and the source is intact; a DeleteOnClose control holder loses its file when killed; the Release build ignores the pause flag${L}`, async () => {
    if (!HELPER_DEBUG || !existsSync(HELPER_DEBUG)) throw held("no Debug helper (set KL_FS_HELPER_DEBUG); releases when the job builds the Debug configuration");
    const tmp = newTemp();
    try {
      for (let n = 1; n <= 4; n++) {
        const root = join(tmp, `pause-${n}`); mkdirSync(join(root, "work"), { recursive: true }); mkdirSync(join(root, "held"));
        const content = `kill me at ${n}`; writeFileSync(join(root, "work", "note.md"), content);
        const r = await runHelperUntil(HELPER_DEBUG, { op: "sequence", root, src: ["work", "note.md"], held: ["held", "copy.md"], sha: sha256(bytes(content)), pauseAfter: n }, (line) => line.includes(`"paused":${n}`));
        r.proc.kill("SIGKILL"); await r.exited;
        const steps = r.lines.map((l) => { try { return JSON.parse(l) as { step?: number; done?: boolean; paused?: number }; } catch { return {}; } });
        assert.deepEqual(steps.filter((s) => s.done).map((s) => s.step), Array.from({ length: n }, (_, i) => i + 1), `steps reported before the kill at ${n}`);
        assert.equal(steps.some((s) => s.step === n + 1), false);
        assert.equal(existsSync(join(root, "work", "note.md")), true, `source present after a kill at step ${n}`);
        assert.equal(readFileSync(join(root, "work", "note.md"), "utf8"), content, `source intact after a kill at step ${n}`);
        if (n >= 3) assert.equal(readFileSync(join(root, "held", "copy.md"), "utf8"), content); else assert.equal(existsSync(join(root, "held", "copy.md")), false);
      }
      // control: a holder with FileOptions.DeleteOnClose, killed, leaves the source gone
      const victim = join(tmp, "victim.md"); writeFileSync(victim, "delete on close");
      const c = await runHelperUntil(HELPER, { op: "hold-delete-on-close", path: victim }, (line) => line.includes('"holding":true'));
      assert.equal(existsSync(victim), true);
      c.proc.kill("SIGKILL"); await c.exited;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(existsSync(victim), false);
      // the Release build ignores the pause flag: the sequence runs to step 5
      const root = join(tmp, "release"); mkdirSync(join(root, "work"), { recursive: true }); mkdirSync(join(root, "held"));
      writeFileSync(join(root, "work", "note.md"), "release run");
      const rel = await runHelperUntil(HELPER, { op: "sequence", root, src: ["work", "note.md"], held: ["held", "copy.md"], sha: sha256(bytes("release run")), pauseAfter: 2 }, (line) => line.includes('"ok":true') || line.includes('"ok":false'));
      rel.proc.stdin!.end(); await rel.exited;
      assert.equal(rel.lines.some((l) => l.includes('"paused"')), false);
      assert.equal(rel.lines.filter((l) => l.includes('"done":true')).length, 5);
      assert.equal(existsSync(join(root, "work", "note.md")), false);
      assert.equal(readFileSync(join(root, "held", "copy.md"), "utf8"), "release run");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  withHarness("N10", "volume: the temp folder's NTFS volume is accepted as a supported local volume", async (h) => {
    const { scope } = await tree(h);
    const s = value(await h.fs.inspect(h.path(scope)));
    assert.equal(s.volumeKind, "ntfs"); assert.equal(s.supportedLocalVolume, true);
  });
  for (const [id, kind] of [["N10R", "ReFS"], ["N10N", "network"], ["N10S", "removable with a changed serial"]] as const) {
    test(`${id} volume: ${kind} is refused${L}`, () => { throw held(`no ${kind} volume in the job; releases when the job creates one and logs fsutil fsinfo volumeinfo for it`); });
  }
  withHarness("P01", "paths: a name with spaces, dots and mixed case resolves to one identity; invalid segments are refused path-invalid", async (h) => {
    const scope = h.seedScope("paths");
    const p = h.path(scope, "A Folder.v2", "Note File.final.md"); await h.seedDirectory(h.path(scope, "A Folder.v2")); await h.seedFile(p, bytes("x"));
    assert.deepEqual(value(await h.fs.inspect(h.path(scope, "a folder.V2", "note file.FINAL.md"))).identity, value(await h.fs.inspect(p)).identity);
    for (const segment of ["..", "a/b", "a\\b", "name.", "name ", "x:y", "con"]) refused(await h.fs.inspect({ scope, segments: [segment] }), "path-invalid");
  });
  withHarness("P02", "long paths: a file deeper than 260 characters opens, hashes and is placed through the helper", async (h) => {
    const scope = h.seedScope("long");
    const segs: string[] = [];
    let depth = 0;
    while (h.host(h.path(scope, ...segs)).length < 300) { segs.push(`segment-${depth++}-${"x".repeat(40)}`); await h.seedDirectory(h.path(scope, ...segs)); }
    const p = h.path(scope, ...segs, "deep.md"); await h.seedFile(p, bytes("deep"));
    assert(h.host(p).length > 260);
    const hd = value(await h.fs.openExclusive(p, await guard(h, p), "read-delete"));
    assert.equal(value(await h.fs.hash(hd)).sha256, sha256(bytes("deep")));
    const dest = h.path(scope, ...segs, "moved.md");
    value(await h.fs.renameNoReplace(hd, dest, await h.parentGuard(dest)));
    value(await h.fs.close(hd));
    assert.equal(await h.exists(dest), true); assert.equal(await h.exists(p), false);
  });
  test(`P06 git ls-files in a linked worktree${L}`, () => { throw held("S2d's git port (packages/core/src/inventory/git-port.ts) is run natively in a later session"); });
  test(`P07 drill test${L}`, () => { throw held("the Kopia drill needs the restore orchestration (S2 item 6) and a repository; not in S2e"); });
});
