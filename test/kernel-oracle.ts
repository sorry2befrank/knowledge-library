// Independent executable reading of DESIGN 6.1/6.3/6.4. Imports no production or focus code.
// Bounded domain: well-shaped unique opaque IDs, <=8 candidates; nullable factual observations are allowed.
export type ORule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export interface OFile {
  id: string; kind: 'file' | 'directory' | 'other' | null;
  path: { drive: string; segments: readonly string[]; normalized: boolean | null } | null;
  pins: { complete: boolean | null; kinds: readonly string[]; personaHome: boolean | null } | null;
  times: { mtimeMs: number | null; changeTimeMs: number | null; creationMs: number | null; firstSeenAtPathMs: number | null } | null;
  restore: { historyComplete: boolean | null; latestAtMs: number | 'never' | null } | null;
  git: { walkComplete: boolean | null; innermostResolved: boolean | null; state: string } | null;
  custody: { classRemovable: boolean | null; verified: boolean | null; versionId: string | null; currentSha256: string | null; archivedSha256: string | null } | null;
  location: { rootFileId: string | null; deniedSegment: boolean | null } | null;
  activity: { complete: boolean | null; reservations: number | null; holds: number | null; restores: number | null; anotherProcessOpen: boolean | null; changedSinceGeneration: boolean | null } | null;
  identity: { fileId: string | null; snapshotFileId: string | null; volumeSerial: string | null; hardLinks: number | null; parentsComplete: boolean | null; anyReparse: boolean | null; volumeKind: string } | null;
}
export interface ONote { id: string; hardPinned: boolean; designated: boolean; approvedGoalMatched: boolean; newestEditMs: number | null }
export interface OEdge { id: string; source: string; target: string; kind: string }
export interface OracleInput {
  nowMs: number; phase: 'plan' | 'apply';
  snapshot: { id: string; capturedAtMs: number; complete: boolean | null; files: readonly OFile[] };
  folder: { id: string; deviceId: string; drive: string; segments: readonly string[]; rootFileId: string; volumeSerial: string; mappingHash: string | null; registryComplete: boolean | null; registeredInOrrery: boolean | null; obsidianSyncEnabled: boolean | null };
  policy: { state: string; hash: string; folderId: string; deviceId: string; enabled: boolean | null; types: readonly string[]; editGraceDays: number; restoreProtectWeeks: number; linkGuard: string; gitMode: string; nameMentions: string; syncReplicated: string };
  goal: { state: string; hash: string; policyHash: string; folderId: string; deviceId: string; issuedAtMs: number; expiresAtMs: number; superseded: boolean | null; conflicting: boolean | null };
  references: { id: string; snapshotId: string; policyHash: string; goalHash: string; complete: boolean | null; rootsComplete: boolean | null; unresolvedReadErrors: number | null; skippedUnexcluded: number | null; exclusionsRecorded: boolean | null; exclusionsReceiptBound: boolean | null; readMode: string; readAtMs: number; lastFullReadAtMs: number; changeTimeConformance: boolean | null; notes: readonly ONote[]; edges: readonly OEdge[] };
  sweep: { folderId: string; snapshotId: string; format: string; history: string; association: string; adjudication: string; wholeFolderHeld: boolean | null; protectedIds: readonly string[] };
  integration: { state: string; folderId: string; deviceId: string; rootFileId: string; volumeSerial: string; policyHash: string; receiptId: string; expiresAtMs: number; mappingHash: string | null; expectedSequence: number | null; acceptedSequence: number | null; snapshotAtMs: number | null; acceptedAtMs: number | null; observedAtMs: number | null } | null;
}
const DAY = 86_400_000;
export const ORULES: readonly ORule[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const norm = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US');
const numberKnown = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boolKnown = (value: unknown) => value === true || value === false;
const hashKnown = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validSegments = (value: readonly string[] | undefined): value is readonly string[] => !!value && value.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !/[\\/:\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment));
function intrinsic(file: OFile): boolean {
  const segments = file.path?.segments.map(norm) ?? [], name = segments.at(-1) ?? '';
  if (segments.includes('_understudy')) return true;
  if (/^(understudy|archived|claude|agents|pipeline|relationship-register|follow-ups|blocked)\.md$/.test(name)) return true;
  if (/^(readme|status)/.test(name) || (segments.at(-2) === 'secretary' && name === 'ledger.md')) return true;
  return file.pins?.personaHome === true && (/^(northstar|directive|corrections)\.md$/.test(name) || /^(passdown|operating-model)/.test(name) || name.endsWith('.manifest.json'));
}
export interface OracleResult { eligible: string[]; seed: string[]; reasons: Record<string, Record<ORule, string[]>>; global: string[]; nameCounts: Record<string, number> }
export function oracle(input: OracleInput, proposal?: readonly string[]): OracleResult {
  const { nowMs: now, snapshot, folder, policy, goal, references: refs, sweep } = input;
  if (snapshot.files.length > 8) throw new Error('oracle-domain-exceeds-eight');
  const reasons: OracleResult['reasons'] = {}, global: string[] = [];
  if (snapshot.complete !== true) global.push('snapshot-incomplete');
  if (!numberKnown(snapshot.capturedAtMs) || snapshot.capturedAtMs > now || now - snapshot.capturedAtMs >= DAY) global.push('snapshot-stale');
  if (policy.state !== 'accepted' || policy.enabled !== true || policy.folderId !== folder.id || policy.deviceId !== folder.deviceId) global.push('policy-unproven');
  if (goal.state !== 'approved' || !hashKnown(goal.hash) || goal.policyHash !== policy.hash || goal.folderId !== folder.id || goal.deviceId !== folder.deviceId || goal.superseded !== false || goal.conflicting !== false) global.push('goal-unproven');
  if (!numberKnown(goal.issuedAtMs) || !numberKnown(goal.expiresAtMs) || goal.issuedAtMs > now || goal.expiresAtMs <= now || goal.expiresAtMs <= goal.issuedAtMs || goal.expiresAtMs - goal.issuedAtMs > 28 * DAY) global.push('goal-expired-or-invalid');
  if (!boolKnown(folder.obsidianSyncEnabled) || (folder.obsidianSyncEnabled && policy.syncReplicated !== 'acknowledged')) global.push('sync-unacknowledged');
  const coverage = refs.complete === true && refs.rootsComplete === true && refs.unresolvedReadErrors === 0 && refs.skippedUnexcluded === 0 && refs.exclusionsRecorded === true && refs.exclusionsReceiptBound === true
    && refs.snapshotId === snapshot.id && refs.policyHash === policy.hash && refs.goalHash === goal.hash && numberKnown(refs.readAtMs) && refs.readAtMs >= snapshot.capturedAtMs && refs.readAtMs <= now
    && numberKnown(refs.lastFullReadAtMs) && refs.lastFullReadAtMs <= refs.readAtMs && now - refs.lastFullReadAtMs <= 7 * DAY
    && (refs.readMode === 'full' ? refs.lastFullReadAtMs === refs.readAtMs : refs.readMode === 'incremental' && refs.changeTimeConformance === true);
  if (!coverage) global.push('coverage-incomplete');
  for (const file of snapshot.files) {
    const r = Object.fromEntries(ORULES.map(rule => [rule, [] as string[]])) as Record<ORule, string[]>;
    reasons[file.id] = r;
    const name = file.path?.segments.at(-1), note = refs.notes.find(note => note.id === file.id)!;
    if (file.kind === null || !name) r[1].push('file-kind-or-type-unknown');
    else if (file.kind !== 'file') r[1].push('not-file');
    else if (!policy.types.some(type => norm(type) === norm(name.slice(name.lastIndexOf('.'))))) r[1].push('type-not-allowed');
    const p = file.pins;
    if (intrinsic(file) || note.hardPinned || note.designated || (p && p.kinds.length > 0)) r[2].push('hard-pinned');
    else if (!p || p.complete !== true || !boolKnown(p.personaHome)) r[2].push('pins-unknown');
    const sweepKnown = sweep.folderId === folder.id && sweep.snapshotId === snapshot.id && sweep.format === 'known' && sweep.history === 'complete' && sweep.association === 'proven' && sweep.adjudication === 'known' && sweep.wholeFolderHeld === false;
    if (!sweepKnown) r[2].push('adjudication-unknown');
    else if (sweep.protectedIds.includes(file.id)) r[2].push('sweep-protected');
    const times = file.times ? [file.times.mtimeMs, file.times.changeTimeMs, file.times.creationMs, file.times.firstSeenAtPathMs] : [];
    if (times.length !== 4 || times.some(t => !numberKnown(t))) r[3].push('edit-age-unknown');
    else if (Math.max(...times as number[]) > now - policy.editGraceDays * DAY) r[3].push('edit-or-arrival-grace');
    if (!file.restore || file.restore.historyComplete !== true || (file.restore.latestAtMs !== 'never' && !numberKnown(file.restore.latestAtMs))) r[4].push('restore-history-unknown');
    else if (file.restore.latestAtMs !== 'never' && file.restore.latestAtMs > now - policy.restoreProtectWeeks * 7 * DAY) r[4].push('restore-protected');
    if (!file.git || file.git.walkComplete !== true || file.git.innermostResolved !== true || !['no-repository', 'tracked', 'untracked'].includes(file.git.state)) r[5].push('git-unknown');
    else if (file.git.state === 'tracked') r[5].push(policy.gitMode === 'never' ? 'git-tracked' : 'git-sparse-unsupported');
    const custody = file.custody;
    if (!custody || !boolKnown(custody.classRemovable) || !boolKnown(custody.verified) || !hashKnown(custody.currentSha256)) r[6].push('custody-unknown');
    else if (!custody.classRemovable) r[6].push('class-not-removable');
    else if (!custody.verified || !nonempty(custody.versionId) || !hashKnown(custody.archivedSha256) || norm(custody.archivedSha256) !== norm(custody.currentSha256!)) r[6].push('verified-current-custody-missing');
    const path = file.path, location = file.location, identity = file.identity;
    if (!path || path.normalized !== true || !validSegments(path.segments) || !/^[A-Za-z]:$/.test(path.drive) || !location || !boolKnown(location.deniedSegment) || !nonempty(location.rootFileId) || !identity || !nonempty(identity.volumeSerial) || folder.registryComplete !== true || !boolKnown(folder.registeredInOrrery)) r[8].push('location-or-ownership-unknown');
    else if (norm(path.drive) !== norm(folder.drive) || path.segments.length <= folder.segments.length || folder.segments.some((segment, i) => norm(segment) !== norm(path.segments[i]!)) || location.rootFileId !== folder.rootFileId || identity.volumeSerial !== folder.volumeSerial || (norm(path.drive) === 'd:' && norm(path.segments[0]!) === 'orrery') || location.deniedSegment) r[8].push('location-refused');
    else if (folder.registeredInOrrery) {
      const x = input.integration;
      if (!x || x.state !== 'live-tested' || x.folderId !== folder.id || x.deviceId !== folder.deviceId || x.rootFileId !== folder.rootFileId || x.volumeSerial !== folder.volumeSerial || x.policyHash !== policy.hash || !nonempty(x.receiptId) || !numberKnown(x.expiresAtMs) || x.expiresAtMs <= now) r[8].push('integration-unproven');
      else if (!hashKnown(folder.mappingHash) || x.mappingHash !== folder.mappingHash || !numberKnown(x.expectedSequence) || x.expectedSequence < 1 || x.acceptedSequence !== x.expectedSequence || !numberKnown(x.snapshotAtMs) || !numberKnown(x.acceptedAtMs) || !numberKnown(x.observedAtMs) || x.snapshotAtMs > x.acceptedAtMs || x.acceptedAtMs > x.observedAtMs || x.observedAtMs > now || x.observedAtMs < snapshot.capturedAtMs || now - x.snapshotAtMs >= DAY || now - x.acceptedAtMs >= DAY) r[8].push('integration-snapshot-unproven');
    }
    const activity = file.activity;
    if (!activity || activity.complete !== true || [activity.reservations, activity.holds, activity.restores].some(value => !numberKnown(value)) || !boolKnown(activity.anotherProcessOpen) || !boolKnown(activity.changedSinceGeneration)) r[10].push('active-work-unknown');
    else if (activity.reservations! + activity.holds! + activity.restores! > 0 || activity.anotherProcessOpen || activity.changedSinceGeneration) r[10].push('active-work');
    if (!identity || !nonempty(identity.fileId) || !nonempty(identity.snapshotFileId) || !nonempty(identity.volumeSerial) || !numberKnown(identity.hardLinks) || identity.parentsComplete !== true || !boolKnown(identity.anyReparse) || identity.volumeKind === 'unknown') r[11].push('identity-unknown');
    else if (identity.fileId !== identity.snapshotFileId || identity.hardLinks !== 1 || identity.anyReparse || !['ntfs', 'refs'].includes(identity.volumeKind)) r[11].push('identity-unsafe');
  }
  const effectiveNotes = refs.notes.map(note => {
    const file = snapshot.files.find(file => file.id === note.id), times = file?.times;
    const seen = times ? [times.mtimeMs, times.changeTimeMs, times.creationMs, times.firstSeenAtPathMs] : [];
    return { ...note, hardPinned: note.hardPinned || note.designated || !!reasons[note.id]?.[2].some(code => code === 'hard-pinned' || code === 'sweep-protected'),
      newestEditMs: !file ? note.newestEditMs : note.newestEditMs === null || seen.length !== 4 || seen.some(value => !numberKnown(value)) ? null : Math.max(note.newestEditMs, ...seen as number[]) };
  });
  const protects = (edge: OEdge, subset: Set<string>): 7 | 9 | 10 | null => {
    if (['dependency', 'instruction'].includes(edge.kind)) return 10;
    if (edge.source === edge.target || subset.has(edge.source)) return null;
    if (edge.kind === 'ripple') return 9;
    const source = effectiveNotes.find(note => note.id === edge.source)!;
    if (edge.kind === 'name') return source.hardPinned ? 7 : null;
    if (['path', 'ambiguous', 'canvas', 'base'].includes(edge.kind)) return 7;
    if (edge.kind === 'link' && (policy.linkGuard === 'strict' || source.hardPinned || source.designated || source.approvedGoalMatched || source.newestEditMs === null || source.newestEditMs >= now - 90 * DAY)) return 7;
    return null;
  };
  const seed = snapshot.files.filter(file => ([1, 2, 3, 4, 5, 6, 8, 10, 11] as const).every(rule => reasons[file.id]![rule].length === 0)).map(file => file.id);
  // Enumerate every subset, independently of the production dropping/fixed-point implementation.
  const maximumClosed = (pool: readonly string[]): string[] => {
    let best: string[] = [];
    for (let mask = 0; mask < 2 ** pool.length; mask++) {
      const subset = pool.filter((_, i) => (mask & (1 << i)) !== 0);
      if (subset.length <= best.length) continue;
      const set = new Set(subset);
      if (refs.edges.every(edge => !set.has(edge.target) || protects(edge, set) === null)) best = subset;
    }
    return best.sort();
  };
  const fresh = coverage ? maximumClosed(seed) : [];
  const eligible = global.length ? [] : proposal ? maximumClosed(fresh.filter(id => proposal.includes(id))) : fresh;
  const pool = new Set(proposal ? eligible : fresh);
  for (const file of snapshot.files) {
    if (!coverage) { for (const rule of [7, 9, 10] as const) reasons[file.id]![rule].push('coverage-incomplete'); continue; }
    for (const edge of refs.edges.filter(edge => edge.target === file.id)) {
      const rule = protects(edge, pool);
      if (rule) reasons[file.id]![rule].push(rule === 7 ? 'protected-reference' : rule === 9 ? 'referenced-in-fleet' : 'dependency-or-instruction');
    }
  }
  const nameCounts = Object.fromEntries(eligible.map(id => [id, new Set(refs.edges.filter(edge => edge.kind === 'name' && edge.target === id && !pool.has(edge.source)).map(edge => edge.source)).size]));
  return { eligible, seed, reasons, global: global.sort(), nameCounts };
}
