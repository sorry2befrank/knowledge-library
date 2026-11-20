// Champions and promotion (DESIGN §7.9). A champion is a playbook pointer keyed by (capability, scope, privacy);
// a scope without one inherits from its parent (folder → collection → global). Promotion ALWAYS goes
// through apply() with an owner receipt; S1 has no approval channel, so every promotion is refused.
import type { Catalog } from "../catalog/catalog.ts";
import { ApplyRefused } from "../catalog/apply.ts";
import type { ApprovalReceipt } from "../catalog/receipts.ts";
import { BASELINE_V0, playbookHash, type RetrievalPlaybook } from "./baseline.ts";

const SYS = { principal: "system", clientClass: "kl-device" as const };

/** Install the frozen baseline v0 as the first champion for a key (idempotent). The op accepts no hash: it can only install BASELINE_V0. */
export function installBaseline(catalog: Catalog, key: { scopeId: string; privacy: string }): string {
  const existing = catalog.db.get<{ playbookHash: string }>("SELECT playbookHash FROM champions WHERE capability = 'retrieval' AND scopeId = ? AND privacy = ? AND revokedAt IS NULL", [key.scopeId, key.privacy]);
  if (existing) return existing.playbookHash;
  catalog.apply(SYS, { kind: "system" }, { kind: "champion.baseline", capability: "retrieval", scopeId: key.scopeId, privacy: key.privacy });
  return playbookHash(BASELINE_V0);
}

/** Resolve the effective champion along the scope chain (most specific first). */
export function resolveChampion(catalog: Catalog, scopeChain: string[], privacy: string): { playbook: RetrievalPlaybook; scopeId: string; hash: string; frozenBaseline: boolean } {
  for (const scopeId of scopeChain) {
    const row = catalog.db.get<{ body: string; hash: string; frozenBaseline: number }>("SELECT p.body, p.hash, ch.frozenBaseline FROM champions ch JOIN playbooks p ON p.hash = ch.playbookHash WHERE ch.capability = 'retrieval' AND ch.scopeId = ? AND ch.privacy = ? AND ch.revokedAt IS NULL ORDER BY ch.id DESC LIMIT 1", [scopeId, privacy]);
    if (row) return { playbook: JSON.parse(row.body) as RetrievalPlaybook, scopeId, hash: row.hash, frozenBaseline: row.frozenBaseline === 1 };
  }
  return { playbook: BASELINE_V0, scopeId: "global", hash: playbookHash(BASELINE_V0), frozenBaseline: true };
}

export function saveCandidate(catalog: Catalog, key: { scopeId: string; privacy: string }, playbook: RetrievalPlaybook, parentHash: string, generator: string, targetGroups: string[]): { candidateId: string; playbookHash: string } {
  const hash = (catalog.apply(SYS, { kind: "system" }, { kind: "playbook.put", capability: "retrieval", body: playbook as unknown as Record<string, unknown> }).result as { playbookHash: string }).playbookHash;
  const r = catalog.apply(SYS, { kind: "system" }, { kind: "candidate.create", capability: "retrieval", scopeId: key.scopeId, privacy: key.privacy, playbookHash: hash, parentHash, generator, targetGroups });
  return { candidateId: (r.result as { candidateId: string }).candidateId, playbookHash: hash };
}

/** Grade from a replay() report: the verdict, generation and look come from the report, never from the caller. */
export function gradeCandidate(catalog: Catalog, candidateId: string, report: { verdict: "tested" | "tested-insufficient" | "vetoed"; generation: number; heldoutLook: true } & object) {
  return catalog.apply(SYS, { kind: "system" }, { kind: "candidate.grade", candidateId, report });
}

export type PromotionResult = { ok: true } | { ok: false; code: string };
/** The only homing path. Refused without a verified owner receipt; in S1 the verifier refuses every receipt. */
export function promote(catalog: Catalog, candidateId: string, receipt: ApprovalReceipt | undefined, by = { principal: "frank", clientClass: "kl-device" as const }): PromotionResult {
  try { catalog.apply(by, { kind: "receipt", receipt }, { kind: "champion.promote", candidateId }); return { ok: true }; }
  catch (e) { if (e instanceof ApplyRefused) return { ok: false, code: e.code }; throw e; }
}
