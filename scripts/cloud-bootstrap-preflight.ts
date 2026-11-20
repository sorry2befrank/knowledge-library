// Local preparation only: this module never invokes a CLI, authenticates, or deploys.
import { copyFileSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArguments, verifyPackage } from './cloud-bootstrap.ts';
import type { BootstrapConfigInput } from './lib/cloud-bootstrap-config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Pins = { commit: string; manifestSha256: string };

/** Refuse inherited CLI/Node overrides without logging their values. */
export function assertOwnerEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === 'WRANGLER_SEND_METRICS' && value === 'false') continue;
    if (/^(?:CF_|CLOUDFLARE_|WRANGLER_)/.test(upper)
      || (['NODE_OPTIONS', 'NODE_PATH'].includes(upper) && value !== '')) {
      throw new Error('Remove inherited provider or Node overrides in the owner terminal');
    }
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

export function prepareBootstrapRun(source: string, out: string, input: BootstrapConfigInput, pins: Pins,
  env: NodeJS.ProcessEnv = process.env): { dryRunDirectory: string; deployDirectory: string; envFile: string } {
  assertOwnerEnvironment(env);
  const sourcePath = realpathSync(source);
  if (lstatSync(source).isSymbolicLink()) throw new Error('Package directory cannot be a link');
  verifyPackage(sourcePath, input, pins);
  const output = resolve(out);
  const parent = realpathSync(dirname(output));
  if (within(realpathSync(ROOT), parent) || within(sourcePath, parent)) throw new Error('Run directory must be outside the checkout and frozen package');
  // Use the resolved parent so a parent junction cannot silently redirect subsequent copies.
  const run = join(parent, basename(output));
  mkdirSync(run); // Existing directories, links and files all fail atomically; never nest a copy.
  const dryRunDirectory = join(run, 'dry-run');
  const deployDirectory = join(run, 'deploy');
  for (const destination of [dryRunDirectory, deployDirectory]) {
    mkdirSync(destination);
    for (const file of ['worker.mjs', 'wrangler.jsonc', 'README.txt', 'manifest.json']) {
      copyFileSync(join(sourcePath, file), join(destination, file), constants.COPYFILE_EXCL);
    }
    verifyPackage(destination, input, pins);
  }
  verifyPackage(sourcePath, input, pins); // Fail if the frozen source changed during copying.
  const envFile = join(run, 'empty.env');
  writeFileSync(envFile, '', { flag: 'wx' });
  return { dryRunDirectory, deployDirectory, envFile };
}

export function readPreflightArguments(args: string[]) {
  const additional = new Set(['--package', '--commit', '--manifest-sha256']);
  const selected: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Incomplete preflight arguments');
    if (additional.has(key)) {
      if (key in selected) throw new Error('Repeated preflight argument');
      selected[key] = value;
    } else rest.push(key, value);
  }
  if (Object.keys(selected).length !== additional.size) throw new Error('Package and external pins are required');
  const { input, out } = readArguments(rest);
  return { input, out, source: resolve(selected['--package']!), pins: { commit: selected['--commit']!, manifestSha256: selected['--manifest-sha256']! } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = readPreflightArguments(process.argv.slice(2));
    console.log(JSON.stringify({ ...prepareBootstrapRun(args.source, args.out, args.input, args.pins), deployed: false }));
  } catch {
    console.error('Bootstrap run preparation refused. Check the approved pins, clean environment and a new external directory.');
    process.exitCode = 1;
  }
}
