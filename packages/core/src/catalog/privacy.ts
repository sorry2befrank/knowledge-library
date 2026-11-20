// Privacy class breadth (DESIGN §9.4). team is the broadest class; private, client and founders classes are narrower.
// Two classes of equal breadth with different names cannot be compared (client:x against client:y, frank-private against
// partner-private): a flow between them is held like a narrower flow (S1c ruling A2).
const BREADTH: Record<string, number> = { team: 3, "frank-private": 1, "partner-private": 1, founders: 0, "student-record": 0, secret: 0 };
export function classBreadth(c: string): number { return c.startsWith("client:") ? 0 : BREADTH[c] ?? 1; }
export function isNarrowerClass(read: string, dest: string): boolean { return classBreadth(read) < classBreadth(dest); }
/** True when the two classes can be ordered: equal, or of different breadth. */
export function isComparableClass(a: string, b: string): boolean { return a === b || classBreadth(a) !== classBreadth(b); }
/** The narrowest class in a list, or undefined for an empty list. */
export function narrowestClass(classes: string[]): string | undefined {
  return classes.length ? classes.reduce((a, b) => (classBreadth(b) < classBreadth(a) ? b : a)) : undefined;
}
/** Confidential classes need the client class listed in clients_ok. */
export function isConfidentialClass(c: string): boolean { return c.startsWith("client:") || c === "founders"; }

// ---- class sets (the storage form of an intersection ceiling, S1c A1/A2; S2d item 0) ----
// A version may be readable only by a principal and client class that can read EVERY member of its class set. The set is
// stored canonically as the sorted members joined by '+', and one row per member in version_classes. A single class is
// its own canonical set. No member is ever dropped here: `team` is NOT held by every principal (DESIGN §9.6 lets Frank
// grant a named person single collections without it), so a recorded `team` member is a real read-time requirement.
export const CLASS_SET_SEPARATOR = "+";
export function splitClassSet(s: string): string[] { return s.split(CLASS_SET_SEPARATOR).filter(Boolean); }
export function canonicalClassSet(classes: string[]): string {
  return [...new Set(classes.flatMap(splitClassSet))].sort().join(CLASS_SET_SEPARATOR);
}
/**
 * The read ceiling of a save whose lineage sources are `sources` (every class read through the grant in the §3.3 window,
 * plus every declared derivedFrom source) and whose destination class is `dest`.
 * - A source that is narrower than, or incomparable with, the destination narrows the ceiling and HOLDS the save.
 * - A source broader than the destination (today only `team`) is RECORDED in the ceiling and does not hold: the stored
 *   ceiling must not depend on who can read the destination at the moment of the save (S2d item 0, A3).
 * - `team` is dropped only when it is the destination's own class and not a source: that keeps today's canonical form
 *   for held copies without a team source (client:x+frank-private, not client:x+frank-private+team).
 * Returns hold=false when no source narrows; the ceiling may still be wider than `dest` (broader sources recorded).
 */
export function lineageCeiling(sources: string[], dest: string): { hold: boolean; ceiling: string; narrowing: string[]; broader: string[] } {
  const destMembers = splitClassSet(dest);
  const sourceMembers = [...new Set(sources.flatMap(splitClassSet))];
  const src = sourceMembers.filter((c) => !destMembers.includes(c));
  const narrowing = src.filter((c) => destMembers.some((d) => classBreadth(c) <= classBreadth(d)));
  const broader = src.filter((c) => !narrowing.includes(c));
  const members = [...narrowing, ...broader, ...destMembers];
  // A source remains a read requirement even when it is also the requested destination's class.
  const teamIsSource = sourceMembers.includes("team");
  const ceiling = canonicalClassSet(members.length > 1 && !teamIsSource ? members.filter((c) => c !== "team") : members);
  return { hold: narrowing.length > 0, ceiling, narrowing, broader };
}
