// S2e items B and C: the native Harness over the real Windows filesystem and the kl-fs helper, plus the tag every
// native test carries in its name (platform, implementation, helper SHA-256) for test/fs-windows-gate.ts.
// Every file lives inside a fresh fs.mkdtemp(path.join(os.tmpdir(), "kl-")) folder. Nothing here changes machine state.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, linkSync, rmSync, renameSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { windowsHelperBundle } from "../../scripts/hash-windows-helper.ts";
import type { FileTimes, FsCode, FsPath, FsResult, ParentGuard, ScopeId, VolumeKind, ParentIdentity } from "@kl/core";
import { WindowsFs, helperPath } from "@kl/cli";
import type { Harness } from "./fs-contract.ts";

export const onWindows = process.platform === "win32";
export const HELPER = helperPath(process.env);
export const HELPER_DEBUG = process.env.KL_FS_HELPER_DEBUG;
export const held = (reason: string) => new Error(`held:${reason}`);

let hashCache: string | undefined;
/** SHA-256 of the helper's complete runtime bundle; missing/incomplete bundles fail the gate. */
export function helperSha256(): string {
  if (hashCache) return hashCache;
  try { hashCache = windowsHelperBundle(HELPER).sha256; } catch { hashCache = "missing"; }
  return hashCache;
}
/** The tag the gate parses out of every native test name. */
export function nativeLabel(): string { return ` [${process.platform}:windows-native:${helperSha256()}]`; }

export function newTemp(): string { return mkdtempSync(join(tmpdir(), "kl-")); }
const ok = <T>(value: T): FsResult<T> => ({ ok: true, value });
const bad = <T = never>(code: FsCode): FsResult<T> => ({ ok: false, code, effect: "none" });
const isReadOnly = (host: string) => (statSync(host).mode & 0o222) === 0;
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) { if (Date.now() > until) throw new Error("timeout waiting for the helper"); await new Promise((r) => setTimeout(r, 20)); }
}

export class WindowsHarness implements Harness {
  readonly fs: WindowsFs;
  readonly tmp = newTemp();
  #scopes = 0;
  constructor(helper = HELPER) { this.fs = new WindowsFs({ helper }); }

  host(p: FsPath): string { const root = this.fs.rootOf(p.scope); if (!root) throw new Error("unknown scope"); return join(root, ...p.segments); }

