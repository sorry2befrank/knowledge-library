// Resume grader (board UNISON-resume-loop.md slice 3, Contract 6): numbers, paths and citations from a Claude Code session
// log, never message text. Synthetic logs only.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { grade, snapshot, gradeMain } from "../cli/sessions/src/grade.ts";
import { lineCitation, parseCitation } from "../packages/core/src/primitives/citation.ts";
import { callTool } from "../packages/core/src/tools/call.ts";
import { FRANK, newCatalog } from "./helpers/load.ts";

const SCRATCH = "C:\\Users\\u\\AppData\\Local\\Temp\\claude\\proj\\sess\\scratchpad";
let n = 0;
const usage = (input: number, write: number, read: number) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 7 });
/** One assistant line: message id, usage, and optional tool uses. */
const a = (id: string, u: ReturnType<typeof usage>, tools: { id: string; name: string; input: Record<string, unknown> }[] = [], side = false) =>
  JSON.stringify({ type: "assistant", isSidechain: side, uuid: `u${++n}`, message: { id, role: "assistant", usage: u, content: tools.map((t) => ({ type: "tool_use", ...t })) } });
/** One tool result line. */
const r = (toolUseId: string, isError = false, content = "done") =>
  JSON.stringify({ type: "user", isSidechain: false, uuid: `u${++n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }] } });
const human = (text: string) => JSON.stringify({ type: "user", isSidechain: false, uuid: `u${++n}`, message: { role: "user", content: text } });

describe("grade: token numbers", () => {
  it("takes the floor from the first main-chain message and counts a repeated message id once (the last usage seen)", () => {
    const log = [human("hi"), a("m1", usage(4, 100, 0)), a("m1", usage(10, 100, 0)), a("s1", usage(1, 1, 1), [], true), a("m2", usage(5, 20, 110))].join("\n");
    const g = grade(log, { session: "s" });
    expect(g.floorTokens).toBe(110);
    expect(g.perCall).toEqual([110, 135]);
  });

  it("finds the first scratch write and the first project change, and measures resume cost and totals to the project change", () => {
    const log = [
      a("m1", usage(10, 100, 0)),
      a("m2", usage(1, 10, 110), [{ id: "t1", name: "Write", input: { file_path: `${SCRATCH}\\probe.py`, content: "x" } }]), r("t1"),
      a("m3", usage(1, 5, 120), [{ id: "t2", name: "Edit", input: { file_path: "C:\\dev\\repo\\cli\\a.ts", old_string: "a", new_string: "b" } }]), r("t2", true),
      a("m4", usage(2, 8, 125), [{ id: "t3", name: "Edit", input: { file_path: "C:\\dev\\repo\\cli\\a.ts", old_string: "a", new_string: "b" } }]), r("t3"),
      a("m5", usage(9, 9, 9)),
    ].join("\n");
    const g = grade(log, { session: "s" });
    expect(g.firstScratchWrite).toEqual({ messageId: "m2", path: `${SCRATCH}\\probe.py`, promptTokens: 121 });
    expect(g.firstProjectChange).toEqual({ messageId: "m4", path: "C:\\dev\\repo\\cli\\a.ts", promptTokens: 135 });
    expect(g.resumeCostTokens).toBe(135 - 110);
    expect(g.totals).toEqual({ uncached: 10 + 1 + 1 + 2, cacheWritten: 100 + 10 + 5 + 8, cacheRead: 0 + 110 + 120 + 125 });
  });

  it("reports null, not zero, when there is no project change, and lists shell calls before it as undetected", () => {
    const log = [a("m1", usage(10, 100, 0), [{ id: "b1", name: "Bash", input: { command: "echo hi > f.txt" } }]), r("b1")].join("\n");
    const g = grade(log, { session: "s" });
    expect(g.firstProjectChange).toBeNull();
    expect(g.resumeCostTokens).toBeNull();
    expect(g.totals).toBeNull();
    expect(g.undetected).toEqual(["Bash in m1"]);
  });

  it("an explicit scratchpad option decides what counts as scratch", () => {
    const log = [a("m1", usage(1, 1, 1)), a("m2", usage(1, 1, 1), [{ id: "t1", name: "Write", input: { file_path: "D:\\work\\notes\\x.md", content: "y" } }]), r("t1")].join("\n");
    expect(grade(log, { session: "s", scratchpad: "D:\\work\\notes" }).firstProjectChange).toBeNull();
    expect(grade(log, { session: "s" }).firstProjectChange?.path).toBe("D:\\work\\notes\\x.md");
  });
});

describe("grade: Library reads", () => {
  it("lists only reads whose result arrived, with errors apart, and [] when the log has none", () => {
    const tool = "mcp__knowledge-library__library_read";
    const log = [
      a("m1", usage(1, 1, 1), [{ id: "l1", name: tool, input: { ref: "kl:7QK2M9X4AB@2" } }, { id: "l2", name: tool, input: { ref: "kl:7QK2M9X4AB@3" } }, { id: "l3", name: tool, input: { ref: "kl:7QK2M9X4AB@4" } }]),
      r("l1"), r("l2", true, "version-not-found"),
    ].join("\n");
    const g = grade(log, { session: "s" });
    expect(g.libraryReads).toEqual([{ cite: "kl:7QK2M9X4AB@2", ok: true, fingerprintMatched: null }, { cite: "kl:7QK2M9X4AB@3", ok: false, fingerprintMatched: null }]);
    expect(g.libraryErrors).toEqual(["library_read kl:7QK2M9X4AB@3: version-not-found"]);
    expect(grade(a("m1", usage(1, 1, 1)), { session: "s" }).libraryReads).toEqual([]);
  });
});

describe("grade: evidence-only booleans", () => {
  const old = "C:\\Users\\u\\.claude\\projects\\p\\0ldsess10n-1111.jsonl";
  const readsOld = [a("m1", usage(1, 1, 1), [{ id: "x", name: "Read", input: { file_path: old } }]), r("x")].join("\n");
  const quiet = a("m1", usage(1, 1, 1));
  it("oldLogOpened is null without --old-log, true when a tool touched it, false only with the evidence input", () => {
    expect(grade(readsOld, { session: "s" }).oldLogOpened).toBeNull();
    expect(grade(quiet, { session: "s" }).oldLogOpened).toBeNull();
    expect(grade(readsOld, { session: "s", oldLogPath: old }).oldLogOpened).toBe(true);
    expect(grade(quiet, { session: "s", oldLogPath: old }).oldLogOpened).toBe(false);
  });
  it("resumeUsed comes only from a launch record", () => {
    expect(grade(quiet, { session: "s" }).resumeUsed).toBeNull();
    expect(grade(quiet, { session: "s", launch: "claude --mcp-config prod.json" }).resumeUsed).toBe(false);
    expect(grade(quiet, { session: "s", launch: "claude --resume 1234" }).resumeUsed).toBe(true);
    expect(grade(quiet, { session: "s", launch: "claude -c" }).resumeUsed).toBe(true);
  });
  it("predecessorLastPrompt is the last main-chain prompt of the predecessor log, null without it", () => {
    expect(grade(quiet, { session: "s" }).predecessorLastPrompt).toBeNull();
    expect(grade(quiet, { session: "s", predecessor: [a("p1", usage(1, 2, 3)), a("p2", usage(10, 20, 30))].join("\n") }).predecessorLastPrompt).toBe(60);
  });
});

describe("Codex's review of PR #33 (ba13d4b, 211ef73)", () => {
  const tool = "mcp__knowledge-library__library_read";
  const result = (cite: string, sha256: string) => JSON.stringify({ cite, sha256, text: "<untrusted>...</untrusted>", truncated: false });
  it("1: missing or invalid usage is unknown, never zero, and a later line without usage keeps the measured one", () => {
    const noUsage = JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1", role: "assistant", content: [] } });
    expect(grade(noUsage, { session: "s" }).floorTokens).toBeNull();
    const stringy = JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1", role: "assistant", usage: { input_tokens: "5", cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }, content: [] } });
    expect(grade(stringy, { session: "s" }).floorTokens).toBeNull();
    const kept = [a("m1", usage(10, 100, 0)), JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1", role: "assistant", content: [] } })].join("\n");
    expect(grade(kept, { session: "s" }).floorTokens).toBe(110);
    const g = grade([a("m1", usage(1, 1, 1)), noUsage.replace('"m1"', '"m2"')].join("\n"), { session: "s" });
    expect(g.perCall).toBeNull();
  });
  it("1: a damaged log line is reported, and totals across it are unknown", () => {
    const log = [a("m1", usage(10, 100, 0)), "{not json", a("m2", usage(1, 5, 120), [{ id: "t", name: "Edit", input: { file_path: "C:\\dev\\repo\\a.ts", old_string: "a", new_string: "b" } }]), r("t")].join("\n");
    const g = grade(log, { session: "s" });
    expect(g.undetected).toContain("damaged log line 2");
    expect(g.totals).toBeNull();
    expect(g.firstProjectChange?.promptTokens).toBe(126);
  });
  it("2: library_read is read from its real request and result, and the fingerprint is measured", () => {
    const sha = "f03deb4c" + "0".repeat(56), other = "0badf00d" + "0".repeat(56);
    const log = [
      a("m1", usage(1, 1, 1), [{ id: "a1", name: tool, input: { ref: "kl:7QK2M9X4AB@2~f03deb4c" } }, { id: "a2", name: tool, input: { ref: "kl:7QK2M9X4AB@3~f03deb4c" } }, { id: "a3", name: tool, input: { ref: "kl:7QK2M9X4AB@4" } }]),
      r("a1", false, result("kl:7QK2M9X4AB@2~f03deb4c", sha)), r("a2", false, result("kl:7QK2M9X4AB@3~0badf00d", other)), r("a3", false, "not json"),
    ].join("\n");
    expect(grade(log, { session: "s" }).libraryReads).toEqual([
      { cite: "kl:7QK2M9X4AB@2~f03deb4c", ok: true, fingerprintMatched: true },
      { cite: "kl:7QK2M9X4AB@3~0badf00d", ok: true, fingerprintMatched: false },
      { cite: "kl:7QK2M9X4AB@4", ok: true, fingerprintMatched: null },
    ]);
  });
  it("3: only observed reads count; a mention is not a read, and unobserved shell reads leave it unknown", () => {
    const old = "C:\\Users\\u\\.claude\\projects\\p\\0ld.jsonl";
    const mention = [a("m1", usage(1, 1, 1), [{ id: "w", name: "Write", input: { file_path: "C:\\dev\\notes.md", content: `see ${old}` } }]), r("w")].join("\n");
    expect(grade(mention, { session: "s", oldLogPath: old }).oldLogOpened).toBe(false);
    const shell = [a("m1", usage(1, 1, 1), [{ id: "b", name: "Bash", input: { command: 'cat "$OLD_SESSION_LOG"' } }]), r("b")].join("\n");
    expect(grade(shell, { session: "s", oldLogPath: old }).oldLogOpened).toBeNull();
    const grep = [a("m1", usage(1, 1, 1), [{ id: "g", name: "Grep", input: { pattern: "x", path: old } }]), r("g")].join("\n");
    expect(grade(grep, { session: "s", oldLogPath: old }).oldLogOpened).toBe(true);
  });
  it("4: a quoted resume option counts, and an empty launch record is unknown", () => {
    const quiet = a("m1", usage(1, 1, 1));
    expect(grade(quiet, { session: "s", launch: 'claude "--resume" 1234' }).resumeUsed).toBe(true);
    expect(grade(quiet, { session: "s", launch: "claude '--continue'" }).resumeUsed).toBe(true);
    expect(grade(quiet, { session: "s", launch: "   " }).resumeUsed).toBeNull();
    expect(grade(quiet, { session: "s", launch: 'claude --mcp-config "C:\\a b\\prod.json"' }).resumeUsed).toBe(false);
  });
  it("5: invalid or duplicate snapshot entries are refused, never reported", () => {
    const quiet = a("m1", usage(1, 1, 1));
    const ok = [{ path: "x", size: 1, mtime: "2026-10-23T10:00:00.000Z" }];
    expect(() => grade(quiet, { session: "s", before: [{ path: "x", mtime: "t" } as never], after: ok })).toThrow(/snapshot/);
    expect(() => grade(quiet, { session: "s", before: [{ path: "x", size: "1", mtime: "2026-10-23T10:00:00.000Z" } as never], after: ok })).toThrow(/snapshot/);
    expect(() => grade(quiet, { session: "s", before: [...ok, ...ok], after: ok })).toThrow(/snapshot/);
    expect(() => grade(quiet, { session: "s", before: ok, after: [{ path: "x", size: 1, mtime: "not a time" }] })).toThrow(/snapshot/);
  });
});

describe("Codex's review of PR #33 (fedec33)", () => {
  const old = "C:/sessions/old.jsonl";
  const tool = "mcp__knowledge-library__library_read";
  const span = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
  const wrapped = (text: string, cite: string) => `<untrusted-note-n0nce cite="${cite}">${text}</untrusted-note-n0nce>`;
  it("1: a search pattern is not a read path; a search over the old log's folder counts only by its received result", () => {
    const pattern = [a("m1", usage(1, 1, 1), [{ id: "g", name: "Grep", input: { path: "C:/unrelated", pattern: old } }]), r("g", false, "No matches found")].join("\n");
    expect(grade(pattern, { session: "s", oldLogPath: old }).oldLogOpened).toBe(false);
    const found = [a("m1", usage(1, 1, 1), [{ id: "g", name: "Grep", input: { path: "C:/sessions", glob: "*.jsonl", pattern: "decision" } }]), r("g", false, "C:/sessions/old.jsonl:12: decision")].join("\n");
    expect(grade(found, { session: "s", oldLogPath: old }).oldLogOpened).toBe(true);
    const unseen = [a("m1", usage(1, 1, 1), [{ id: "g", name: "Grep", input: { path: "C:/sessions", pattern: "decision" } }]), r("g", false, "No matches found")].join("\n");
    expect(grade(unseen, { session: "s", oldLogPath: old }).oldLogOpened).toBeNull();
  });
  it("1: a damaged log line or an unresolved read of the old log leaves it unknown", () => {
    const damaged = [a("m1", usage(1, 1, 1)), "{torn"].join("\n");
    expect(grade(damaged, { session: "s", oldLogPath: old }).oldLogOpened).toBeNull();
    const unresolved = a("m1", usage(1, 1, 1), [{ id: "x", name: "Read", input: { file_path: old } }]);
    expect(grade(unresolved, { session: "s", oldLogPath: old }).oldLogOpened).toBeNull();
  });
  it("2: a line-span read is measured by its span hash, and keeps its own citation", () => {
    const text = "line two";
    const good = `kl:7QK2M9X4AB@2#L2-L2~${span(text)}`, bad = "kl:7QK2M9X4AB@2#L2-L2~00000000";
    const body = (cite: string, t: string) => JSON.stringify({ cite: "kl:7QK2M9X4AB@2~f03deb4c", sha256: "f03deb4c" + "0".repeat(56), text: wrapped(t, cite), truncated: false });
    const log = [a("m1", usage(1, 1, 1), [{ id: "s1", name: tool, input: { ref: good } }, { id: "s2", name: tool, input: { ref: bad } }]), r("s1", false, body(good, text)), r("s2", false, body(bad, text))].join("\n");
    expect(grade(log, { session: "s" }).libraryReads).toEqual([{ cite: good, ok: true, fingerprintMatched: true }, { cite: bad, ok: true, fingerprintMatched: false }]);
  });
  it("2: a received hash that is not a SHA-256 proves nothing", () => {
    const log = [a("m1", usage(1, 1, 1), [{ id: "w", name: tool, input: { ref: "kl:7QK2M9X4AB@2~f03deb4c" } }]), r("w", false, JSON.stringify({ cite: "kl:7QK2M9X4AB@2~f03deb4c", sha256: "f03deb4c" }))].join("\n");
    expect(grade(log, { session: "s" }).libraryReads).toEqual([{ cite: "kl:7QK2M9X4AB@2~f03deb4c", ok: true, fingerprintMatched: null }]);
  });
  it("3: an empty quoted command or an unmatched quote is unusable evidence, so null", () => {
    const quiet = a("m1", usage(1, 1, 1));
    expect(grade(quiet, { session: "s", launch: '""' }).resumeUsed).toBeNull();
    expect(grade(quiet, { session: "s", launch: 'claude "--resume' }).resumeUsed).toBeNull();
    expect(grade(quiet, { session: "s", launch: "claude 'x" }).resumeUsed).toBeNull();
    expect(grade(quiet, { session: "s", launch: "claude --mcp-config prod.json" }).resumeUsed).toBe(false);
  });
});

