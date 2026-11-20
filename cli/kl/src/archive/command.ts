import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { loadArchiveRegistration } from './registration.ts';
import { archiveChildEnv, archiveProgramOnPath, scanArchiveSource } from './source.ts';
import { PushJournal } from './journal.ts';
import { runArchiveWorkflow } from './workflow.ts';
import type { Io } from '../kl.ts';

const exec = promisify(execFile);
const USAGE = 'usage: kl <push|sync> <registered-folder> [--into-repos] [--json]\n';

async function parentCommand(platform: string): Promise<string> {
  if (platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.ppid}').CommandLine`;
    const systemRoot=process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw Error('parent-context-unavailable');
    const shell=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const result = await exec(shell,['-NoProfile','-NonInteractive','-Command',script],{env:archiveChildEnv(),windowsHide:true,timeout:10_000,maxBuffer:65_536});
    if (!result.stdout.trim()) throw Error('parent-context-unavailable');
    return result.stdout;
  }
  if (platform === 'linux') return (await readFile(`/proc/${process.ppid}/cmdline`,'utf8')).replaceAll('\0',' ');
  throw Error('parent-context-unavailable');
}

/** DESIGN 6.7: this guard precedes journal writes, source reads and uploads. */
export function assertArchiveContext(env: Record<string,string|undefined>, cwd: string, parent: string): void {
  if (Object.keys(env).some(key=>/^ARMILLARY_/i.test(key) && env[key] !== undefined)) throw Error('orrery-context-refused');
  const path = cwd.replaceAll('\\','/').toLowerCase().replace(/\/+$/,'');
  const parts=path.split('/');
  if (parts[0]==='d:' && parts[1]==='orrery') throw Error('orrery-context-refused');
  if (!parent.trim() || /(?:^|[\s"'])(?:--print|-p)(?=$|[\s="'])/.test(parent)) throw Error('headless-or-unknown-context-refused');
}

async function personaTripwire(repo: string): Promise<void> {
  const env = archiveChildEnv();
  const program=await archiveProgramOnPath('git');
  if (!program) throw Error('persona-tripwire-unavailable');
  const result = await exec(program,['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',repo,'status','--porcelain','--ignored','--','persona/'],{env,windowsHide:true,timeout:10_000,maxBuffer:1<<20});
  if (result.stdout.trim()) throw Error('persona-tripwire-dirty');
}

/** A journal lives outside the source; never follow a symlink while making its state directory. */
async function journalDirectory(state: string, root: string): Promise<void> {
  if (!isAbsolute(state)) throw Error('state-path-must-be-absolute');
  const delta = relative(root,state);
  if (!delta || (!delta.startsWith('..') && !isAbsolute(delta))) throw Error('journal-inside-source-refused');
  const parsed = parse(state); let cursor=parsed.root;
  for (const part of state.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
    cursor=join(cursor,part);
    try { const stat=await lstat(cursor); if (!stat.isDirectory()||stat.isSymbolicLink()) throw Error('unsafe-state-path'); }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      await mkdir(cursor);
    }
  }
  if (resolve(await realpath(state)).toLowerCase()!==resolve(state).toLowerCase()) throw Error('unsafe-state-path');
  const file=join(state,'kl.sqlite');
  for (const suffix of ['', '-wal','-shm']) {
    try { const stat=await lstat(file+suffix); if (!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1) throw Error('unsafe-journal-file'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  }
}

/** Read-only trusted composition seam for tests; never parsed from command-line flags. */
export interface ArchiveCommandContext { cwd: string; parentCommand: string }
export async function archiveCommand(mode:'push'|'sync',args:string[],io:Io,readDeviceToken:()=>Promise<string|undefined>,context?:ArchiveCommandContext):Promise<number> {
  let journal:PushJournal|undefined;
  try {
    if (!args[0] || args.slice(1).some(arg=>!['--into-repos','--json'].includes(arg)) || args[0].startsWith('--')) {io.stderr(USAGE);return 2;}
    const cwd=context?.cwd??process.cwd();
    // Check known Orrery markers even if parent inspection is unavailable.
    assertArchiveContext(io.env,cwd,context?.parentCommand??'pending-parent-check');
    const parent=context?.parentCommand??await parentCommand(io.platform??process.platform);
    assertArchiveContext(io.env,cwd,parent);
    const root=resolve(args[0]);
    const stateDir=resolve(io.env.KL_STATE_DIR??'D:\\.knowledge-library\\state');
    const registration=await loadArchiveRegistration({stateDir,root});
    await personaTripwire(registration.libraryRepo);
    const api=io.env.KL_API;
    if (api && api.replace(/\/+$/,'')!==registration.apiOrigin) throw Error('registered-endpoint-mismatch');
    const token=await readDeviceToken();
    if (!token) throw Error('device-token-required');
    await journalDirectory(stateDir,root);
    journal=new PushJournal(join(stateDir,'kl.sqlite'));
    const receipt=await runArchiveWorkflow({registration,scan:()=>scanArchiveSource(registration,{intoRepos:args.includes('--into-repos')}),journal,token,fetch:io.fetch,mode});
    io.stdout(args.includes('--json')?JSON.stringify(receipt)+'\n':
      `${mode}: ${receipt.partial?'partial':'complete'}; ${receipt.counts.readbackVerified}/${receipt.items.length} files read back and verified; ${receipt.counts.heldLocal} held local; ${receipt.counts.readErrors} read errors; ${receipt.counts.skipped} skipped. No source files removed.\n`);
    return receipt.partial?1:0;
  } catch(error) {
    // Fixed diagnostics only; no token, note content, remote error body or arbitrary system error.
    const message=error instanceof Error && /^[a-z][a-z0-9.-]{1,80}$/.test(error.message)?error.message:'archive-operation-failed';
    io.stderr(`kl ${mode}: ${message}; original files remain in place.\n`);return 1;
  } finally {journal?.close();}
}
