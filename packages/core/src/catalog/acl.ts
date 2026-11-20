// Access control first (DESIGN §4.2 step 1). One predicate, used before ranking, counts, snippets,
// reads, direct object reads, edges, cases and renders. A denied note looks exactly like a missing one.
import type { SqlDriver, SqlParam } from "./driver.ts";
import { isConfidentialClass, splitClassSet } from "./privacy.ts";

export type ClientClass = "connector" | "claude-code" | "codex" | "kl-device";
export interface Actor { principal: string; clientClass: ClientClass; interactive?: boolean; sessionId?: string; /** Server-authenticated token boundary; absent is legacy unscoped, [] permits nothing. */ collectionIds?: readonly string[] }

export interface AclContext { allowedClasses: string[]; clientClass: ClientClass; status: "active" | "revoked" | "unknown"; collectionIds?: readonly string[] }

export function loadAcl(db: SqlDriver, actor: Actor): AclContext {
  const row = db.get<{ status: string; allowed_classes: string }>("SELECT status, allowed_classes FROM principals WHERE id = ?", [actor.principal]);
  const boundary = actor.collectionIds === undefined ? {} : { collectionIds: [...actor.collectionIds] };
  if (db.get("SELECT 1 FROM meta WHERE key='recovery_state'")) return {allowedClasses:[],clientClass:actor.clientClass,status:'unknown',...boundary};
  if (!row) return { allowedClasses: [], clientClass: actor.clientClass, status: "unknown", ...boundary };
  if (row.status !== "active") return { allowedClasses: [], clientClass: actor.clientClass, status: "revoked", ...boundary };
  return { allowedClasses: JSON.parse(row.allowed_classes) as string[], clientClass: actor.clientClass, status: "active", ...boundary };
}

/**
 * SQL fragment over aliases col (collections), v (versions). Admits a row only if
 *  - the principal's allowed classes include the collection class, and for a confidential collection class the
 *    token's client class is in THAT collection's clients_ok (the same rule writes apply, S1c A3);
 *  - every member of the version's own class set (version_classes) is allowed, and every confidential member that is
 *    not the collection's own class is admitted by EVERY decision row of that class (a version held outside its class's
 *    collection is readable only where every decision for that class agrees).
 */
export function aclPredicate(acl: AclContext): { sql: string; params: SqlParam[] } {
  if (acl.status !== "active" || acl.allowedClasses.length === 0 || acl.collectionIds?.length === 0) return { sql: "0", params: [] };
  const scope = acl.collectionIds === undefined ? { sql: "1", params: [] } : { sql: "col.collectionId IN (SELECT value FROM json_each(?))", params: [JSON.stringify(acl.collectionIds)] };
  const marks = acl.allowedClasses.map(() => "?").join(",");
  const colOk = `(col.class IN (${marks}) AND ((col.class NOT LIKE 'client:%' AND col.class != 'founders') OR instr(col.clients_ok, '"' || ? || '"') > 0))`;
  const heldOk = `(vc.class IN (${marks}) AND ((vc.class NOT LIKE 'client:%' AND vc.class != 'founders') OR (EXISTS (SELECT 1 FROM collections cc WHERE cc.class = vc.class AND cc.decision_row IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM collections cc WHERE cc.class = vc.class AND cc.decision_row IS NOT NULL AND instr(cc.clients_ok, '"' || ? || '"') = 0))))`;
  return {
    sql: `(${scope.sql} AND ${colOk} AND NOT EXISTS (SELECT 1 FROM version_classes vc WHERE vc.noteId = v.noteId AND vc.ver = v.ver AND vc.class != col.class AND NOT ${heldOk}))`,
    params: [...scope.params, ...acl.allowedClasses, acl.clientClass, ...acl.allowedClasses, acl.clientClass],
  };
}

/** Collection permissions intersect privacy permissions; sharing a class never widens a token. */
export function aclAllowsCollection(acl: AclContext, collectionId: string): boolean {
  return acl.status === "active" && (acl.collectionIds === undefined || acl.collectionIds.includes(collectionId));
}

/** The same rule as aclPredicate's collection part, for choosing a destination collection on a write. A confidential collection needs a decision row (DESIGN §9.4). */
export function aclAllowsClass(acl: AclContext, cls: string, clientsOk: string[], hasDecisionRow = true): boolean {
  if (acl.status !== "active" || !acl.allowedClasses.includes(cls)) return false;
  if (isConfidentialClass(cls)) return hasDecisionRow && clientsOk.includes(acl.clientClass);
  return true;
}

/** The held-version rule in JavaScript: every member allowed; every confidential member admitted by every decision row of that class (and at least one exists). Used to filter classes outside a collection context (status counts, FTS tables). */
export function aclAllowsClassSet(db: SqlDriver, acl: AclContext, classSet: string): boolean {
  if (acl.status !== "active") return false;
  for (const c of splitClassSet(classSet)) {
    if (!acl.allowedClasses.includes(c)) return false;
    if (!isConfidentialClass(c)) continue;
    const rows = db.all<{ clients_ok: string }>("SELECT clients_ok FROM collections WHERE class = ? AND decision_row IS NOT NULL", [c]);
    if (rows.length === 0 || rows.some((r) => !(JSON.parse(r.clients_ok) as string[]).includes(acl.clientClass))) return false;
  }
  return true;
}
