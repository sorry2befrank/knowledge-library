// The Windows adapter of the frozen Fs port (packages/core/src/fs/fs.ts), over the kl-fs helper.
// Every identity, open, hash, rename and disposition goes through the helper's handle; this file validates guards,
// paths, access and handle authority exactly as the memory model does, and maps the helper's codes.
import type { Access, CreatedHandle, FileGuard, FileHandle, FileIdentity, FileTimes, Fs, FsCode, FsPath, FsResult, Handle, HandleSnapshot, ParentGuard, ParentIdentity, PathSnapshot, ReadChunk, ScopeId, UnsupportedFeature, VolumeKind } from "@kl/core";
import { HelperClient, helperPath } from "./windows-helper.ts";

const MAX_CHUNK = 65536;
const ok = <T>(value: T): FsResult<T> => ({ ok: true, value });
const bad = <T = never>(code: FsCode, unsupported?: UnsupportedFeature): FsResult<T> => ({ ok: false, code, effect: "none", ...(unsupported ? { unsupported } : {}) });
const sameId = (a: FileIdentity, b: FileIdentity) => a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;

interface HelperIdentity { volumeSerial: string; fileId: string }
interface HelperInfo { identity: HelperIdentity; links: number; bytes: number; readOnly: boolean; directory: boolean; reparse: boolean; deletePending: boolean; times: { created: string; modified: string; changed: string }; volume: { kind: VolumeKind; supported: boolean; driveType: number; fs: string } }
interface HelperComponent { identity: HelperIdentity | null; reparse: boolean; directory: boolean; exists: boolean }
interface Location { scope: ScopeId; root: string; segments: string[] }
interface Bound { token: Handle; id: number; epoch: number; closed: boolean; created: boolean; access: Access; location: Location; expected: FileGuard; identity: FileIdentity; disposition: boolean }

const times = (t: HelperInfo["times"]): FileTimes => ({ created: BigInt(t.created), modified: BigInt(t.modified), changed: BigInt(t.changed) });

export class WindowsFs implements Fs {
  readonly implementation = "windows-native" as const;
  readonly client: HelperClient;
  readonly #scopes = new Map<ScopeId, string>();
  readonly #handles = new WeakMap<object, Bound>();
  readonly #live = new Set<Bound>();
  #scopeCounter = 0;
  #epoch = 0;
  #injection: { operation: string; action: () => void | Promise<void> } | null = null;

