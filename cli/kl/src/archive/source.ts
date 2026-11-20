// Read-only Node scanner for a pre-enrolled source. Its dev/ino binding is deliberately NOT a
// Win32 safeMove/volume-serial proof. It never follows reparse/symlink paths, reads ignore files,
// writes the source, or claims native removal eligibility. Every admitted file is hashed anew.
import { access, lstat, realpath, readdir, open, mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256Hex } from '../../../../packages/core/src/primitives/sha256.ts';
import { admit } from '../../../../packages/core/src/admission/guard.ts';
import { referenceProfile } from '../../../../packages/core/src/admission/reference-policy.ts';
import { ArchiveSourceError, archiveRootKey, isAuthenticatedArchiveRegistration, type ArchiveRegistration, type ArchiveRootIdentity } from './registration.ts';

export const ARCHIVE_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const ARCHIVE_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export interface ArchiveFile {
  relPath: string; bytes: Uint8Array; sha256: string; size: number; mtime: string; capturedAt: string;
  gitTracked: boolean; identity: ArchiveRootIdentity; changeTime: string;
}
export interface ArchiveScan {
  files: ArchiveFile[];
  heldLocal: { relPath: string; ruleCodes: string[] }[];
  skipped: { relPath: string; reason: string; kind: 'file' | 'directory' | 'other' }[];
  readErrors: { relPath: string; code: string }[];
  complete: boolean;
}
export interface ArchiveScanOptions { intoRepos?: boolean; now?: string; maxEntries?: number; maxSnapshotBytes?: number; maxTextBytes?: number; maxFiles?: number }
interface BoundDirectory { path: string; stat: BigIntStats }
const run = promisify(execFile);
const TEXT = new Set(['.md', '.markdown', '.txt']);
const EXCLUDED = new Set(['.git', '.obsidian', '.remember', 'node_modules']);
/** Local detectors need platform/path settings, never the caller's archive or cloud credentials. */
export function archiveChildEnv(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH','PATHEXT','SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL']);
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => allowed.has(name.toUpperCase()) && value !== undefined));
}
/** PATH directories only: Windows' current-directory executable lookup must not run source files. */
export async function archiveProgramOnPath(name: 'git' | 'gitleaks'): Promise<string | null> {
  const pathValue = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const item of pathValue.split(delimiter)) {
    const directory = item.replace(/^"|"$/g, '');
    if (!isAbsolute(directory)) continue;
    const path = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const actual = await realpath(path);
      if ((await lstat(actual)).isFile()) return actual;
    } catch { /* Other PATH directories may contain the installed executable. */ }
  }
  return null;
}
function equalIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return equalIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function identity(stat: BigIntStats): ArchiveRootIdentity {
  if (stat.ino <= 0n || stat.dev < 0n) throw new ArchiveSourceError('identity-unavailable');
  return { volumeSerial: `node-dev:${stat.dev}`, fileId: `node-ino:${stat.ino}` };
}
function sameRoot(a: ArchiveRootIdentity, b: ArchiveRootIdentity): boolean { return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId; }
function validName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\x00-\x1f\\/:]/.test(name) && !/[ .]$/.test(name);
}
async function bindParents(path: string): Promise<BoundDirectory[]> {
  const absolute = resolve(path), root = parse(absolute).root;
  if (!isAbsolute(path) || absolute.startsWith('\\\\')) throw new ArchiveSourceError('source-path-invalid');
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  if (segments.some(segment => !validName(segment))) throw new ArchiveSourceError('source-path-invalid');
  const result: BoundDirectory[] = [];
  for (let i = 0; i <= segments.length; i++) {
    const part = join(root, ...segments.slice(0, i));
    const stat = await lstat(part, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArchiveSourceError('source-reparse-or-not-directory');
    identity(stat);
    if (archiveRootKey(await realpath(part)) !== archiveRootKey(part)) throw new ArchiveSourceError('source-reparse-or-not-directory');
    result.push({ path: part, stat });
  }
  return result;
}
async function recheckParents(parents: readonly BoundDirectory[]): Promise<void> {
  for (const parent of parents) {
    const stat = await lstat(parent.path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !equalIdentity(stat, parent.stat) ||
        archiveRootKey(await realpath(parent.path)) !== archiveRootKey(parent.path)) throw new ArchiveSourceError('source-parent-changed');
  }
}
function requireRootBinding(parents: readonly BoundDirectory[], root: string, expected: ArchiveRootIdentity): void {
  const bound = parents.find(parent => archiveRootKey(parent.path) === archiveRootKey(root));
  if (!bound || !sameRoot(identity(bound.stat), expected)) throw new ArchiveSourceError('source-identity-mismatch');
}
/** Identity observation only. It grants no enrollment and writes no local state. */
export async function inspectArchiveRoot(root: string): Promise<ArchiveRootIdentity> {
  try { const parents = await bindParents(root); return identity(parents[parents.length - 1]!.stat); }
  catch (error) { if (error instanceof ArchiveSourceError) throw error; throw new ArchiveSourceError('source-unavailable'); }
}

/** A file is returned only after same-handle stat/read/stat and all-parent/path revalidation. */
async function stableRead(root: string, relPath: string, expectedRoot: ArchiveRootIdentity, maxTextBytes:number): Promise<{ bytes: Uint8Array; stat: BigIntStats }> {
  const path = join(root, ...relPath.split('/'));
  const parents = await bindParents(dirname(path));
  requireRootBinding(parents, root, expectedRoot);
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) throw new ArchiveSourceError('source-not-regular');
  if (before.size > BigInt(maxTextBytes)) throw new ArchiveSourceError('text-too-large');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!stable(opened, before) || !opened.isFile()) throw new ArchiveSourceError('source-changed');
    await recheckParents(parents);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxTextBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxTextBytes) throw new ArchiveSourceError('text-too-large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    await recheckParents(parents);
    if (!stable(before, after) || !stable(after, pathAfter) || pathAfter.isSymbolicLink() || !pathAfter.isFile() || BigInt(length) !== after.size) throw new ArchiveSourceError('source-changed');
    return { bytes: new Uint8Array(Buffer.concat(chunks)), stat: after };
  } finally { await handle.close(); }
}

