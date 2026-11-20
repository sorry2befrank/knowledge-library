import { describe, it, expect } from 'vitest';
import { eligible, closeKernelProposal, type KernelInput, type KernelFile, type Rule } from '../packages/core/src/focus/eligibility.ts';
const DAY = 86400000, NOW = 300 * DAY, HASH = 'a'.repeat(64), GOAL = 'b'.repeat(64), CONTENT = 'c'.repeat(64);
function file(id: string): KernelFile {
    return { id, kind: 'file', path: { drive: 'D:', segments: ['vault', 'project', id + '.md'], normalized: true },
        pins: { complete: true, kinds: [], personaHome: false }, times: { mtimeMs: 100 * DAY, changeTimeMs: 100 * DAY, creationMs: 100 * DAY, firstSeenAtPathMs: 100 * DAY },
        restore: { historyComplete: true, latestAtMs: 'never' }, git: { walkComplete: true, innermostResolved: true, state: 'untracked' },
        custody: { classRemovable: true, verified: true, versionId: id + '@1', currentSha256: CONTENT, archivedSha256: CONTENT },
        location: { rootFileId: 'root-1', deniedSegment: false }, activity: { complete: true, reservations: 0, holds: 0, restores: 0, anotherProcessOpen: false, changedSinceGeneration: false },
        identity: { fileId: 'inode-' + id, snapshotFileId: 'inode-' + id, volumeSerial: 'volume-1', hardLinks: 1, parentsComplete: true, anyReparse: false, volumeKind: 'ntfs' } };
}
function fixture(): KernelInput {
    return { nowMs: NOW, phase: 'plan', snapshot: { id: 'snapshot-1', capturedAtMs: NOW, complete: true, files: [file('a'), file('b'), file('c')] },
        folder: { id: 'folder-1', deviceId: 'device-1', drive: 'D:', segments: ['vault', 'project'], rootFileId: 'root-1', volumeSerial: 'volume-1', mappingHash: 'd'.repeat(64), registryComplete: true, registeredInOrrery: false, obsidianSyncEnabled: false },
        policy: { state: 'accepted', hash: HASH, folderId: 'folder-1', deviceId: 'device-1', enabled: true, types: ['.md', '.markdown', '.txt'], editGraceDays: 14, restoreProtectWeeks: 8, linkGuard: 'strict', gitMode: 'never', nameMentions: 'ask', syncReplicated: 'unknown' },
        goal: { state: 'approved', hash: GOAL, policyHash: HASH, folderId: 'folder-1', deviceId: 'device-1', issuedAtMs: NOW - DAY, expiresAtMs: NOW + 13 * DAY, superseded: false, conflicting: false },
        references: { id: 'refs-1', snapshotId: 'snapshot-1', policyHash: HASH, goalHash: GOAL, complete: true, rootsComplete: true, unresolvedReadErrors: 0, skippedUnexcluded: 0, exclusionsRecorded: true, exclusionsReceiptBound: true, readMode: 'full', readAtMs: NOW, lastFullReadAtMs: NOW, changeTimeConformance: false,
            notes: ['a', 'b', 'c', 'kept'].map(id => ({ id, hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: 100 * DAY })), edges: [] },
        sweep: { folderId: 'folder-1', snapshotId: 'snapshot-1', format: 'known', history: 'complete', association: 'proven', adjudication: 'known', wholeFolderHeld: false, protectedIds: [] }, integration: null };
}
const a = (x: KernelInput) => x.snapshot.files[0]!;
function blocked(input: KernelInput, rule: Rule, code?: string) { const r = eligible(input); expect(r.eligible).not.toContain('a'); expect(r.items.a![rule].state).not.toBe('pass'); if (code)
    expect(r.items.a![rule].codes).toContain(code); return r; }
