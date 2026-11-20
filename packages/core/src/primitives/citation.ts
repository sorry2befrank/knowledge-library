import { sha256Hex } from "./sha256.ts";
import { isNoteId } from "./base32.ts";

/**
 * kl:<noteId>@<ver>[#L<a>-L<b> | #$.key.path][~<sha8>]
 * Resolves against the archive only. ~sha8 is the span hash, so a citation verifies itself.
 * A citation without a span uses the first 8 hex of the version sha256.
 */
export interface Citation {
  noteId: string;
  ver: number;
  lines?: { from: number; to: number };
  jsonPath?: string;
  sha8?: string;
}

const CITE_RE = /^kl:([0-9A-HJKMNP-TV-Z]{10})@(\d+)(?:#(L(\d+)-L(\d+)|\$[^~\s]+))?(?:~([0-9a-f]{8}))?$/;
export const LEGACY_VAULT_RE = /^vault:(.+?)(?:@(\d+))?$/;

export function parseCitation(s: string): Citation | null {
  const m = CITE_RE.exec(s);
  if (!m) return null;
  const c: Citation = { noteId: m[1]!, ver: Number(m[2]) };
  if (m[3]) {
    if (m[3].startsWith("L")) c.lines = { from: Number(m[4]), to: Number(m[5]) };
    else c.jsonPath = m[3];
  }
  if (m[6]) c.sha8 = m[6];
  if (!isNoteId(c.noteId) || !Number.isInteger(c.ver) || c.ver < 1) return null;
  if (c.lines && (c.lines.from < 1 || c.lines.to < c.lines.from)) return null;
  return c;
}

export function formatCitation(c: Citation): string {
  let s = `kl:${c.noteId}@${c.ver}`;
  if (c.lines) s += `#L${c.lines.from}-L${c.lines.to}`;
  else if (c.jsonPath) s += `#${c.jsonPath}`;
  if (c.sha8) s += `~${c.sha8}`;
  return s;
}

/** Span hash: sha256 of the exact span text (lines joined with \n), first 8 hex. */
export function spanHash(spanText: string): string {
  return sha256Hex(spanText).slice(0, 8);
}

export function sliceLines(text: string, from: number, to: number): string {
  const lines = text.split("\n");
  return lines.slice(from - 1, to).join("\n");
}

/** Whole-version citation: ~sha8 is the first 8 hex of the version's sha256. */
export function versionCitation(noteId: string, ver: number, sha256: string): string {
  return formatCitation({ noteId, ver, sha8: sha256.slice(0, 8) });
}

export function lineCitation(noteId: string, ver: number, text: string, from: number, to: number): string {
  return formatCitation({ noteId, ver, lines: { from, to }, sha8: spanHash(sliceLines(text, from, to)) });
}
