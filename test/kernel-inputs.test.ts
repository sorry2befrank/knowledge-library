import { expect, it } from 'vitest';
import { eligible, type Snapshot, type GoalRev, type Policy, type Pins, type Custody, type History, type GitState,
  type ReferenceGeneration, type Reservations, type IntegrationState } from '../packages/core/src/focus/kernel-adapter.ts';
import { collectKernelInputs } from '../packages/core/src/focus/collect-kernel-inputs.ts';
import { fixture } from './helpers/s2f-adapter-fixture.ts';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
// Every object key is enumerated below, recursively. Array/nullable wrappers carry no extra authority keys.
type KeyTree<T> = T extends string | number | boolean | bigint ? true : T extends readonly (infer U)[] ? KeyTree<NonNullable<U>>[] : { [K in keyof T]-?: KeyTree<NonNullable<T[K]>> };
type Signature = Assert<Equals<Parameters<typeof eligible>, [Snapshot, GoalRev, Policy, Pins, Custody, History, GitState, ReferenceGeneration, Reservations, IntegrationState]>>;
type SnapshotExact = Assert<Equals<KeyTree<Snapshot>, {
  nowMs: true; phase: true; id: true; capturedAtMs: true; complete: true;
  folder: { id: true; deviceId: true; drive: true; segments: true[]; rootFileId: true; volumeSerial: true; mappingHash: true; registryComplete: true; registeredInOrrery: true; obsidianSyncEnabled: true };
  files: { id: true; kind: true; path: { drive: true; segments: true[]; normalized: true };
    times: { mtimeMs: true; changeTimeMs: true; creationMs: true; firstSeenAtPathMs: true };
    location: { rootFileId: true; deniedSegment: true };
    identity: { fileId: true; snapshotFileId: true; volumeSerial: true; hardLinks: true; parentsComplete: true; anyReparse: true; volumeKind: true } }[];
}>>;
type GoalExact = Assert<Equals<KeyTree<GoalRev>, { state: true; hash: true; policyHash: true; folderId: true; deviceId: true; issuedAtMs: true; expiresAtMs: true; superseded: true; conflicting: true }>>;
type PolicyExact = Assert<Equals<KeyTree<Policy>, {
  state: true; hash: true; folderId: true; deviceId: true; enabled: true; types: true[]; editGraceDays: true; restoreProtectWeeks: true;
  linkGuard: true; gitMode: true; nameMentions: true; syncReplicated: true; timezone: true; registryComplete: true;
  personaHomes: { drive: true; segments: true[] }[]; deniedSegments: true[]; understudyProjectLabels: true[];
}>>;
type PinsExact = Assert<Equals<KeyTree<Pins>, {
  files: { id: true; value: { complete: true; kinds: true[]; personaHome: true } }[];
  sweep: { folderId: true; snapshotId: true; format: true; history: true; association: true; adjudication: true; wholeFolderHeld: true; protectedIds: true[] };
  parserReasonCodes: true[];
}>>;
type CustodyExact = Assert<Equals<KeyTree<Custody>, { id: true; value: { classRemovable: true; verified: true; versionId: true; currentSha256: true; archivedSha256: true } }[]>>;
type HistoryExact = Assert<Equals<KeyTree<History>, { id: true; value: { historyComplete: true; latestAtMs: true } }[]>>;
type GitExact = Assert<Equals<KeyTree<GitState>, { id: true; value: { walkComplete: true; innermostResolved: true; state: true } }[]>>;
type ReferencesExact = Assert<Equals<KeyTree<ReferenceGeneration>, {
  id: true; snapshotId: true; policyHash: true; goalHash: true; complete: true; rootsComplete: true; unresolvedReadErrors: true; skippedUnexcluded: true;
  exclusionsRecorded: true; exclusionsReceiptBound: true; readMode: true; readAtMs: true; lastFullReadAtMs: true; changeTimeConformance: true;
  notes: { id: true; hardPinned: true; designated: true; approvedGoalMatched: true; newestEditMs: true }[];
  edges: { id: true; source: true; target: true; kind: true }[]; localSources: { id: true; path: true }[]; unreadableSources: true[];
}>>;
type ReservationsExact = Assert<Equals<KeyTree<Reservations>, { id: true; value: { complete: true; reservations: true; holds: true; restores: true; anotherProcessOpen: true; changedSinceGeneration: true } }[]>>;
type IntegrationExact = Assert<Equals<KeyTree<NonNullable<IntegrationState>>, {
  state: true; folderId: true; deviceId: true; rootFileId: true; volumeSerial: true; policyHash: true; receiptId: true; expiresAtMs: true;
  mappingHash: true; expectedSequence: true; acceptedSequence: true; snapshotAtMs: true; acceptedAtMs: true; observedAtMs: true;
}>>;

it('the exact ten-input boundary preserves unknown nested facts as protective evidence', async () => {
  const { c, ports } = await fixture(), inputs = await collectKernelInputs(c, ports);
  expect(eligible(...inputs).kernel.eligible).toHaveLength(2);
  inputs[0].files[0]!.identity!.anyReparse = null;
  const output = eligible(...inputs); expect(output.kernel.eligible).toHaveLength(1);
  expect(output.eligibilityProof[inputs[0].files[0]!.id]![11].codes).toContain('identity-unknown');
});
