// Injected, read-only collection. No native adapter, receipt verifier, or catalog connection is created here.
import type { Fs, FsPath, FsTime, PathSnapshot, ScopeId } from '../fs/fs.ts';
import type { GitPort } from '../inventory/git-port.ts';
import type { InventoryFile, InventoryResult } from '../inventory/inventory.ts';
import type { KernelFile, KernelInput } from './eligibility.ts';
import type { ClosureNote, ClosureReference } from './reference-closure.ts';
import type { GoalRev, IntegrationState, KernelInputs, Policy, ReferenceGeneration, Snapshot, SnapshotFile } from './kernel-adapter.ts';
import { parseSweepProtection } from '../../../../vendor/sweep-protection.mjs';

export interface PathFact<T> { path: string; value: T }
export interface CollectorContext {
  snapshot: { id: string; capturedAtMs: number; complete: boolean | null; phase: KernelInput['phase'] };
  folder: KernelInput['folder'];
  scope: ScopeId;
  virtualFolder: string;
  goalRev: GoalRev;
  policy: Policy;
  inventory: InventoryResult;
  pins: readonly PathFact<{ complete: boolean | null; kinds: NonNullable<KernelFile['pins']>['kinds'] }>[];
  history: readonly PathFact<{ fileId: string; volumeSerial: string; firstSeenAtPathMs: number | null; restore: KernelFile['restore'] }>[];
  // Current-byte hashes come from the trusted sync snapshot, never from the archived catalog version.
  // This collector does not hash files: absent or differently bound evidence stays unknown.
  currentContent: readonly PathFact<{ snapshotId: string; fileId: string; volumeSerial: string; sha256: string;
    bytes: number; mtimeMs: number; changeTimeMs: number; creationMs: number }>[];
  reservations: readonly PathFact<KernelFile['activity']>[];
  // Trusted factual classifications of every kept source, including task:<n>. No learned goal expansion.
  sourceFacts: readonly PathFact<Pick<ClosureNote, 'hardPinned' | 'designated' | 'approvedGoalMatched'>>[];
  referenceBinding: { snapshotId: string; policyHash: string; goalHash: string;
    exclusionsReceiptBound: boolean | null; changeTimeConformance: boolean | null };
  sweep: { sweepLogText: string | null; trustLedgerText: string | null; understudyText: string | null;
    reportAbsentConfirmed: boolean; historyComplete: boolean; associationProven: boolean };
  integrationState: IntegrationState;
}
export interface CollectorPorts {
  fs: Pick<Fs, 'inspect'>;
  git: GitPort;
  clock: { nowMs(): number };
  catalog: { custodySnapshot(): Promise<readonly PathFact<KernelFile['custody']>[]> };
  timeEncoding: 'windows-filetime-100ns' | 'unknown';
}
const DAY = 86_400_000;
const norm = (text: string) => text.replace(/\\/g, '/').normalize('NFC').toLowerCase();
const parts = (text: string) => text.split('/').filter(Boolean);
const knownTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function dateMs(text: string | null): number | null {
  if (text === null || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(text)) return null;
  const value = Date.parse(text);
  return knownTime(value) ? value : null;
}
function fact<T>(rows: readonly PathFact<T>[], path: string): T | null {
  const matches = rows.filter(row => norm(row.path) === norm(path));
  return matches.length === 1 ? matches[0]!.value : null;
}
/** Windows FILETIME: 100 ns since 1601-01-01 UTC. Round upward, never age a file by truncating a newer tick. */
export function filetimeMilliseconds(value: FsTime | null, encoding: CollectorPorts['timeEncoding']): number | null {
  if (encoding !== 'windows-filetime-100ns' || typeof value !== 'bigint') return null;
  const ticks = value - 116444736000000000n;
  if (ticks < 0n) return null;
  const ms = (ticks + 9999n) / 10000n;
  return ms <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ms) : null;
}
/** Subtract fourteen elapsed days, then format its local minute. Invalid timezone/context never defaults to UTC. */
export function sweepCutoff(nowMs: number, timezone: string): string | null {
  if (!knownTime(nowMs) || nowMs < 14 * DAY) return null;
  try {
    const values = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs - 14 * DAY));
    const get = (type: string) => values.find(part => part.type === type)?.value;
    const result = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    return /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(result) ? result : null;
  } catch { return null; }
}
export interface SweepResult {
  status: 'known' | 'adjudication-unknown'; reasonCodes: string[]; blockEveryCandidate: boolean;
  protectedTargets: string[]; protectedReports: { key: string; verdict: string; reason: string }[];
}
export function validateSweepResult(value: unknown): SweepResult | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<SweepResult>;
  if (!['known', 'adjudication-unknown'].includes(r.status ?? '') || typeof r.blockEveryCandidate !== 'boolean'
    || !Array.isArray(r.reasonCodes) || !r.reasonCodes.every(x => typeof x === 'string')
    || !Array.isArray(r.protectedTargets) || !r.protectedTargets.every(x => typeof x === 'string')
    || !Array.isArray(r.protectedReports) || !r.protectedReports.every(x => x && typeof x.key === 'string' && typeof x.verdict === 'string' && typeof x.reason === 'string')
    || (r.status === 'known' ? r.blockEveryCandidate || r.reasonCodes.length !== 0 : !r.blockEveryCandidate)) return null;
  return r as SweepResult;
}
function validSegments(segments: readonly string[]): boolean {
  return segments.every(s => s.length > 0 && s !== '.' && s !== '..' && !/[\\/:\x00-\x1f]/.test(s) && !/[. ]$/.test(s));
}
function matchingParents(observed: PathSnapshot, expected: FsPath, rootId: string, volume: string): boolean {
  return observed.path.scope === expected.scope && JSON.stringify(observed.path.segments) === JSON.stringify(expected.segments)
    && observed.parents !== null && observed.parents.length === expected.segments.length
    && observed.parents.every((parent, i) => JSON.stringify(parent.segments) === JSON.stringify(expected.segments.slice(0, i))
      && parent.identity.volumeSerial === volume && parent.identity.fileId.length > 0)
    && observed.parents[0]?.identity.fileId === rootId;
}
function newest(file: InventoryFile): number | null {
  const times = [dateMs(file.times.modified), dateMs(file.times.changed), dateMs(file.times.created)];
  return times.every(knownTime) ? Math.max(...times as number[]) : null;
}

