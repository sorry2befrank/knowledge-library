// The adapter-neutral Fs contract (S2e item B): the cases of test/fs-memory.test.ts that do not depend on a memory-only
// control, run through a Harness. Test bodies never branch on the implementation. A harness operation with no native
// equivalent throws `held:<reason>`, and the Windows gate records that test as held. A native difference is declared only
// in test/fs-windows-differences.json. Case IDs, names and assertions are the memory suite's.
import { test } from "vitest";
import assert from "node:assert/strict";
import { MemoryFs, type MemoryOperation, type Fs, type FsResult, type FsPath, type FileGuard, type ParentGuard, type FileTimes, type ScopeId, type VolumeKind } from "@kl/core";

export type Right = "read" | "write" | "delete";

/** Fixture controls over one Fs implementation. The memory harness is MemoryFs itself; the native harness drives the real filesystem. */
export interface Harness {
  readonly fs: Fs;
  seedScope(serial: string, kind?: VolumeKind): ScopeId;
  /** A second scope id for the same volume and tree. */
  aliasScope(scope: ScopeId): ScopeId;
  path(scope: ScopeId, ...segments: string[]): FsPath;
  parentGuard(path: FsPath): Promise<ParentGuard>;
  seedDirectory(path: FsPath): Promise<void>;
  seedFile(path: FsPath, data: Uint8Array, times?: Partial<FileTimes>): Promise<void>;
  seedHardLink(source: FsPath, target: FsPath): Promise<void>;
  /** A hard link made while the source may be held by the adapter. */
  forceHardLink(source: FsPath, target: FsPath): Promise<void>;
  /** Make an existing entry a reparse point (junction). */
  makeReparse(path: FsPath): Promise<void>;
  bytes(path: FsPath): Promise<Uint8Array>;
  exists(path: FsPath): Promise<boolean>;
  isFlushed(path: FsPath): Promise<boolean>;
  openHandles(): number;
  editFile(path: FsPath, data: Uint8Array, options?: { preserveMtime?: boolean }): Promise<FsResult<void>>;
  forceEditFile(path: FsPath, data: Uint8Array): Promise<void>;
  replaceFile(path: FsPath, data: Uint8Array): Promise<FsResult<void>>;
  forceReplaceFile(path: FsPath, data: Uint8Array): Promise<void>;
  replaceDirectory(path: FsPath): Promise<FsResult<void>>;
  forceReplaceDirectory(path: FsPath): Promise<void>;
  changeVolume(scope: ScopeId, serial: string): Promise<void>;
  /** Make the file's ChangeTime unknown to inspection. */
  unknownChangeTime(path: FsPath): Promise<void>;
  /** Run an action just before the next named Fs operation. */
  beforeNext(operation: string, action: () => void | Promise<void>): void;
  /** The adapter's process dies: every handle it held is closed; the files stay as they are. */
  crashProcess(): Promise<FsResult<void>>;
  /** Called after each case: release helpers, temp roots. */
  dispose(): Promise<void>;
}

export const bytes = (s: string) => new TextEncoder().encode(s), text = (b: Uint8Array) => new TextDecoder().decode(b);
export function value<T>(r: FsResult<T>): T {
  assert.equal(r.ok, true, JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (!r.ok) throw Error("refused");
  return r.value;
}
export function refused<T>(r: FsResult<T>, code: string) {
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, code); assert.equal(r.effect, "none"); }
}

export const CONTRACT_IDS = ["FS02", "FS03", "FS04", "FS06", "FS07", "FS09", "FS10", "FS11", "FS12", "FS14", "FS15", "FS16", "FS18", "FS19", "FS20", "FS21", "FS22", "FS23", "FS27", "FS30", "FS31", "FS32"] as const;

