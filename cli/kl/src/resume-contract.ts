// Resume-loop contracts: the shapes the claude and codex lanes build against (board UNISON-resume-loop.md, Contracts 1-3
// and 6; docs/sessions/RL1-resume-loop.md once written). Pure: no I/O. The strict brief check (cli/kl/src/handoff.ts)
// and the resume grader (cli/sessions/src/grade.ts) import from here; neither lane edits this file without both lanes'
// agreement on the board.
import { parseCitation } from "@kl/core";

/** `Assignment source: <source>, as of <YYYY-MM-DD HH:MM>` (Contract 1). */
export interface AssignmentLine { source: string; sourceKind: "path" | "kl"; asOf: { date: string; time: string } }
/** `Responsible: <name>; transfer: none` or `Responsible: <name>; transfer: to <name> until <YYYY-MM-DD>` (Contract 1). */
export interface ResponsibleLine { responsible: string; transfer: { to: string; until: string } | null }

const ASSIGNMENT = /^Assignment source: (.+), as of (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/;
const RESPONSIBLE = /^Responsible: ([^;]*); transfer: (?:none|to (.*) until (\d{4}-\d{2}-\d{2}))$/;

/** A real calendar date in YYYY-MM-DD form. */
function realDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** 00:00 to 23:59. */
const realTime = (time: string) => Number(time.slice(0, 2)) <= 23 && Number(time.slice(3, 5)) <= 59;
/**
 * A path relative to the planning folder: not absolute, and no URI scheme or drive letter (`https:`, `file:`, `C:`). A
 * parent segment is allowed: it is still relative to the planning folder (Contract 1; Codex, PR #32 review).
 */
const relativePath = (p: string) => !/^[\\/]/.test(p) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p);
/** One line only: no CR, LF, line separator or paragraph separator anywhere in it (Codex, PR #32 review). */
const oneLine = (s: string) => ![...s].some((c) => [10, 13, 0x2028, 0x2029].includes(c.charCodeAt(0)));

/**
 * The assignment line, or undefined. The time is the owner's local wall-clock time with no zone suffix. A well-formed
 * line proves syntax only, never that the assignment is current: an agent re-reads the source for that (test T4).
 */
export function parseAssignmentLine(line: string): AssignmentLine | undefined {
  const text = line.replace(/\r$/, "");
  const m = oneLine(text) ? ASSIGNMENT.exec(text) : null;
  if (!m) return undefined;
  const [, source, date, time] = m as unknown as [string, string, string, string];
  if (source.trim() !== source || source === "" || !realDate(date) || !realTime(time)) return undefined;
  if (source.startsWith("kl:")) return parseCitation(source) ? { source, sourceKind: "kl", asOf: { date, time } } : undefined;
  return relativePath(source) ? { source, sourceKind: "path", asOf: { date, time } } : undefined;
}

/** The responsible line, or undefined. */
export function parseResponsibleLine(line: string): ResponsibleLine | undefined {
  const text = line.replace(/\r$/, "");
  const m = oneLine(text) ? RESPONSIBLE.exec(text) : null;
  if (!m) return undefined;
  const [, responsible, to, until] = m as unknown as [string, string, string | undefined, string | undefined];
  if (responsible.trim() === "" || responsible.trim() !== responsible) return undefined;
  if (to === undefined) return { responsible, transfer: null };
  if (to.trim() === "" || to.trim() !== to || !realDate(until!)) return undefined;
  return { responsible, transfer: { to, until: until! } };
}

/** The strict brief check's rule ids (Contract 2). Each check reports a code and a line, never a matched value. */
export const STRICT_RULES: Readonly<Record<string, string>> = Object.freeze({
  "assignment.missing": "no Assignment source line between the title and the first section",
  "assignment.malformed": "an Assignment source line that does not match the contract (source, real date, 24-hour time)",
  "assignment.duplicate": "more than one Assignment source line",
  "responsible.missing": "no Responsible line between the title and the first section",
  "responsible.malformed": "a Responsible line that does not match the contract (name; transfer none or to a name until a real date)",
  "responsible.duplicate": "more than one Responsible line",
  "header.misplaced": "an Assignment source or Responsible line outside the space between the title and the first section",
  "decision.none": "no top-level bullet under the Decisions section",
  "decision.uncited": "a top-level Decisions bullet (continuation lines included) with no kl: citation outside fences and comments",
});

/** A decision note's required sections, in order (Contract 3). Kind decision, path decisions/<slug>.md, title `Decision: <text>`. */
export const DECISION_SECTIONS: readonly string[] = Object.freeze(["Decision", "Reason", "Evidence"]);

/** A file edit the grader found: the message it happened in, the path, and the prompt size of that message. */
export interface GradeEdit { messageId: string; path: string; promptTokens: number }
/** One file's size and modified time before and after a retirement (test T8). Contents are never read. */
export interface UntouchedRecord { path: string; sizeBefore: number; sizeAfter: number | null; mtimeBefore: string; mtimeAfter: string | null }

/**
 * The resume grader's report (Contract 6). Every unknown is null, never false, 0 or an empty list: an empty list means
 * measured and none found. A message's prompt size is input + cache-creation + cache-read input tokens; repeated log
 * lines with the same message id count once (the last usage seen).
 */
export interface GradeReport {
  session: string;
  floorTokens: number | null;
  firstScratchWrite: GradeEdit | null;
  firstProjectChange: GradeEdit | null;
  resumeCostTokens: number | null;
  totals: { uncached: number; cacheWritten: number; cacheRead: number } | null;
  perCall: number[] | null;
  predecessorLastPrompt: number | null;
  libraryReads: { cite: string; ok: boolean; fingerprintMatched: boolean | null }[] | null;
  libraryErrors: string[] | null;
  oldLogOpened: boolean | null;
  resumeUsed: boolean | null;
  undetected: string[] | null;
  untouched: UntouchedRecord[] | null;
}

/** A report that knows nothing yet: every field but the session is null. */
export function unknownGradeReport(session: string): GradeReport {
  return {
    session, floorTokens: null, firstScratchWrite: null, firstProjectChange: null, resumeCostTokens: null, totals: null,
    perCall: null, predecessorLastPrompt: null, libraryReads: null, libraryErrors: null, oldLogOpened: null,
    resumeUsed: null, undetected: null, untouched: null,
  };
}
