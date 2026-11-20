// Signals are observations (DESIGN §7.3). Only authenticated principals' actions in interactive sessions
// create them; headless processes and self-referential sessions never do. Nothing here confirms anything.
import type { Catalog } from "../catalog/catalog.ts";
import { aclPredicate, type Actor, type ClientClass } from "../catalog/acl.ts";

export interface IncomingSignal {
  signalId?: string; kind: string; principal: string; client: ClientClass; query?: string; targetNoteId: string; targetVer?: number;
  interactive: boolean; headless?: boolean; selfReferential?: boolean; scopeId?: string; queryId?: string;
}
export const STRENGTH: Record<string, string> = { S0: "positive", S1: "strong", S2: "strong", S3: "weak", S4: "medium", S5: "medium", S6: "strong", S7: "strong", S8: "strong", S9: "strong" };

export interface IngestReport { recorded: number; excluded: { headless: number; selfReferential: number; nonInteractive: number; unknownPrincipal: number; inaccessible: number } }

export function ingestSignals(catalog: Catalog, signals: IncomingSignal[]): IngestReport {
  const report: IngestReport = { recorded: 0, excluded: { headless: 0, selfReferential: 0, nonInteractive: 0, unknownPrincipal: 0, inaccessible: 0 } };
  for (const s of signals) {
    if (s.headless) { report.excluded.headless++; continue; }
    if (s.selfReferential) { report.excluded.selfReferential++; continue; }
    if (!s.interactive) { report.excluded.nonInteractive++; continue; }
    const actor: Actor = { principal: s.principal, clientClass: s.client, interactive: true };
    const acl = catalog.acl(actor);
    if (acl.status !== "active") { report.excluded.unknownPrincipal++; continue; }
    // A signal about a note the principal cannot see is not a signal (and would leak existence if stored).
    const { sql, params } = aclPredicate(acl);
    const visible = catalog.db.get<{ ver: number }>(`SELECT v.ver FROM versions v JOIN notes n ON n.noteId = v.noteId JOIN collections col ON col.collectionId = n.collectionId WHERE v.noteId = ? AND v.ver = ${s.targetVer === undefined ? "n.currentVer" : "?"} AND n.status NOT IN ('withdrawn', 'purge-pending') AND ${sql} LIMIT 1`, [s.targetNoteId, ...(s.targetVer === undefined ? [] : [s.targetVer]), ...params]);
    if (!visible) { report.excluded.inaccessible++; continue; }
    // The observation belongs to the version seen now, never whichever version exists at replay time.
    catalog.apply(actor, { kind: "principal" }, { kind: "signal.record", signalId: s.signalId, signalKind: s.kind, scopeId: s.scopeId ?? "global", targetNoteId: s.targetNoteId, targetVer: visible.ver, queryId: s.queryId, query: s.query, strength: STRENGTH[s.kind] ?? "medium", interactive: true });
    report.recorded++;
  }
  return report;
}