describe("Codex's review of PR #33 (ffc7a3e)", () => {
  const old = "C:/sessions/old.jsonl";
  /** The same line as the session log records it, with the working folder the tool ran in. */
  const inCwd = (line: string, cwd: string) => JSON.stringify({ ...JSON.parse(line), cwd });
  const read = (path: string, cwd?: string) => {
    const use = a("m1", usage(1, 1, 1), [{ id: "x", name: "Read", input: { file_path: path } }]);
    return grade([cwd === undefined ? use : inCwd(use, cwd), r("x")].join("\n"), { session: "s", oldLogPath: old }).oldLogOpened;
  };
  const grep = (input: Record<string, unknown>, result: string, cwd?: string) => {
    const use = a("m1", usage(1, 1, 1), [{ id: "g", name: "Grep", input }]);
    return grade([cwd === undefined ? use : inCwd(use, cwd), r("g", false, result)].join("\n"), { session: "s", oldLogPath: old }).oldLogOpened;
  };
  it("1: a read through . or .. segments, or relative to the session's working folder, is a read of the old log", () => {
    expect(read("C:/sessions/nested/../old.jsonl")).toBe(true);
    expect(read("C:\\sessions\\.\\old.jsonl")).toBe(true);
    expect(read("old.jsonl", "C:\\sessions")).toBe(true);
    expect(read("C:/sessions/other.jsonl")).toBe(false);
  });
  it("1: a path whose identity cannot be established is unknown, never false", () => {
    expect(read("old.jsonl")).toBeNull();
    expect(read("D:/backup/old.jsonl")).toBeNull();
    expect(read("C:old.jsonl", "D:\\project")).toBeNull();
  });
  it("1: Grep reads the old log only when a result line's file path is the old log, never by matched content", () => {
    expect(grep({ path: "C:/sessions", glob: "current.md", output_mode: "content", pattern: "jsonl" }, "C:/sessions/current.md:1:C:/sessions/old.jsonl")).toBeNull();
    expect(grep({ path: "C:/sessions", output_mode: "content", pattern: "decision" }, "C:\\sessions\\old.jsonl:3:decision")).toBe(true);
    expect(grep({ path: "C:/sessions", output_mode: "count", pattern: "decision" }, "C:/sessions/old.jsonl:4")).toBe(true);
    expect(grep({ path: "C:/sessions/nested/..", pattern: "decision" }, "Found 1 file\nC:/sessions/nested/../old.jsonl")).toBe(true);
  });
  it("1: the file path is the text before the first colon past the drive, so matched text never resolves into one (Codex's review of 43abb34)", () => {
    const hit = { path: "C:/sessions", glob: "current.md", pattern: "old.jsonl", output_mode: "content" };
    expect(grep(hit, "C:/sessions/current.md:1:../../old.jsonl")).toBeNull();
    expect(grep(hit, "C:/sessions/current.md:1:C:/sessions/old.jsonl:2:x")).toBeNull();
    expect(grep({ path: "C:/sessions", pattern: "x", output_mode: "content" }, "C:/sessions/old.jsonl:7:a: b: ../old.jsonl")).toBe(true);
    expect(grep({ path: "C:/sessions", pattern: "x", output_mode: "content" }, "old.jsonl:7:x", "C:\\sessions")).toBe(true);
  });
  it("1: a Grep without a path searches the session's working folder", () => {
    expect(grep({ pattern: "decision" }, "Found 1 file\nC:/sessions/old.jsonl", "C:\\sessions")).toBe(true);
    expect(grep({ pattern: "decision" }, "No files found", "D:\\project")).toBe(false);
    expect(grep({ pattern: "decision" }, "No files found")).toBeNull();
  });
  it("2: a verified line span holding a literal untrusted&#45;note matches its fingerprint (real library_read)", async () => {
    const { catalog } = newCatalog();
    const content = "# Decision: wrapper\nReason: untrusted&#45;note is literal, untrusted-note is escaped\nEvidence: none\n";
    const saved = await catalog.save(FRANK, { content, collection: "inbox:frank" });
    if (!saved.ok) throw new Error("save failed");
    const { noteId, ver } = parseCitation(saved.cite)!;
    const good = lineCitation(noteId, ver, content, 2, 2);
    const bad = good.replace(/~[0-9a-f]{8}$/, "~00000000");
    const tool = "mcp__knowledge-library__library_read";
    const res = await callTool({ catalog, actor: FRANK, scopes: ["read"], random: catalog.random }, "library_read", { ref: good });
    expect(res.isError).toBe(false);
    const log = [a("m1", usage(1, 1, 1), [{ id: "s1", name: tool, input: { ref: good } }, { id: "s2", name: tool, input: { ref: bad } }]), r("s1", false, res.text), r("s2", false, res.text)].join("\n");
    expect(grade(log, { session: "s" }).libraryReads).toEqual([{ cite: good, ok: true, fingerprintMatched: true }, { cite: bad, ok: true, fingerprintMatched: false }]);
  });
});

