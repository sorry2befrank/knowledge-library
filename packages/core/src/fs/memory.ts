// Portable synthetic model. No host filesystem, native calls, clock, network, or policy authority.
import { sha256Hex } from '../primitives/sha256.ts';
import type { Access, CreatedHandle, FileGuard, FileHandle, FileIdentity, FileTimes, Fs, FsCode, FsPath, FsResult, Handle, HandleSnapshot, ParentGuard, ParentIdentity, PathSnapshot, ReadChunk, ScopeId, UnsupportedFeature, VolumeKind } from './fs.ts';
type Right = 'read' | 'write' | 'delete';
type Node = {
    id: FileIdentity;
    kind: 'file' | 'directory';
    data: Uint8Array;
    links: number | null;
    identityKnown: boolean;
    reparse: boolean;
    reparseKnown: boolean | null;
    readOnly: boolean;
    times: FileTimes;
    generation: number;
    flushed: number | null;
};
type Volume = {
    serial: string;
    kind: VolumeKind;
    entries: Map<string, Node>;
};
type Location = {
    scope: ScopeId;
    volume: Volume;
    segments: string[];
    key: string;
};
type Bound = {
    token: Handle;
    epoch: number;
    closed: boolean;
    created: boolean;
    access: Access;
    node: Node;
    location: Location;
    expected: FileGuard;
    disposition: boolean;
};
type External = {
    node: Node;
    access: Set<Right>;
    share: Set<Right>;
    closed: boolean;
};
export type MemoryOperation = 'inspect' | 'openExclusive' | 'createNew' | 'statHandle' | 'read' | 'hash' | 'appendCreated' | 'flushCreated' | 'setReadOnly' | 'renameNoReplace' | 'setDeleteDisposition' | 'close';
type Injection = {
    operation: MemoryOperation;
    at: 'before' | 'after';
    action: () => void;
};
export class ModelCrash extends Error {
    readonly operation: MemoryOperation;
    readonly at: 'before' | 'after';
    constructor(operation: MemoryOperation, at: 'before' | 'after') {
        super('modeled-process-crash');
        this.name = 'ModelCrash';
        this.operation = operation;
        this.at = at;
    }
}
type Limits = {
    maxNodes: number;
    maxHandles: number;
    maxBytes: number;
    maxChunk: number;
};
type Metadata = {
    identityKnown?: boolean;
    changed?: bigint | null;
    modified?: bigint | null;
    reparse?: boolean;
    reparseKnown?: boolean | null;
    links?: number | null;
};
const ok = <T>(value: T): FsResult<T> => ({ ok: true, value });
const bad = <T = never>(code: FsCode, unsupported?: UnsupportedFeature): FsResult<T> => ({ ok: false, code, effect: 'none', ...(unsupported ? { unsupported } : {}) });
const copyId = (id: FileIdentity): FileIdentity => ({ ...id });
const sameId = (a: FileIdentity, b: FileIdentity) => a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
const cloneParents = (p: ParentGuard): ParentGuard => ({ scope: p.scope, parents: p.parents.map(x => ({ segments: [...x.segments], identity: copyId(x.identity) })) });
export class MemoryFs implements Fs {
    readonly implementation = 'memory-model' as const;
    readonly #limits: Limits;
    readonly #scopes = new Map<ScopeId, Volume>();
    readonly #nodes = new Set<Node>();
    readonly #handles = new WeakMap<object, Bound>();
    readonly #live = new Set<Bound>();
    readonly #external = new Map<object, External>();
    #counter = 0;
    #scopeCounter = 0;
    #clock = 0n;
    #epoch = 0;
    #injection: Injection | null = null;
    constructor(limits: Partial<Limits> = {}) {
        this.#limits = { maxNodes: 512, maxHandles: 64, maxBytes: 1048576, maxChunk: 65536, ...limits };
        for (const n of Object.values(this.#limits))
            if (!Number.isSafeInteger(n) || n < 1)
                throw Error('invalid-model-limit');
    }
    #time() {
        return ++this.#clock;
    }
    #adoptTimes(times: FileTimes) {
        for (const t of Object.values(times)) {
            if (t !== null && typeof t !== 'bigint')
                throw Error('invalid-model-time');
            if (t !== null && t > this.#clock)
                this.#clock = t;
        }
    }
    #usedBytes() {
        let count = 0;
        for (const n of this.#nodes)
            count += n.data.length;
        return count;
    }
    #countHandles() {
        return this.#live.size + [...this.#external.values()].filter(x => !x.closed).length;
    }
    #newNode(volume: Volume, kind: 'file' | 'directory', data: Uint8Array): Node {
        if (this.#nodes.size >= this.#limits.maxNodes || this.#usedBytes() + data.length > this.#limits.maxBytes)
            throw Error('model-seed-limit');
        const time = this.#time(), node: Node = { id: { volumeSerial: volume.serial, fileId: 'model-node-' + (++this.#counter) }, kind, data: new Uint8Array(data), links: 1, identityKnown: true, reparse: false, reparseKnown: true, readOnly: false, times: { created: time, modified: time, changed: time }, generation: 1, flushed: 1 };
        this.#nodes.add(node);
        return node;
    }
    #loc(p: FsPath): FsResult<Location> {
        if (!p || !Array.isArray(p.segments) || typeof p.scope !== 'string')
            return bad('path-invalid');
        const volume = this.#scopes.get(p.scope);
        if (!volume)
            return bad('path-invalid');
        for (const s of p.segments) {
            if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[\\/:\u0000-\u001f]/.test(s) || /[. ]$/.test(s))
                return bad('path-invalid');
            if (!/^[\x20-\x7e]+$/.test(s) || s.length > 120)
                return bad('unsupported', 'path-normalization');
            if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
                return bad('path-invalid');
        }
        return ok({ scope: p.scope, volume, segments: [...p.segments], key: p.segments.map(x => x.toLowerCase()).join('/') });
    }
    #fixture(p: FsPath): Location {
        const r = this.#loc(p);
        if (!r.ok)
            throw Error('invalid-model-fixture');
        return r.value;
    }
    #parentNodes(l: Location): FsResult<{
        nodes: Node[];
        parents: ParentIdentity[];
    }> {
        const nodes: Node[] = [], parents: ParentIdentity[] = [];
        for (let length = 0; length < Math.max(1, l.segments.length); length++) {
            const segments = l.segments.slice(0, length), n = l.volume.entries.get(segments.map(x => x.toLowerCase()).join('/'));
            if (!n)
                return bad('not-found');
            if (n.kind !== 'directory')
                return bad('not-file');
            nodes.push(n);
            parents.push({ segments, identity: copyId(n.id) });
        }
        return ok({ nodes, parents });
    }
    #volume(l: Location): FsResult<void> {
        if (!['ntfs', 'refs'].includes(l.volume.kind))
            return bad('unsupported', 'volume');
        return ok(undefined);
    }
    #parents(l: Location, guard: ParentGuard): FsResult<Node[]> {
        const v = this.#volume(l);
        if (!v.ok)
            return v;
        const found = this.#parentNodes(l);
        if (!found.ok)
            return found;
        if (!guard || guard.scope !== l.scope || !Array.isArray(guard.parents) || guard.parents.length !== found.value.parents.length)
            return bad('parent-changed');
        for (let i = 0; i < found.value.parents.length; i++) {
            const expected = guard.parents[i], current = found.value.parents[i]!, node = found.value.nodes[i]!;
            if (!expected || !Array.isArray(expected.segments) || expected.segments.length !== current.segments.length || expected.segments.some((s: unknown, i: number) => typeof s !== 'string' || s.toLowerCase() !== current.segments[i]!.toLowerCase()) || !expected.identity)
                return bad('parent-changed');
            if (expected.identity.volumeSerial !== l.volume.serial)
                return bad('volume-changed');
            if (!node.identityKnown)
                return bad('unsupported', 'identity');
            if (node.reparseKnown === null)
                return bad('unsupported', 'parent-binding');
            if (node.reparse)
                return bad('reparse');
            if (!sameId(expected.identity, current.identity))
                return bad('parent-changed');
        }
        return ok(found.value.nodes);
    }
    #safeFile(l: Location, node: Node, expected: FileIdentity): FsResult<void> {
        if (!expected || expected.volumeSerial !== l.volume.serial)
            return bad('volume-changed');
        if (node.kind !== 'file')
            return bad('not-file');
        if (!node.identityKnown)
            return bad('unsupported', 'identity');
        if (node.reparseKnown === null)
            return bad('unsupported', 'parent-binding');
        if (node.reparse)
            return bad('reparse');
        if (!sameId(node.id, expected))
            return bad('identity-changed');
        if (node.links === null)
            return bad('unsupported', 'identity');
        if (node.links !== 1)
            return bad('hard-linked');
        return ok(undefined);
    }
    #nodeIsHeld(node: Node) {
        return [...this.#live].some(h => h.node === node || h.expected.parents.parents.some(p => sameId(p.identity, node.id))) || [...this.#external.values()].some(h => !h.closed && h.node === node);
    }
    #capacity(): FsResult<void> {
        return this.#countHandles() >= this.#limits.maxHandles ? bad('limit') : ok(undefined);
    }
    #mint(l: Location, node: Node, expected: FileGuard, access: Access, created: boolean): Handle {
        const token = Object.freeze({}) as Handle;
        const r: Bound = { token, epoch: this.#epoch, closed: false, created, access, node, location: { ...l, segments: [...l.segments] }, expected: { identity: copyId(expected.identity), parents: cloneParents(expected.parents) }, disposition: false };
        this.#handles.set(token, r);
        this.#live.add(r);
        return token;
    }
    #bound(handle: Handle, validate = true): FsResult<Bound> {
        if (!handle || typeof handle !== 'object')
            return bad('invalid-handle');
        const r = this.#handles.get(handle);
        if (!r)
            return bad('invalid-handle');
        if (r.closed || r.epoch !== this.#epoch)
            return bad('closed-handle');
        if (validate) {
            const p = this.#parents(r.location, r.expected.parents);
            if (!p.ok)
                return p;
            const current = r.location.volume.entries.get(r.location.key);
            if (current !== r.node)
                return bad('identity-changed');
            const safe = this.#safeFile(r.location, r.node, r.expected.identity);
            if (!safe.ok)
                return safe;
        }
        return ok(r);
    }
    #changed(node: Node, modified = true) {
        node.generation++;
        node.times = { ...node.times, changed: this.#time(), ...(modified ? { modified: this.#time() } : {}) };
    }
    #injected(op: MemoryOperation, at: 'before' | 'after') {
        const x = this.#injection;
        if (x?.operation === op && x.at === at) {
            this.#injection = null;
            x.action();
        }
    }
    async #run<T>(op: MemoryOperation, fn: () => FsResult<T>): Promise<FsResult<T>> {
        this.#injected(op, 'before');
        const result = fn();
        if (result.ok)
            this.#injected(op, 'after');
        return result;
    }
    #snapshot(l: Location, n: Node): PathSnapshot {
        const p = this.#parentNodes(l), nodes = p.ok ? [...p.value.nodes, n] : [n], unknown = nodes.some(x => x.reparseKnown === null);
        return { path: { scope: l.scope, segments: [...l.segments] }, kind: n.reparse ? 'reparse' : n.kind, identity: n.identityKnown ? copyId(n.id) : null, parents: p.ok && p.value.nodes.every(x => x.identityKnown) ? p.value.parents : null, volumeKind: l.volume.kind, supportedLocalVolume: l.volume.kind === 'unknown' ? null : ['ntfs', 'refs'].includes(l.volume.kind), hardLinks: n.links, bytes: n.kind === 'file' ? n.data.length : null, readOnly: n.readOnly, times: { ...n.times }, anyReparseComponent: unknown ? null : nodes.some(x => x.reparse) };
    }
    inspect(path: FsPath) {
        return this.#run<PathSnapshot>('inspect', () => {
            const l = this.#loc(path);
            if (!l.ok)
                return l;
            const n = l.value.volume.entries.get(l.value.key);
            return n ? ok(this.#snapshot(l.value, n)) : bad('not-found');
        });
    }
    openExclusive(path: FsPath, expected: FileGuard, access: Access) {
        return this.#run<FileHandle>('openExclusive', () => {
            if (!['read', 'read-delete', 'read-attributes', 'read-delete-attributes'].includes(access))
                return bad('access-denied');
            const l = this.#loc(path);
            if (!l.ok)
                return l;
            const p = this.#parents(l.value, expected?.parents);
            if (!p.ok)
                return p;
            const n = l.value.volume.entries.get(l.value.key);
            if (!n)
                return bad('not-found');
            const safe = this.#safeFile(l.value, n, expected?.identity);
            if (!safe.ok)
                return safe;
            if (this.#nodeIsHeld(n) || p.value.some(x => [...this.#external.values()].some(e => !e.closed && e.node === x)))
                return bad('in-use');
            const cap = this.#capacity();
            if (!cap.ok)
                return cap;
            return ok(this.#mint(l.value, n, expected, access, false) as FileHandle);
        });
    }
    createNew(path: FsPath, expectedParents: ParentGuard) {
        return this.#run<CreatedHandle>('createNew', () => {
            const l = this.#loc(path);
            if (!l.ok)
                return l;
            const p = this.#parents(l.value, expectedParents);
            if (!p.ok)
                return p;
            if (l.value.volume.entries.has(l.value.key))
                return bad('already-exists');
            if (!l.value.segments.length)
                return bad('path-invalid');
            if (p.value.some(x => [...this.#external.values()].some(e => !e.closed && e.node === x)))
                return bad('in-use');
            const cap = this.#capacity();
            if (!cap.ok)
                return cap;
            if (this.#nodes.size >= this.#limits.maxNodes)
                return bad('limit');
            const n = this.#newNode(l.value.volume, 'file', new Uint8Array());
            n.flushed = null;
            l.value.volume.entries.set(l.value.key, n);
            return ok(this.#mint(l.value, n, { identity: n.id, parents: expectedParents }, 'read-delete-attributes', true) as CreatedHandle);
        });
    }
    statHandle(handle: Handle) {
        return this.#run<HandleSnapshot>('statHandle', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            const n = r.value.node;
            return ok({ identity: copyId(n.id), hardLinks: 1, bytes: n.data.length, readOnly: n.readOnly, times: { ...n.times } });
        });
    }
    read(handle: Handle, offset: number, maxBytes: number) {
        return this.#run<ReadChunk>('read', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.#limits.maxChunk || !Number.isSafeInteger(offset + maxBytes))
                return bad('limit');
            return ok({ bytes: new Uint8Array(r.value.node.data.slice(offset, offset + maxBytes)), eof: offset + maxBytes >= r.value.node.data.length });
        });
    }
    hash(handle: Handle) {
        return this.#run<{
            sha256: string;
            bytes: number;
        }>('hash', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            return ok({ sha256: sha256Hex(r.value.node.data), bytes: r.value.node.data.length });
        });
    }
    appendCreated(handle: CreatedHandle, bytes: Uint8Array) {
        return this.#run<void>('appendCreated', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (!r.value.created)
                return bad('access-denied');
            if (r.value.node.readOnly)
                return bad('read-only');
            if (!(bytes instanceof Uint8Array) || bytes.length > this.#limits.maxChunk || this.#usedBytes() + bytes.length > this.#limits.maxBytes)
                return bad('limit');
            const previous = r.value.node.data, combined = new Uint8Array(previous.length + bytes.length);
            combined.set(previous);
            combined.set(bytes, previous.length);
            r.value.node.data = combined;
            this.#changed(r.value.node);
            return ok(undefined);
        });
    }
    flushCreated(handle: CreatedHandle) {
        return this.#run<void>('flushCreated', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (!r.value.created)
                return bad('access-denied');
            r.value.node.flushed = r.value.node.generation;
            return ok(undefined);
        });
    }
    setReadOnly(handle: Handle, value: boolean) {
        return this.#run<void>('setReadOnly', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (typeof value !== 'boolean' || !r.value.access.includes('attributes'))
                return bad('access-denied');
            r.value.node.readOnly = value;
            r.value.node.times = { ...r.value.node.times, changed: this.#time() };
            return ok(undefined);
        });
    }
    renameNoReplace(handle: Handle, destination: FsPath, expectedParents: ParentGuard) {
        return this.#run<FileIdentity>('renameNoReplace', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (!r.value.access.includes('delete') || r.value.disposition)
                return bad('access-denied');
            const l = this.#loc(destination);
            if (!l.ok)
                return l;
            if (l.value.volume !== r.value.location.volume || l.value.volume.serial !== r.value.node.id.volumeSerial)
                return bad('cross-volume');
            const p = this.#parents(l.value, expectedParents);
            if (!p.ok)
                return p;
            if (l.value.volume.entries.has(l.value.key))
                return bad('already-exists');
            if (!l.value.segments.length)
                return bad('path-invalid');
            if (p.value.some(x => [...this.#external.values()].some(e => !e.closed && e.node === x)))
                return bad('in-use');
            r.value.location.volume.entries.delete(r.value.location.key);
            l.value.volume.entries.set(l.value.key, r.value.node);
            r.value.location = l.value;
            r.value.expected = { identity: copyId(r.value.node.id), parents: cloneParents(expectedParents) };
            r.value.node.times = { ...r.value.node.times, changed: this.#time() };
            return ok(copyId(r.value.node.id));
        });
    }
    setDeleteDisposition(handle: FileHandle) {
        return this.#run<void>('setDeleteDisposition', () => {
            const r = this.#bound(handle);
            if (!r.ok)
                return r;
            if (r.value.created || !r.value.access.includes('delete'))
                return bad('access-denied');
            if (r.value.node.readOnly)
                return bad('read-only');
            r.value.disposition = true;
            return ok(undefined);
        });
    }
    #close(r: Bound): FsResult<void> {
        let result: FsResult<void> = ok(undefined);
        if (r.disposition) {
            const current = this.#bound(r.token);
            if (!current.ok)
                result = { ...current, effect: 'unknown' };
            else {
                r.location.volume.entries.delete(r.location.key);
                r.node.links = 0;
                this.#nodes.delete(r.node);
            }
        }
        r.closed = true;
        this.#live.delete(r);
        return result;
    }
    close(handle: Handle) {
        return this.#run<void>('close', () => {
            const r = this.#bound(handle, false);
            return r.ok ? this.#close(r.value) : r;
        });
    }
    // Fixture controls below are deliberately absent from Fs. They operate on memory only.
    seedScope(serial: string, kind: VolumeKind = 'ntfs'): ScopeId {
        if (!serial || [...this.#scopes.values()].some(v => v.serial === serial))
            throw Error('model-volume-required');
        const id = ('model-scope-' + (++this.#scopeCounter)) as ScopeId, volume: Volume = { serial, kind, entries: new Map() };
        volume.entries.set('', this.#newNode(volume, 'directory', new Uint8Array()));
        this.#scopes.set(id, volume);
        return id;
    }
    aliasScope(scope: ScopeId): ScopeId {
        const volume = this.#scopes.get(scope);
        if (!volume)
            throw Error('unknown-model-scope');
        const id = ('model-scope-' + (++this.#scopeCounter)) as ScopeId;
        this.#scopes.set(id, volume);
        return id;
    }
    path(scope: ScopeId, ...segments: string[]): FsPath {
        return Object.freeze({ scope, segments: Object.freeze([...segments]) });
    }
    parentGuardForTest(path: FsPath): ParentGuard {
        const l = this.#fixture(path), p = this.#parentNodes(l);
        if (!p.ok)
            throw Error('invalid-model-parents');
        return { scope: path.scope, parents: p.value.parents };
    }
    seedDirectory(path: FsPath) {
        const l = this.#fixture(path);
        if (!l.segments.length || l.volume.entries.has(l.key) || !this.#parentNodes(l).ok)
            throw Error('invalid-model-directory');
        l.volume.entries.set(l.key, this.#newNode(l.volume, 'directory', new Uint8Array()));
    }
    seedFile(path: FsPath, data: Uint8Array, times: Partial<FileTimes> = {}) {
        const l = this.#fixture(path);
        if (!l.segments.length || l.volume.entries.has(l.key) || !this.#parentNodes(l).ok)
            throw Error('invalid-model-file');
        const n = this.#newNode(l.volume, 'file', data);
        n.times = { ...n.times, ...times };
        this.#adoptTimes(n.times);
        l.volume.entries.set(l.key, n);
    }
    bytesForTest(path: FsPath) {
        const l = this.#fixture(path), n = l.volume.entries.get(l.key);
        if (!n || n.kind !== 'file')
            throw Error('model-file-missing');
        return new Uint8Array(n.data);
    }
    existsForTest(path: FsPath) {
        const l = this.#fixture(path);
        return l.volume.entries.has(l.key);
    }
    isFlushedForTest(path: FsPath) {
        const l = this.#fixture(path), n = l.volume.entries.get(l.key);
        return !!n && n.flushed === n.generation;
    }
    modelState() {
        return { openHandles: this.#live.size, externalHandles: [...this.#external.values()].filter(x => !x.closed).length, nodes: this.#nodes.size, bytes: this.#usedBytes(), epoch: this.#epoch };
    }
    tamperMetadata(path: FsPath, metadata: Metadata) {
        const l = this.#fixture(path), n = l.volume.entries.get(l.key);
        if (!n)
            throw Error('model-node-missing');
        if (metadata.identityKnown !== undefined)
            n.identityKnown = metadata.identityKnown;
        if ('changed' in metadata)
            n.times = { ...n.times, changed: metadata.changed! };
        if ('modified' in metadata)
            n.times = { ...n.times, modified: metadata.modified! };
        if (metadata.reparse !== undefined)
            n.reparse = metadata.reparse;
        if ('reparseKnown' in metadata)
            n.reparseKnown = metadata.reparseKnown!;
        if ('links' in metadata)
            n.links = metadata.links!;
        this.#adoptTimes(n.times);
    }
    changeVolume(scope: ScopeId, serial: string) {
        const volume = this.#scopes.get(scope);
        if (!volume || !serial)
            throw Error('model-volume-missing');
        volume.serial = serial;
        for (const n of new Set(volume.entries.values()))
            n.id = { ...n.id, volumeSerial: serial };
    }
    openExternal(path: FsPath, access: readonly Right[], share: readonly Right[]): FsResult<object> {
        const l = this.#loc(path);
        if (!l.ok)
            return l;
        const n = l.value.volume.entries.get(l.value.key);
        if (!n)
            return bad('not-found');
        if (!access.length || [...access, ...share].some(x => !['read', 'write', 'delete'].includes(x)))
            return bad('access-denied');
        if (this.#nodeIsHeldByModel(n))
            return bad('in-use');
        for (const e of this.#external.values())
            if (!e.closed && e.node === n && (access.some(x => !e.share.has(x)) || [...e.access].some(x => !share.includes(x))))
                return bad('in-use');
        const cap = this.#capacity();
        if (!cap.ok)
            return cap;
        const token = Object.freeze({});
        this.#external.set(token, { node: n, access: new Set(access), share: new Set(share), closed: false });
        return ok(token);
    }
    #nodeIsHeldByModel(n: Node) {
        return [...this.#live].some(h => h.node === n || h.expected.parents.parents.some(p => sameId(p.identity, n.id)));
    }
    closeExternal(token: object): FsResult<void> {
        const e = this.#external.get(token);
        if (!e)
            return bad('invalid-handle');
        if (e.closed)
            return bad('closed-handle');
        e.closed = true;
        return ok(undefined);
    }
    editFile(path: FsPath, data: Uint8Array, options: {
        preserveMtime?: boolean;
    } = {}): FsResult<void> {
        const l = this.#fixture(path), n = l.volume.entries.get(l.key);
        if (!n || n.kind !== 'file')
            return bad('not-found');
        if (this.#nodeIsHeld(n))
            return bad('in-use');
        if (n.readOnly)
            return bad('read-only');
        if (this.#usedBytes() - n.data.length + data.length > this.#limits.maxBytes)
            return bad('limit');
        const mtime = n.times.modified;
        n.data = new Uint8Array(data);
        this.#changed(n);
        if (options.preserveMtime)
            n.times = { ...n.times, modified: mtime };
        return ok(undefined);
    }
    forceEditFile(path: FsPath, data: Uint8Array) {
        const l = this.#fixture(path), n = l.volume.entries.get(l.key);
        if (!n || n.kind !== 'file' || this.#usedBytes() - n.data.length + data.length > this.#limits.maxBytes)
            throw Error('invalid-model-edit');
        n.data = new Uint8Array(data);
        this.#changed(n);
    }
    #replace(path: FsPath, kind: 'file' | 'directory', data: Uint8Array, force: boolean): FsResult<void> {
        const l = this.#fixture(path), old = l.volume.entries.get(l.key);
        if (!old || old.kind !== kind)
            return bad('not-found');
        if (!force && this.#nodeIsHeld(old))
            return bad('in-use');
        if (this.#nodes.size >= this.#limits.maxNodes || this.#usedBytes() + data.length > this.#limits.maxBytes)
            return bad('limit');
        l.volume.entries.set(l.key, this.#newNode(l.volume, kind, data));
        return ok(undefined);
    }
    replaceFile(path: FsPath, data: Uint8Array) {
        return this.#replace(path, 'file', data, false);
    }
    forceReplaceFile(path: FsPath, data: Uint8Array) {
        const r = this.#replace(path, 'file', data, true);
        if (!r.ok)
            throw Error('invalid-model-replacement');
    }
    replaceDirectory(path: FsPath) {
        return this.#replace(path, 'directory', new Uint8Array(), false);
    }
    forceReplaceDirectory(path: FsPath) {
        const r = this.#replace(path, 'directory', new Uint8Array(), true);
        if (!r.ok)
            throw Error('invalid-model-replacement');
    }
    seedHardLink(source: FsPath, target: FsPath) {
        const l = this.#fixture(source), n = l.volume.entries.get(l.key);
        if (n && this.#nodeIsHeld(n))
            throw Error('model-in-use');
        this.forceHardLink(source, target);
    }
    forceHardLink(source: FsPath, target: FsPath) {
        const a = this.#fixture(source), b = this.#fixture(target), n = a.volume.entries.get(a.key);
        if (!n || n.kind !== 'file' || a.volume !== b.volume || b.volume.entries.has(b.key) || !this.#parentNodes(b).ok || n.links === null)
            throw Error('invalid-model-hardlink');
        b.volume.entries.set(b.key, n);
        n.links++;
    }
    beforeNext(operation: MemoryOperation, action: () => void) {
        if (this.#injection)
            throw Error('model-injection-pending');
        this.#injection = { operation, at: 'before', action };
    }
    crashNext(operation: MemoryOperation, at: 'before' | 'after') {
        if (this.#injection)
            throw Error('model-injection-pending');
        this.#injection = { operation, at, action: () => {
                throw new ModelCrash(operation, at);
            } };
    }
    crashProcess(): FsResult<void> {
        let result: FsResult<void> = ok(undefined);
        for (const h of [...this.#live]) {
            const r = this.#close(h);
            if (!r.ok)
                result = r;
        }
        this.#epoch++;
        this.#injection = null;
        return result;
    }
    crashPowerLoss(): FsResult<void> {
        return bad('unsupported', 'power-loss');
    }
}