  seedScope(serial: string, kind: VolumeKind = "ntfs"): ScopeId {
    if (kind !== "ntfs") throw held(`no ${kind} volume in the job`);
    let root: string;
    if (serial === "different") {
      const second = process.env.KL_FS_SECOND_VOLUME;
      if (!second) throw held("no second volume in the job (set KL_FS_SECOND_VOLUME to a directory on another volume)");
      if (second.slice(0, 2).toLowerCase() === this.tmp.slice(0, 2).toLowerCase()) throw held(`KL_FS_SECOND_VOLUME (${second}) is on the harness's own drive ${this.tmp.slice(0, 2)}; not a second volume`);
      root = mkdtempSync(join(second, "kl-"));
    } else { root = join(this.tmp, `scope-${++this.#scopes}`); mkdirSync(root); }
    return this.fs.registerScope(root);
  }
  aliasScope(scope: ScopeId): ScopeId { return this.fs.registerScope(this.fs.rootOf(scope)!); }
  path(scope: ScopeId, ...segments: string[]): FsPath { return this.fs.path(scope, ...segments); }
  async parentGuard(p: FsPath): Promise<ParentGuard> {
    const parent: FsPath = { scope: p.scope, segments: p.segments.slice(0, -1) };
    const s = await this.fs.inspect(parent);
    if (!s.ok || !s.value.identity || !s.value.parents) throw new Error("parent not inspectable");
    // inspect(<scope root>).parents already ends with the root itself (as the memory model's parentNodes does), so a root-level path adds nothing
    const chain: ParentIdentity[] = parent.segments.length === 0 ? [...s.value.parents] : [...s.value.parents, { segments: [...parent.segments], identity: s.value.identity }];
    return { scope: p.scope, parents: chain };
  }
  async seedDirectory(p: FsPath): Promise<void> { mkdirSync(this.host(p)); }
  async seedFile(p: FsPath, data: Uint8Array, times: Partial<FileTimes> = {}): Promise<void> {
    writeFileSync(this.host(p), data);
    if (times.modified != null) await this.setModified(p, times.modified);
  }
  /** Exact LastWriteTime (FILETIME ticks) through the helper, so a seeded copy can carry the source's mtime bit for bit. */
  async setModified(p: FsPath, modified: bigint): Promise<void> {
    const root = this.fs.rootOf(p.scope)!;
    const observed = await this.fs.inspect(p);
    if (!observed.ok || !observed.value.identity || !observed.value.parents) throw new Error("setModified guard unavailable");
    const o = await this.fs.client.request("openBound", { root, segments: [...p.segments], access: "read-attributes", identity: observed.value.identity, parents: observed.value.parents });
    if (!o.ok) throw new Error(`setModified open: ${o.code}`);
    const h = (o.value as { h: number }).h;
    const r = await this.fs.client.request("setModified", { h, modified: modified.toString() });
    await this.fs.client.request("close", { h });
    if (!r.ok) throw new Error(`setModified: ${r.code}`);
  }
  async seedHardLink(s: FsPath, t: FsPath): Promise<void> { linkSync(this.host(s), this.host(t)); }
  async forceHardLink(s: FsPath, t: FsPath): Promise<void> {
    try { linkSync(this.host(s), this.host(t)); } catch (e) { throw held(`Windows refuses a hard link to a file held with no sharing (${(e as NodeJS.ErrnoException).code})`); }
  }
  async makeReparse(p: FsPath): Promise<void> {
    const target = join(this.tmp, `junction-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(target);
    execFileSync("cmd.exe", ["/c", "mklink", "/J", this.host(p), target], { stdio: "ignore", windowsHide: true });
  }
  /** The file's bytes; a file the adapter holds with no sharing is read through the adapter's own handle (EBUSY otherwise). */
  async bytes(p: FsPath): Promise<Uint8Array> {
    try { return new Uint8Array(readFileSync(this.host(p))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
      const viaHandle = await this.fs.readHeldForTest(p);
      if (viaHandle) return viaHandle;
      throw e;
    }
  }
  async exists(p: FsPath): Promise<boolean> { try { lstatSync(this.host(p)); return true; } catch { return false; } }
  async isFlushed(): Promise<boolean> { throw held("flush state is not observable from outside the kernel"); }
  openHandles(): number { return this.fs.openHandlesForTest(); }
  async editFile(p: FsPath, data: Uint8Array, options: { preserveMtime?: boolean } = {}): Promise<FsResult<void>> {
    const host = this.host(p);
    if (!existsSync(host)) return bad("not-found");
    if (isReadOnly(host)) return bad("read-only");
    let before: bigint | null = null;
    if (options.preserveMtime) { const s = await this.fs.inspect(p); before = s.ok ? s.value.times.modified : null; }
    try { writeFileSync(host, data); } catch { return bad("in-use"); }
    if (before !== null) await this.setModified(p, before);
    return ok(undefined);
  }
  async forceEditFile(p: FsPath, data: Uint8Array): Promise<void> {
    const host = this.host(p), ro = isReadOnly(host);
    if (ro) chmodSync(host, 0o666);
    writeFileSync(host, data);
    if (ro) chmodSync(host, 0o444);
  }
  async replaceFile(p: FsPath, data: Uint8Array): Promise<FsResult<void>> {
    const host = this.host(p);
    try { rmSync(host); } catch { return bad("in-use"); }
    writeFileSync(host, data);
    return ok(undefined);
  }
  async forceReplaceFile(): Promise<void> { throw held("Windows refuses to replace a file held with no sharing"); }
  async replaceDirectory(p: FsPath): Promise<FsResult<void>> {
    const host = this.host(p), aside = `${host}.replaced-${Date.now()}`;
    try { renameSync(host, aside); } catch { return bad("in-use"); }
    mkdirSync(host);
    for (const e of readdirSync(aside)) renameSync(join(aside, e), join(host, e));
    rmSync(aside, { recursive: true, force: true });
    return ok(undefined);
  }
  async forceReplaceDirectory(): Promise<void> { throw held("Windows refuses to rename a directory holding a file opened with no sharing"); }
  async changeVolume(): Promise<void> { throw held("a volume serial cannot change inside the job; releases when the job mounts a volume it can detach"); }
  async unknownChangeTime(): Promise<void> { throw held("ChangeTime is always known on NTFS; an unknown ChangeTime needs a volume that cannot report it"); }
  beforeNext(operation: string, action: () => void | Promise<void>): void { this.fs.beforeNextForTest(operation, action); }
  async crashProcess(): Promise<FsResult<void>> {
    this.fs.killHelperForTest();
    // Logical invalidation is immediate; only stop's terminal wait proves the process released its handles.
    await this.fs.client.stop();
    return ok(undefined);
  }
  async dispose(): Promise<void> {
    await this.fs.stop().catch(() => undefined);
    try { rmSync(this.tmp, { recursive: true, force: true }); } catch { /* a junction target or a killed holder may linger; the temp root is per run */ }
  }
}