/** Register the contract cases. `label` is appended to every test name (the Windows run tags platform, implementation and helper hash). */
export function runFsContract(makeHarness: () => Harness | Promise<Harness>, label = "") {
  const check = (id: string, name: string, fn: (h: Harness) => Promise<void> | void) => test(`${id} ${name}${label}`, async () => {
    const h = await makeHarness();
    try { await fn(h); } finally { await h.dispose(); }
  });
  let fixtures = 0;
  async function fixture(h: Harness) {
    const scope = h.seedScope(`synthetic-volume-${++fixtures}`); // a fresh volume and tree per call, as the memory suite made a fresh model per iteration
    const src = h.path(scope, "work", "note.md"), held = h.path(scope, "held", "copy.md");
    await h.seedDirectory(h.path(scope, "work"));
    await h.seedDirectory(h.path(scope, "held"));
    await h.seedFile(src, bytes("original"));
    return { fs: h.fs, scope, src, held };
  }
  async function guard(h: Harness, p: FsPath): Promise<FileGuard> {
    const s = value(await h.fs.inspect(p));
    assert(s.identity && s.parents);
    return { identity: s.identity, parents: { scope: p.scope, parents: s.parents } };
  }
  const parents = (h: Harness, p: FsPath) => h.parentGuard(p);
  async function open(h: Harness, p: FsPath, access: "read" | "read-delete" | "read-attributes" | "read-delete-attributes" = "read") {
    return value(await h.fs.openExclusive(p, await guard(h, p), access));
  }

  check("FS02", "exact file, volume and every parent are bound", async (h) => {
    for (const part of ["file", "volume", "root", "parent"]) {
      const { fs, src } = await fixture(h);
      const original = await guard(h, src), g = { identity: { ...original.identity }, parents: { scope: original.parents.scope, parents: original.parents.parents.map((p) => ({ segments: [...p.segments], identity: { ...p.identity } })) } };
      if (part === "file") g.identity.fileId = "wrong";
      if (part === "volume") g.identity.volumeSerial = "wrong";
      if (part === "root") g.parents.parents[0]!.identity.fileId = "wrong";
      if (part === "parent") g.parents.parents.at(-1)!.identity.fileId = "wrong";
      refused(await fs.openExclusive(src, g, "read"), part === "file" ? "identity-changed" : part === "volume" ? "volume-changed" : "parent-changed");
      assert.equal(h.openHandles(), 0);
    }
  });
  check("FS03", "same bytes at a replaced source name do not preserve identity", async (h) => {
    const { fs, src } = await fixture(h), g = await guard(h, src);
    await h.replaceFile(src, bytes("original"));
    refused(await fs.openExclusive(src, g, "read-delete"), "identity-changed");
    assert.equal(text(await h.bytes(src)), "original");
  });
  check("FS04", "replacement parent invalidates a previously recorded chain", async (h) => {
    const { fs, scope, src } = await fixture(h), g = await guard(h, src);
    await h.replaceDirectory(h.path(scope, "work"));
    refused(await fs.openExclusive(src, g, "read-delete"), "parent-changed");
  });
  check("FS06", "hard links fail custody while independent copies have new identities", async (h) => {
    const { fs, scope, src } = await fixture(h);
    await h.seedHardLink(src, h.path(scope, "work", "alias.md"));
    const g = await guard(h, src);
    refused(await fs.openExclusive(src, g, "read-delete"), "hard-linked");
    const independent = h.path(scope, "held", "independent.md");
    await h.seedFile(independent, await h.bytes(src));
    assert.notDeepEqual(value(await fs.inspect(independent)).identity, g.identity);
    assert.equal(value(await fs.inspect(independent)).hardLinks, 1);
  });
  check("FS07", "unsupported volumes and changed serial refuse with a positive alias control", async (h) => {
    for (const kind of ["network", "unknown", "other"] as const) {
      const scope = h.seedScope("v-" + kind, kind), p = h.path(scope, "n.md");
      await h.seedFile(p, bytes("x"));
      refused(await h.fs.openExclusive(p, await guard(h, p), "read"), "unsupported");
    }
    const { fs, scope, src } = await fixture(h), g = await guard(h, src);
    const alias = h.aliasScope(scope);
    assert.deepEqual(value(await fs.inspect(h.path(alias, "work", "note.md"))).identity, g.identity);
    await h.changeVolume(scope, "replacement-volume");
    refused(await fs.openExclusive(src, g, "read"), "volume-changed");
  });
  check("FS09", "held parent replacement is blocked and forced tampering is rechecked", async (h) => {
    const { fs, scope, src } = await fixture(h), hd = await open(h, src, "read-delete"), p = h.path(scope, "work");
    refused(await h.replaceDirectory(p), "in-use");
    await h.forceReplaceDirectory(p);
    refused(await fs.setDeleteDisposition(hd), "parent-changed");
    assert.equal(text(await h.bytes(src)), "original");
  });
  check("FS10", "create-new preserves existing normal empty identical linked or reparse entries", async (h) => {
    for (const kind of ["normal", "empty", "same", "link", "reparse"]) {
      const { fs, src, held } = await fixture(h);
      if (kind === "link") await h.seedHardLink(src, held);
      else if (kind === "reparse") await h.makeReparse(held);
      else await h.seedFile(held, bytes(kind === "empty" ? "" : kind === "same" ? "original" : "kept"));
      const before = kind === "reparse" ? null : await h.bytes(held);
      refused(await fs.createNew(held, await parents(h, held)), "already-exists");
      if (before) assert.deepEqual(await h.bytes(held), before);
      else assert.equal(value(await fs.inspect(held)).kind, "reparse");
    }
  });
  check("FS11", "created and returned byte buffers are independent", async (h) => {
    const { fs, src, held } = await fixture(h), input = bytes("independent"), hd = value(await fs.createNew(held, await parents(h, held)));
    value(await fs.appendCreated(hd, input));
    input.fill(0);
    const chunk = value(await fs.read(hd, 0, 64));
    assert.equal(text(chunk.bytes), "independent");
    chunk.bytes.fill(0);
    assert.equal(text(value(await fs.read(hd, 0, 64)).bytes), "independent");
    value(await fs.close(hd));
    value(await h.editFile(src, bytes("changed")));
    assert.equal(text(await h.bytes(held)), "independent");
  });
  check("FS12", "foreign forged closed and pre-crash handles never gain authority", async (h) => {
    const { fs, src, held } = await fixture(h), hd = await open(h, src);
    refused(await fs.appendCreated(hd as never, bytes("x")), "access-denied");
    refused(await fs.hash({} as never), "invalid-handle");
    const other = await makeHarness();
    try { await fixture(other); refused(await other.fs.hash(hd), "invalid-handle"); } finally { await other.dispose(); }
    value(await fs.close(hd));
    refused(await fs.hash(hd), "closed-handle");
    const c = value(await fs.createNew(held, await parents(h, held)));
    value(await h.crashProcess());
    refused(await fs.appendCreated(c, bytes("x")), "closed-handle");
  });
  check("FS14", "bound hashes do not silently follow source pathname replacement", async (h) => {
    const { fs, src } = await fixture(h), hd = await open(h, src);
    const old = value(await fs.hash(hd));
    assert.equal(old.bytes, 8);
    await h.forceReplaceFile(src, bytes("different"));
    refused(await fs.hash(hd), "identity-changed");
    assert.equal(text(await h.bytes(src)), "different");
  });
  check("FS15", "same size and restored mtime still changes ChangeTime", async (h) => {
    const { fs, src } = await fixture(h), before = value(await fs.inspect(src));
    value(await h.editFile(src, bytes("modified"), { preserveMtime: true }));
    const after = value(await fs.inspect(src));
    assert.equal(before.bytes, after.bytes);
    assert.equal(before.times.modified, after.times.modified);
    assert.notEqual(before.times.changed, after.times.changed);
    await h.unknownChangeTime(src);
    assert.equal(value(await fs.inspect(src)).times.changed, null);
  });
  check("FS16", "copying old mtime does not copy creation or identity", async (h) => {
    const { fs, src, held } = await fixture(h), a = value(await fs.inspect(src));
    await h.seedFile(held, await h.bytes(src), { modified: a.times.modified });
    const b = value(await fs.inspect(held));
    assert.equal(b.times.modified, a.times.modified);
    assert.notEqual(b.times.created, a.times.created);
    assert.notDeepEqual(b.identity, a.identity);
  });
  check("FS18", "read-only sealing requires attributes access and tampering remains detectable", async (h) => {
    const { fs, src } = await fixture(h), r = await open(h, src);
    refused(await fs.setReadOnly(r, true), "access-denied");
    value(await fs.close(r));
    const hd = await open(h, src, "read-attributes"), before = value(await fs.hash(hd));
    value(await fs.setReadOnly(hd, true));
    value(await fs.close(hd));
    refused(await h.editFile(src, bytes("new")), "read-only");
    await h.forceEditFile(src, bytes("tampered"));
    const again = await open(h, src);
    assert.notEqual(value(await fs.hash(again)).sha256, before.sha256);
  });
  check("FS19", "non-replacing placement preserves a target including a final-boundary race", async (h) => {
    for (const content of ["", "conflict"]) {
      const { fs, scope, held } = await fixture(h), dest = h.path(scope, "work", "restored.md"), hd = value(await fs.createNew(held, await parents(h, held)));
      value(await fs.appendCreated(hd, bytes("complete")));
      h.beforeNext("renameNoReplace", () => h.seedFile(dest, bytes(content)));
      refused(await fs.renameNoReplace(hd, dest, await parents(h, dest)), "already-exists");
      assert.equal(text(await h.bytes(dest)), content);
      assert.equal(text(await h.bytes(held)), "complete");
    }
  });
  check("FS20", "same-volume placement is complete and cross-volume never falls back", async (h) => {
    const { fs, scope, held } = await fixture(h), dest = h.path(scope, "work", "restored.md"), hd = value(await fs.createNew(held, await parents(h, held)));
    value(await fs.appendCreated(hd, bytes("complete")));
    const before = value(await fs.statHandle(hd));
    const other = h.seedScope("different"), cross = h.path(other, "target.md");
    refused(await fs.renameNoReplace(hd, cross, await parents(h, cross)), "cross-volume");
    assert.equal(text(await h.bytes(held)), "complete");
    assert.equal(await h.exists(cross), false);
    assert.deepEqual(value(await fs.renameNoReplace(hd, dest, await parents(h, dest))), before.identity);
    assert.equal(await h.exists(held), false);
    assert.equal(text(await h.bytes(dest)), "complete");
  });
  check("FS21", "destination parent guards are checked at the final boundary", async (h) => {
    const { fs, scope, held } = await fixture(h), dest = h.path(scope, "work", "restored.md"), hd = value(await fs.createNew(held, await parents(h, held))), g = await parents(h, dest);
    h.beforeNext("renameNoReplace", () => h.forceReplaceDirectory(h.path(scope, "work")));
    refused(await fs.renameNoReplace(hd, dest, g), "parent-changed");
    assert.equal(await h.exists(dest), false);
  });
  check("FS22", "disposition requires delete access and rechecks link safety", async (h) => {
    const { fs, scope, src } = await fixture(h), hd = await open(h, src);
    refused(await fs.setDeleteDisposition(hd), "access-denied");
    value(await fs.close(hd));
    const d = await open(h, src, "read-delete");
    await h.forceHardLink(src, h.path(scope, "work", "alias.md"));
    refused(await fs.setDeleteDisposition(d), "hard-linked");
    assert.equal(await h.exists(src), true);
  });
  check("FS23", "source has no delete-on-close; explicit disposition survives process crash", async (h) => {
    for (const disposition of [false, true]) {
      const { fs, src } = await fixture(h), hd = await open(h, src, "read-delete");
      if (disposition) value(await fs.setDeleteDisposition(hd));
      value(await h.crashProcess());
      assert.equal(await h.exists(src), !disposition);
      refused(await fs.hash(hd), "closed-handle");
    }
  });
  check("FS27", "ASCII aliases collide; unmodeled normalization explicitly refuses", async (h) => {
    const { fs, scope, src } = await fixture(h);
    assert.deepEqual(value(await fs.inspect(h.path(scope, "WORK", "NOTE.MD"))).identity, value(await fs.inspect(src)).identity);
    for (const segment of ["..", "a/b", "a\\b", "name.", "name ", "x:y"]) refused(await fs.inspect({ scope, segments: [segment] }), "path-invalid");
    refused(await fs.inspect({ scope, segments: ["界.md"] }), "unsupported");
  });
  check("FS30", "disposition cleanup reports uncertainty and preserves a substituted identity", async (h) => {
    const { fs, src } = await fixture(h), hd = await open(h, src, "read-delete");
    value(await fs.setDeleteDisposition(hd));
    await h.forceReplaceFile(src, bytes("replacement"));
    const result = await fs.close(hd);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.effect, "unknown"); assert.equal(result.code, "identity-changed"); }
    assert.equal(text(await h.bytes(src)), "replacement");
    assert.equal(h.openHandles(), 0);
  });
  check("FS31", "malformed parent segments cannot impersonate the complete chain", async (h) => {
    const { fs, scope } = await fixture(h), dir = h.path(scope, "work", "sub"), src = h.path(scope, "work", "sub", "deep.md");
    await h.seedDirectory(dir);
    await h.seedFile(src, bytes("deep"));
    const g = await guard(h, src), malformed = { ...g, parents: { ...g.parents, parents: g.parents.parents.map((p, i) => (i === 2 ? { ...p, segments: ["work/sub"] } : p)) } };
    refused(await fs.openExclusive(src, malformed, "read"), "parent-changed");
    const hd = await open(h, src);
    refused(await fs.read(hd, Number.MAX_SAFE_INTEGER, 2), "limit");
  });
  check("FS32", "bound SHA256 uses exact bytes and zero-length content", async (h) => {
    const scope = h.seedScope("v");
    for (const [name, content, digest] of [["empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"], ["abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]] as const) {
      const p = h.path(scope, name);
      await h.seedFile(p, bytes(content));
      const hd = await open(h, p);
      assert.deepEqual(value(await h.fs.hash(hd)), { sha256: digest, bytes: content.length });
    }
  });
}

/** The memory harness: MemoryFs's own fixture controls, one model per case. */
export function memoryHarness(): Harness {
  const fs = new MemoryFs();
  const sync = <T>(v: T) => Promise.resolve(v);
  return {
    fs,
    seedScope: (serial, kind) => fs.seedScope(serial, kind),
    aliasScope: (scope) => fs.aliasScope(scope),
    path: (scope, ...segments) => fs.path(scope, ...segments),
    parentGuard: (p) => sync(fs.parentGuardForTest(p)),
    seedDirectory: (p) => sync(fs.seedDirectory(p)),
    seedFile: (p, data, t) => sync(fs.seedFile(p, data, t)),
    seedHardLink: (s, t) => sync(fs.seedHardLink(s, t)),
    forceHardLink: (s, t) => sync(fs.forceHardLink(s, t)),
    makeReparse: (p) => { fs.seedFile(p, new Uint8Array()); fs.tamperMetadata(p, { reparse: true }); return sync(undefined); },
    bytes: (p) => sync(fs.bytesForTest(p)),
    exists: (p) => sync(fs.existsForTest(p)),
    isFlushed: (p) => sync(fs.isFlushedForTest(p)),
    openHandles: () => fs.modelState().openHandles,
    editFile: (p, data, o) => sync(fs.editFile(p, data, o)),
    forceEditFile: (p, data) => sync(fs.forceEditFile(p, data)),
    replaceFile: (p, data) => sync(fs.replaceFile(p, data)),
    forceReplaceFile: (p, data) => sync(fs.forceReplaceFile(p, data)),
    replaceDirectory: (p) => sync(fs.replaceDirectory(p)),
    forceReplaceDirectory: (p) => sync(fs.forceReplaceDirectory(p)),
    changeVolume: (scope, serial) => sync(fs.changeVolume(scope, serial)),
    unknownChangeTime: (p) => sync(fs.tamperMetadata(p, { changed: null })),
    beforeNext: (op, action) => fs.beforeNext(op as MemoryOperation, () => { void action(); }),
    crashProcess: () => sync(fs.crashProcess()),
    dispose: () => sync(undefined),
  };
}
