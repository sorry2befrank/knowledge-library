// The memory model of the Fs port. The adapter-neutral cases live in test/helpers/fs-contract.ts and run here through the
// memory harness with the same IDs, names and assertions; the cases below need a memory-only control (crash points,
// tamperMetadata, openExternal, model limits, the flush generation).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MemoryFs, ModelCrash } from '../packages/core/src/fs/index.ts';
import type { FsResult, FsPath, FileGuard, ParentGuard } from '../packages/core/src/fs/index.ts';
import { runFsContract, memoryHarness } from './helpers/fs-contract.ts';
const bytes = (s: string) => new TextEncoder().encode(s), text = (b: Uint8Array) => new TextDecoder().decode(b);
function value<T>(r: FsResult<T>): T {
    assert.equal(r.ok, true, JSON.stringify(r, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    if (!r.ok)
        throw Error('refused');
    return r.value;
}
function refused<T>(r: FsResult<T>, code: string) {
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.code, code);
        assert.equal(r.effect, 'none');
    }
}
function fixture() {
    const fs = new MemoryFs(), scope = fs.seedScope('synthetic-volume');
    const src = fs.path(scope, 'work', 'note.md'), held = fs.path(scope, 'held', 'copy.md');
    fs.seedDirectory(fs.path(scope, 'work'));
    fs.seedDirectory(fs.path(scope, 'held'));
    fs.seedFile(src, bytes('original'));
    return { fs, scope, src, held };
}
async function guard(fs: MemoryFs, p: FsPath): Promise<FileGuard> {
    const s = value(await fs.inspect(p));
    assert(s.identity && s.parents);
    return { identity: s.identity, parents: { scope: p.scope, parents: s.parents } };
}
async function parents(fs: MemoryFs, p: FsPath): Promise<ParentGuard> {
    return fs.parentGuardForTest(p);
}
async function open(fs: MemoryFs, p: FsPath, access: 'read' | 'read-delete' | 'read-attributes' | 'read-delete-attributes' = 'read') {
    return value(await fs.openExclusive(p, await guard(fs, p), access));
}
function check(id: string, name: string, fn: () => Promise<void> | void) {
    test(id + ' ' + name, fn);
}
check('FS01', 'unknown metadata survives inspection and cannot authorize an open', async () => {
    const { fs, src } = fixture();
    fs.tamperMetadata(src, { identityKnown: false, changed: null, reparseKnown: null });
    const s = value(await fs.inspect(src));
    assert.equal(s.identity, null);
    assert.equal(s.times.changed, null);
    assert.equal(s.anyReparseComponent, null);
    const fake = { identity: { volumeSerial: 'synthetic-volume', fileId: 'invented' }, parents: fs.parentGuardForTest(src) };
    refused(await fs.openExclusive(src, fake, 'read'), 'unsupported');
});
check('FS05', 'reparse leaf, parent and unknown reparse metadata refuse', async () => {
    for (const where of ['leaf', 'parent', 'unknown']) {
        const { fs, scope, src } = fixture(), g = await guard(fs, src);
        fs.tamperMetadata(where === 'parent' ? fs.path(scope, 'work') : src, where === 'unknown' ? { reparseKnown: null } : { reparse: true });
        refused(await fs.openExclusive(src, g, 'read-delete'), where === 'unknown' ? 'unsupported' : 'reparse');
    }
});
check('FS08', 'all existing external readers or writers block exclusive custody', async () => {
    for (const access of [['read'], ['write'], ['delete']] as const) {
        const { fs, src } = fixture();
        const external = value(fs.openExternal(src, [...access], ['read', 'write', 'delete']));
        refused(await fs.openExclusive(src, await guard(fs, src), 'read-delete'), 'in-use');
        value(fs.closeExternal(external));
        const h = await open(fs, src);
        refused(await fs.openExclusive(src, await guard(fs, src), 'read'), 'in-use');
        refused(fs.openExternal(src, ['read'], ['read', 'write', 'delete']), 'in-use');
        value(await fs.close(h));
        value(fs.openExternal(src, ['read'], ['read', 'write', 'delete']));
    }
});
check('FS08B', 'external sharing checks both directions', () => {
    const { fs, src } = fixture();
    const first = value(fs.openExternal(src, ['read'], ['read', 'write']));
    refused(fs.openExternal(src, ['write'], ['write']), 'in-use');
    const second = value(fs.openExternal(src, ['write'], ['read']));
    value(fs.closeExternal(second));
    value(fs.closeExternal(first));
});
check('FS13', 'chunk, handle, node and byte bounds refuse without a partial append', async () => {
    const fs = new MemoryFs({ maxNodes: 3, maxHandles: 1, maxBytes: 4, maxChunk: 3 }), scope = fs.seedScope('v'), a = fs.path(scope, 'a.md'), b = fs.path(scope, 'b.md'), c = fs.path(scope, 'c.md');
    fs.seedFile(a, bytes('abc'));
    const h = await open(fs, a);
    refused(await fs.read(h, -1, 1), 'limit');
    refused(await fs.read(h, 0, 4), 'limit');
    refused(await fs.createNew(b, await parents(fs, b)), 'limit');
    value(await fs.close(h));
    const w = value(await fs.createNew(b, await parents(fs, b)));
    refused(await fs.appendCreated(w, bytes('xy')), 'limit');
    assert.equal(fs.bytesForTest(b).length, 0);
    value(await fs.close(w));
    refused(await fs.createNew(c, await parents(fs, c)), 'limit');
});
check('FS17', 'flush covers a particular generation and later append invalidates it', async () => {
    const { fs, held } = fixture(), h = value(await fs.createNew(held, await parents(fs, held)));
    value(await fs.appendCreated(h, bytes('a')));
    assert.equal(fs.isFlushedForTest(held), false);
    value(await fs.flushCreated(h));
    assert.equal(fs.isFlushedForTest(held), true);
    value(await fs.appendCreated(h, bytes('b')));
    assert.equal(fs.isFlushedForTest(held), false);
});
check('FS24', 'before versus after operation crash preserves actual state and lost acknowledgement', async () => {
    for (const at of ['before', 'after'] as const) {
        const { fs, held } = fixture();
        fs.crashNext('createNew', at);
        await assert.rejects(fs.createNew(held, await parents(fs, held)), (e: unknown) => e instanceof ModelCrash && e.at === at);
        assert.equal(fs.existsForTest(held), at === 'after');
        value(fs.crashProcess());
    }
});
check('FS25', 'rename after-step crash exposes completed placement and preserves conflicts', async () => {
    const { fs, scope, held } = fixture(), dest = fs.path(scope, 'work', 'restored.md'), h = value(await fs.createNew(held, await parents(fs, held)));
    value(await fs.appendCreated(h, bytes('complete')));
    fs.crashNext('renameNoReplace', 'after');
    await assert.rejects(fs.renameNoReplace(h, dest, await parents(fs, dest)), ModelCrash);
    value(fs.crashProcess());
    assert.equal(fs.existsForTest(held), false);
    assert.equal(text(fs.bytesForTest(dest)), 'complete');
});
check('FS26', 'power loss remains unsupported and cannot close or mutate handles', async () => {
    const { fs, src } = fixture(), h = await open(fs, src);
    const r = fs.crashPowerLoss();
    refused(r, 'unsupported');
    if (!r.ok)
        assert.equal(r.unsupported, 'power-loss');
    assert.equal(value(await fs.hash(h)).bytes, 8);
});
check('FS28', 'five-step model scenario leaves a verified copy at every injected boundary', async () => {
    const points = ['openExclusive', 'hash', 'createNew', 'appendCreated', 'flushCreated', 'close', 'setReadOnly', 'setDeleteDisposition'] as const;
    for (const op of points)
        for (const at of ['before', 'after'] as const) {
            const { fs, src, held } = fixture();
            const expected = await guard(fs, src), sg = await parents(fs, held);
            let verified = false;
            fs.crashNext(op, at);
            try {
                const source = value(await fs.openExclusive(src, expected, 'read-delete'));
                const digest = value(await fs.hash(source));
                const dst = value(await fs.createNew(held, sg));
                value(await fs.appendCreated(dst, value(await fs.read(source, 0, 64)).bytes));
                value(await fs.flushCreated(dst));
                value(await fs.close(dst));
                const check = await open(fs, held, 'read-attributes');
                assert.equal(value(await fs.hash(check)).sha256, digest.sha256);
                value(await fs.setReadOnly(check, true));
                value(await fs.close(check));
                verified = true;
                value(await fs.setDeleteDisposition(source));
                value(await fs.close(source));
            }
            catch (e) {
                assert(e instanceof ModelCrash);
            }
            value(fs.crashProcess());
            const sourcePresent = fs.existsForTest(src);
            if (!verified)
                assert.equal(sourcePresent, true, op + ':' + at);
            assert(sourcePresent || fs.existsForTest(held));
            if (!sourcePresent) {
                assert.equal(text(fs.bytesForTest(held)), 'original');
                assert.equal(fs.isFlushedForTest(held), true);
                assert.equal(value(await fs.inspect(held)).readOnly, true);
            }
        }
});
check('FS29', 'external-process holders survive a model process crash', async () => {
    const { fs, src } = fixture(), g = await guard(fs, src), external = value(fs.openExternal(src, ['read'], ['read', 'write', 'delete']));
    value(fs.crashProcess());
    assert.equal(fs.modelState().externalHandles, 1);
    refused(await fs.openExclusive(src, g, 'read-delete'), 'in-use');
    value(fs.closeExternal(external));
    value(await fs.openExclusive(src, g, 'read-delete'));
});
check('FS33', 'future supplied timestamps cannot make a later edit move ChangeTime backwards', async () => {
    const fs = new MemoryFs(), scope = fs.seedScope('v'), p = fs.path(scope, 'future.md');
    fs.seedFile(p, bytes('old'), { changed: 1000n, modified: 999n });
    const before = value(await fs.inspect(p));
    value(fs.editFile(p, bytes('new'), { preserveMtime: true }));
    const first = value(await fs.inspect(p));
    assert(first.times.changed !== null && first.times.changed > 1000n);
    assert.equal(first.times.modified, before.times.modified);
    fs.tamperMetadata(p, { changed: 5000n });
    value(fs.editFile(p, bytes('yet'), { preserveMtime: true }));
    const second = value(await fs.inspect(p));
    assert(second.times.changed !== null && second.times.changed > 5000n);
});

runFsContract(memoryHarness);