  constructor(opts: { helper?: string; client?: HelperClient } = {}) {
    this.client = opts.client ?? new HelperClient(opts.helper ?? helperPath());
    this.client.onExit(() => this.#helperGone());
  }

  /** Register an absolute host directory as a scope root. The scope id, not the path, is what FsPath carries. */
  registerScope(root: string): ScopeId {
    const id = `win-scope-${++this.#scopeCounter}` as ScopeId;
    this.#scopes.set(id, root);
    return id;
  }
  rootOf(scope: ScopeId): string | undefined { return this.#scopes.get(scope); }
  path(scope: ScopeId, ...segments: string[]): FsPath { return Object.freeze({ scope, segments: Object.freeze([...segments]) }); }
  openHandlesForTest(): number { return this.#live.size; }
  /** Test only: the whole content of a file this adapter currently holds, read through its own handle; undefined when it holds none at that path. */
  async readHeldForTest(path: FsPath): Promise<Uint8Array | undefined> {
    const l = this.#loc(path); if (!l.ok) return undefined;
    const key = l.value.segments.map((s) => s.toLowerCase()).join("/");
    const r = [...this.#live].find((h) => !h.closed && h.location.root === l.value.root && h.location.segments.map((s) => s.toLowerCase()).join("/") === key);
    if (!r) return undefined;
    const chunks: Uint8Array[] = []; let offset = 0;
    while (true) {
      const x = await this.#call("read", { h: r.id, offset, max: MAX_CHUNK }, r.epoch); if (!x.ok) return undefined;
      const v = x.value as { data: string; eof: boolean }; const b = new Uint8Array(Buffer.from(v.data, "base64"));
      chunks.push(b); offset += b.length; if (v.eof || b.length === 0) break;
    }
    const out = new Uint8Array(offset); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
  /** Kill the helper: the OS closes every handle, as a process crash would. The next call starts a fresh helper. */
  killHelperForTest(): void { this.client.kill(); }
  async stop(): Promise<void> { await this.client.stop(); }
  /** Test only: run an action once, just before the next named operation reaches the helper (the race window a test needs). */
  beforeNextForTest(operation: string, action: () => void | Promise<void>): void {
    if (this.#injection) throw new Error("injection pending");
    this.#injection = { operation, action };
  }
  async #injected(operation: string): Promise<void> {
    const x = this.#injection;
    if (x?.operation === operation) { this.#injection = null; await x.action(); }
  }

  #helperGone() {
    for (const h of this.#live) h.closed = true;
    this.#live.clear();
    this.#epoch++;
    this.client.reset();
  }

  #loc(p: FsPath): FsResult<Location> {
    if (!p || !Array.isArray(p.segments) || typeof p.scope !== "string") return bad("path-invalid");
    const root = this.#scopes.get(p.scope);
    if (!root) return bad("path-invalid");
    for (const s of p.segments) {
      if (typeof s !== "string" || !s || s === "." || s === ".." || /[\\/:\u0000-\u001f]/.test(s) || /[. ]$/.test(s)) return bad("path-invalid");
      if (!/^[\x20-\x7e]+$/.test(s) || s.length > 120) return bad("unsupported", "path-normalization");
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) return bad("path-invalid");
    }
    return ok({ scope: p.scope, root, segments: [...p.segments] });
  }

  async #call(op: string, params: Record<string, unknown>, epoch = this.#epoch): Promise<{ ok: true; value: unknown } | { ok: false; code: FsCode; effect: "none" | "unknown" }> {
    if (epoch !== this.#epoch) return { ok: false, code: "closed-handle", effect: "unknown" };
    const r = await this.client.request(op, params);
    // Native handle numbers may be reused after restart. Never send or accept work across generations.
    if (epoch !== this.#epoch) return { ok: false, code: "closed-handle", effect: "unknown" };
    if (r.ok) return r;
    return { ok: false, code: (r.code === "unknown-op" ? "unsupported" : r.code) as FsCode, effect: r.effect };
  }

  /** Compare the live parent chain with a guard, root first: lengths, segment names (case-insensitive), volume, reparse and identity. */
  #checkParents(l: Location, guard: ParentGuard, components: HelperComponent[]): FsResult<void> {
    if (components.some((c) => !c.exists)) return bad("not-found");
    if (components.some((c) => c.exists && !c.directory && !c.reparse)) return bad("not-file");
    if (!guard || guard.scope !== l.scope || !Array.isArray(guard.parents) || guard.parents.length !== components.length) return bad("parent-changed");
    for (let i = 0; i < components.length; i++) {
      const expected = guard.parents[i]!, current = components[i]!, segments = l.segments.slice(0, i);
      if (!expected || !Array.isArray(expected.segments) || expected.segments.length !== segments.length || expected.segments.some((s: unknown, j: number) => typeof s !== "string" || s.toLowerCase() !== segments[j]!.toLowerCase()) || !expected.identity) return bad("parent-changed");
      if (!current.identity) return bad("unsupported", "identity");
      if (expected.identity.volumeSerial !== current.identity.volumeSerial) return bad("volume-changed");
      if (current.reparse) return bad("reparse");
      if (!sameId(expected.identity, current.identity)) return bad("parent-changed");
    }
    return ok(undefined);
  }

  #checkFile(info: HelperInfo, expected: FileIdentity): FsResult<void> {
    if (!expected || expected.volumeSerial !== info.identity.volumeSerial) return bad("volume-changed");
    if (!info.volume.supported) return bad("unsupported", "volume");
    if (info.directory) return bad("not-file");
    if (info.reparse) return bad("reparse");
    if (!sameId(info.identity, expected)) return bad("identity-changed");
    if (info.links !== 1) return bad("hard-linked");
    return ok(undefined);
  }

  #mint(id: number, l: Location, expected: FileGuard, identity: FileIdentity, access: Access, created: boolean, epoch: number): FsResult<Handle> {
    const token = Object.freeze({}) as Handle;
    const r: Bound = { token, id, epoch, closed: false, created, access, location: { ...l, segments: [...l.segments] }, expected: { identity: { ...expected.identity }, parents: { scope: expected.parents.scope, parents: expected.parents.parents.map((p) => ({ segments: [...p.segments], identity: { ...p.identity } })) } }, identity, disposition: false };
    if (epoch !== this.#epoch) return { ok: false, code: "closed-handle", effect: "unknown" };
    this.#handles.set(token, r);
    this.#live.add(r);
    return ok(token);
  }

  /** Authenticate a handle (ours, open, this helper generation) and, when validating, re-check the bound identity, link count and parents. */
  async #bound(handle: Handle, validate = true): Promise<FsResult<Bound>> {
    if (!handle || typeof handle !== "object") return bad("invalid-handle");
    const r = this.#handles.get(handle);
    if (!r) return bad("invalid-handle");
    if (r.closed || r.epoch !== this.#epoch) return bad("closed-handle");
    if (validate) {
      const comps = await this.#call("components", { root: r.location.root, segments: r.location.segments }, r.epoch);
      if (!comps.ok) return bad(comps.code);
      const p = this.#checkParents(r.location, r.expected.parents, comps.value as HelperComponent[]);
      if (!p.ok) return p;
      const st = await this.#call("stat", { h: r.id }, r.epoch);
      if (!st.ok) return bad(st.code);
      const info = st.value as HelperInfo;
      if (!sameId(info.identity, r.identity)) return bad("identity-changed");
      const safe = this.#checkFile(info, r.identity);
      if (!safe.ok) return safe;
    }
    return r.closed || r.epoch !== this.#epoch ? bad("closed-handle") : ok(r);
  }

  async #discard(id: number, epoch: number) { const closed = await this.#call("close", { h: id }, epoch); if (!closed.ok && epoch === this.#epoch) this.client.kill(); }

  async inspect(path: FsPath): Promise<FsResult<PathSnapshot>> {
    const l = this.#loc(path); if (!l.ok) return l;
    const r = await this.#call("inspect", { root: l.value.root, segments: l.value.segments });
    if (!r.ok) return bad(r.code);
    const v = r.value as { exists: boolean; reparse?: boolean; directory?: boolean; info: HelperInfo | null; components: HelperComponent[] };
    if (!v.exists) return bad("not-found");
    const parents: ParentIdentity[] | null = v.components.every((c) => c.identity) ? v.components.map((c, i) => ({ segments: l.value.segments.slice(0, i), identity: { ...c.identity! } })) : null;
    const info = v.info;
    return ok({
      path: { scope: l.value.scope, segments: [...l.value.segments] },
      kind: v.reparse ? "reparse" : v.directory ? "directory" : "file",
      identity: info ? { ...info.identity } : null,
      parents,
      volumeKind: info?.volume.kind ?? "unknown",
      supportedLocalVolume: info ? info.volume.supported : null,
      hardLinks: info ? info.links : null,
      bytes: info && !info.directory ? info.bytes : null,
      readOnly: info ? info.readOnly : null,
      times: info ? times(info.times) : { created: null, modified: null, changed: null },
      anyReparseComponent: v.components.some((c) => c.reparse) || v.reparse === true,
    });
  }

  async openExclusive(path: FsPath, expected: FileGuard, access: Access): Promise<FsResult<FileHandle>> {
    if (!["read", "read-delete", "read-attributes", "read-delete-attributes"].includes(access)) return bad("access-denied");
    const l = this.#loc(path); if (!l.ok) return l;
    if (!expected || typeof expected !== "object" || !expected.parents || !expected.identity) return bad("parent-changed");
    const epoch = this.#epoch;
    await this.#injected("openExclusive");
    const r = await this.#call("openBound", { root: l.value.root, segments: l.value.segments, access, parents: expected.parents.parents, identity: expected.identity }, epoch);
    if (!r.ok) return bad(r.code);
    const v = r.value as { h: number; info: HelperInfo; components: HelperComponent[] };
    const p = this.#checkParents(l.value, expected.parents, v.components);
    if (!p.ok) { await this.#discard(v.h, epoch); return p; }
    const f = this.#checkFile(v.info, expected.identity);
    if (!f.ok) { await this.#discard(v.h, epoch); return f; }
    return this.#mint(v.h, l.value, expected, { ...v.info.identity }, access, false, epoch) as FsResult<FileHandle>;
  }

  async createNew(path: FsPath, expectedParents: ParentGuard): Promise<FsResult<CreatedHandle>> {
    const l = this.#loc(path); if (!l.ok) return l;
    if (!l.value.segments.length) return bad("path-invalid");
    const epoch = this.#epoch;
    const comps = await this.#call("components", { root: l.value.root, segments: l.value.segments }, epoch);
    if (!comps.ok) return bad(comps.code);
    const p = this.#checkParents(l.value, expectedParents, comps.value as HelperComponent[]);
    if (!p.ok) return p;
    await this.#injected("createNew");
    const r = await this.#call("createNewBound", { root: l.value.root, segments: l.value.segments, parents: expectedParents.parents }, epoch);
    if (!r.ok) return r;
    const v = r.value as { h: number; info: HelperInfo; components: HelperComponent[] };
    const again = this.#checkParents(l.value, expectedParents, v.components);
    // A successful create already made an artifact. Closing releases resources; it does not undo creation.
    if (!again.ok) { await this.#discard(v.h, epoch); return { ...again, effect: "unknown" }; }
    const safe = this.#checkFile(v.info, v.info.identity);
    if (!safe.ok) { await this.#discard(v.h, epoch); return { ...safe, effect: "unknown" }; }
    const identity = { ...v.info.identity };
    return this.#mint(v.h, l.value, { identity, parents: expectedParents }, identity, "read-delete-attributes", true, epoch) as FsResult<CreatedHandle>;
  }

  async statHandle(handle: Handle): Promise<FsResult<HandleSnapshot>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    const st = await this.#call("stat", { h: r.value.id }, r.value.epoch); if (!st.ok) return bad(st.code);
    const info = st.value as HelperInfo;
    const safe = this.#checkFile(info, r.value.identity); if (!safe.ok) return safe;
    return ok({ identity: { ...info.identity }, hardLinks: 1, bytes: info.bytes, readOnly: info.readOnly, times: times(info.times) });
  }

  async read(handle: Handle, offset: number, maxBytes: number): Promise<FsResult<ReadChunk>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHUNK || !Number.isSafeInteger(offset + maxBytes)) return bad("limit");
    const x = await this.#call("read", { h: r.value.id, offset, max: maxBytes }, r.value.epoch); if (!x.ok) return bad(x.code);
    const v = x.value as { data: string; eof: boolean };
    return ok({ bytes: new Uint8Array(Buffer.from(v.data, "base64")), eof: v.eof });
  }

  async hash(handle: Handle): Promise<FsResult<{ readonly sha256: string; readonly bytes: number }>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    const x = await this.#call("hash", { h: r.value.id }, r.value.epoch); if (!x.ok) return bad(x.code);
    return ok(x.value as { sha256: string; bytes: number });
  }

  async appendCreated(handle: CreatedHandle, bytes: Uint8Array): Promise<FsResult<void>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (!r.value.created) return bad("access-denied");
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CHUNK) return bad("limit");
    const st = await this.#call("stat", { h: r.value.id }, r.value.epoch); if (!st.ok) return bad(st.code);
    if ((st.value as HelperInfo).readOnly) return bad("read-only");
    const x = await this.#call("append", { h: r.value.id, data: Buffer.from(bytes).toString("base64") }, r.value.epoch);
    return x.ok ? ok(undefined) : { ok: false, code: x.code, effect: x.effect };
  }

  async flushCreated(handle: CreatedHandle): Promise<FsResult<void>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (!r.value.created) return bad("access-denied");
    const x = await this.#call("flush", { h: r.value.id }, r.value.epoch);
    return x.ok ? ok(undefined) : x;
  }

