// Local packaging only. This program has no remote deployment or authentication command.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, accessSync, constants, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { makeBootstrapConfig, validateBootstrapConfig, type BootstrapConfigInput } from './lib/cloud-bootstrap-config.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_WRANGLER = '4.150.0';
const PACKAGE_FILES = ['worker.mjs', 'wrangler.jsonc', 'README.txt'] as const;

export function bootstrapGit(args: string[], cwd = ROOT, options: { timeoutMs?: number; trim?: boolean } = {}): string {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid local Git timeout');
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  let executable: string | undefined;
  for (const part of pathValue.split(delimiter)) {
    const directory = part.replace(/^"|"$/g, '');
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const physical = realpathSync(candidate);
      if (lstatSync(physical).isFile()) { executable = physical; break; }
    } catch { /* Check the next trusted installed PATH directory, never cwd. */ }
  }
  if (!executable) throw new Error('Installed Git unavailable');
  const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
  try {
    const result = execFileSync(executable, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=' + empty,
      '-c', 'credential.helper=', '-c', 'protocol.allow=never', ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty,
        GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C', LANG: 'C' } });
    return options.trim === false ? result : result.trim();
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const bounded = typeof code === 'string' && ['ETIMEDOUT', 'ENOENT', 'EACCES', 'ENOBUFS'].includes(code) ? ` (${code})` : '';
    throw new Error('Local Git verification failed' + bounded);
  }
}

export function readArguments(args: string[]): { input: BootstrapConfigInput; out: string } {
  const allowed = new Set(['--staging-account', '--production-account', '--account-layout', '--out']);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!allowed.has(key) || key in values || !value || value.startsWith('--')) throw new Error('Expected both account IDs, --account-layout and --out NEW_DIRECTORY');
    values[key] = value;
  }
  if (Object.keys(values).length !== 4) throw new Error('All four packaging arguments are required');
  const input = { environment: 'staging', stagingAccountId: values['--staging-account']!, productionAccountId: values['--production-account']!,
    accountIsolation: values['--account-layout']! } as BootstrapConfigInput;
  makeBootstrapConfig(input);
  return { input, out: resolve(values['--out']!) };
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === keys.sort().join();
}

function inspectPackage(directory: string, expected: BootstrapConfigInput): { commit: string; manifestSha256: string } {
  makeBootstrapConfig(expected);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Package directory must not be a link');
  for (const file of [...PACKAGE_FILES, 'manifest.json']) {
    const stat = lstatSync(join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Package members must be regular unlinked files');
  }
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (!exactKeys(manifest, ['format', 'phase', 'archiveAvailable', 'environment', 'accountIsolation', 'stagingAccountId', 'productionAccountId', 'wrangler', 'commit', 'lockfileSha256', 'files'])
    || manifest.format !== 1 || manifest.phase !== 'bootstrap' || manifest.archiveAvailable !== false || manifest.environment !== 'staging'
    || manifest.accountIsolation !== expected.accountIsolation || manifest.stagingAccountId !== expected.stagingAccountId || manifest.productionAccountId !== expected.productionAccountId
    || manifest.wrangler !== PINNED_WRANGLER || typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.commit)
    || typeof manifest.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256)
    || !exactKeys(manifest.files, [...PACKAGE_FILES])) throw new Error('Bootstrap package identity mismatch');
  const files = manifest.files as Record<string, string>;
  if (Object.keys(files).sort().join() !== [...PACKAGE_FILES].sort().join()) throw new Error('Unexpected package file inventory');
  if (readdirSync(directory).sort().join() !== [...PACKAGE_FILES, 'manifest.json'].sort().join()) throw new Error('Unexpected package contents');
  for (const file of PACKAGE_FILES) if (hash(readFileSync(join(directory, file))) !== files[file]) throw new Error('Bootstrap package integrity mismatch');
  validateBootstrapConfig(JSON.parse(readFileSync(join(directory, 'wrangler.jsonc'), 'utf8')), expected);
  return { commit: manifest.commit, manifestSha256: hash(manifestBytes) };
}

/** Verify against an independently supplied approval, never a self-recomputed pin. */
export function verifyPackage(directory: string, expected: BootstrapConfigInput,
  pins: { commit: string; manifestSha256: string }): { commit: string; manifestSha256: string } {
  if (!exactKeys(pins, ['commit', 'manifestSha256']) || typeof pins.commit !== 'string' || !/^[a-f0-9]{40}$/.test(pins.commit)
    || typeof pins.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pins.manifestSha256)) throw new Error('External review pins are required');
  const result = inspectPackage(directory, expected);
  if (result.commit !== pins.commit || result.manifestSha256 !== pins.manifestSha256) throw new Error('Bootstrap package review pin mismatch');
  return result;
}

function refuseGitFilters(): void {
  // status may execute a repository clean filter. Inspect names (never secret values) first.
  const keys = bootstrapGit(['config', '--includes', '--list', '--name-only']).split(/\r?\n/);
  if (keys.some((key) => /^filter\./i.test(key))) throw new Error('Repository Git filters are not allowed during packaging');
}

