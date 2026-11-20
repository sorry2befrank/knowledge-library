// Resume-loop contracts (board UNISON-resume-loop.md, Contracts 1-3 and 6): the shared shapes both lanes build against.
// Pure: no I/O. Every refusal case has an accepted twin, so a parser that refuses everything cannot pass.
import { describe, it, expect } from "vitest";
import { DECISION_SECTIONS, STRICT_RULES, parseAssignmentLine, parseResponsibleLine, unknownGradeReport, type GradeReport } from "../cli/kl/src/resume-contract.ts";

describe("Contract 1: the Assignment source line", () => {
  it("accepts a relative path and a kl: citation, with a real date and a 24-hour time", () => {
    expect(parseAssignmentLine("Assignment source: ASSIGNMENT.md, as of 2026-10-23 15:18")).toEqual({ source: "ASSIGNMENT.md", sourceKind: "path", asOf: { date: "2026-10-23", time: "15:18" } });
    expect(parseAssignmentLine("Assignment source: plans/next week.md, as of 2026-12-31 00:00")).toEqual({ source: "plans/next week.md", sourceKind: "path", asOf: { date: "2026-12-31", time: "00:00" } });
    expect(parseAssignmentLine("Assignment source: kl:7QK2M9X4AB@2~f03deb4c, as of 2024-02-29 23:59")).toEqual({ source: "kl:7QK2M9X4AB@2~f03deb4c", sourceKind: "kl", asOf: { date: "2024-02-29", time: "23:59" } });
    // A parent segment is still relative to the planning folder (Contract 1; Codex, PR #32 review finding 2).
    expect(parseAssignmentLine("Assignment source: ../ASSIGNMENT.md, as of 2026-10-23 15:18")).toEqual({ source: "../ASSIGNMENT.md", sourceKind: "path", asOf: { date: "2026-10-23", time: "15:18" } });
    expect(parseAssignmentLine("Assignment source: ASSIGNMENT.md, as of 2026-10-23 15:18\r")).toEqual({ source: "ASSIGNMENT.md", sourceKind: "path", asOf: { date: "2026-10-23", time: "15:18" } });
  });
  it.each([
    ["no as-of", "Assignment source: ASSIGNMENT.md"],
    ["a date that does not exist", "Assignment source: ASSIGNMENT.md, as of 2026-02-30 10:00"],
    ["not a leap year", "Assignment source: ASSIGNMENT.md, as of 2026-02-29 10:00"],
    ["hour 24", "Assignment source: ASSIGNMENT.md, as of 2026-10-23 24:00"],
    ["one-digit hour", "Assignment source: ASSIGNMENT.md, as of 2026-10-23 9:05"],
    ["a zone suffix", "Assignment source: ASSIGNMENT.md, as of 2026-10-23 15:18 EDT"],
    ["seconds", "Assignment source: ASSIGNMENT.md, as of 2026-10-23 15:18:00"],
    ["an empty source", "Assignment source: , as of 2026-10-23 15:18"],
    ["a source with a leading space", "Assignment source:  ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["a source with a trailing space", "Assignment source: ASSIGNMENT.md , as of 2026-10-23 15:18"],
    ["a source of spaces only", "Assignment source:    , as of 2026-10-23 15:18"],
    ["a Windows absolute path", "Assignment source: C:\\plans\\ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["a POSIX absolute path", "Assignment source: /plans/ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["a malformed citation", "Assignment source: kl:nope@0, as of 2026-10-23 15:18"],
    ["an https URL", "Assignment source: https://example.com/ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["a file URL", "Assignment source: file:///C:/plans/ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["another scheme", "Assignment source: vault:plans/ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["a different label", "Assignment: ASSIGNMENT.md, as of 2026-10-23 15:18"],
    ["leading spaces", "  Assignment source: ASSIGNMENT.md, as of 2026-10-23 15:18"],
  ])("refuses %s", (_name, line) => {
    expect(parseAssignmentLine(line)).toBeUndefined();
  });
});

describe("Contract 1: the Responsible line", () => {
  it("accepts no transfer and a dated transfer", () => {
    expect(parseResponsibleLine("Responsible: Claude; transfer: none")).toEqual({ responsible: "Claude", transfer: null });
    expect(parseResponsibleLine("Responsible: Frank Epps; transfer: to Codex until 2026-11-01")).toEqual({ responsible: "Frank Epps", transfer: { to: "Codex", until: "2026-11-01" } });
  });
  it.each([
    ["no transfer part", "Responsible: Claude"],
    ["a transfer with no until", "Responsible: Claude; transfer: to Codex"],
    ["a transfer date that does not exist", "Responsible: Claude; transfer: to Codex until 2026-11-31"],
    ["an empty name", "Responsible: ; transfer: none"],
    ["an empty transfer target", "Responsible: Claude; transfer: to  until 2026-11-01"],
    ["a different label", "Owner: Claude; transfer: none"],
    ["a carriage return inside the name", "Responsible: Frank" + String.fromCharCode(13) + "Codex; transfer: none"],
    ["a line feed inside the name", "Responsible: Frank" + String.fromCharCode(10) + "Codex; transfer: none"],
    ["a line separator inside the name", "Responsible: Frank" + String.fromCharCode(0x2028) + "Codex; transfer: none"],
    ["a line feed inside the transfer target", "Responsible: Frank; transfer: to Co" + String.fromCharCode(10) + "dex until 2026-11-01"],
  ])("refuses %s", (_name, line) => {
    expect(parseResponsibleLine(line)).toBeUndefined();
  });
});

describe("Contract 2: strict rule ids", () => {
  it("are exactly the nine agreed ids, each with a meaning", () => {
    expect(Object.keys(STRICT_RULES).sort()).toEqual([
      "assignment.duplicate", "assignment.malformed", "assignment.missing", "decision.none", "decision.uncited",
      "header.misplaced", "responsible.duplicate", "responsible.malformed", "responsible.missing",
    ]);
    for (const meaning of Object.values(STRICT_RULES)) expect(meaning.trim().length).toBeGreaterThan(10);
  });
});

describe("Contract 3: decision note sections", () => {
  it("are Decision, Reason and Evidence, in that order", () => {
    expect(DECISION_SECTIONS).toEqual(["Decision", "Reason", "Evidence"]);
  });
});

describe("Contract 6: the grade report", () => {
  it("reports every unknown as null, never false, zero or empty", () => {
    const r: GradeReport = unknownGradeReport("00000000");
    expect(r.session).toBe("00000000");
    const { session: _s, ...rest } = r;
    for (const [key, value] of Object.entries(rest)) expect(value, key).toBeNull();
    expect(Object.keys(rest).sort()).toEqual([
      "firstProjectChange", "firstScratchWrite", "floorTokens", "libraryErrors", "libraryReads", "oldLogOpened",
      "perCall", "predecessorLastPrompt", "resumeCostTokens", "resumeUsed", "totals", "undetected", "untouched",
    ]);
  });
});
