// Pure parsing/folding adapters. No database writes, receipt issuance or promotion.
// Rows passed to ledger functions must come from the server ledger, not request JSON.
export const CORRECTION_TOPIC_RE = /^- \[\d{4}-\d\d-\d\d\]\s*\(topic:\s*([^)]+)\)/i;
export function normalizeCorrectionTopic(topic: string): string { return topic.replace(/[)\s]+/g, " ").trim(); }
export function liveSourceCorrections(raw: string): string {
  const lines = raw.split(/\r?\n/), last = new Map<string, number>();
  const topic = (line: string) => CORRECTION_TOPIC_RE.exec(line)?.[1]?.trim().toLowerCase();
  lines.forEach((line, i) => { const key = topic(line); if (key !== undefined) last.set(key, i); });
  return lines.filter((line, i) => { const key = topic(line); return key === undefined || last.get(key) === i; }).join("\n").trim();
}
export interface CorrectionRow {
  id: string; author: string; client: string; scope: string; target: string; topic: string;
  statement: string; state: "applied" | "proposed" | "reverted"; ts: string;
}
export interface CorrectionInput { id: string; target: string; topic: string; statement: string }
// actor/scope/ts are explicit trusted server inputs. Claims in input never override these fields.
export function correctionFromAuthenticatedActor(input: CorrectionInput, actor: { principal: string; client: string }, scope: string, ts: string): CorrectionRow {
  const topic = normalizeCorrectionTopic(input.topic), statement = input.statement.replace(/\s+/g, " ").trim();
  if (!topic || !statement || !input.id || !input.target || !actor.principal || !actor.client || !scope) throw new Error("correction.invalid");
  return Object.freeze({ id: input.id, author: actor.principal, client: actor.client, scope, target: input.target, topic, statement, state: "proposed", ts });
}
export interface CorrectionFold {
  live: CorrectionRow[]; heldUnderNext: CorrectionRow[]; disputedIds: string[];
  crossAuthorConflict: boolean; confirmedLabel: false; trainingEligible: false;
}
// Input order is ledger order, never date order. This comparison requires separately authorized
// access to every supplied row. It is not a public rendering or a confirmation decision.
export function foldCorrectionLedger(rows: readonly CorrectionRow[], ownerPrincipal: string): CorrectionFold {
  const latest = new Map<string, CorrectionRow>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error("correction.duplicate-id"); seen.add(row.id);
    const key = JSON.stringify([row.scope, row.target, row.author, row.topic.trim().toLowerCase()]);
    // A reverted row must not silently erase an earlier live correction.
    if (row.state !== "reverted") latest.set(key, row);
  }
  const groups = new Map<string, CorrectionRow[]>();
  for (const row of latest.values()) {
    const key = JSON.stringify([row.scope, row.target, row.topic.trim().toLowerCase()]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const live: CorrectionRow[] = [], heldUnderNext: CorrectionRow[] = [], disputedIds: string[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map(r => r.statement)).size > 1 && new Set(group.map(r => r.author)).size > 1) {
      disputedIds.push(...group.map(r => r.id));
      const owner = group.filter(r => r.author === ownerPrincipal);
      live.push(...owner); heldUnderNext.push(...group.filter(r => r.author !== ownerPrincipal));
    } else live.push(...group);
  }
  return { live, heldUnderNext, disputedIds, crossAuthorConflict: disputedIds.length > 0, confirmedLabel: false, trainingEligible: false };
}
export interface CorrectionViewContext {
  principal: string; ownerPrincipal: string; scope: string;
  // Supplied by current server ACL/receipt lookup. Never copied from an input row or client flag.
  canRead: (row: Pick<CorrectionRow, "id" | "author" | "scope" | "target">) => boolean;
  confirmedIds: ReadonlySet<string>;
}
export function projectCorrections(rows: readonly CorrectionRow[], viewer: CorrectionViewContext): CorrectionFold {
  const visible = rows.filter(row => row.scope === viewer.scope
    && (row.author === viewer.principal || viewer.confirmedIds.has(row.id))
    && viewer.canRead({ id: row.id, author: row.author, scope: row.scope, target: row.target }));
  // Filter before folding: a hidden row cannot retire a visible row or reveal a dispute/count.
  return foldCorrectionLedger(visible, viewer.ownerPrincipal);
}