function sourceHashes(commit: string): string[] {
  const entries = bootstrapGit(['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  if (!entries.length || entries.some((entry) => !entry.startsWith('H '))) throw new Error('Refusing hidden or unusual Git index flags');
  return ['apps/api/src/cloudflare/worker.ts', 'tsconfig.json', 'package-lock.json', 'package.json',
    'scripts/cloud-bootstrap.ts', 'scripts/lib/cloud-bootstrap-config.ts'].map((file) => {
    const bytes = readFileSync(join(ROOT, file));
    const committed = bootstrapGit(['show', `${commit}:${file}`], ROOT, { trim: false });
    // Only explicit Windows checkout line-ending normalization is permitted, not filters or whitespace trimming.
    if (bytes.toString('utf8').replaceAll('\r\n', '\n') !== committed.replaceAll('\r\n', '\n')) {
      throw new Error('Source changed from the reviewed commit');
    }
    return hash(bytes);
  });
}

export async function packageBootstrap(input: BootstrapConfigInput, out: string): Promise<ReturnType<typeof verifyPackage>> {
  const config = makeBootstrapConfig(input);
  const resolvedOut = resolve(out);
  // Require a caller-created trusted parent, then compare physical paths (including junctions).
  const physicalParent = realpathSync(dirname(resolvedOut));
  const rel = relative(realpathSync(ROOT), physicalParent);
  // A clean checkout is the source; local state and frozen artifacts live elsewhere.
  if (!rel || (!(rel === '..' || rel.startsWith('..' + sep)) && !isAbsolute(rel))) throw new Error('Output must be outside the source checkout');
  if (existsSync(resolvedOut)) throw new Error('Refusing to overwrite an existing package');
  refuseGitFilters();
  if (bootstrapGit(['status', '--porcelain']) !== '') throw new Error('Commit and review the source before packaging');
  const commit = bootstrapGit(['rev-parse', 'HEAD']);
  const before = sourceHashes(commit);
  const lockBytes = readFileSync(join(ROOT, 'package-lock.json'));
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/wrangler/package.json'), 'utf8')) as { version: string };
  if (installed.version !== PINNED_WRANGLER) throw new Error('Installed Wrangler does not match the reviewed version');
  const bundle = await build({ absWorkingDir: ROOT, entryPoints: ['apps/api/src/cloudflare/worker.ts'],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers'], metafile: true, sourcemap: false, legalComments: 'none' });
  const imports = Object.keys(bundle.metafile!.inputs);
  if (imports.length !== 1 || imports[0] !== 'apps/api/src/cloudflare/worker.ts') throw new Error('Bootstrap bundle has unreviewed dependencies');
  refuseGitFilters();
  if (bootstrapGit(['status', '--porcelain']) !== '' || bootstrapGit(['rev-parse', 'HEAD']) !== commit) throw new Error('Source changed during packaging');
  if (sourceHashes(commit).some((digest, i) => digest !== before[i])) throw new Error('Source changed during packaging');
  mkdirSync(resolvedOut); // atomic refusal if another process created it
  const worker = bundle.outputFiles![0]!.contents;
  const configBytes = JSON.stringify(config, null, 2) + '\n';
  const readme = [
    'Knowledge Library: CLOSED STAGING BOOTSTRAP',
    `Source commit: ${commit}`,
    `Staging account: ${input.stagingAccountId}`,
    `Production account: ${input.productionAccountId}`,
    `Account layout: ${input.accountIsolation}. Shared-account resources do not have an account-level permission boundary.`,
    'Worker: kl-api-staging. No bindings, enrollment, storage or archive API.',
    'This package has not been deployed or approved by being generated.',
    'Use the reviewed deployment runbook (kept outside this public copy).',
    'Owner creates the first Worker using their own attended terminal; no broad credential belongs in an agent session.',
    'Use externally approved commit and manifest pins with cloud:verify and cloud:prepare. Never reuse a run directory.',
    'An explicit empty environment file, override checks, a successful dry run and owner credential cleanup are required.',
    'Record provider version, exact bindings and a GET /health result after provisioning.',
    'Health must say ready=false and archiveAvailable=false. A 200 health response is not archive readiness.',
    'Keep this package as a closed bootstrap artifact. It is not a proven rollback target across a later DO migration.',
    'Before activating Durable Objects, deploy and rehearse a closed version with the same migration/schema/bindings as the live version.',
    '',
  ].join('\n');
  writeFileSync(join(resolvedOut, 'worker.mjs'), worker, { flag: 'wx' });
  writeFileSync(join(resolvedOut, 'wrangler.jsonc'), configBytes, { flag: 'wx' });
  writeFileSync(join(resolvedOut, 'README.txt'), readme, { flag: 'wx' });
  const manifest = { format: 1, phase: 'bootstrap', archiveAvailable: false, environment: 'staging',
    stagingAccountId: input.stagingAccountId, productionAccountId: input.productionAccountId, accountIsolation: input.accountIsolation, commit,
    wrangler: PINNED_WRANGLER, lockfileSha256: hash(lockBytes),
    files: { 'worker.mjs': hash(worker), 'wrangler.jsonc': hash(configBytes), 'README.txt': hash(readme) } };
  writeFileSync(join(resolvedOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  // Creation establishes integrity only; it cannot grant its own independent approval.
  return inspectPackage(resolvedOut, input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = readArguments(process.argv.slice(2));
    console.log(JSON.stringify({ ...await packageBootstrap(args.input, args.out), phase: 'bootstrap', deployed: false, archiveAvailable: false }));
  } catch {
    // Never print provider/child stderr, filesystem paths or input values on failure.
    console.error('Cloud bootstrap packaging failed. Check the required account layout, clean checkout and new output directory.');
    process.exitCode = 1;
  }
}