interface GitView { tracked: Set<string> | null; root: string | null }
async function gitView(directory: string): Promise<GitView> {
  const gitProgram = await archiveProgramOnPath('git');
  if (!gitProgram) return { root: null, tracked: null };
  const env = archiveChildEnv();
  const options = { cwd: directory, encoding: 'utf8' as const, timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env };
  const prefix = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', directory];
  try {
    const repo = await run(gitProgram, [...prefix, 'rev-parse', '--show-toplevel'], options);
    const gitRoot = repo.stdout.trim();
    if (!isAbsolute(gitRoot) || /[\r\n\0]/.test(gitRoot)) return { root: null, tracked: null };
    const tracked = await run(gitProgram, [...prefix, 'ls-files', '-z', '--', '.'], options);
    // ls-files paths are relative to the invocation directory, including when inside a parent repo.
    return { root: resolve(gitRoot), tracked: new Set(tracked.stdout.split('\0').filter(Boolean)) };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string };
    if (failure.code === 128 && /not a git repository/i.test(failure.stderr ?? '')) return { root: null, tracked: new Set() };
    return { root: null, tracked: null };
  }
}

interface DetectorDirectory { path: string; assertEmpty(): Promise<void>; cleanup(): Promise<void> }
type CensusSource = Pick<ArchiveRegistration,'root'|'identity'|'collectionId'|'libraryRepo'|'denyRules'>;
async function detectorDirectory(registration: CensusSource): Promise<DetectorDirectory> {
  const repo = resolve(registration.libraryRepo), review = join(repo, '.review');
  const sourceKey = archiveRootKey(registration.root), reviewKey = archiveRootKey(review);
  if (reviewKey === sourceKey || reviewKey.startsWith(sourceKey.endsWith(sep) ? sourceKey : sourceKey + sep)) throw new ArchiveSourceError('detector-source-overlap');
  const repoParents = await bindParents(repo);
  try { await mkdir(review); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await recheckParents(repoParents);
  const reviewParents = await bindParents(review);
  await recheckParents(repoParents);
  const path = await mkdtemp(join(review, 'gitleaks-'));
  if (archiveRootKey(dirname(path)) !== reviewKey || !/^gitleaks-[A-Za-z0-9]+$/.test(relative(review, path))) throw new ArchiveSourceError('detector-directory-invalid');
  const parents = await bindParents(path);
  await recheckParents(reviewParents);
  const assertEmpty = async () => {
    await recheckParents(parents);
    if ((await readdir(path)).length !== 0) throw new ArchiveSourceError('detector-directory-not-empty');
  };
  await assertEmpty();
  return { path, assertEmpty, async cleanup() {
    // Remove only this still-bound empty directory; never recurse through its contents.
    await assertEmpty();
    await rmdir(path);
  } };
}

async function gitleaksAvailable(registration: CensusSource): Promise<{ program: string | null; status: 'absent' | 'ready' | 'unavailable'; directory?: DetectorDirectory }> {
  const program = await archiveProgramOnPath('gitleaks');
  if (!program) return { program, status: 'absent' };
  let directory: DetectorDirectory | undefined;
  try {
    directory = await detectorDirectory(registration);
    await run(program, ['version'], { cwd: directory.path, windowsHide: true, timeout: 10_000, maxBuffer: 4096, env: archiveChildEnv() });
    await directory.assertEmpty();
    return { program, directory, status: 'ready' };
  } catch {
    if (directory) await directory.cleanup();
    return { program, status: 'unavailable' };
  }
}
/** The optional detector reads exact stdin bytes, never source ignore/config files or reports. */
async function gitleaksCheck(program: string, bytes: Uint8Array, directory: DetectorDirectory): Promise<'clean' | 'held' | 'unavailable'> {
  try { await directory.assertEmpty(); } catch { return 'unavailable'; }
  const env = archiveChildEnv();
  env.GITLEAKS_CONFIG_TOML = '[extend]\nuseDefault = true\n';
  const result = await new Promise<'clean' | 'held' | 'unavailable'>(resolveCheck => {
    const child = spawn(program, ['stdin', '--no-banner', '--redact', '--exit-code', '10', '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path', process.platform === 'win32' ? 'NUL' : '/dev/null', '--timeout', '10'],
    { cwd: directory.path, windowsHide: true, env, stdio: ['pipe', 'ignore', 'ignore'] });
    let ended = false;
    const finish = (value: 'clean' | 'held' | 'unavailable') => { if (!ended) { ended = true; clearTimeout(timer); resolveCheck(value); } };
    const timer = setTimeout(() => { child.kill(); finish('unavailable'); }, 15_000);
    child.once('error', () => finish('unavailable'));
    child.once('close', code => finish(code === 0 ? 'clean' : code === 10 ? 'held' : 'unavailable'));
    child.stdin.on('error', () => { /* The exit/error result decides; no source bytes enter diagnostics. */ });
    child.stdin.end(bytes);
  });
  try { await directory.assertEmpty(); return result; } catch { return 'unavailable'; }
}

export async function scanArchiveSource(registration: ArchiveRegistration, options: ArchiveScanOptions = {}): Promise<ArchiveScan> {
  if (!isAuthenticatedArchiveRegistration(registration)) throw new ArchiveSourceError('registration-untrusted');
  return scanReadOnlySource(registration,options);
}

/** Owner preparation only: uses the same bounded scanner and accepted policy as
 * push, but cannot upload or return note contents and grants no registration. */
export async function scanArchiveCensus(source:CensusSource,options:ArchiveScanOptions={}) {
  const profile=referenceProfile(source.denyRules);
  if(!profile?.ready)throw new ArchiveSourceError('policy-unavailable');
  const result=await scanReadOnlySource(source,options);
  const files=result.files.map(file=>({relPath:file.relPath,sha256:file.sha256,size:file.size,identity:file.identity,
    changeTime:file.changeTime,outcome:'push',privacyClass:'owner-selected'}));
  for(const file of result.files)file.bytes.fill(0);
  return {contentAdmission:'measured' as const,policyHash:profile.policyHash,observedAt:options.now??new Date().toISOString(),
    complete:result.complete,files,heldLocal:result.heldLocal,skipped:result.skipped,readErrors:result.readErrors,
    counts:{push:files.length,bytes:files.reduce((n,f)=>n+f.size,0),held:result.heldLocal.length,skipped:result.skipped.length,readErrors:result.readErrors.length},
    detectorCoverage:'accepted-built-in-policy; gitleaks used only when installed'};
}

async function scanReadOnlySource(registration:CensusSource, options:ArchiveScanOptions):Promise<ArchiveScan> {
  const root = resolve(registration.root);
  const observed = await inspectArchiveRoot(root);
  if (!sameRoot(observed, registration.identity)) throw new ArchiveSourceError('source-identity-mismatch');
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new ArchiveSourceError('scan-time-invalid');
  const scan: ArchiveScan = { files: [], heldLocal: [], skipped: [], readErrors: [], complete: true };
  const maxEntries = options.maxEntries ?? 100_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) throw new ArchiveSourceError('scan-limit-invalid');
  const maxSnapshotBytes = options.maxSnapshotBytes ?? ARCHIVE_MAX_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > ARCHIVE_MAX_SNAPSHOT_BYTES) throw new ArchiveSourceError('scan-limit-invalid');
  const maxTextBytes = options.maxTextBytes ?? ARCHIVE_MAX_TEXT_BYTES;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > ARCHIVE_MAX_TEXT_BYTES) throw new ArchiveSourceError('scan-limit-invalid');
  const maxFiles = options.maxFiles ?? 10_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) throw new ArchiveSourceError('scan-limit-invalid');
  let entriesSeen = 0;
  let snapshotBytes = 0;
  const rootGit = await gitView(root);
  const gitleaks = await gitleaksAvailable(registration);
  const directories: BoundDirectory[] = [];
  const error = (relPath: string, code: string) => { scan.readErrors.push({ relPath, code }); scan.complete = false; };

  async function visit(relDir: string, inheritedRules: string[], git: GitView, gitBase: string): Promise<void> {
    const full = relDir ? join(root, ...relDir.split('/')) : root;
    let names: string[];
    try {
      const parents = await bindParents(full);
      requireRootBinding(parents, root, registration.identity);
      const bound = parents[parents.length - 1]!;
      directories.push(bound);
      names = (await readdir(full)).sort();
      await recheckParents(parents);
      if (relDir && names.some(name => name.toLowerCase() === '.git')) {
        if (!options.intoRepos) { scan.skipped.push({ relPath: relDir, kind: 'directory', reason: 'nested-repository' }); scan.complete = false; return; }
        git = await gitView(full); gitBase = relDir;
      }
    } catch { error(relDir || '.', 'directory-unreadable'); return; }
    for (const name of names) {
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (++entriesSeen > maxEntries) { error(relDir || '.', 'entry-limit'); return; }
      if (!validName(name)) { error(relPath, 'path-invalid'); continue; }
      let stat: BigIntStats;
      try { stat = await lstat(join(full, name), { bigint: true }); } catch { error(relPath, 'stat-unreadable'); continue; }
      if (stat.isSymbolicLink()) { scan.skipped.push({ relPath, kind: 'other', reason: 'reparse' }); scan.complete = false; continue; }
      if (stat.isDirectory()) {
        if (EXCLUDED.has(name.toLowerCase())) { scan.skipped.push({ relPath, kind: 'directory', reason: 'library-exclusion' }); continue; }
        const g = admit(registration.denyRules, { requestId: 'local-directory', content: '', path: `${relPath}/directory-probe.md`, requestedCollection: registration.collectionId });
        await visit(relPath, [...new Set([...inheritedRules, ...(g.outcome === 'admitted' ? [] : g.ruleCodes)])], git, gitBase);
        continue;
      }
      if (!stat.isFile()) { scan.skipped.push({ relPath, kind: 'other', reason: 'unsupported-file-kind' }); scan.complete = false; continue; }
      if (inheritedRules.length) { scan.heldLocal.push({ relPath, ruleCodes: inheritedRules }); continue; }
      const pathGuard = admit(registration.denyRules, { requestId: 'local-path', content: '', path: relPath, requestedCollection: registration.collectionId });
      if (pathGuard.outcome !== 'admitted' || pathGuard.destination?.quarantine) { scan.heldLocal.push({ relPath, ruleCodes: pathGuard.ruleCodes }); continue; }
      if (!TEXT.has(extname(name).toLowerCase())) { scan.skipped.push({ relPath, kind: 'file', reason: 'unsupported-type' }); continue; }
      if (scan.files.length >= maxFiles) { error(relPath, 'manifest-entry-limit'); continue; }
      if (!git.tracked) { error(relPath, 'git-state-unknown'); continue; }
      if (stat.size > BigInt(maxSnapshotBytes - snapshotBytes)) { error(relPath, 'snapshot-byte-limit'); continue; }
      try {
        const read = await stableRead(root, relPath, registration.identity, maxTextBytes);
        if (read.bytes.length > maxSnapshotBytes - snapshotBytes) { error(relPath, 'snapshot-byte-limit'); continue; }
        // Reject malformed text, but retain the original exact bytes, including BOM/CRLF.
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
        const g = admit(registration.denyRules, { requestId: 'local-file', content: read.bytes, path: relPath, requestedCollection: registration.collectionId });
        if (g.outcome !== 'admitted' || g.destination?.quarantine || g.destination?.collection !== registration.collectionId) {
          scan.heldLocal.push({ relPath, ruleCodes: g.ruleCodes.length ? g.ruleCodes : ['destination.not-allowed'] }); continue;
        }
        const leakCheck = gitleaks.status === 'ready' ? await gitleaksCheck(gitleaks.program!, read.bytes, gitleaks.directory!) : gitleaks.status === 'absent' ? 'clean' : 'unavailable';
        if (leakCheck === 'held') { scan.heldLocal.push({ relPath, ruleCodes: ['secret.gitleaks'] }); continue; }
        if (leakCheck !== 'clean') { error(relPath, 'gitleaks-unavailable'); continue; }
        const trackedPath = gitBase ? relPath.slice(gitBase.length + 1) : relPath;
        snapshotBytes += read.bytes.length;
        scan.files.push({ relPath, bytes: read.bytes, sha256: sha256Hex(read.bytes), size: read.bytes.length,
          mtime: new Date(Number(read.stat.mtimeMs)).toISOString(), capturedAt: now, gitTracked: git.tracked.has(trackedPath),
          identity: identity(read.stat), changeTime: read.stat.ctimeNs.toString() });
      } catch (failure) { error(relPath, failure instanceof ArchiveSourceError ? failure.code : 'file-unreadable-or-invalid-text'); }
    }
  }
  try {
  await visit('', [], rootGit, '');
  // Changed directory entries mean absence/move inference is unsafe for this snapshot.
  for (const directory of directories) {
    try { const after = await lstat(directory.path, { bigint: true }); if (!stable(directory.stat, after) || after.isSymbolicLink()) error(relative(root, directory.path).split(sep).join('/') || '.', 'directory-changed'); }
    catch { error(relative(root, directory.path).split(sep).join('/') || '.', 'directory-changed'); }
  }
  if (!sameRoot(await inspectArchiveRoot(root), registration.identity)) throw new ArchiveSourceError('source-identity-mismatch');
  return scan;
  } finally { if (gitleaks.directory) await gitleaks.directory.cleanup(); }
}
