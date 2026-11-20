import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Io } from '../kl.ts';
import { ArchiveSourceError, archiveRootKey, canonicalArchiveOrigin, type ArchiveTrustConfig } from './registration.ts';
import { inspectArchiveRoot } from './source.ts';
import { installArchiveEnrollment } from './enrollment.ts';

const USAGE = 'usage: kl enroll-install <artifact.json> --trust <owner-pins.json> --root <absolute-folder> --state <new-absolute-state> --device <id> --api <origin>\n';

/** Owner-selected local inputs only; refuse links, path aliases, large/changing files and invalid UTF-8. */
export async function readEnrollmentInput(path: string, maximum: number): Promise<unknown> {
  if (!isAbsolute(path)) throw new ArchiveSourceError('absolute-path-required');
  await inspectArchiveRoot(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw new ArchiveSourceError('enrollment-input-invalid');
  const handle = await open(path, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size || held.nlink !== 1n) throw new ArchiveSourceError('enrollment-input-changed');
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const r = await handle.read(bytes, length, bytes.length - length, length);
      if (!r.bytesRead) break;
      length += r.bytesRead;
    }
    const end = await handle.stat({ bigint: true }), after = await lstat(path, { bigint: true });
    if (length > maximum || BigInt(length) !== before.size || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || end.mtimeNs !== before.mtimeNs || end.ctimeNs !== before.ctimeNs) throw new ArchiveSourceError('enrollment-input-changed');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new ArchiveSourceError('enrollment-input-invalid'); }
  } finally { await handle.close(); }
}

export async function enrollmentInstallCommand(args: string[], io: Io): Promise<number> {
  const options = new Map<string, string>();
  if (args.length !== 11 || !args[0] || args[0].startsWith('--')) { io.stderr(USAGE); return 2; }
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (!['--trust', '--root', '--state', '--device', '--api'].includes(flag) || options.has(flag) || !value || value.startsWith('--')) {
      io.stderr(USAGE); return 2;
    }
    options.set(flag, value);
  }
  try {
    const artifactPath = args[0], trustPath = options.get('--trust')!, root = options.get('--root')!, stateDir = options.get('--state')!;
    if (![artifactPath, trustPath, root, stateDir].every(isAbsolute)) throw new ArchiveSourceError('absolute-path-required');
    if (archiveRootKey(artifactPath) === archiveRootKey(trustPath)) throw new ArchiveSourceError('enrollment-independent-trust-required');
    const apiOrigin = options.get('--api')!;
    if (canonicalArchiveOrigin(apiOrigin) !== apiOrigin) throw new ArchiveSourceError('endpoint-mismatch');
    const [artifact, trustedPins] = await Promise.all([readEnrollmentInput(artifactPath, 12 * 1024 * 1024), readEnrollmentInput(trustPath, 16_384)]);
    await installArchiveEnrollment({ artifact, trustedPins: trustedPins as ArchiveTrustConfig, root, stateDir,
      device: options.get('--device')!, apiOrigin });
    io.stdout('Local enrollment installed. Original files are unchanged. This command does not enroll the server or store tokens.\n');
    return 0;
  } catch (error) {
    const code = error instanceof ArchiveSourceError ? error.code : 'enrollment-install-failed';
    io.stderr(`kl enroll-install: ${code}. Existing state is not replaced; interrupted installs require review and a fresh state directory.\n`);
    return 1;
  }
}