const edge = (id: string, source: string, target: string, kind: KernelInput['references']['edges'][number]['kind']) => ({ id, source, target, kind });
describe('pure eleven-rule kernel, no movement authority', () => {
    it('positive factual fixture passes every rule and emits actual supplied-input counts', () => { const r = eligible(fixture()); expect(r.eligible).toEqual(['a', 'b', 'c']); expect(r.effect).toBe('none'); expect(r.counts).toMatchObject({ evaluatedFiles: 3, eligible: 3, held: 0, zeroYield: false }); for (const row of Object.values(r.counts.byRule))
        expect(row).toEqual({ pass: 3, blocked: 0, unknown: 0 }); });
    it('all eleven independent blocking facts are reported for one item', () => { const x = fixture(), f = a(x); f.kind = 'directory'; f.pins!.kinds = ['goal']; f.times!.creationMs = NOW; f.restore!.latestAtMs = NOW; f.git!.state = 'tracked'; f.custody!.classRemovable = false; f.location!.deniedSegment = true; f.identity!.hardLinks = 2; x.references.edges = [edge('link', 'kept', 'a', 'link'), edge('ripple', 'kept', 'a', 'ripple'), edge('dependency', 'b', 'a', 'dependency')]; const r = eligible(x); expect(r.eligible).toEqual(['b', 'c']); for (const rule of Object.values(r.items.a!))
        expect(rule.state).toBe('blocked'); for (const row of Object.values(r.counts.byRule))
        expect(row).toEqual({ pass: 2, blocked: 1, unknown: 0 }); expect(r.counts.byReason['hard-pinned']).toBe(1); });
    it('R1 refuses directories, wrong types and missing facts', () => { for (const kind of ['directory', 'other', null] as const) {
        const x = fixture();
        a(x).kind = kind;
        blocked(x, 1);
    } const x = fixture(); a(x).path!.segments = ['vault', 'project', 'a.bin']; blocked(x, 1, 'type-not-allowed'); a(x).path!.segments = ['VAULT', 'PROJECT', 'A.MD']; expect(eligible(x).eligible).toContain('a'); });
    it('R2 applies intrinsic pins even when an otherwise complete pin list is empty', () => { for (const name of ['UNDERSTUDY.md', 'ARCHIVED.md', 'CLAUDE.md', 'AGENTS.md', 'README-old.md', 'STATUS.txt', 'PIPELINE.md', 'RELATIONSHIP-REGISTER.md', 'FOLLOW-UPS.md', 'BLOCKED.md']) {
        const x = fixture();
        a(x).path!.segments = ['vault', 'project', name];
        blocked(x, 2, 'hard-pinned');
    } for (const relative of [['_UNDERSTUDY', 'report.md'], ['secretary', 'LEDGER.md']]) {
        const x = fixture();
        a(x).path!.segments = ['vault', 'project', ...relative];
        blocked(x, 2, 'hard-pinned');
    } });
    it('R2 persona-home patterns require current registry facts and preserve ordinary controls', () => { for (const name of ['NORTHSTAR.md', 'DIRECTIVE.md', 'CORRECTIONS.md', 'PASSDOWN-next.md', 'OPERATING-MODEL-v2.md', 'agent.manifest.json']) {
        const x = fixture();
        a(x).path!.segments = ['vault', 'project', name];
        a(x).pins!.personaHome = true;
        blocked(x, 2, 'hard-pinned');
    } const x = fixture(); a(x).path!.segments = ['vault', 'project', 'DIRECTIVE.md']; expect(eligible(x).eligible).toContain('a'); a(x).pins!.personaHome = null; blocked(x, 2, 'pins-unknown'); });
    it('R2 every explicit pin channel blocks and inventory pins cannot be contradicted', () => { for (const kind of ['goal', 'extra', 'feedback', 'designation', 'open-tab', 'last-open', 'bookmark', 'newest-handoff', 'project-marker', 'owner'] as const) {
        const x = fixture();
        a(x).pins!.kinds = [kind];
        blocked(x, 2, 'hard-pinned');
    } const x = fixture(); x.references.notes[0]!.hardPinned = true; blocked(x, 2, 'hard-pinned'); });
    it('R2 parser-format knowledge never clears missing history, association or folder holds', () => { for (const mutate of [(x: KernelInput) => { x.sweep.format = 'unknown'; }, (x: KernelInput) => { x.sweep.history = 'unproven'; }, (x: KernelInput) => { x.sweep.association = 'unproven'; }, (x: KernelInput) => { x.sweep.adjudication = 'unknown'; }, (x: KernelInput) => { x.sweep.wholeFolderHeld = true; }, (x: KernelInput) => { x.sweep.folderId = 'wrong'; }, (x: KernelInput) => { x.sweep.snapshotId = 'old'; }]) {
        const x = fixture();
        mutate(x);
        const r = eligible(x);
        expect(r.eligible).toEqual([]);
        expect(r.counts.zeroYield).toBe(true);
        expect(r.counts.byRule[2].unknown).toBe(3);
        expect(r.counts.byReason['adjudication-unknown']).toBe(3);
    } const x = fixture(); x.sweep.protectedIds = ['a']; blocked(x, 2, 'sweep-protected'); });
    it('R3 the newest of four timestamps protects copied or newly arrived notes', () => { for (const key of ['mtimeMs', 'changeTimeMs', 'creationMs', 'firstSeenAtPathMs'] as const) {
        const x = fixture();
        a(x).times![key] = NOW - 1;
        blocked(x, 3, 'edit-or-arrival-grace');
        a(x).times![key] = null;
        blocked(x, 3, 'edit-age-unknown');
    } });
    it('R3 exact grace boundary passes but future timestamps protect', () => { const x = fixture(); a(x).times!.changeTimeMs = NOW - 14 * DAY; expect(eligible(x).eligible).toContain('a'); a(x).times!.changeTimeMs = NOW - 14 * DAY + 1; blocked(x, 3); a(x).times!.changeTimeMs = NOW + 1; blocked(x, 3); });
    it('R4 restored and unknown history protect, exact eight-week boundary passes', () => { const x = fixture(); a(x).restore!.latestAtMs = NOW - 56 * DAY; expect(eligible(x).eligible).toContain('a'); a(x).restore!.latestAtMs = NOW - 56 * DAY + 1; blocked(x, 4, 'restore-protected'); a(x).restore!.latestAtMs = null; blocked(x, 4, 'restore-history-unknown'); a(x).restore = { historyComplete: false, latestAtMs: 'never' }; blocked(x, 4); });
    it('R5 unreadable ancestor or unresolved innermost repository protects', () => { for (const key of ['walkComplete', 'innermostResolved'] as const) {
        const x = fixture();
        a(x).git![key] = false;
        blocked(x, 5, 'git-unknown');
    } const x = fixture(); a(x).git!.state = 'tracked'; blocked(x, 5, 'git-tracked'); x.policy.gitMode = 'sparse'; blocked(x, 5, 'git-sparse-unsupported'); a(x).git!.state = 'no-repository'; expect(eligible(x).eligible).toContain('a'); });
    it('R6 needs removable class and exact verified current-byte custody', () => { for (const mutate of [(f: KernelFile) => { f.custody!.classRemovable = false; }, (f: KernelFile) => { f.custody!.verified = false; }, (f: KernelFile) => { f.custody!.archivedSha256 = 'd'.repeat(64); }, (f: KernelFile) => { f.custody!.versionId = null; }, (f: KernelFile) => { f.custody!.currentSha256 = null; }]) {
        const x = fixture();
        mutate(a(x));
        blocked(x, 6);
    } expect(eligible(fixture()).eligible).toContain('a'); });
    it('R7 hard-pinned names protect under both guards while ordinary names only need review', () => { for (const guard of ['strict', 'stale-sources'] as const) {
        const x = fixture();
        x.policy.linkGuard = guard;
        x.references.edges = [edge('name', 'kept', 'a', 'name')];
        let r = eligible(x);
        expect(r.eligible).toContain('a');
        expect(r.nameMentionCounts.a).toBe(1);
        expect(r.nameReviewRequired).toEqual(['a']);
        x.policy.nameMentions = 'allow';
        expect(eligible(x).nameReviewRequired).toEqual([]);
        x.references.notes[3]!.hardPinned = true;
        blocked(x, 7, 'protected-reference');
    } });
    it('R7 stale discount applies only to ordinary resolved links', () => { for (const kind of ['link', 'path', 'ambiguous', 'canvas', 'base'] as const) {
        const x = fixture();
        x.policy.linkGuard = 'stale-sources';
        x.references.edges = [edge('r', 'kept', 'a', kind)];
        if (kind === 'link')
            expect(eligible(x).eligible).toContain('a');
        else
            blocked(x, 7);
    } });
    it('R7/R9 cascade after every other rule changes the candidate set', () => { const x = fixture(); x.references.edges = [edge('ab', 'a', 'b', 'link'), edge('bc', 'b', 'c', 'ripple')]; expect(eligible(x).eligible).toEqual(['a', 'b', 'c']); a(x).times!.mtimeMs = NOW; const r = eligible(x); expect(r.eligible).toEqual([]); expect(r.items.b![7].state).toBe('blocked'); expect(r.items.c![9].state).toBe('blocked'); expect(r.counts.zeroYield).toBe(true); });
    it('R8 rejects outside, sibling-prefix, wrong root, serial, drive, denied and Orrery locations', () => { for (const mutate of [(x: KernelInput) => { a(x).path!.segments = ['vault', 'project-other', 'a.md']; }, (x: KernelInput) => { a(x).path!.drive = 'C:'; }, (x: KernelInput) => { a(x).location!.rootFileId = 'new-root'; }, (x: KernelInput) => { a(x).identity!.volumeSerial = 'new-volume'; }, (x: KernelInput) => { a(x).location!.deniedSegment = true; }, (x: KernelInput) => { x.folder.segments = ['orrery', 'project']; a(x).path!.segments = ['orrery', 'project', 'a.md']; }]) {
        const x = fixture();
        mutate(x);
        blocked(x, 8, 'location-refused');
    } });
    it('R8 registered folders require live tested current scoped integration evidence', () => { const x = fixture(); x.folder.registeredInOrrery = true; blocked(x, 8, 'integration-unproven'); x.integration = { state: 'live-tested', folderId: x.folder.id, deviceId: x.folder.deviceId, rootFileId: x.folder.rootFileId, volumeSerial: x.folder.volumeSerial, policyHash: x.policy.hash, receiptId: 'scoped-receipt', expiresAtMs: NOW + DAY, mappingHash: x.folder.mappingHash, expectedSequence: 41, acceptedSequence: 41, snapshotAtMs: NOW - 1000, acceptedAtMs: NOW - 500, observedAtMs: NOW }; expect(eligible(x).eligible).toEqual(['a', 'b', 'c']); for (const key of ['folderId', 'deviceId', 'rootFileId', 'volumeSerial', 'policyHash', 'receiptId'] as const) {
        const changed = structuredClone(x);
        changed.integration![key] = '';
        blocked(changed, 8);
    } x.integration.expiresAtMs = NOW; blocked(x, 8); });
    it('R8 missing recent accepted snapshot facts hold a registered folder', () => { const x = fixture(); x.folder.registeredInOrrery = true; x.integration = { state: 'live-tested', folderId: x.folder.id, deviceId: x.folder.deviceId, rootFileId: x.folder.rootFileId, volumeSerial: x.folder.volumeSerial, policyHash: x.policy.hash, receiptId: 'scoped-receipt', expiresAtMs: NOW + DAY } as KernelInput['integration']; expect(eligible(x).eligible).toEqual([]); });
    it('R8 acceptance requires current mapping, exact sequence and ordered recent timestamps', () => { const base = fixture(); base.folder.registeredInOrrery = true; base.integration = { state: 'live-tested', folderId: base.folder.id, deviceId: base.folder.deviceId, rootFileId: base.folder.rootFileId, volumeSerial: base.folder.volumeSerial, policyHash: base.policy.hash, receiptId: 'scoped-receipt', expiresAtMs: NOW + DAY, mappingHash: base.folder.mappingHash, expectedSequence: 41, acceptedSequence: 41, snapshotAtMs: NOW - 1000, acceptedAtMs: NOW - 500, observedAtMs: NOW }; expect(eligible(base).eligible).toHaveLength(3); for (const mutate of [(x: KernelInput) => { x.integration!.expectedSequence = null; }, (x: KernelInput) => { x.integration!.expectedSequence = 0; }, (x: KernelInput) => { x.integration!.expectedSequence = 1.5; }, (x: KernelInput) => { x.integration!.acceptedSequence = 40; }, (x: KernelInput) => { x.integration!.acceptedSequence = 42; }, (x: KernelInput) => { x.integration!.mappingHash = 'e'.repeat(64); }, (x: KernelInput) => { x.folder.mappingHash = null; }, (x: KernelInput) => { x.integration!.snapshotAtMs = NOW - DAY; }, (x: KernelInput) => { x.integration!.acceptedAtMs = NOW - DAY; }, (x: KernelInput) => { x.integration!.snapshotAtMs = NOW; }, (x: KernelInput) => { x.integration!.acceptedAtMs = NOW + 1; }, (x: KernelInput) => { x.integration!.observedAtMs = NOW + 1; }, (x: KernelInput) => { x.integration!.observedAtMs = NOW - 1; }, (x: KernelInput) => { x.integration!.observedAtMs = null; }]) {
        const x = structuredClone(base);
        mutate(x);
        blocked(x, 8, 'integration-snapshot-unproven');
    } });
    it('R9 fleet hits never acquire stale-source discount and self/peer tokens do not block', () => { const x = fixture(); x.policy.linkGuard = 'stale-sources'; x.references.edges = [edge('self', 'a', 'a', 'ripple'), edge('peer', 'b', 'a', 'ripple')]; expect(eligible(x).eligible).toEqual(['a', 'b', 'c']); x.references.edges = [...x.references.edges, edge('kept', 'kept', 'a', 'ripple')]; blocked(x, 9, 'referenced-in-fleet'); });
    it('R10 dependency and instruction references protect even from candidate peers', () => { for (const kind of ['dependency', 'instruction'] as const) {
        const x = fixture();
        x.references.edges = [edge('r', 'b', 'a', kind)];
        blocked(x, 10, 'dependency-or-instruction');
    } });
    it('R10 reservations, holds, restore requests and active work protect at plan and apply', () => { for (const phase of ['plan', 'apply'] as const)
        for (const key of ['reservations', 'holds', 'restores', 'anotherProcessOpen', 'changedSinceGeneration'] as const) {
            const x = fixture();
            x.phase = phase;
            if (key === 'anotherProcessOpen' || key === 'changedSinceGeneration')
                a(x).activity![key] = true;
            else
                a(x).activity![key] = 1;
            blocked(x, 10, 'active-work');
        } const x = fixture(); a(x).activity!.complete = null; blocked(x, 10, 'active-work-unknown'); });
    it('R11 protects hard links, reparses, unsupported volumes and changed identity', () => { for (const mutate of [(f: KernelFile) => { f.identity!.hardLinks = 2; }, (f: KernelFile) => { f.identity!.anyReparse = true; }, (f: KernelFile) => { f.identity!.volumeKind = 'network'; }, (f: KernelFile) => { f.identity!.fileId = 'replaced'; }]) {
        const x = fixture();
        mutate(a(x));
        blocked(x, 11, 'identity-unsafe');
    } for (const mutate of [(f: KernelFile) => { f.identity!.parentsComplete = null; }, (f: KernelFile) => { f.identity!.anyReparse = null; }, (f: KernelFile) => { f.identity!.hardLinks = null; }, (f: KernelFile) => { f.identity!.volumeKind = 'unknown'; }]) {
        const x = fixture();
        mutate(a(x));
        blocked(x, 11, 'identity-unknown');
    } });
    it('unknown per-file factual sections never become a passing rule', () => { for (const [field, rule] of [['pins', 2], ['times', 3], ['restore', 4], ['git', 5], ['custody', 6], ['location', 8], ['activity', 10], ['identity', 11]] as const) {
        const x = fixture();
        a(x)[field] = null;
        blocked(x, rule);
    } });
    it('global policy and goal gates are scoped, current and lifetime-bounded', () => { for (const mutate of [(x: KernelInput) => { x.policy.state = 'unaccepted'; }, (x: KernelInput) => { x.policy.enabled = false; }, (x: KernelInput) => { x.policy.folderId = 'wrong'; }, (x: KernelInput) => { x.policy.deviceId = 'wrong'; }, (x: KernelInput) => { x.goal.state = 'proposal'; }, (x: KernelInput) => { x.goal.policyHash = 'd'.repeat(64); }, (x: KernelInput) => { x.goal.folderId = 'wrong'; }, (x: KernelInput) => { x.goal.deviceId = 'wrong'; }, (x: KernelInput) => { x.goal.superseded = true; }, (x: KernelInput) => { x.goal.conflicting = true; }, (x: KernelInput) => { x.goal.expiresAtMs = NOW; }, (x: KernelInput) => { x.goal.expiresAtMs = x.goal.issuedAtMs + 29 * DAY; }, (x: KernelInput) => { x.goal.issuedAtMs = NOW + 1; }]) {
        const x = fixture();
        mutate(x);
        const r = eligible(x);
        expect(r.eligible).toEqual([]);
        expect(r.globalHolds.length).toBeGreaterThan(0);
        expect(r.counts.zeroYield).toBe(true);
    } });
    it('fresh snapshot means strictly less than24h and no future date', () => { const x = fixture(); x.snapshot.capturedAtMs = NOW - DAY + 1; expect(eligible(x).eligible).toHaveLength(3); x.snapshot.capturedAtMs--; expect(eligible(x).globalHolds).toContain('snapshot-stale'); x.snapshot.capturedAtMs = NOW + 1; expect(eligible(x).eligible).toEqual([]); });
    it('sync replication requires accepted acknowledgment, never a default', () => { const x = fixture(); x.folder.obsidianSyncEnabled = true; expect(eligible(x).globalHolds).toContain('sync-unacknowledged'); x.policy.syncReplicated = 'acknowledged'; expect(eligible(x).eligible).toHaveLength(3); x.folder.obsidianSyncEnabled = null; expect(eligible(x).eligible).toEqual([]); });
    it('every incomplete inventory fact blocks all candidates and marks all three reference rules unknown', () => { for (const mutate of [(x: KernelInput) => { x.references.complete = false; }, (x: KernelInput) => { x.references.rootsComplete = false; }, (x: KernelInput) => { x.references.unresolvedReadErrors = 1; }, (x: KernelInput) => { x.references.skippedUnexcluded = 1; }, (x: KernelInput) => { x.references.exclusionsRecorded = false; }, (x: KernelInput) => { x.references.exclusionsReceiptBound = false; }, (x: KernelInput) => { x.references.snapshotId = 'old'; }, (x: KernelInput) => { x.references.policyHash = 'd'.repeat(64); }, (x: KernelInput) => { x.references.goalHash = 'd'.repeat(64); }, (x: KernelInput) => { x.references.readMode = 'incremental'; x.references.changeTimeConformance = null; }, (x: KernelInput) => { x.references.readAtMs = NOW - 1; }]) {
        const x = fixture();
        mutate(x);
        const r = eligible(x);
        expect(r.eligible).toEqual([]);
        expect(r.globalHolds).toContain('coverage-incomplete');
        for (const rule of [7, 9, 10] as const)
            expect(r.counts.byRule[rule].unknown).toBe(3);
    } });
    it('current full reads work without native ChangeTime proof; old full reads need proven incremental detection', () => { const x = fixture(); expect(eligible(x).eligible).toHaveLength(3); x.references.lastFullReadAtMs = NOW - 7 * DAY; x.references.readMode = 'incremental'; x.references.changeTimeConformance = true; expect(eligible(x).eligible).toHaveLength(3); x.references.lastFullReadAtMs--; expect(eligible(x).eligible).toEqual([]); });
    it('proposal closure cannot widen and omitted peers protect again', () => { const x = fixture(); x.references.edges = [edge('ab', 'a', 'b', 'link'), edge('ba', 'b', 'a', 'link')]; expect(eligible(x).eligible).toEqual(['a', 'b', 'c']); expect(closeKernelProposal(x, ['a', 'invented']).eligible).toEqual([]); expect(closeKernelProposal(x, ['a', 'b', 'invented']).eligible).toEqual(['a', 'b']); expect(eligible(x).eligible).toEqual(['a', 'b', 'c']); });
    it('1000 learned payloads cannot alter fixed factual eligibility and only narrow proposals', () => { const x = fixture(), expected = eligible(x); for (let i = 0; i < 1000; i++) {
        const augmented = { ...x, playbook: { force: true, seed: i }, learnedProjection: { eligible: ['invented'] } };
        expect(eligible(augmented)).toEqual(expected);
        const r = closeKernelProposal(augmented, i % 2 ? ['a', 'invented'] : ['b']);
        expect(r.eligible).toEqual(i % 2 ? ['a'] : ['b']);
    } });
    it('malformed facts refuse without exposing path text', () => { for (const value of [null, {}, { ...fixture(), nowMs: Number.NaN }, { ...fixture(), snapshot: { ...fixture().snapshot, files: [file('a'), file('a')] } }]) {
        const r = eligible(value as KernelInput);
        expect(r.eligible).toEqual([]);
        expect(r.globalHolds).toEqual(['input-invalid']);
        expect(r.counts.evaluatedFiles).toBe(0);
    } const x = fixture(); a(x).path!.segments = ['vault', 'project', 'PRIVATE_SENTINEL.md']; a(x).location!.deniedSegment = true; expect(JSON.stringify(eligible(x))).not.toContain('PRIVATE_SENTINEL'); });
    it('valid unique cohorts prove each bound with at-limit positive controls', () => {
        const large = (files: number, notes: number, edges: number): KernelInput => { const x = fixture(); x.snapshot.files = Array.from({ length: files }, (_, i) => file('f' + i)); x.references.notes = Array.from({ length: notes }, (_, i) => ({ id: 'f' + i, hardPinned: false, designated: false, approvedGoalMatched: false, newestEditMs: 100 * DAY })); x.references.edges = Array.from({ length: edges }, (_, i) => edge('e' + i, 'f0', 'f0', 'ripple')); return x; };
        for (const [below, above] of [[large(10000, 10000, 0), large(10001, 10001, 0)], [large(1, 20000, 0), large(1, 20001, 0)], [large(1, 1, 100000), large(1, 1, 100001)], [large(1000, 1000, 2000), large(1000, 1000, 2001)]]) {
            const yes = eligible(below!), no = eligible(above!);
            expect(yes.evaluation).toBe('evaluated');
            expect(yes.eligible).toHaveLength(below!.snapshot.files.length);
            expect(yes.globalHolds).toEqual([]);
            expect(no.evaluation).toBe('refused');
            expect(no.globalHolds).toEqual(['workload-limit-exceeded']);
            expect(no.counts.evaluatedFiles).toBe(0);
            expect(no.eligible).toEqual([]);
        }
        const common = large(1000, 1000, 10000);
        expect(eligible(common).globalHolds).toEqual(['workload-limit-exceeded']);
    });
    for (const which of ['path', 'identity'] as const) it('duplicate '+which+' refuses inflated candidate counts', () => {
            const x = fixture(), first = x.snapshot.files[0]!, second = x.snapshot.files[1]!;
            if (which === 'path') second.path = { ...first.path!, segments: ['VAULT', 'PROJECT', 'A.MD'] };
            else second.identity = { ...first.identity! };
            const result = eligible(x);
            expect(result.eligible).toEqual([]);
            expect(result.evaluation).toBe('refused');
            expect(result.globalHolds).toEqual(['duplicate-snapshot-identity']);
            expect(result.counts.evaluatedFiles).toBe(0);
    });
    it('malformed learned proposals cannot fall back to full eligibility', () => {
        for (const value of [null, undefined, false, '', 42, {}]) {
            const result = closeKernelProposal(fixture(), value as unknown as readonly string[]);
            expect(result.eligible).toEqual([]); expect(result.evaluation).toBe('refused');
        }
        expect(closeKernelProposal(fixture(), []).eligible).toEqual([]);
        expect(closeKernelProposal(fixture(), ['a']).eligible).toEqual(['a']);
    });
    it('an explicit inventory designation pins itself and its name references', () => {
        const x = fixture(); x.references.notes[0]!.designated = true;
        x.references.edges = [edge('designated-name', 'a', 'b', 'name')];
        const result = eligible(x); expect(result.eligible).toEqual(['c']);
        expect(result.items.a![2].codes).toContain('hard-pinned');
        expect(result.items.b![7].state).toBe('blocked');
    });
    it('source recency reconciles current file timestamps instead of trusting a stale duplicate', () => {
        for (const field of ['mtimeMs','changeTimeMs','creationMs','firstSeenAtPathMs'] as const) {
            const x = fixture(); x.policy.linkGuard = 'stale-sources';
            a(x).times![field] = NOW; x.references.edges = [edge('fresh-source', 'a', 'b', 'link')];
            expect(eligible(x).eligible).toEqual(['c']);
            a(x).times![field] = null; expect(eligible(x).eligible).toEqual(['c']);
        }
        const consistent = fixture(); consistent.policy.linkGuard = 'stale-sources';
        a(consistent).git!.state = 'tracked'; consistent.references.edges = [edge('old-source', 'a', 'b', 'link')];
        expect(eligible(consistent).eligible).toEqual(['b','c']);
    });
    it('a known explicit pin remains protective when additional pin coverage is incomplete', () => {
        const x = fixture(); a(x).pins!.complete = false; a(x).pins!.kinds = ['goal'];
        x.policy.linkGuard = 'stale-sources'; x.references.edges = [edge('known-pin-name', 'a', 'b', 'name')];
        expect(eligible(x).eligible).toEqual(['c']);
    });
    it('does not mutate any supplied factual evidence', () => { const x = fixture(), before = JSON.stringify(x); eligible(x); closeKernelProposal(x, ['a']); expect(JSON.stringify(x)).toBe(before); });
});
