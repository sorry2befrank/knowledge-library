/**
 * Pure, fail-closed format adapter for the kernel's Understudy hard-pin requirement.
 * Source formats: understudy-trust-ledger, understudy/understudy-sweep.ps1,
 * understudy/adjudicate-report.ps1, understudy-verify-report and understudy-sweep-skill,
 * pinned in provenance. Additional legacy log forms are documented observations.
 * New Library adapter, not an extracted runtime module. No IO, imports, models,
 * state defaults, writes, authorization or general citation verification.
 * Consume only read-success UTF-8 strings and an already resolved project identity.
 * See docs/reference/sweep-protection.md for caller obligations and limitations.
 */

const REPORT_RE = /^- (\d{4}-\d\d-\d\d \d\d:\d\d) - (.+?): (ACCEPTED|REJECTED)\b/;
const HEADER_RE = /^#\s+Understudy scan/i;
// Python's source grammar additionally recognizes five C0/C1 whitespace points.
// Widen lexical whitespace outside captures; never normalize path identity.
const CITE_RE = /^[\s\x1c-\x1f\x85]*[-*][\s\x1c-\x1f\x85]+`([^`]+)`[\s\x1c-\x1f\x85]*(?:--|—|-)[\s\x1c-\x1f\x85]*(?:"(.*)"|`(.*)`|(EXISTS|ABSENT))[\s\x1c-\x1f\x85]*$/u;
const VERDICTS = new Set(["clean", "false", "neutral", "learned"]);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readable = (value) => typeof value === "string" && !/[\u0000\uFFFD]/u.test(value);
const linesOf = (value) => value.split(/\r\n|\r|\n/u);
const QUIET_RE = /^Nothing[\s\x1c-\x1f\x85]+(?:new[\s\x1c-\x1f\x85]+)?worth your attention\.?$/iu;
const SEPARATOR_RE = /^[\s\x1c-\x1f\x85]*---[\s\x1c-\x1f\x85]*$/u;
const QUIET_SECTION_RE = /^##[\s\x1c-\x1f\x85]+(?:Findings|Verdict)[\s\x1c-\x1f\x85]*$/iu;
const lexicalTrim = (line) => line.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu, "");
const headingView = (line) => line.replace(/[\x1c-\x1f\x85]/gu, " ").replace(/\p{Cf}/gu, "");

function citationLike(line) {
  return CITE_RE.test(line) || /^[\s\x1c-\x1f\x85]*[-*][\s\x1c-\x1f\x85]+`/u.test(line)
    || /`[^`]+`[\s\x1c-\x1f\x85]*(?:--|—|-)/u.test(line)
    || /\b(?:EXISTS|ABSENT)\b/u.test(line)
    || /\[[^\]]*\]\([^)]*\)/u.test(line)
    || /`[^`]*(?:[\\/]|\.[a-z0-9]{1,12}(?::\d+)?)[^`]*`/iu.test(line)
    || /(?:^|\s)[\w.-]+[\\/][\w.\\/-]+\.[a-z0-9]{1,12}(?::\d+)?(?:\s|$|[),;])/iu.test(line)
    || /\b[^\s]+\.[a-z0-9]{1,12}:\d+\b/iu.test(line);
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]));
  return parts[0] >= 100 && date.getUTCFullYear() === parts[0]
    && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2]
    && date.getUTCHours() === parts[3] && date.getUTCMinutes() === parts[4];
}

function validHeaderStamp(value) {
  const match = value.match(/^(\d{4}-\d\d-\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(?:Z|[+-](\d\d):(\d\d))?)?$/u);
  return Boolean(match && validTimestamp(`${match[1]} 00:00`)
    && (match[2] === undefined || (Number(match[2]) <= 23 && Number(match[3]) <= 59
      && (match[4] === undefined || Number(match[4]) <= 59)
      && (match[5] === undefined || (Number(match[5]) <= 23 && Number(match[6]) <= 59)))));
}

function unknown(reason) {
  return { status: "adjudication-unknown", reasonCodes: [reason],
    blockEveryCandidate: true, protectedTargets: [], protectedReports: [] };
}

function parseUniqueJson(raw) {
  const parsed = JSON.parse(raw);
  const frames = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "{") frames.push({ type: "object", keys: new Set(), expectKey: true });
    else if (char === "[") frames.push({ type: "array" });
    else if (char === "}" || char === "]") frames.pop();
    else if (char === ",") {
      const frame = frames.at(-1);
      if (frame?.type === "object") frame.expectKey = true;
    } else if (char === ":") {
      const frame = frames.at(-1);
      if (frame?.type === "object") frame.expectKey = false;
    } else if (char === '"') {
      const start = i;
      for (i++; i < raw.length; i++) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') break;
      }
      const frame = frames.at(-1);
      if (frame?.type === "object" && frame.expectKey) {
        const key = JSON.parse(raw.slice(start, i + 1));
        if (frame.keys.has(key)) throw new Error("duplicate-json-member");
        frame.keys.add(key);
        frame.expectKey = false;
      }
    }
  }
  return parsed;
}

/** Strings are caller-provided bytes; null marks a missing/unreadable input. */
export function parseSweepProtection(input) {
  if (!object(input) || typeof input.project !== "string" || !input.project
    || /[|\r\n\u0000\uFFFD]/u.test(input.project)
    || !validTimestamp(input.cutoffTimestamp)) return unknown("invalid-parser-context");
  if (!readable(input.sweepLogText)) return unknown("sweep-log-missing-unreadable");
  if (!readable(input.trustLedgerText)) return unknown("trust-ledger-missing-unreadable");
  if (input.understudyText !== null && !readable(input.understudyText))
    return unknown("understudy-unreadable");

  let ledger;
  try { ledger = parseUniqueJson(input.trustLedgerText); }
  catch (error) { return unknown(error?.message === "duplicate-json-member"
    ? "trust-ledger-duplicate-json-member" : "trust-ledger-unparseable"); }
  if (!object(ledger) || !object(ledger.adjudications)) return unknown("trust-ledger-shape");
  for (const [key, entry] of Object.entries(ledger.adjudications)) {
    const separator = key.indexOf("|");
    const stamp = key.slice(0, separator);
    const wellFormedStamp = validTimestamp(stamp)
      || (/^\d{4}-\d\d-\d\d$/u.test(stamp) && validTimestamp(`${stamp} 00:00`));
    if (separator < 0 || !wellFormedStamp
      || !key.slice(separator + 1) || /[|\r\n\u0000\uFFFD]/u.test(key.slice(separator + 1))
      || !object(entry) || !VERDICTS.has(entry.verdict)
      || (owns(entry, "note") && typeof entry.note !== "string")
      || (owns(entry, "by") && typeof entry.by !== "string"))
      return unknown("trust-ledger-adjudication-shape");
  }

  const accepted = [];
  for (const raw of linesOf(input.sweepLogText)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(REPORT_RE);
    if (!match) {
      const row = line.match(/^- (\d{4}-\d\d-\d\d \d\d:\d\d) - (.*)$/u);
      if (!row) return unknown("sweep-log-unknown-record");
      if (!validTimestamp(row[1])) return unknown("sweep-log-invalid-timestamp");
      const message = row[2];
      const nonreport = message === "offline - skipped"
        || message === "nothing changed in any project - no tokens spent"
        || message === "claude returned nothing - watermark NOT advanced"
        || /^swept \d+ files - \d+ finding\(s\) -> _UNDERSTUDY\/proposals\/[A-Za-z0-9_.-]+\.md$/u.test(message)
        || /^.+?: RUN FAILED \([^\r\n]+, no report produced\) - see _UNDERSTUDY\/failed\/[^/\\\r\n]+$/u.test(message)
        || /^.+?: RUN FAILED \(no report produced: .*\) - watermark NOT advanced - charged to NEITHER the agent nor the harness$/u.test(message)
        || /^.+?: APPLIED \d+ sweep fix\(es\) via the corrector lane \(undo: .+\)$/u.test(message);
      if (!nonreport) return unknown("sweep-log-unknown-record");
      continue;
    }
    if (!validTimestamp(match[1])) return unknown("sweep-log-invalid-timestamp");
    if (match[2] !== input.project && (match[2].toLowerCase() === input.project.toLowerCase()
      || match[2].toUpperCase() === input.project.toUpperCase()))
      return unknown("project-label-case-variant");
    if (match[2] !== input.project || match[3] !== "ACCEPTED") continue;
    const key = `${match[1]}|${match[2]}`;
    accepted.push({ key, timestamp: match[1], date: match[1].slice(0, 10),
      adjudicated: owns(ledger.adjudications, key),
      verdict: owns(ledger.adjudications, key) ? ledger.adjudications[key].verdict : "pending" });
  }
  const byDate = new Map();
  const seenKeys = new Set();
  let previousReportDay = null;
  for (const report of accepted) {
    if (seenKeys.has(report.key)) return unknown("duplicate-report-identity");
    if (previousReportDay !== null && report.date < previousReportDay)
      return unknown("sweep-report-order");
    previousReportDay = report.date;
    seenKeys.add(report.key);
    if (!byDate.has(report.date)) byDate.set(report.date, []);
    byDate.get(report.date).push(report);
  }
  if (input.understudyText === null) {
    if (accepted.length > 0)
      return unknown("required-understudy-missing");
    return { status: "known", reasonCodes: [], blockEveryCandidate: false,
      protectedTargets: [], protectedReports: [] };
  }
  if (accepted.length === 0) return unknown("no-report-lines-for-folder");

  const blocks = [];
  for (const line of linesOf(input.understudyText)) {
    if (!blocks.length && line === "# UNDERSTUDY.md") continue;
    if (HEADER_RE.test(line)) {
      const dates = line.match(/(?<![0-9])\d{4}-\d\d-\d\d(?![0-9])/gu) ?? [];
      if (dates.length !== 1 || !validTimestamp(`${dates[0]} 00:00`))
        return unknown("understudy-block-header-unparseable");
      const framing = line.match(/^#[ \t]+Understudy scan[ \t]+(?:—|-)[ \t]+(.+?)[ \t]*$/iu);
      const stamp = framing?.[1].match(/\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/u)?.[0];
      if (!framing || !stamp) return unknown("unsupported-understudy-report-header");
      if (!validHeaderStamp(stamp)) return unknown("understudy-block-header-unparseable");
      if (framing[1] !== stamp && framing[1] !== `${input.project} — ${stamp}`
        && framing[1] !== `${input.project} - ${stamp}`)
        return unknown("unsupported-understudy-report-header");
      if (blocks.length && dates[0] < blocks.at(-1).date)
        return unknown("understudy-block-order");
      blocks.push({ date: dates[0], lines: [], terminated: false });
    } else if (/^\s*#+\s*understudy\b/iu.test(headingView(line))
      || /^\s*Understudy\s+scan\b/iu.test(headingView(line))
      || (blocks.length && /^\s*#(?!#)/u.test(headingView(line)))) {
      return unknown("unsupported-understudy-report-header");
    } else if (blocks.length) {
      const block = blocks.at(-1);
      if (block.terminated && lexicalTrim(line)) return unknown("report-content-after-terminator");
      block.lines.push(line);
      if (SEPARATOR_RE.test(line)) block.terminated = true;
    } else if (CITE_RE.test(line)
      || /^[\s\x1c-\x1f\x85]*[-*][\s\x1c-\x1f\x85]+`/u.test(line)
      || /`[^`]+`[\s\x1c-\x1f\x85]*(?:--|—|-)/u.test(line)) {
      return unknown("citation-outside-report-block");
    } else if (lexicalTrim(line) && line !== "# UNDERSTUDY.md" && !SEPARATOR_RE.test(line)) {
      return unknown("report-preamble-unrecognized");
    }
  }
  const blockByDate = new Map();
  if (blocks.length === 0) return unknown("no-understudy-report-blocks");
  for (const block of blocks) {
    if (!byDate.has(block.date)) return unknown("unmatched-understudy-block");
    const contentLines = block.lines.filter((line) => lexicalTrim(line) && !SEPARATOR_RE.test(line)
      && !QUIET_SECTION_RE.test(lexicalTrim(line))).map(lexicalTrim);
    if (contentLines.length === 0)
      return unknown("understudy-block-empty");
    const targets = new Set();
    for (const line of block.lines) {
      const match = line.match(CITE_RE);
      if (match) {
        const target = match[1].replace(/:\d+$/u, "");
        const withoutDrive = /^[a-z]:[\\/]/iu.test(target) ? target.slice(2) : target;
        if (!target || /[\r\n\u0000\uFFFD]/u.test(target) || withoutDrive.includes(":"))
          return unknown("citation-target-unparseable");
        targets.add(target);
      } else if (citationLike(line)) {
        return unknown("citation-unparseable");
      }
    }
    if (!block.terminated) return unknown("report-terminator-missing");
    if (!blockByDate.has(block.date)) blockByDate.set(block.date, []);
    blockByDate.get(block.date).push({ ...block, targets: [...targets],
      quiet: targets.size === 0 && contentLines.length === 1 && QUIET_RE.test(contentLines[0]) });
  }

  for (const [date, sameDayBlocks] of blockByDate) {
    const sameDayReports = byDate.get(date);
    if (sameDayBlocks.length > sameDayReports.length) return unknown("same-day-block-ambiguity");
    if (sameDayBlocks.length < sameDayReports.length) return unknown("same-day-report-ambiguity");
  }
  for (const [date, sameDayReports] of byDate) {
    if (!blockByDate.has(date)) return unknown(sameDayReports.length > 1
      ? "same-day-report-ambiguity" : "required-report-block-unmatched");
  }

  const protectedTargets = new Set();
  const protectedReports = [];
  for (const report of accepted) {
    const protective = !report.adjudicated || report.timestamp >= input.cutoffTimestamp;
    if (!protective) continue;
    // Counts and dates are consistency checks, never authenticated association.
    // A protective event protects all represented citations, including older days.
    for (const block of [...blockByDate.values()].flat()) {
      if (block.targets.length === 0 && !block.quiet) return unknown("required-report-citations-missing");
      for (const target of block.targets) protectedTargets.add(target);
    }
    protectedReports.push({ key: report.key, verdict: report.verdict,
      reason: !report.adjudicated ? "pending" : "recent-adjudicated" });
  }
  return { status: "known", reasonCodes: [], blockEveryCandidate: false,
    protectedTargets: [...protectedTargets].sort(), protectedReports };
}