describe("snapshot and untouched", () => {
  it("snapshots size and modified time, and joins before and after by path", () => {
    const dir = mkdtempSync(join(tmpdir(), "grade-"));
    try {
      const f = join(dir, "cred.json");
      writeFileSync(f, "abc");
      const before = snapshot([f]);
      expect(before).toEqual([{ path: f, size: 3, mtime: statSync(f).mtime.toISOString() }]);
      writeFileSync(f, "abcd");
      const g = grade(a("m1", usage(1, 1, 1)), { session: "s", before, after: snapshot([f]) });
      expect(g.untouched).toEqual([{ path: f, sizeBefore: 3, sizeAfter: 4, mtimeBefore: before[0]!.mtime, mtimeAfter: statSync(f).mtime.toISOString() }]);
      expect(grade(a("m1", usage(1, 1, 1)), { session: "s" }).untouched).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a path missing after the run reports a null size and time", () => {
    const g = grade(a("m1", usage(1, 1, 1)), { session: "s", before: [{ path: "x", size: 1, mtime: "2026-10-23T10:00:00.000Z" }], after: [] });
    expect(g.untouched).toEqual([{ path: "x", sizeBefore: 1, sizeAfter: null, mtimeBefore: "2026-10-23T10:00:00.000Z", mtimeAfter: null }]);
  });
});

describe("gradeMain: the command line", () => {
  it("prints the report as JSON with --json and never prints message text", () => {
    const dir = mkdtempSync(join(tmpdir(), "grade-"));
    try {
      const log = join(dir, "abc.jsonl");
      writeFileSync(log, [human("SECRET-WORDS-IN-A-PROMPT"), a("m1", usage(1, 2, 3))].join("\n"));
      let out = "";
      const code = gradeMain([log, "--json"], { stdout: (s) => { out += s; }, stderr: () => {} });
      expect(code).toBe(0);
      expect(JSON.parse(out).floorTokens).toBe(6);
      expect(JSON.parse(out).session).toBe("abc");
      expect(out).not.toContain("SECRET-WORDS");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses a missing log or an unknown flag with exit 2", () => {
    expect(gradeMain(["nope.jsonl", "--json"], { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(gradeMain(["a.jsonl", "--bogus"], { stdout: () => {}, stderr: () => {} })).toBe(2);
  });
});
