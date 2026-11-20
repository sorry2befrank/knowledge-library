// S2f composition boundary. All eleven rules remain owned by eligibility.ts.
import { eligible as evaluateKernel, type KernelFile, type KernelInput, type KernelResult } from './eligibility.ts';

export type SnapshotFile = Omit<KernelFile, 'pins' | 'custody' | 'restore' | 'git' | 'activity'>;
export interface Snapshot {
  nowMs: number;
  phase: KernelInput['phase'];
  id: string;
  capturedAtMs: number;
  complete: boolean | null;
  folder: KernelInput['folder'];
  files: readonly SnapshotFile[];
}
export type GoalRev = KernelInput['goal'];
type BasePolicy = KernelInput['policy'];
export interface Policy extends BasePolicy {
  timezone: string;
  registryComplete: boolean | null;
  personaHomes: readonly { drive: string; segments: readonly string[] }[];
  deniedSegments: readonly string[];
  understudyProjectLabels: readonly string[];
}
export interface FactRow<T> { id: string; value: T }
export interface Pins {
  files: readonly FactRow<KernelFile['pins']>[];
  sweep: KernelInput['sweep'];
  parserReasonCodes: readonly string[];
}
export type Custody = readonly FactRow<KernelFile['custody']>[];
export type History = readonly FactRow<KernelFile['restore']>[];
export type GitState = readonly FactRow<KernelFile['git']>[];
export type Reservations = readonly FactRow<KernelFile['activity']>[];
export type IntegrationState = KernelInput['integration'];
type BaseReferences = KernelInput['references'];
export interface ReferenceGeneration extends BaseReferences {
  localSources: readonly { id: string; path: string }[];
  unreadableSources: readonly string[];
}
export type KernelInputs = [Snapshot, GoalRev, Policy, Pins, Custody, History, GitState, ReferenceGeneration, Reservations, IntegrationState];
export interface KernelOutput {
  status: 'evaluated' | 'goal-unapproved' | 'refused';
  kernel: KernelResult;
  eligibilityProof: KernelResult['items'];
  // Local factual context only. Shared census output must never serialize this object.
  input: KernelInput;
  localSources: ReferenceGeneration['localSources'];
  unreadableSources: readonly string[];
  parserReasonCodes: readonly string[];
}

function lookup<T>(rows: readonly FactRow<T>[], id: string): T | null {
  const matches = rows.filter(row => row.id === id);
  return matches.length === 1 ? matches[0]!.value : null;
}

/** Synchronous factual adapter. Missing or duplicate per-file evidence stays unknown. */
export function eligible(snapshot: Snapshot, goalRev: GoalRev, policy: Policy, pins: Pins, custody: Custody,
  history: History, gitState: GitState, refGeneration: ReferenceGeneration, reservations: Reservations,
  integrationState: IntegrationState): KernelOutput {
  const input: KernelInput = {
    nowMs: snapshot.nowMs, phase: snapshot.phase, folder: snapshot.folder,
    snapshot: { id: snapshot.id, capturedAtMs: snapshot.capturedAtMs, complete: snapshot.complete,
      files: snapshot.files.map(file => ({ ...file, pins: lookup(pins.files, file.id), custody: lookup(custody, file.id),
        restore: lookup(history, file.id), git: lookup(gitState, file.id), activity: lookup(reservations, file.id) })) },
    policy, goal: goalRev, references: refGeneration, sweep: pins.sweep, integration: integrationState,
  };
  const kernel = evaluateKernel(input);
  const goalHeld = kernel.globalHolds.some(code => code === 'goal-unproven' || code === 'goal-expired-or-invalid');
  return { status: goalHeld ? 'goal-unapproved' : kernel.evaluation, kernel, eligibilityProof: kernel.items, input,
    localSources: refGeneration.localSources, unreadableSources: refGeneration.unreadableSources,
    parserReasonCodes: pins.parserReasonCodes };
}
