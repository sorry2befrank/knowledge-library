import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createApiHandler } from '@kl/api';
import { RateLimiter, sha256Hex } from '@kl/core';
import { canonicalJson } from '../packages/core/src/primitives/canonical.ts';
import { newCatalog, issueToken } from './helpers/load.ts';
import { PushJournal } from '../cli/kl/src/archive/journal.ts';
import { runArchiveWorkflow } from '../cli/kl/src/archive/workflow.ts';
import type { ArchiveRegistration } from '../cli/kl/src/archive/registration.ts';
import type { ArchiveScan } from '../cli/kl/src/archive/source.ts';
import { archiveChildEnv } from '../cli/kl/src/archive/source.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = resolve('.review', 'archive-checkpoint'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-')); if (!root.startsWith(parent + sep)) throw Error('fixture-escape'); roots.push(root);
  const { catalog } = newCatalog();
  catalog.db.run('INSERT INTO folders(folderId,device,volumeSerial,rootFileId,display_path_h,owner_principal,collectionId) VALUES (?,?,?,?,?,?,?)',
    ['folder:push-fixture', 'fixture-device', 'fixture-volume', 'fixture-root', '0'.repeat(64), 'frank', 'col:synth-desk']);
  const tokenA = issueToken(catalog, 'frank', 'kl-device', [], 'rotation-a');
  const tokenB = issueToken(catalog, 'frank', 'kl-device', [], 'rotation-b');
  const api = createApiHandler({ catalog, rateLimiter: new RateLimiter(10000) });
  const journalPath = join(root, 'kl.sqlite'); const journal = new PushJournal(journalPath);
  const registration: ArchiveRegistration = { schema: 'kl-archive-registration/v1', identityScheme: 'node-stat-v1', root: join(root, 'source'),
    identity: { volumeSerial: 'fixture-volume', fileId: 'fixture-root' }, folderId: 'folder:push-fixture', device: 'fixture-device',
    collectionId: 'col:synth-desk', privacyClass: 'team', apiOrigin: 'http://127.0.0.1:8787', libraryRepo: root,
    privacyCensusHash: '1'.repeat(64), approvalReceiptId: 'fixture-receipt', policyHash: '2'.repeat(64), policyEpoch: 1,
    registrationEpoch: 1, issuedAt: '2026-10-12T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', denyRules: catalog.denyRules };
  const scan = (text: string, extra = false): ArchiveScan => ({ files: Object.entries({ 'note.md': text, ...(extra ? { 'refused.md': 'synthetic withheld note' } : {}) }).map(([relPath, content]) => {
    const bytes = new TextEncoder().encode(content); return { relPath, bytes, sha256: sha256Hex(bytes), size: bytes.length,
      mtime: '2020-01-01T00:00:00.000Z', capturedAt: '2020-01-01T00:00:01.000Z', gitTracked: false,
      identity: { volumeSerial: 'fixture-volume', fileId: relPath }, changeTime: '1' };
  }), heldLocal: [], skipped: [], readErrors: [], complete: true });
  const wire: { entries: { relPath: string; lastKnownVer?: number }[]; snapshotId: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/manifest/diff') wire.push(JSON.parse(String(init!.body)));
    return api(new Request(String(input), init));
  };
  const run = (text: string, token = tokenA, extra = false, transport = fetcher) => runArchiveWorkflow({
    registration, scan: scan(text, extra), journal, token, fetch: transport, mode: 'push' });
  const rows = (sql: string) => { const db = new DatabaseSync(journalPath, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { root, journalPath, journal, registration, tokenA, tokenB, catalog, scan, wire, fetcher, run, rows };
}

describe('grant-independent checkpoints and isolated pending runs', () => {
  it.each(['token rotation', 'policy reacceptance'])('%s preserves current parents through two ordinary edits', async change => {
    const f = await fixture(); try {
      await f.run('# synthetic first version');
      if (change === 'policy reacceptance') f.registration.policyHash = '3'.repeat(64);
      const token = change === 'token rotation' ? f.tokenB : f.tokenA;
      const second = await f.run('# synthetic second version', token);
      const third = await f.run('# synthetic third version', token);
      expect(second.items[0]).toMatchObject({ status: 'current', ver: 2, stage: 'READBACK_OK' });
      expect(third.items[0]).toMatchObject({ status: 'current', ver: 3, stage: 'READBACK_OK' });
      expect(f.wire.map(x => x.entries[0]!.lastKnownVer)).toEqual([undefined, 1, 2]);
      expect(f.rows('SELECT ver FROM archive_versions')).toEqual([{ ver: 3 }]);
    } finally { f.journal.close(); }
  });
  it('a rotated token keeps the old parent for a divergent edit and never checkpoints the sibling', async () => {
    const f = await fixture(); try {
      await f.run('# synthetic first version'); await f.run('# synthetic remote change');
      const db = new DatabaseSync(f.journalPath); try { db.prepare('UPDATE archive_versions SET ver=1').run(); } finally { db.close(); }
      const result = await f.run('# synthetic divergent local edit', f.tokenB);
      expect(f.wire.at(-1)!.entries[0]!.lastKnownVer).toBe(1);
      expect(result.items[0]).toMatchObject({ status: 'sibling', stage: 'READBACK_OK' });
      expect(result.partial).toBe(true);
      expect(f.rows('SELECT ver FROM archive_versions')).toEqual([{ ver: 1 }]);
    } finally { f.journal.close(); }
  });
  it('a terminal refusal preserves its reason and checkpoints the verified neighboring item', async () => {
    const f = await fixture(); try {
      const transport: typeof fetch = async (input, init) => {
        if (new URL(String(input)).pathname === '/v1/commit') {
          const response = await f.fetcher(input, init); const body = await response.json() as { results: unknown[] };
          body.results[1] = { ok: false, n: 1, relPath: 'refused.md', status: 'refused', reason: 'withdrawn' };
          return Response.json({ ...body, partial: true });
        }
        return f.fetcher(input, init);
      };
      const first = await f.run('# synthetic first version', f.tokenA, true, transport);
      expect(first.items[1]).toMatchObject({ status: 'refused', reason: 'withdrawn', stage: 'UNPROVEN' });
      expect(first.partial).toBe(true);
      expect(f.rows('SELECT relPath,ver FROM archive_versions')).toEqual([{ relPath: 'note.md', ver: 1 }]);
      expect(f.rows("SELECT state FROM archive_runs")).toEqual([{ state: 'complete' }]);
      const next = await f.run('# synthetic second version', f.tokenA, true, transport);
      expect(next.items[0]).toMatchObject({ status: 'current', ver: 2 });
    } finally { f.journal.close(); }
  });
  it('pending runs never resume with a rotated grant', async () => {
    const f = await fixture(); try {
      const failReadback: typeof fetch = async (input, init) => new URL(String(input)).pathname.endsWith('/bytes') ? new Response(null, { status: 404 }) : f.fetcher(input, init);
      await f.run('# synthetic first version', f.tokenA, false, failReadback);
      await f.run('# synthetic first version', f.tokenB);
      expect(f.wire[1]!.snapshotId).not.toBe(f.wire[0]!.snapshotId);
      expect(f.rows("SELECT count(DISTINCT binding) AS n FROM archive_runs")[0]!.n).toBe(2);
    } finally { f.journal.close(); }
  });
  it('a real withdrawn item does not freeze current checkpoints or turn neighboring edits into proposals', async () => {
    const f = await fixture(); try {
      const first = await f.run('# synthetic first version',f.tokenA,true);
      f.catalog.db.run("UPDATE notes SET status='withdrawn' WHERE noteId=?",[first.items[1]!.noteId!]);
      const second = await f.run('# synthetic second version',f.tokenA,true);
      const third = await f.run('# synthetic third version',f.tokenA,true);
      expect(second.items[1]).toMatchObject({status:'refused',reason:'withdrawn',stage:'UNPROVEN'});
      expect(third.items[1]).toMatchObject({status:'refused',reason:'withdrawn'});
      expect(second.items[0]).toMatchObject({status:'current',ver:2,stage:'READBACK_OK'});
      expect(third.items[0]).toMatchObject({status:'current',ver:3,stage:'READBACK_OK'});
      expect(third.partial).toBe(true);
      expect(f.rows("SELECT ver FROM archive_versions WHERE relPath='note.md'")).toEqual([{ver:3}]);
      expect(f.catalog.db.get<{n:number}>("SELECT count(*) AS n FROM text_pushes WHERE state='open'")!.n).toBe(0);
    } finally { f.journal.close(); }
  });
  it.each(['folderId','device','root','apiOrigin','collectionId'] as const)('never carries a checkpoint across a %s registration change', async field => {
    const f = await fixture(); try {
      await f.run('# synthetic first version');
      f.registration[field] += '-changed';
      let parent: number | undefined = 99;
      const stopped: typeof fetch = async (_input, init) => { parent = JSON.parse(String(init!.body)).entries[0].lastKnownVer; return new Response(null, { status: 400 }); };
      await expect(f.run('# synthetic second version', f.tokenA, false, stopped)).rejects.toThrow('archive-http-400');
      expect(parent).toBeUndefined();
    } finally { f.journal.close(); }
  });
  it('migrates only the reconstructable legacy grant/policy checkpoint, preserving unknown legacy rows', async () => {
    const f = await fixture(); try {
      await f.run('# synthetic first version');
      const r = f.registration;
      const legacyBinding = sha256Hex(canonicalJson({ folderId:r.folderId,device:r.device,root:r.root,origin:r.apiOrigin,
        collection:r.collectionId,policy:r.policyHash,grant:sha256Hex(f.tokenA) }));
      const db = new DatabaseSync(f.journalPath); try {
        db.prepare('UPDATE archive_versions SET binding=?').run(legacyBinding);
        db.prepare('INSERT INTO archive_versions(binding,relPath,noteId,ver,sha256) VALUES(?,?,?,?,?)').run('unknown-old-grant','other.md','0000000001',1,'a'.repeat(64));
      } finally { db.close(); }
      const result = await f.run('# synthetic second version');
      expect(result.items[0]).toMatchObject({ status:'current',ver:2 });
      expect(f.wire.at(-1)!.entries[0]!.lastKnownVer).toBe(1);
      expect(f.rows("SELECT relPath,ver FROM archive_versions WHERE binding='unknown-old-grant'")).toEqual([{relPath:'other.md',ver:1}]);
      expect(f.rows(`SELECT count(*) AS n FROM archive_versions WHERE binding='${legacyBinding}'`)[0]!.n).toBe(0);
    } finally { f.journal.close(); }
  });
  it.each(['held','refused','rerouted'] as const)('preserves a typed %s reason without treating it as custody/readback proof', async status => {
    const f = await fixture(); try {
      const transport: typeof fetch = async (input, init) => new URL(String(input)).pathname === '/v1/commit' ?
        Response.json({pushId:'synthetic-push',partial:true,results:[{ok:false,n:0,relPath:'note.md',status,reason:'review',ruleCodes:['lineage.uncertain']}]}) :
        new URL(String(input)).pathname === '/v1/manifest/diff' ? Response.json({pushId:'synthetic-push',missing:[]}) : f.fetcher(input,init);
      const result = await f.run('# synthetic withheld bytes',f.tokenA,false,transport);
      expect(result.items[0]).toMatchObject({status,reason:'review',ruleCodes:['lineage.uncertain'],stage:'UNPROVEN'});
      expect(result.partial).toBe(true); expect(result.counts.readbackVerified).toBe(0);
      expect(f.rows('SELECT count(*) AS n FROM archive_versions')[0]!.n).toBe(0);
      expect(f.rows('SELECT state FROM archive_runs')).toEqual([{state:'complete'}]);
    } finally { f.journal.close(); }
  });
  it('custody pending stays resumable with its typed reason', async () => {
    const f = await fixture(); try {
      const transport: typeof fetch = async input => new URL(String(input)).pathname === '/v1/commit' ?
        Response.json({pushId:'synthetic-push',partial:true,results:[{ok:false,n:0,relPath:'note.md',status:'pending',reason:'custody-pending'}]}) :
        Response.json({pushId:'synthetic-push',missing:[]});
      const result = await f.run('# synthetic pending bytes',f.tokenA,false,transport);
      expect(result.items[0]).toMatchObject({status:'pending',reason:'custody-pending',stage:'UNPROVEN'});
      expect(result.partial).toBe(true);
      expect(f.rows('SELECT state FROM archive_runs')).toEqual([{state:'pending'}]);
    } finally { f.journal.close(); }
  });
  it('concurrent clients for one local folder cannot both reach the network', async () => {
    const f = await fixture(); const secondJournal = new PushJournal(f.journalPath);
    let release!: () => void; let entered!: () => void;
    const gated = new Promise<void>(resolve => { release = resolve; });
    const atNetwork = new Promise<void>(resolve => { entered = resolve; });
    const delayed: typeof fetch = async (input, init) => { if (new URL(String(input)).pathname === '/v1/manifest/diff') { entered(); await gated; } return f.fetcher(input, init); };
    const first = f.run('# synthetic first version', f.tokenA, false, delayed);
    try {
      await atNetwork;
      let secondReachedNetwork = false;
      const second = runArchiveWorkflow({ registration: f.registration, scan: f.scan('# synthetic concurrent version'), journal: secondJournal,
        token: f.tokenB, fetch: async () => { secondReachedNetwork = true; throw Error('unexpected-network'); }, mode: 'sync' }).catch(error => error.message);
      expect(await second).toBe('archive-folder-busy'); expect(secondReachedNetwork).toBe(false);
    } finally { release(); await first; secondJournal.close(); f.journal.close(); }
  });
  it('the folder lock is released by process exit, without deleting or taking over a stale lock', async () => {
    const f = await fixture();
    const module = pathToFileURL(resolve('cli/kl/src/archive/journal.ts')).href;
    const key = sha256Hex(canonicalJson({origin:f.registration.apiOrigin,folderId:f.registration.folderId}));
    // An idle process does not retain an unreachable DatabaseSync owner. Root
    // this fixture's journal, then force GC before announcing the held lock.
    const child = spawn(process.execPath,['--expose-gc','--no-warnings=ExperimentalWarning','--input-type=module','-e',
      'const {PushJournal}=await import(process.argv[1]); const j=new PushJournal(process.argv[2]); j.lockFolder(process.argv[3]); globalThis.lockTestOwner=j; setImmediate(()=>{globalThis.gc(); setImmediate(()=>{globalThis.gc(); process.stdout.write("locked");});}); setInterval(()=>{},1000);',
      module,f.journalPath,key],{env:archiveChildEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    const exited=once(child,'exit');
    try {
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('synthetic-lock-child-timeout')),10_000);
        child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
        child.once('error',error=>{clearTimeout(timeout);reject(error);});
        child.once('exit',code=>{clearTimeout(timeout);reject(Error(`synthetic-lock-child-exited-${code}`));});
      });
      await expect(f.run('# synthetic locked version')).rejects.toThrow('archive-folder-busy');
      child.kill('SIGKILL');await exited;
      expect((await f.run('# synthetic unlocked version')).partial).toBe(false);
    } finally { if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await exited;f.journal.close(); }
  });
});
