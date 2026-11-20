// Source-compatible projection of reports-and-turnover.md; report text remains untrusted data.
export interface FourFields { moved: string; blocked: string; hiring: string; next: string }
export function parseFourFields(raw: string): FourFields {
  const out: FourFields = { moved: "", blocked: "", hiring: "", next: "" };
  let current: keyof FourFields | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?\*{0,2}(MOVED|BLOCKED|HIRING|NEXT)\*{0,2}:\*{0,2}\s*(.*)$/i.exec(line);
    if (match) {
      const field = match[1]!.toLowerCase() as keyof FourFields;
      current = out[field] ? null : field;
      if (current) out[current] = match[2]!.replace(/\*+$/, "").trim();
    } else if (!line.trim() || /^\s*#/.test(line) || /^\s*---/.test(line)) current = null;
    else if (current) out[current] = `${out[current]} ${line.trim()}`.trim();
  }
  return out;
}

// Trusted code supplies already privacy-filtered fields. Newlines and Markdown delimiters cannot
// turn a statement into another field/heading. This view does not confirm any claim it displays.
function literalLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}
export interface LearnedFields { saved: string; tested: string; deployed: string; demonstrated: string }
export function renderReferenceReport(fields: FourFields, learned: LearnedFields): string {
  return ["## Report", ...(["moved", "blocked", "hiring", "next"] as const).map(k => `${k.toUpperCase()}: ${literalLine(fields[k])}`),
    "", "## LEARNED", ...(["saved", "tested", "deployed", "demonstrated"] as const).map(k => `${k}: ${literalLine(learned[k])}`), ""].join("\n");
}
