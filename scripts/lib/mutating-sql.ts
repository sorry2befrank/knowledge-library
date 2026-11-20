// Finds mutating SQL (INSERT/UPDATE/DELETE/REPLACE) in TypeScript source. Shared by scripts/lint-mutating-sql.ts and its test.
import ts from "typescript";
export interface Mutation { verb: string; table: string; index: number }

// Case-insensitive and multi-line: the whole file is scanned with comments stripped, so "insert\n into x" is caught.
const MUTATION = /\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(?:OR\s+\w+\s+)?(?:INTO\s+|FROM\s+)?([a-zA-Z_${}][\w${}.]*)?/gi;

/** String-aware comment stripping: a // or /* inside a string, template or regex literal is not a comment. Stripped text keeps its length (spaces), so indexes stay valid. */
export function stripComments(src: string): string {
  // Let the existing TypeScript parser identify literal boundaries. Guessing whether a slash
  // begins a regex loses the remainder of a line for valid literals such as /[//]/.
  // Template pieces are protected individually so comments inside ${expressions} still strip.
  const file = ts.createSourceFile("scan.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literalEnds = new Map<number, number>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)
      || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail) literalEnds.set(node.getStart(file), node.end);
    ts.forEachChild(node, visit);
  };
  visit(file);
  let out = ""; let i = 0;
  const n = src.length;
  while (i < n) {
    const literalEnd = literalEnds.get(i);
    if (literalEnd !== undefined) { out += src.slice(i, literalEnd); i = literalEnd; continue; }
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { const end = src.indexOf("*/", i + 2); const stop = end < 0 ? n : end + 2; for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " "; continue; }
    out += c; i++;
  }
  return out;
}

export function findMutations(source: string): Mutation[] {
  let src = stripComments(source);
  // Scan the actual value of static string literals, not only their source spelling.
  // For example, an escaped newline between UPDATE and its table is SQL whitespace.
  // Padding preserves every following source offset; an offset within a cooked literal
  // identifies that literal's normalized view. Dynamic SQL still needs runtime write guards.
  const file = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cook = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || node.kind === ts.SyntaxKind.TemplateHead
      || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
      const token = node as ts.StringLiteral | ts.TemplateLiteralToken;
      const suffix = node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1;
      const start = node.getStart(file), width = node.end - start - 1 - suffix;
      src = src.slice(0, start + 1) + token.text.padEnd(width, " ") + src.slice(node.end - suffix);
    }
    ts.forEachChild(node, cook);
  };
  cook(file);
  const out: Mutation[] = [];
  for (const m of src.matchAll(MUTATION)) {
    const verb = m[1]!.toUpperCase(), table = (m[2] ?? "?").toLowerCase();
    // JavaScript's delete operator on a property (`delete <ident>.<ident>`), not SQL: only that exact shape is skipped.
    if (verb === "DELETE" && /^delete\s+[A-Za-z_$][\w$]*\.[A-Za-z_$]/.test(src.slice(m.index!, m.index! + 80))) continue;
    // Prose ("update the ..."): a short list of English continuations, and never followed by a SET anywhere in the statement.
    const statementTail = src.slice(m.index!).split(/[;'"`]/u, 1)[0]!;
    if (verb === "UPDATE" && /^(on|or|SET|the|a|an|to|its|only|that|their|every|is|are|in|at|each|this|per)$/i.test(m[2] ?? "") && !/\bSET\b/i.test(statementTail)) continue;
    out.push({ verb, table, index: m.index! });
  }
  return out;
}