  async setReadOnly(handle: Handle, value: boolean): Promise<FsResult<void>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (typeof value !== "boolean" || !r.value.access.includes("attributes")) return bad("access-denied");
    const x = await this.#call("readOnly", { h: r.value.id, value }, r.value.epoch);
    return x.ok ? ok(undefined) : x;
  }

  async renameNoReplace(handle: Handle, destination: FsPath, expectedParents: ParentGuard): Promise<FsResult<FileIdentity>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (!r.value.access.includes("delete") || r.value.disposition) return bad("access-denied");
    const l = this.#loc(destination); if (!l.ok) return l;
    if (!l.value.segments.length) return bad("path-invalid");
    const comps = await this.#call("components", { root: l.value.root, segments: l.value.segments }, r.value.epoch); if (!comps.ok) return bad(comps.code);
    const components = comps.value as HelperComponent[];
    const p = this.#checkParents(l.value, expectedParents, components); if (!p.ok) return p;
    if (components[0]?.identity && components[0].identity.volumeSerial !== r.value.identity.volumeSerial) return bad("cross-volume");
    await this.#injected("renameNoReplace");
    const x = await this.#call("renameBound", { h: r.value.id, root: l.value.root, segments: l.value.segments, parents: expectedParents.parents }, r.value.epoch);
    if (!x.ok) return { ok: false, code: x.code, effect: x.effect };
    const info = x.value as HelperInfo;
    r.value.location = { ...l.value, segments: [...l.value.segments] };
    r.value.expected = { identity: { ...info.identity }, parents: { scope: expectedParents.scope, parents: expectedParents.parents.map((q) => ({ segments: [...q.segments], identity: { ...q.identity } })) } };
    return ok({ ...info.identity });
  }

  async setDeleteDisposition(handle: FileHandle): Promise<FsResult<void>> {
    const r = await this.#bound(handle); if (!r.ok) return r;
    if (r.value.created || !r.value.access.includes("delete")) return bad("access-denied");
    await this.#injected("setDeleteDisposition");
    const x = await this.#call("dispose", { h: r.value.id }, r.value.epoch);
    if (!x.ok) return { ok: false, code: x.code, effect: x.effect };
    r.value.disposition = true;
    return ok(undefined);
  }

  async close(handle: Handle): Promise<FsResult<void>> {
    const r = await this.#bound(handle, false); if (!r.ok) return r;
    let result: FsResult<void> = ok(undefined);
    if (r.value.disposition) {
      const current = await this.#bound(handle);
      if (!current.ok) result = { ...current, effect: "unknown" };
    }
    const x = await this.#call("close", { h: r.value.id }, r.value.epoch);
    r.value.closed = true;
    this.#live.delete(r.value);
    if (!x.ok && result.ok) result = { ok: false, code: x.code, effect: "unknown" };
    return result;
  }
}
