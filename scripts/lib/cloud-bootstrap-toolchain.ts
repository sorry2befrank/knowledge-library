import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapGit } from '../cloud-bootstrap.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER = '4.150.0';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type ReviewPins = { commit: string; manifestSha256: string };

/** Read-only local provenance check. Call after the package's contents/config have been verified. */
export function verifyBootstrapToolchain(directory: string, pins: ReviewPins): { commit: string; wrangler: string; lockfileSha256: string } {
  try {
    if (!pins || typeof pins.commit !== 'string' || !/^[a-f0-9]{40}$/.test(pins.commit)
      || typeof pins.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pins.manifestSha256)) throw new Error('Invalid review pins');
    // Re-read the pinned manifest instead of trusting an earlier check if the package has changed meanwhile.
    const bytes = readFileSync(join(directory, 'manifest.json'));
    if (digest(bytes) !== pins.manifestSha256) throw new Error('Manifest changed');
    const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (manifest.commit !== pins.commit || manifest.wrangler !== WRANGLER
      || typeof manifest.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256)) throw new Error('Invalid toolchain identity');
    if (bootstrapGit(['rev-parse', 'HEAD'], ROOT) !== pins.commit) throw new Error('Checkout identity mismatch');
    const configNames = bootstrapGit(['config', '--includes', '--list', '--name-only'], ROOT).split(/\r?\n/);
    if (configNames.some((name) => /^filter\./i.test(name.trim()))) throw new Error('Git filters are not permitted');
    if (bootstrapGit(['status', '--porcelain'], ROOT) !== '') throw new Error('Uncommitted checkout changes');
    const entries = bootstrapGit(['ls-files', '-v', '-z'], ROOT).split('\0').filter(Boolean);
    if (!entries.length || entries.some((entry) => !entry.startsWith('H '))) throw new Error('Hidden index entries');
    const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/wrangler/package.json'), 'utf8')) as { version?: unknown };
    if (installed.version !== WRANGLER) throw new Error('Installed Wrangler mismatch');
    const lockfileSha256 = digest(readFileSync(join(ROOT, 'package-lock.json')));
    if (lockfileSha256 !== manifest.lockfileSha256) throw new Error('Local lockfile mismatch');
    return { commit: pins.commit, wrangler: WRANGLER, lockfileSha256 };
  } catch {
    // Filesystem and Git failures can contain local paths, environment data, or child output.
    throw new Error('Bootstrap local toolchain verification failed');
  }
}