export async function collectKernelInputs(context: CollectorContext, ports: CollectorPorts): Promise<KernelInputs> {
  const c = context, nowMs = ports.clock.nowMs(), inventory = c.inventory;
  // Assign local opaque IDs from the entire sorted path universe. Never expose these IDs as shared shapes.
  const allPaths = [...new Set([...inventory.files.map(f => f.path), ...inventory.references.map(r => r.source)])].sort();
  const ids = new Map(allPaths.map((path, i) => [path, `f${i + 1}`]));
  const idFor = (path: string): string | undefined => {
    const matches = allPaths.filter(p => norm(p) === norm(path));
    return matches.length === 1 ? ids.get(matches[0]!) : undefined;
  };
  let mappingComplete = new Set(allPaths.map(norm)).size === allPaths.length;
  const folderPath = norm(c.virtualFolder).replace(/\/$/, '');
  const targetFiles = inventory.files.filter(file => norm(file.path).startsWith(folderPath + '/') && file.sets.includes('vault'));
  const files: SnapshotFile[] = [], pinRows: KernelInputs[3]['files'][number][] = [], historyRows: KernelInputs[5][number][] = [];
  const gitRows: KernelInputs[6][number][] = [], activityRows: KernelInputs[8][number][] = [], custodyRows: KernelInputs[4][number][] = [];
  let catalogRows: readonly PathFact<KernelFile['custody']>[] = [];
  try { catalogRows = await ports.catalog.custodySnapshot(); } catch { /* Missing custody protects every file. */ }
  const obsidianPins = new Map<string, Set<'open-tab' | 'last-open' | 'bookmark'>>();
  const edges: ClosureReference[] = [];
  const addEdge = (source: string, target: string, kind: ClosureReference['kind']) => edges.push({ id: `r${edges.length + 1}`, source, target, kind });
  for (const reference of inventory.references) {
    const source = idFor(reference.source);
    const targets = reference.kind === 'ambiguous' ? reference.candidates ?? [] : reference.target === null ? [] : [reference.target];
    if (!source || reference.kind === 'unresolved' || targets.length === 0) { mappingComplete = false; continue; }
    for (const targetPath of targets) {
      const target = idFor(targetPath);
      if (!target) { mappingComplete = false; continue; }
      if (reference.kind === 'obsidian') {
        const pin = reference.detail === 'open-leaf' ? 'open-tab' : reference.detail;
        if (!pin) { mappingComplete = false; continue; }
        const set = obsidianPins.get(target) ?? new Set(); set.add(pin); obsidianPins.set(target, set);
      } else addEdge(source, target, reference.kind);
    }
  }
  const notes: ClosureNote[] = allPaths.map(path => {
    const source = fact(c.sourceFacts, path), observed = inventory.files.find(file => file.path === path);
    if (!source) mappingComplete = false;
    return { id: ids.get(path)!, hardPinned: source?.hardPinned ?? false, designated: source?.designated ?? false,
      approvedGoalMatched: source?.approvedGoalMatched ?? false, newestEditMs: observed ? newest(observed) : null };
  });
  for (const file of targetFiles) {
    const id = ids.get(file.path)!, relative = parts(file.path).slice(parts(c.virtualFolder).length);
    const expected: FsPath = { scope: c.scope, segments: relative };
    let observed: PathSnapshot | null = null;
    if (validSegments(relative)) try { const result = await ports.fs.inspect(expected); if (result.ok) observed = result.value; } catch { /* inspect remains unknown */ }
    const samePath = observed?.path.scope === c.scope && JSON.stringify(observed.path.segments) === JSON.stringify(relative);
    if (!samePath) observed = null;
    const historyFact = fact(c.history, file.path), pins = fact(c.pins, file.path), activity = fact(c.reservations, file.path);
    const history = historyFact && observed?.identity && historyFact.fileId === observed.identity.fileId
      && historyFact.volumeSerial === observed.identity.volumeSerial ? historyFact : null;
    const absoluteSegments = [...c.folder.segments, ...relative];
    const registryKnown = c.policy.registryComplete === true && c.folder.registryComplete === true;
    const personaHome = registryKnown ? c.policy.personaHomes.some(home => norm(home.drive) === norm(c.folder.drive)
      && home.segments.length < absoluteSegments.length && home.segments.every((s, i) => norm(s) === norm(absoluteSegments[i]!))) : null;
    const times = observed ? { mtimeMs: filetimeMilliseconds(observed.times.modified, ports.timeEncoding),
      changeTimeMs: filetimeMilliseconds(observed.times.changed, ports.timeEncoding), creationMs: filetimeMilliseconds(observed.times.created, ports.timeEncoding),
      firstSeenAtPathMs: history?.firstSeenAtPathMs ?? null } : null;
    files.push({ id, kind: observed?.kind === 'reparse' ? 'other' : observed?.kind ?? null,
      path: observed ? { drive: c.folder.drive, segments: absoluteSegments, normalized: validSegments(absoluteSegments) } : null, times,
      location: observed ? { rootFileId: observed.parents?.[0]?.identity.fileId ?? null,
        deniedSegment: registryKnown ? absoluteSegments.some(s => c.policy.deniedSegments.some(d => norm(d) === norm(s))) : null } : null,
      identity: observed ? { fileId: observed.identity?.fileId ?? null, snapshotFileId: file.identity?.fileId ?? null,
        volumeSerial: observed.identity?.volumeSerial ?? null, hardLinks: observed.hardLinks,
        parentsComplete: matchingParents(observed, expected, c.folder.rootFileId, c.folder.volumeSerial),
        anyReparse: observed.anyReparseComponent,
        volumeKind: observed.supportedLocalVolume === true ? observed.volumeKind : 'unknown' } : null });
    pinRows.push({ id, value: { complete: pins?.complete ?? null, kinds: [...new Set([...(pins?.kinds ?? []), ...(obsidianPins.get(id) ?? [])])], personaHome } });
    historyRows.push({ id, value: history?.restore ?? null });
    const catalog = fact(catalogRows, file.path), content = fact(c.currentContent, file.path);
    const contentBound = content && observed?.identity && times && content.snapshotId === c.snapshot.id
      && content.fileId === observed.identity.fileId && content.volumeSerial === observed.identity.volumeSerial
      && content.bytes === observed.bytes && content.bytes === file.size
      && content.mtimeMs === times.mtimeMs && content.changeTimeMs === times.changeTimeMs && content.creationMs === times.creationMs;
    custodyRows.push({ id, value: catalog ? { ...catalog, currentSha256: contentBound ? content.sha256 : null } : null });
    let tracking: ReturnType<GitPort['tracking']> = 'git-unknown';
    try { tracking = ports.git.tracking(`${c.folder.drive}/${absoluteSegments.join('/')}`, `${c.folder.drive}/${c.folder.segments.join('/')}`); } catch { /* unknown */ }
    gitRows.push({ id, value: { walkComplete: tracking !== 'git-unknown', innermostResolved: tracking !== 'git-unknown',
      state: tracking === 'no-repo' ? 'no-repository' : tracking === 'git-unknown' ? 'unknown' : tracking } });
    const oldTimes = [dateMs(file.times.modified), dateMs(file.times.changed), dateMs(file.times.created)];
    const currentTimes = times ? [times.mtimeMs, times.changeTimeMs, times.creationMs] : [];
    const comparable = currentTimes.length === 3 && [...oldTimes, ...currentTimes].every(knownTime) && !!observed?.identity && !!file.identity;
    const changed = comparable ? currentTimes.some((time, i) => time !== oldTimes[i])
      || observed!.identity!.fileId !== file.identity!.fileId || observed!.identity!.volumeSerial !== file.identity!.volumeSerial : null;
    activityRows.push({ id, value: activity ? { ...activity, changedSinceGeneration: activity.changedSinceGeneration === true || changed === true ? true
      : activity.changedSinceGeneration === false && changed === false ? false : null } : null });
  }
  const cutoff = sweepCutoff(nowMs, c.policy.timezone), labels = c.policy.understudyProjectLabels;
  // Raw strings pass unchanged to the pinned parser. No prefix stripping or alternate grammar.
  const parsed = validateSweepResult(parseSweepProtection({ sweepLogText: c.sweep.sweepLogText, trustLedgerText: c.sweep.trustLedgerText,
    understudyText: c.sweep.understudyText, project: labels.length === 1 ? labels[0] : null, cutoffTimestamp: cutoff }));
  const parserReasonCodes = [...(parsed?.reasonCodes ?? ['sweep-result-invalid'])];
  const protectedIds = new Set<string>();
  let unresolvedProtection = false;
  for (const target of parsed?.protectedTargets ?? []) {
    const relative = norm(target).replace(/^\.\//, '');
    const matches = allPaths.filter(path => norm(path) === relative || norm(path) === `${folderPath}/${relative}`
      || norm(`${c.folder.drive}/${c.folder.segments.join('/')}/${parts(path).slice(parts(c.virtualFolder).length).join('/')}`) === relative);
    if (matches.length === 0) unresolvedProtection = true;
    for (const path of matches) protectedIds.add(ids.get(path)!);
  }
  // B only unions inventory-resolved citations and path/name mentions from this folder's report.
  const reportId = idFor(`${c.virtualFolder.replace(/\/$/, '')}/UNDERSTUDY.md`);
  for (const edge of edges) if (edge.source === reportId && ['link', 'path', 'ambiguous', 'name'].includes(edge.kind)) protectedIds.add(edge.target);
  const sweepKnown = parsed?.status === 'known' && !parsed.blockEveryCandidate && !unresolvedProtection
    && (c.sweep.understudyText !== null || c.sweep.reportAbsentConfirmed);
  if (unresolvedProtection) parserReasonCodes.push('protective-target-unresolved');
  const generation = inventory.generation;
  const references: ReferenceGeneration = { id: generation.id, ...c.referenceBinding,
    complete: generation.complete && mappingComplete && !generation.flags.includes('fleet-exclusions-unpinned'), rootsComplete: generation.roots.length > 0 && generation.roots.every(root => root.complete),
    unresolvedReadErrors: generation.readErrors.length, skippedUnexcluded: generation.oversizeListed.length,
    exclusionsRecorded: true, readMode: generation.mode, readAtMs: dateMs(generation.finishedAt) ?? -1,
    lastFullReadAtMs: dateMs(generation.lastFullReadAt) ?? -1, notes, edges,
    localSources: allPaths.map(path => ({ id: ids.get(path)!, path })),
    unreadableSources: [...new Set([...generation.readErrors.map(error => error.path), ...generation.oversizeListed.map(item => item.path)])].sort() };
  const snapshot: Snapshot = { ...c.snapshot, nowMs, folder: c.folder, files };
  return [snapshot, c.goalRev, c.policy, { files: pinRows, parserReasonCodes, sweep: { folderId: c.folder.id, snapshotId: c.snapshot.id,
    format: sweepKnown ? 'known' : 'unknown', adjudication: sweepKnown ? 'known' : 'unknown', wholeFolderHeld: !sweepKnown,
    history: c.sweep.historyComplete ? 'complete' : 'unproven', association: c.sweep.associationProven ? 'proven' : 'unproven', protectedIds: [...protectedIds].sort() } },
    custodyRows, historyRows, gitRows, references, activityRows, c.integrationState];
}
