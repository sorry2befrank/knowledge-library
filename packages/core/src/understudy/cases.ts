// Case capture (DESIGN §7.4): labelled signals become cases in lineage-safe groups with frozen inputs.
// The split is assigned once by hash(groupKey) mod 10. Confirmation needs a receipt; S1 has none.
import type { Catalog } from "../catalog/catalog.ts";
import { computeLineageKey } from "./lineage.ts";

const LABELLED: Record<string, { capability: string; label: string }> = {
  S1: { capability: "retrieval", label: "miss" }, S4: { capability: "retrieval", label: "miss" }, S5: { capability: "retrieval", label: "useful" },
  S2: { capability: "focus", label: "false-removal" }, S7: { capability: "focus", label: "miss" }, S8: { capability: "focus", label: "false-proposal" }, S9: { capability: "focus", label: "miss" },
  S6: { capability: "link", label: "proposal-decision" },
};

export interface CaptureReport { created: number; alreadyCaptured: number; unlabelled: number; unproven: number }

export function captureCases(catalog: Catalog): CaptureReport {
  const { db } = catalog;
  const report: CaptureReport = { created: 0, alreadyCaptured: 0, unlabelled: 0, unproven: 0 };
  const sys = { principal: "system", clientClass: "kl-device" as const };
  const signals = db.all<{ signalId: string; kind: string; principal: string; client: string; scopeId: string; target: string; q_h: string | null; queryId: string | null }>("SELECT signalId, kind, principal, client, scopeId, target, q_h, queryId FROM signals WHERE status = 'unconfirmed' ORDER BY ts, signalId");
  for (const s of signals) {
    const lab = LABELLED[s.kind];
    if (!lab) { report.unlabelled++; continue; }
    if (db.get("SELECT 1 FROM cases WHERE instr(sourceSignals, ?) > 0", [s.signalId])) { report.alreadyCaptured++; continue; }
    // Legacy unversioned observations cannot be safely relabelled from today's note.
    const target = /^([0-9A-HJKMNP-TV-Z]{10})@([1-9][0-9]*)$/.exec(s.target);
    const version = target ? db.get<{ privacy_class: string }>("SELECT privacy_class FROM versions WHERE noteId = ? AND ver = ?", [target[1]!, Number(target[2])]) : undefined;
    if (!target || !version) { report.unproven++; continue; }
    const noteId = target[1]!;
    const privacy = version.privacy_class;
    const lineageKey = computeLineageKey(db, noteId);
    catalog.apply(sys, { kind: "system" }, { kind: "case.create", capability: lab.capability, scopeId: s.scopeId, privacy, groupKey: lineageKey, lineageKey,
      inputRef: JSON.stringify({ q_h: s.q_h, queryId: s.queryId, target: s.target }), frozenFeatures: { q_h: s.q_h, kind: s.kind }, expected: { noteId, label: lab.label }, sourceSignals: [s.signalId], author: s.principal });
    report.created++;
  }
  return report;
}

export interface CaseRow { caseId: string; capability: string; scopeId: string; privacy: string; groupKey: string; split: string; q_h: string | null; expectedNoteId: string; label: string; author: string }

export function listCases(catalog: Catalog, filter: { capability: string; split?: string; privacy?: string }): CaseRow[] {
  const rows = catalog.db.all<{ caseId: string; capability: string; scopeId: string; privacy: string; groupKey: string; split: string; frozenFeatures: string; expected: string; author: string }>(
    `SELECT caseId, capability, scopeId, privacy, groupKey, split, frozenFeatures, expected, author FROM cases WHERE capability = ? ${filter.split ? "AND split = ?" : ""} ${filter.privacy ? "AND privacy = ?" : ""} AND status != 'discarded' ORDER BY createdAt, caseId`,
    [filter.capability, ...(filter.split ? [filter.split] : []), ...(filter.privacy ? [filter.privacy] : [])]);
  return rows.map((r) => { const f = JSON.parse(r.frozenFeatures) as { q_h: string | null }; const e = JSON.parse(r.expected) as { noteId: string; label: string }; return { caseId: r.caseId, capability: r.capability, scopeId: r.scopeId, privacy: r.privacy, groupKey: r.groupKey, split: r.split, q_h: f.q_h, expectedNoteId: e.noteId, label: e.label, author: r.author }; });
}
