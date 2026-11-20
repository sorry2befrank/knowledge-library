// Pure factual eligibility only. No I/O, learned input, approval verifier or movement authority.
import { closeEligibility, closeProposal, type ClosureNote, type ClosureReference } from './reference-closure.ts';
export type Rule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export type Check = {
    state: 'pass' | 'blocked' | 'unknown';
    codes: string[];
    references: string[];
};
export interface KernelFile {
    id: string;
    kind: 'file' | 'directory' | 'other' | null;
    // Canonical, resolved components supplied by the inventory, never caller text.
    path: {
        drive: string;
        segments: readonly string[];
        normalized: boolean | null;
    } | null;
    pins: {
        complete: boolean | null;
        kinds: readonly ('goal' | 'extra' | 'feedback' | 'designation' | 'open-tab' | 'last-open' | 'bookmark' | 'newest-handoff' | 'project-marker' | 'owner')[];
        personaHome: boolean | null;
    } | null;
    times: {
        mtimeMs: number | null;
        changeTimeMs: number | null;
        creationMs: number | null;
        firstSeenAtPathMs: number | null;
    } | null;
    restore: {
        historyComplete: boolean | null;
        latestAtMs: number | 'never' | null;
    } | null;
    git: {
        walkComplete: boolean | null;
        innermostResolved: boolean | null;
        state: 'no-repository' | 'untracked' | 'tracked' | 'unknown';
    } | null;
    custody: {
        classRemovable: boolean | null;
        verified: boolean | null;
        versionId: string | null;
        currentSha256: string | null;
        archivedSha256: string | null;
    } | null;
    location: {
        rootFileId: string | null;
        deniedSegment: boolean | null;
    } | null;
    activity: {
        complete: boolean | null;
        reservations: number | null;
        holds: number | null;
        restores: number | null;
        anotherProcessOpen: boolean | null;
        changedSinceGeneration: boolean | null;
    } | null;
    identity: {
        fileId: string | null;
        snapshotFileId: string | null;
        volumeSerial: string | null;
        hardLinks: number | null;
        parentsComplete: boolean | null;
        anyReparse: boolean | null;
        volumeKind: 'ntfs' | 'refs' | 'network' | 'other' | 'unknown';
    } | null;
}
export interface KernelInput {
    nowMs: number;
    phase: 'plan' | 'apply';
    snapshot: {
        id: string;
        capturedAtMs: number;
        complete: boolean | null;
        files: readonly KernelFile[];
    };
    folder: {
        id: string;
        deviceId: string;
        drive: string;
        segments: readonly string[];
        rootFileId: string;
        volumeSerial: string;
        mappingHash: string | null;
        registryComplete: boolean | null;
        registeredInOrrery: boolean | null;
        obsidianSyncEnabled: boolean | null;
    };
    // These are outputs of current scoped receipt verification, not approvals from this function.
    policy: {
        state: 'accepted' | 'unaccepted' | 'unknown';
        hash: string;
        folderId: string;
        deviceId: string;
        enabled: boolean | null;
        types: readonly string[];
        editGraceDays: number;
        restoreProtectWeeks: number;
        linkGuard: 'strict' | 'stale-sources';
        gitMode: 'never' | 'sparse';
        nameMentions: 'ask' | 'allow';
        syncReplicated: 'acknowledged' | 'unknown';
    };
    goal: {
        state: 'approved' | 'proposal' | 'missing' | 'unknown';
        hash: string;
        policyHash: string;
        folderId: string;
        deviceId: string;
        issuedAtMs: number;
        expiresAtMs: number;
        superseded: boolean | null;
        conflicting: boolean | null;
    };
    references: {
        id: string;
        snapshotId: string;
        policyHash: string;
        goalHash: string;
        complete: boolean | null;
        rootsComplete: boolean | null;
        unresolvedReadErrors: number | null;
        skippedUnexcluded: number | null;
        exclusionsRecorded: boolean | null;
        exclusionsReceiptBound: boolean | null;
        readMode: 'full' | 'incremental';
        readAtMs: number;
        lastFullReadAtMs: number;
        changeTimeConformance: boolean | null;
        notes: readonly ClosureNote[];
        edges: readonly ClosureReference[];
    };
    sweep: {
        folderId: string;
        snapshotId: string;
        format: 'known' | 'unknown';
        history: 'complete' | 'unproven';
        association: 'proven' | 'unproven';
        adjudication: 'known' | 'unknown';
        wholeFolderHeld: boolean | null;
        protectedIds: readonly string[];
    };
    integration: {
        state: 'live-tested' | 'disabled' | 'unknown';
        folderId: string;
        deviceId: string;
        rootFileId: string;
        volumeSerial: string;
        policyHash: string;
        receiptId: string;
        expiresAtMs: number;
        mappingHash: string | null;
        expectedSequence: number | null;
        acceptedSequence: number | null;
        snapshotAtMs: number | null;
        acceptedAtMs: number | null;
        observedAtMs: number | null;
    } | null;
}
export interface KernelResult {
    evaluation: 'evaluated' | 'refused';
    eligible: string[];
    items: Record<string, Record<Rule, Check>>;
    globalHolds: string[];
    nameMentionCounts: Record<string, number>;
    nameReviewRequired: string[];
    counts: {
        evaluatedFiles: number;
        eligible: number;
        held: number;
        zeroYield: boolean;
        byRule: Record<Rule, {
            pass: number;
            blocked: number;
            unknown: number;
        }>;
        byReason: Record<string, number>;
    };
    effect: 'none';
}
const DAY = 86400000;
const RULES: readonly Rule[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const PIN_KINDS = new Set(['goal', 'extra', 'feedback', 'designation', 'open-tab', 'last-open', 'bookmark', 'newest-handoff', 'project-marker', 'owner']);
const KINDS = new Set(['link', 'path', 'ambiguous', 'canvas', 'base', 'name', 'ripple', 'dependency', 'instruction']);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const identityValue = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const count = (v: unknown): v is number => time(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const check = (state: Check['state'], code?: string, references: string[] = []): Check => ({ state, codes: code ? [code] : [], references });
const pass = () => check('pass');
const held = (code: string) => check('blocked', code);
const unknown = (code: string) => check('unknown', code);
const canonical = (s: string) => s.normalize('NFC').toLowerCase();
function segments(v: unknown): v is readonly string[] {
    return Array.isArray(v) && v.length <= 128 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 255 && x !== '.' && x !== '..' && !/[\\/:\x00-\x1f]/.test(x) && !/[. ]$/.test(x));
}
function within(path: readonly string[], root: readonly string[]): boolean {
    return path.length > root.length && root.every((s, i) => canonical(s) === canonical(path[i]!));
}
function exceedsBounds(input: KernelInput): boolean {
    const files = input?.snapshot?.files, notes = input?.references?.notes, edges = input?.references?.edges;
    return (Array.isArray(files) && files.length > 10000) || (Array.isArray(notes) && notes.length > 20000) || (Array.isArray(edges) && edges.length > 100000)
        || (Array.isArray(files) && Array.isArray(edges) && files.length * edges.length > 2000000);
}
function shape(input: KernelInput): boolean {
    if (!input || !time(input.nowMs) || !['plan', 'apply'].includes(input.phase))
        return false;
    const { snapshot, folder, policy, goal, references, sweep } = input;
    if (!snapshot || !id(snapshot.id) || !Array.isArray(snapshot.files) || snapshot.files.length > 10000
        || !folder || !id(folder.id) || !id(folder.deviceId) || !identityValue(folder.rootFileId) || !identityValue(folder.volumeSerial) || !/^[A-Za-z]:$/.test(folder.drive) || !segments(folder.segments)
        || !policy || !sha(policy.hash) || !Array.isArray(policy.types) || !policy.types.length || policy.types.length > 32 || !policy.types.every(x => typeof x === 'string' && /^\.[a-z0-9]{1,16}$/i.test(x))
        || !time(policy.editGraceDays) || policy.editGraceDays > 3650 || !time(policy.restoreProtectWeeks) || policy.restoreProtectWeeks > 520
        || !['strict', 'stale-sources'].includes(policy.linkGuard) || !['never', 'sparse'].includes(policy.gitMode) || !['ask', 'allow'].includes(policy.nameMentions)
        || !goal || !references || !id(references.id) || !Array.isArray(references.notes) || references.notes.length > 20000 || !Array.isArray(references.edges) || references.edges.length > 100000
        || snapshot.files.length * references.edges.length > 2000000
        || !sweep || !Array.isArray(sweep.protectedIds) || sweep.protectedIds.length > 10000 || !sweep.protectedIds.every(id))
        return false;
    const files = new Set<string>();
    for (const file of snapshot.files)
        if (!file || !id(file.id) || files.has(file.id))
            return false;
        else
            files.add(file.id);
    const notes = new Set<string>();
    for (const note of references.notes) {
        if (!note || !id(note.id) || notes.has(note.id) || !bool(note.hardPinned) || !bool(note.designated) || !bool(note.approvedGoalMatched) || (note.newestEditMs !== null && !time(note.newestEditMs)))
            return false;
        notes.add(note.id);
    }
    if ([...files].some(x => !notes.has(x)) || sweep.protectedIds.some(x => !notes.has(x)))
        return false;
    const edges = new Set<string>();
    for (const ref of references.edges)
        if (!ref || !id(ref.id) || edges.has(ref.id) || !notes.has(ref.source) || !notes.has(ref.target) || !KINDS.has(ref.kind))
            return false;
        else
            edges.add(ref.id);
    return true;
}
function duplicateIdentity(input: KernelInput): boolean {
    const paths = new Set<string>(), identities = new Set<string>();
    for (const file of input.snapshot.files) {
        if (file.path?.normalized === true && /^[A-Za-z]:$/.test(file.path.drive) && segments(file.path.segments)) {
            const key = canonical(file.path.drive) + '/' + file.path.segments.map(canonical).join('/');
            if (paths.has(key)) return true;
            paths.add(key);
        }
        if (identityValue(file.identity?.volumeSerial) && identityValue(file.identity?.fileId)) {
            const key = JSON.stringify([canonical(file.identity.volumeSerial), canonical(file.identity.fileId)]);
            if (identities.has(key)) return true;
            identities.add(key);
        }
    }
    return false;
}
function intrinsicPin(file: KernelFile): boolean {
    const p = file.path?.segments;
    if (!segments(p) || !p.length)
        return false;
    const base = canonical(p[p.length - 1]!), parent = canonical(p[p.length - 2] ?? '');
    return p.some(x => canonical(x) === '_understudy')
        || ['understudy.md', 'archived.md', 'claude.md', 'agents.md', 'pipeline.md', 'relationship-register.md', 'follow-ups.md', 'blocked.md'].includes(base)
        || base.startsWith('readme') || base.startsWith('status') || (parent === 'secretary' && base === 'ledger.md')
        || (file.pins?.personaHome === true && (['northstar.md', 'directive.md', 'corrections.md'].includes(base) || base.startsWith('passdown') || base.startsWith('operating-model') || base.endsWith('.manifest.json')));
}
function globalHolds(input: KernelInput): string[] {
    const { nowMs: now, snapshot, folder, policy, goal } = input, out: string[] = [];
    if (snapshot.complete !== true)
        out.push('snapshot-incomplete');
    if (!time(snapshot.capturedAtMs) || snapshot.capturedAtMs > now || now - snapshot.capturedAtMs >= DAY)
        out.push('snapshot-stale');
    if (policy.state !== 'accepted' || policy.enabled !== true || policy.folderId !== folder.id || policy.deviceId !== folder.deviceId)
        out.push('policy-unproven');
    if (goal.state !== 'approved' || !sha(goal.hash) || goal.policyHash !== policy.hash || goal.folderId !== folder.id || goal.deviceId !== folder.deviceId || goal.superseded !== false || goal.conflicting !== false)
        out.push('goal-unproven');
    if (!time(goal.issuedAtMs) || !time(goal.expiresAtMs) || goal.issuedAtMs > now || goal.expiresAtMs <= now || goal.expiresAtMs <= goal.issuedAtMs || goal.expiresAtMs - goal.issuedAtMs > 28 * DAY)
        out.push('goal-expired-or-invalid');
    if (!bool(folder.obsidianSyncEnabled) || (folder.obsidianSyncEnabled && policy.syncReplicated !== 'acknowledged'))
        out.push('sync-unacknowledged');
    return out.sort();
}
function completeReferences(input: KernelInput): boolean {
    const r = input.references;
    return r.complete === true && r.rootsComplete === true && r.unresolvedReadErrors === 0 && r.skippedUnexcluded === 0
        && r.exclusionsRecorded === true && r.exclusionsReceiptBound === true && r.snapshotId === input.snapshot.id && r.policyHash === input.policy.hash && r.goalHash === input.goal.hash
        && time(r.readAtMs) && r.readAtMs >= input.snapshot.capturedAtMs && r.readAtMs <= input.nowMs && time(r.lastFullReadAtMs) && r.lastFullReadAtMs <= r.readAtMs && input.nowMs - r.lastFullReadAtMs <= 7 * DAY
        && ((r.readMode === 'full' && r.lastFullReadAtMs === r.readAtMs) || (r.readMode === 'incremental' && r.changeTimeConformance === true));
}
function baseChecks(file: KernelFile, input: KernelInput, inventoryHardPin: boolean): Record<Rule, Check> {
    const result = Object.fromEntries(RULES.map(r => [r, pass()])) as Record<Rule, Check>;
    const path = file.path, name = path && segments(path.segments) ? path.segments.at(-1) : undefined;
    if (file.kind === null || file.kind === undefined || !name)
        result[1] = unknown('file-kind-or-type-unknown');
    else if (file.kind !== 'file')
        result[1] = held('not-file');
    else if (!input.policy.types.map(canonical).includes(canonical(name.slice(name.lastIndexOf('.')))))
        result[1] = held('type-not-allowed');
    const p = file.pins, sweep = input.sweep;
    if (intrinsicPin(file) || inventoryHardPin || (Array.isArray(p?.kinds) && p.kinds.some(x => PIN_KINDS.has(x))))
        result[2] = held('hard-pinned');
    else if (!p || p.complete !== true || !Array.isArray(p.kinds) || p.kinds.some(x => !PIN_KINDS.has(x)) || !bool(p.personaHome))
        result[2] = unknown('pins-unknown');
    if (sweep.folderId !== input.folder.id || sweep.snapshotId !== input.snapshot.id || sweep.format !== 'known' || sweep.history !== 'complete' || sweep.association !== 'proven' || sweep.adjudication !== 'known' || sweep.wholeFolderHeld !== false) {
        if (result[2].state === 'pass')
            result[2] = unknown('adjudication-unknown');
        else
            result[2].codes.push('adjudication-unknown');
    }
    else if (sweep.protectedIds.includes(file.id))
        result[2] = held('sweep-protected');
    const t = file.times, ts = t ? [t.mtimeMs, t.changeTimeMs, t.creationMs, t.firstSeenAtPathMs] : [];
    if (ts.length !== 4 || !ts.every(time))
        result[3] = unknown('edit-age-unknown');
    else if (Math.max(...ts as number[]) > input.nowMs || input.nowMs - Math.max(...ts as number[]) < input.policy.editGraceDays * DAY)
        result[3] = held('edit-or-arrival-grace');
    if (!file.restore || file.restore.historyComplete !== true || (file.restore.latestAtMs !== 'never' && !time(file.restore.latestAtMs)))
        result[4] = unknown('restore-history-unknown');
    else if (file.restore.latestAtMs !== 'never' && (file.restore.latestAtMs > input.nowMs || input.nowMs - file.restore.latestAtMs < input.policy.restoreProtectWeeks * 7 * DAY))
        result[4] = held('restore-protected');
    const git = file.git;
    if (!git || git.walkComplete !== true || git.innermostResolved !== true || !['no-repository', 'untracked', 'tracked'].includes(git.state))
        result[5] = unknown('git-unknown');
    else if (git.state === 'tracked')
        result[5] = input.policy.gitMode === 'never' ? held('git-tracked') : unknown('git-sparse-unsupported');
    const custody = file.custody;
    if (!custody || !bool(custody.classRemovable) || !bool(custody.verified) || !sha(custody.currentSha256))
        result[6] = unknown('custody-unknown');
    else if (!custody.classRemovable)
        result[6] = held('class-not-removable');
    else if (!custody.verified || !identityValue(custody.versionId) || !sha(custody.archivedSha256) || canonical(custody.archivedSha256) !== canonical(custody.currentSha256))
        result[6] = held('verified-current-custody-missing');
    const loc = file.location, identity = file.identity, folder = input.folder;
    if (!path || path.normalized !== true || !segments(path.segments) || !/^[A-Za-z]:$/.test(path.drive) || !loc || !bool(loc.deniedSegment) || !identityValue(loc.rootFileId) || !identity || !identityValue(identity.volumeSerial) || folder.registryComplete !== true || !bool(folder.registeredInOrrery))
        result[8] = unknown('location-or-ownership-unknown');
    else if (canonical(path.drive) !== canonical(folder.drive) || !within(path.segments, folder.segments) || loc.rootFileId !== folder.rootFileId || identity.volumeSerial !== folder.volumeSerial || (canonical(path.drive) === 'd:' && canonical(path.segments[0] ?? '') === 'orrery') || loc.deniedSegment)
        result[8] = held('location-refused');
    else if (folder.registeredInOrrery) {
        const x = input.integration;
        if (!x || x.state !== 'live-tested' || x.folderId !== folder.id || x.deviceId !== folder.deviceId || x.rootFileId !== folder.rootFileId || x.volumeSerial !== folder.volumeSerial || x.policyHash !== input.policy.hash || !id(x.receiptId) || !time(x.expiresAtMs) || x.expiresAtMs <= input.nowMs)
            result[8] = unknown('integration-unproven');
        else if (!sha(folder.mappingHash) || x.mappingHash !== folder.mappingHash || !count(x.expectedSequence) || x.expectedSequence < 1 || x.acceptedSequence !== x.expectedSequence
            || !time(x.snapshotAtMs) || !time(x.acceptedAtMs) || !time(x.observedAtMs) || x.snapshotAtMs > x.acceptedAtMs || x.acceptedAtMs > x.observedAtMs || x.observedAtMs > input.nowMs || x.observedAtMs < input.snapshot.capturedAtMs
            || input.nowMs - x.snapshotAtMs >= DAY || input.nowMs - x.acceptedAtMs >= DAY)
            result[8] = unknown('integration-snapshot-unproven');
    }
    const a = file.activity;
    if (!a || a.complete !== true || ![a.reservations, a.holds, a.restores].every(count) || !bool(a.anotherProcessOpen) || !bool(a.changedSinceGeneration))
        result[10] = unknown('active-work-unknown');
    else if (a.reservations! > 0 || a.holds! > 0 || a.restores! > 0 || a.anotherProcessOpen || a.changedSinceGeneration)
        result[10] = held('active-work');
    if (!identity || !identityValue(identity.fileId) || !identityValue(identity.snapshotFileId) || !identityValue(identity.volumeSerial) || !count(identity.hardLinks) || identity.parentsComplete !== true || !bool(identity.anyReparse) || identity.volumeKind === 'unknown')
        result[11] = unknown('identity-unknown');
    else if (identity.fileId !== identity.snapshotFileId || identity.hardLinks !== 1 || identity.anyReparse || !['ntfs', 'refs'].includes(identity.volumeKind))
        result[11] = held('identity-unsafe');
    return result;
}
function finish(items: KernelResult['items'], eligible: string[], global: string[], names: Record<string, number>, ask: boolean, evaluation: KernelResult['evaluation'] = 'evaluated'): KernelResult {
    const byRule = Object.fromEntries(RULES.map(r => [r, { pass: 0, blocked: 0, unknown: 0 }])) as KernelResult['counts']['byRule'];
    const byReason: Record<string, number> = Object.create(null);
    for (const proof of Object.values(items))
        for (const rule of RULES) {
            const c = proof[rule];
            byRule[rule][c.state]++;
            for (const code of new Set(c.codes))
                byReason[code] = (byReason[code] ?? 0) + 1;
        }
    for (const code of global)
        byReason[code] = Object.keys(items).length || 1;
    const e = [...eligible].sort(), n = Object.keys(items).length;
    return { evaluation, eligible: e, items, globalHolds: global, nameMentionCounts: names, nameReviewRequired: ask ? e.filter(x => (names[x] ?? 0) > 0) : [], counts: { evaluatedFiles: n, eligible: e.length, held: n - e.length, zeroYield: e.length === 0, byRule, byReason }, effect: 'none' };
}
function compute(input: KernelInput, proposed?: readonly string[]): KernelResult {
    if (exceedsBounds(input))
        return finish(Object.create(null), [], ['workload-limit-exceeded'], Object.create(null), false, 'refused');
    if (!shape(input) || (proposed && (proposed.length > 10000 || !proposed.every(id) || new Set(proposed).size !== proposed.length)))
        return finish(Object.create(null), [], ['input-invalid'], Object.create(null), false, 'refused');
    if (duplicateIdentity(input)) return finish(Object.create(null), [], ['duplicate-snapshot-identity'], Object.create(null), false, 'refused');
    const items: KernelResult['items'] = Object.create(null), global = globalHolds(input), complete = completeReferences(input);
    const inventoryNotes = new Map(input.references.notes.map(n => [n.id, n]));
    for (const file of input.snapshot.files)
        items[file.id] = baseChecks(file, input, inventoryNotes.get(file.id)!.hardPinned || inventoryNotes.get(file.id)!.designated);
    if (!complete)
        global.push('coverage-incomplete');
    const fileById = new Map(input.snapshot.files.map(file => [file.id, file]));
    const notes = input.references.notes.map(note => {
        const file = fileById.get(note.id), times = file?.times;
        const observed = times ? [times.mtimeMs, times.changeTimeMs, times.creationMs, times.firstSeenAtPathMs] : [];
        // A stale duplicate cannot discount a newer or unknown current observation.
        const newestEditMs = !file ? note.newestEditMs
            : note.newestEditMs === null || observed.length !== 4 || !observed.every(time) ? null
            : Math.max(note.newestEditMs, ...(observed as number[]));
        return { ...note, newestEditMs, hardPinned: note.hardPinned || note.designated
            || !!items[note.id]?.[2].codes.some(x => ['hard-pinned', 'sweep-protected'].includes(x)) };
    });
    const seed = input.snapshot.files.filter(f => [1, 2, 3, 4, 5, 6, 8, 10, 11].every(r => items[f.id]![r as Rule].state === 'pass')).map(f => f.id);
    const closureInput = { nowMs: input.nowMs, complete, notes, references: input.references.edges, seed, linkGuard: input.policy.linkGuard };
    const closure = proposed ? closeProposal(closureInput, proposed) : closeEligibility(closureInput), pool = new Set(closure.eligible), noteById = new Map(notes.map(n => [n.id, n]));
    for (const [target, proof] of Object.entries(items)) {
        if (!complete || closure.coverage !== 'complete') {
            proof[7] = unknown('coverage-incomplete');
            proof[9] = unknown('coverage-incomplete');
            if (proof[10].state === 'pass')
                proof[10] = unknown('coverage-incomplete');
            else
                proof[10].codes.push('coverage-incomplete');
            continue;
        }
        for (const ref of input.references.edges) {
            if (ref.target !== target)
                continue;
            let rule: 7 | 9 | 10 | null = null;
            const source = noteById.get(ref.source)!;
            if (ref.kind === 'dependency' || ref.kind === 'instruction')
                rule = 10;
            else if (ref.source !== target && !pool.has(ref.source) && ref.kind === 'ripple')
                rule = 9;
            else if (ref.source !== target && !pool.has(ref.source) && (ref.kind === 'name' ? source.hardPinned : ref.kind !== 'link' || input.policy.linkGuard === 'strict' || source.hardPinned || source.designated || source.approvedGoalMatched || source.newestEditMs === null || input.nowMs - source.newestEditMs <= 90 * DAY))
                rule = 7;
            if (rule) {
                const code = rule === 7 ? 'protected-reference' : rule === 9 ? 'referenced-in-fleet' : 'dependency-or-instruction';
                if (proof[rule].state === 'pass')
                    proof[rule] = held(code);
                else if (!proof[rule].codes.includes(code))
                    proof[rule].codes.push(code);
                proof[rule].references.push(ref.id);
            }
        }
    }
    const eligible = global.length ? [] : closure.eligible.filter(x => RULES.every(r => items[x]![r].state === 'pass'));
    return finish(items, eligible, global.sort(), closure.nameMentionCounts, input.policy.nameMentions === 'ask');
}
/** Inputs must originate in trusted current adapters. This does not verify signatures or authorize apply. */
export function eligible(input: KernelInput): KernelResult { try {
    return compute(input);
}
catch {
    return finish(Object.create(null), [], ['input-invalid'], Object.create(null), false, 'refused');
} }
/** A learned proposal is a separate narrowing operation; it never changes the eligibility input. */
export function closeKernelProposal(input: KernelInput, proposed: readonly string[]): KernelResult {
    if (!Array.isArray(proposed)) return finish(Object.create(null), [], ['proposal-invalid'], Object.create(null), false, 'refused');
    try {
    return compute(input, proposed);
}
catch {
    return finish(Object.create(null), [], ['input-invalid'], Object.create(null), false, 'refused');
} }
