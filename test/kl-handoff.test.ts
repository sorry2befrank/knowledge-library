// AR1: kl handoff check and kl handoff save (docs/sessions/AR1-handoff-notes.md). Synthetic content only.
// check is local: no token, no network. save checks first, sends under exactly one token kind, and succeeds only on a current version.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { admit, bundleHash, generateServiceKey, mintToken, seededRng, signAcceptance, type DenyRules, type PolicyBundle } from "@kl/core";
import { loadReferenceAdmissionRules } from "../packages/core/src/admission/reference-policy.ts";
import { checkHandoff } from "../cli/kl/src/handoff.ts";
import { startHarness, kl, type Harness } from "./helpers/s2e-harness.ts";

let h: Harness;
let dir: string;
beforeAll(async () => { h = await startHarness(); dir = mkdtempSync(join(tmpdir(), "kl-handoff-")); });
afterAll(async () => { await h.close(); rmSync(dir, { recursive: true, force: true }); });

const SECTIONS = ["Goal", "Decisions", "State", "Open items", "File map", "Next step"];
const TITLE = "Handoff: synthetic project, test thread, 2026-10-21";
/** A complete synthetic handoff; options drop or empty one section, omit the title, or append lines. */
function note(o: { title?: boolean; drop?: string; empty?: string; extra?: string; marker?: string } = {}): string {
  const lines = o.title === false ? [] : [`# ${TITLE}`, ""];
  for (const s of SECTIONS) {
    if (s === o.drop) continue;
    lines.push(`## ${s}`, "", s === o.empty ? "" : `Synthetic ${s.toLowerCase()} text ${o.marker ?? ""}.`, "");
  }
  if (o.extra) lines.push(o.extra, "");
  return lines.join("\n");
}
let n = 0;
const file = (text: string) => { const p = join(dir, `h${++n}.md`); writeFileSync(p, text); return p; };
/** A fetch that records every call and fails the test's network expectations if used. */
function spyFetch() { const calls: string[] = []; const f = (async (u: string | URL | Request) => { calls.push(String(u)); throw new Error("no network expected"); }) as typeof fetch; return { calls, f }; }
const args = (f: string, thread = "test-thread", extra: string[] = []) => ["handoff", "save", f, "--thread", thread, "--collection", "inbox:frank", ...extra];

describe("kl handoff check: local only", () => {
  it("a complete note passes with no token and no network call", async () => {
    const spy = spyFetch();
    const r = await kl(["handoff", "check", file(note({ extra: `See ${h.teamCite}.` }))], {}, { fetch: spy.f });
    expect(r.err).toBe(""); expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok: 6 sections, 1 citation\(s\), \d+ bytes\n$/);
    expect(spy.calls).toEqual([]);
  });
  it("a note without an H1 title fails as title.missing", async () => {
    const r = await kl(["handoff", "check", file(note({ title: false }))], {});
    expect(r.code).toBe(1); expect(r.out).toBe(""); expect(r.err).toMatch(/^title\.missing/m);
  });
  it("each missing required section is named", async () => {
    for (const s of SECTIONS) {
      const r = await kl(["handoff", "check", file(note({ drop: s }))], {});
      expect(r.code).toBe(1); expect(r.err).toContain(`section.missing:${s}`);
      expect(r.err.match(/section\.missing:/g)).toHaveLength(1);
    }
  });
  it("a section with only whitespace fails as section.empty", async () => {
    const r = await kl(["handoff", "check", file(note({ empty: "Open items" }))], {});
    expect(r.code).toBe(1); expect(r.err).toContain("section.empty:Open items"); expect(r.err).not.toContain("section.missing");
  });
  it("a malformed kl: citation is reported with its line number; a well-formed one beside it is accepted", async () => {
    const text = note({ extra: `Good ${h.teamCite}; bad kl:0000000000@0 and kl:SHORT@1.` });
    const line = text.split("\n").findIndex((l) => l.startsWith("Good ")) + 1;
    const r = await kl(["handoff", "check", file(text)], {});
    expect(r.code).toBe(1);
    expect(r.err.match(/citation\.invalid/g)).toHaveLength(2);
    expect(r.err).toContain(`citation.invalid line ${line}`);
  });
  it("a credential-shaped string fails, names the guard's rule code and line, and its value is never printed", async () => {
    const rng = seededRng("ar1-plant");
    const plants = { "klb_ bearer token": mintToken((k) => rng.bytes(k)).token, "github token": ["ghp_", "a1B2".repeat(9)].join("") };
    for (const [name, value] of Object.entries(plants)) {
      const text = note({ extra: `Leaked: ${value}` });
      const line = text.split("\n").findIndex((l) => l.startsWith("Leaked")) + 1;
      const r = await kl(["handoff", "check", file(text)], {});
      expect(r.code).toBe(1);
      expect(r.err, name).toMatch(new RegExp(`^credential:secret\\.credential\\.[\\w.-]+ line ${line}$`, "m"));
      expect(r.out + r.err).not.toContain(value);
    }
  });
  it("a note over 32 KiB fails as size.over-budget", async () => {
    const r = await kl(["handoff", "check", file(note({ extra: "x".repeat(32 * 1024) }))], {});
    expect(r.code).toBe(1); expect(r.err).toMatch(/^size\.over-budget/m);
  });
  it("no file argument prints usage and exits 2", async () => {
    const r = await kl(["handoff", "check"], {});
    expect(r.code).toBe(2); expect(r.out).toBe(""); expect(r.err).toMatch(/usage: kl handoff/);
  });
});

describe("kl handoff save", () => {
  it("--dry-run prints the request it would send, and reads no token and makes no network call", async () => {
    const text = note();
    const spy = spyFetch();
    const r = await kl(args(file(text), "test-thread", ["--as", "device", "--dry-run"]), {}, { fetch: spy.f });
    expect(r.err).toBe(""); expect(r.code).toBe(0); expect(spy.calls).toEqual([]);
    const sha = createHash("sha256").update(text).digest("hex");
    expect(r.out).toBe(`dry run: nothing sent\npath: handoffs/test-thread.md\ncollection: inbox:frank\nkind: handoff\ntitle: ${TITLE}\nbytes: ${Buffer.byteLength(text)}\nsha256: ${sha}\n`);
  });
  it("a note that fails check is never sent", async () => {
    const spy = spyFetch();
    const r = await kl(args(file(note({ drop: "Goal" })), "test-thread", ["--as", "device"]), { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { fetch: spy.f });
    expect(r.code).toBe(1); expect(r.err).toContain("section.missing:Goal"); expect(spy.calls).toEqual([]);
  });
  it("an invalid --thread is refused before anything is read or sent", async () => {
    const spy = spyFetch();
    for (const t of ["../up", ".remember", "Upper", "a b", "-lead", "a".repeat(65), "x/y"]) {
      const r = await kl(args(file(note()), t, ["--as", "device"]), { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { fetch: spy.f });
      expect(r.code, t).toBe(2); expect(r.err).toMatch(/--thread/);
    }
    expect(spy.calls).toEqual([]);
  });
  it("--as and --collection are both required", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    const noAs = await kl(args(file(note())), env);
    expect(noAs.code).toBe(2); expect(noAs.err).toMatch(/--as/);
    const noCol = await kl(["handoff", "save", file(note()), "--thread", "test-thread", "--as", "device"], env);
    expect(noCol.code).toBe(2); expect(noCol.err).toMatch(/--collection/);
  });
  it("there is no fallback between token kinds: --as cc with only a device token is 'no cc token' and sends nothing", async () => {
    const spy = spyFetch();
    const r = await kl(args(file(note()), "test-thread", ["--as", "cc"]), { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { fetch: spy.f });
    expect(r.code).toBe(1); expect(r.err).toMatch(/no cc token/); expect(spy.calls).toEqual([]);
  });
  it("the device token saves a current handoff note at handoffs/<thread>.md, and a second save makes the next version current", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    const first = await kl(args(file(note({ marker: "zebracorn" })), "restart-flow", ["--as", "device"]), env);
    expect(first.err).toBe(""); expect(first.code).toBe(0);
    const m1 = /^saved (kl:([0-9A-HJKMNP-TV-Z]{10})@1~[0-9a-f]{8}) current custody=\w+\n$/.exec(first.out);
    expect(m1, first.out).not.toBeNull();
    const noteId = m1![2]!;
    const row = h.catalog.db.get<{ kind: string; collectionId: string; title_h: string | null }>("SELECT kind, collectionId, title_h FROM notes WHERE noteId = ?", [noteId]);
    expect(row?.kind).toBe("handoff"); expect(row?.collectionId).toBe("inbox:frank");
    await h.catalog.drainOutbox(); // indexing is an outbox step after the save commits
    const found = await kl(["search", "--as", "cc", "--json", "zebracorn"], { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url });
    const hit = (JSON.parse(found.out).hits as { cite: string; path: string; title: string }[]).find((x) => x.cite.includes(noteId));
    // vendor-class search wraps note-derived strings (wrapUntrusted); compare what is inside the wrapper
    const inner = (s: string | undefined) => /^<untrusted-note-\w+ cite="[^"]*">([\s\S]*)<\/untrusted-note-\w+>$/.exec(s ?? "")?.[1] ?? s;
    expect(inner(hit?.path)).toBe("handoffs/restart-flow.md"); expect(inner(hit?.title)).toBe(TITLE);

    const second = await kl(args(file(note({ marker: "quokkafin" })), "restart-flow", ["--as", "device"]), env);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(new RegExp(`^saved kl:${noteId}@2~[0-9a-f]{8} current custody=\\w+\\n$`));
    const read = await kl(["read", "--as", "cc", "--json", `kl:${noteId}@2`], { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url });
    expect(JSON.parse(read.out).text).toContain("quokkafin");
  });
  it("a server refusal exits 1 and reports the server's status, with nothing on stdout", async () => {
    const r = await kl(["handoff", "save", file(note()), "--thread", "test-thread", "--collection", "col:does-not-exist", "--as", "device"], { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url });
    expect(r.code).toBe(1); expect(r.out).toBe(""); expect(r.err).toMatch(/kl handoff: not saved as current \(status=(refused|rejected)/);
  });
});

// PR #27 review: the local check must agree with the production guard, and nothing may read a token before it passes.
describe("parity with the production guard", () => {
  const template = JSON.parse(readFileSync(new URL("../policy/deny.template.json", import.meta.url), "utf8"));
  let rules: DenyRules;
  beforeAll(async () => {
    // Production's deny.reference.json is policy/deny.template.json; the private overlay here is fictional.
    const key = await generateServiceKey();
    const b: PolicyBundle = { files: { "deny.reference.json": structuredClone(template), "deny.private.json": { ownerApprovedRevision: "fixture-revision-1", projectAndClientDeniedDirectorySegments: [], projectAuditDirectoryPatterns: [], privateOperationalPathSignatures: [], clientClassificationRules: ["Example Orchard"], privateLedgerPathRules: [] } } };
    rules = await loadReferenceAdmissionRules(b, await signAcceptance(key.privateKey, { policyHash: bundleHash(b), epoch: 2, receiptId: "fixture-receipt", keyId: key.keyId }), { publicKey: key.publicKey, keyId: key.keyId, minEpoch: 2 });
    expect(rules.contentPatterns.length).toBeGreaterThan(2);
  });
  const S = (...p: string[]) => p.join("");
  const v24 = "Zq9x".repeat(6), v32 = "A1b2".repeat(8), v36 = "a1B2".repeat(9);
  const secrets: Record<string, string> = {
    "openai-style key": S("sk-", "proj-", v32), "github oauth": S("gh", "o_", v36), "github classic": S("gh", "p_", v36),
    "bearer header": S("Authorization: ", "Bearer ", v32), "password assignment": S("pass", "word = ", v24), "client secret": S("client_", "secret: ", v24),
    "api-key": S("api", "-key: ", v24), "yaml key across a line break": S("openai_api", "_key:\n  ", v24), "npm token across a line break": S("_auth", "Token\n= x"),
    "lowercase private key": S("-----begin ", "private key-----"), "klb token": mintToken((k) => seededRng("parity").bytes(k)).token,
  };
  const serverRejects = (content: string) => admit(rules, { requestId: "parity", content, path: "handoffs/parity.md", fields: { title: TITLE, kind: "handoff" } }).ruleCodes.includes("secret.credential");
  const localFlags = (content: string) => checkHandoff(content).problems.some((p) => p.code.startsWith("credential:"));
  for (const eol of ["\n", "\r\n"]) {
    it(`every credential the guard rejects is caught locally (${eol === "\n" ? "LF" : "CRLF"})`, () => {
      for (const [name, value] of Object.entries(secrets)) {
        const text = note({ extra: `Leaked: ${value}` }).replace(/\n/g, eol);
        expect(serverRejects(text), `${name}: server`).toBe(true);
        expect(localFlags(text), `${name}: local`).toBe(true);
      }
    });
  }
  it("clean notes pass both, including prose that mentions keys and tokens without a value", () => {
    for (const extra of ["The token rotation plan is in the decision log.", "The api key lives in the owner store, never here.", "A password manager holds it."]) {
      const text = note({ extra });
      expect(serverRejects(text), extra).toBe(false); expect(localFlags(text), extra).toBe(false);
    }
  });
  it("a credential reports the line it starts on, even when it continues onto the next", () => {
    const text = note({ extra: S("openai_api", "_key:\n  ", v24) });
    const line = text.split("\n").findIndex((l) => l.startsWith("openai_api")) + 1;
    const hits = checkHandoff(text).problems.filter((p) => p.code.startsWith("credential:"));
    expect(hits.length).toBeGreaterThan(0); expect(hits.every((p) => p.line === line)).toBe(true);
  });
  it("a --thread whose file name the server's basename rule refuses is refused locally, before anything is read or sent", async () => {
    const base = new RegExp(template.legacySignals.deniedBasename.source, "i");
    const spy = spyFetch();
    for (const t of ["backup-restore", "token-rotation", "secret-scan", "kl-tokens"]) {
      expect(base.test(`${t}.md`), t).toBe(true);
      const r = await kl(args(file(note()), t, ["--as", "device"]), { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { fetch: spy.f });
      expect(r.code, t).toBe(2); expect(r.err).toMatch(/--thread .*file name/);
    }
    expect(spy.calls).toEqual([]);
  });
});

/** An environment that records every read of a KL_TOKEN* variable. */
function watchedEnv(base: Record<string, string | undefined>) {
  const reads: string[] = [];
  const env = new Proxy(base, { get(t, k) { if (typeof k === "string" && k.startsWith("KL_TOKEN")) reads.push(k); return Reflect.get(t, k); } });
  return { env, reads };
}

describe("no token is read until the note has passed and the request is real", () => {
  it("check, a failing save, a dry run and refused arguments read no token; a real save does (positive control)", async () => {
    const cases: string[][] = [
      ["handoff", "check", file(note())],
      args(file(note({ drop: "Goal" })), "test-thread", ["--as", "device"]),
      args(file(note()), "test-thread", ["--as", "device", "--dry-run"]),
      ["handoff", "save", file(note()), "--thread", "test-thread", "--as", "device", "--collection", "--dry-run"],
      args(file(note()), "backup-restore", ["--as", "device"]),
    ];
    for (const argv of cases) {
      const w = watchedEnv({ KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url });
      const spy = spyFetch();
      await kl(argv, w.env, { fetch: spy.f });
      expect(w.reads, argv.join(" ")).toEqual([]); expect(spy.calls, argv.join(" ")).toEqual([]);
    }
    const w = watchedEnv({ KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url });
    const r = await kl(args(file(note({ marker: "controlcase" })), "control-case", ["--as", "device"]), w.env);
    expect(r.code).toBe(0); expect(w.reads.length).toBeGreaterThan(0);
  });
  it("a flag given without a value, or with another flag as its value, is a usage error", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    for (const argv of [["handoff", "save", file(note()), "--thread", "test-thread", "--as", "device", "--collection", "--dry-run"], ["handoff", "save", file(note()), "--thread", "--as", "device", "--collection", "inbox:frank"], ["handoff", "save", file(note()), "--thread", "test-thread", "--collection", "inbox:frank", "--as"]]) {
      const r = await kl(argv, env);
      expect(r.code, argv.join(" ")).toBe(2); expect(r.err).toMatch(/needs a value/);
    }
    const bad = await kl(["handoff", "save", file(note()), "--thread", "test-thread", "--as", "device", "--collection", "not a collection"], env);
    expect(bad.code).toBe(2); expect(bad.err).toMatch(/--collection/);
  });
  it("check refuses save-only flags", async () => {
    const r = await kl(["handoff", "check", file(note()), "--as", "device"], {});
    expect(r.code).toBe(2); expect(r.err).toMatch(/usage: kl handoff/);
  });
});

describe("Markdown shape", () => {
  it("headings inside fenced code are not the title or a section", async () => {
    const text = ["```bash", "# run the tests", "## Goal", "```", "", ...note({ title: false, drop: "Goal" }).split("\n")].join("\n");
    const r = await kl(["handoff", "check", file(text)], {});
    expect(r.code).toBe(1); expect(r.err).toMatch(/^title\.missing/m); expect(r.err).toContain("section.missing:Goal");
  });
  it("a byte-order mark, closing #s and up to three leading spaces are still headings", async () => {
    const text = "﻿" + note().replace("## Goal", "## Goal ##").replace("## Decisions", "   ## Decisions");
    const r = await kl(["handoff", "check", file(text)], {});
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  it("a bold citation is a citation", async () => {
    const r = await kl(["handoff", "check", file(note({ extra: `See **${h.teamCite}**.` }))], {});
    expect(r.err).toBe(""); expect(r.out).toMatch(/1 citation\(s\)/);
  });
  it("the budget is in bytes: 16,632 two-byte characters are over 32 KiB", async () => {
    const r = await kl(["handoff", "check", file(note({ extra: "é".repeat(16_632) }))], {});
    expect(r.code).toBe(1); expect(r.err).toMatch(/^size\.over-budget/m);
  });
  it("the unfilled template fails, and every placeholder the template uses is caught on its own", async () => {
    const tpl = readFileSync(new URL("../docs/reference/handoff-template.md", import.meta.url), "utf8");
    const r = await kl(["handoff", "check", file(tpl)], {});
    expect(r.code).toBe(1); expect(r.err).toMatch(/template\.unfilled/);
    const body = tpl.replace(/<!--[\s\S]*?-->/, "");
    const placeholders = [...new Set([...body.matchAll(/<[^<>\n]+>/g)].map((m) => m[0]))];
    expect(placeholders.length).toBeGreaterThan(5);
    for (const p of placeholders) {
      const one = await kl(["handoff", "check", file(note({ extra: `Left in: ${p}` }))], {});
      expect(one.code, p).toBe(1); expect(one.err, p).toMatch(/template\.unfilled/);
    }
    const comment = tpl.split("\n").find((l) => l.startsWith("Template for"))!;
    const left = await kl(["handoff", "check", file(note({ extra: `<!--\n${comment}\n-->` }))], {});
    expect(left.code).toBe(1); expect(left.err).toMatch(/template\.unfilled/);
  });
});

describe("server answers", () => {
  const answering = (status: number, body: string) => (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  it("a 403 names the server's error code; a null or non-JSON body exits 1 without throwing", async () => {
    const env = { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url };
    const scope = await kl(args(file(note()), "test-thread", ["--as", "cc"]), { KL_TOKEN_CC: h.tokens.cc, KL_API: h.url });
    expect(scope.code).toBe(1); expect(scope.err).toMatch(/insufficient-scope/);
    for (const [status, body] of [[200, "null"], [503, "<html>down</html>"], [200, "[]"]] as const) {
      const r = await kl(args(file(note()), "test-thread", ["--as", "device"]), env, { fetch: answering(status, body) });
      expect(r.code, body).toBe(1); expect(r.out).toBe(""); expect(r.err, body).toMatch(/kl handoff:|kl:/);
    }
  });
});

// PR #27 re-review nits: everything else the public guard would refuse is refused locally too, before any token is read.
describe("the rest of the public guard, locally", () => {
  it("a --thread whose path the server refuses as a client ledger is refused before anything is read or sent", async () => {
    const spy = spyFetch();
    for (const t of ["blocked", "pipeline", "follow-ups", "relationship-register"]) {
      const w = watchedEnv({ KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url });
      const r = await kl(args(file(note()), t, ["--as", "device"]), w.env, { fetch: spy.f });
      expect(r.code, t).toBe(2); expect(r.err).toMatch(/--thread .*ledger/); expect(w.reads).toEqual([]);
    }
    expect(spy.calls).toEqual([]);
  });
  it("student-record content the server refuses is refused locally (student.content), and one signature alone is not", () => {
    const two = note({ extra: "The form asks for the date of birth and the student id." });
    expect(checkHandoff(two).problems.map((p) => p.code)).toContain("student.content");
    expect(checkHandoff(note({ extra: "Record the date of birth of the project." })).problems).toEqual([]);
  });
  it("fails closed when the public reference cannot be read", () => {
    expect(checkHandoff(note(), undefined, null).problems.map((p) => p.code)).toEqual(["policy.unavailable"]);
  });
  it("the derived save path is scanned too", () => {
    const value = ["gh", "p_", "a1B2".repeat(9)].join("");
    expect(checkHandoff(note(), `handoffs/${value}.md`).problems.some((p) => p.code.startsWith("credential:") && p.line === undefined)).toBe(true);
  });
  it("a flag given twice is a usage error", async () => {
    const r = await kl([...args(file(note())), "--collection", "col:other", "--as", "device"], { KL_TOKEN_DEVICE: h.tokens.device, KL_API: h.url }, { fetch: spyFetch().f });
    expect(r.code).toBe(2); expect(r.err).toMatch(/--collection given twice/);
  });
});

describe("fewer false positives", () => {
  it("placeholders inside inline code or fenced code are not an unfilled template", async () => {
    const extra = ["Run `kl read <path>` to fetch it; notes live in `.remember/<project>/`.", "```", "kl read <path>", "```"].join("\n");
    const r = await kl(["handoff", "check", file(note({ extra }))], {});
    expect(r.err).toBe(""); expect(r.code).toBe(0);
  });
  it("a citation followed by a dash, an ellipsis or a closing quote is still a citation", async () => {
    const r = await kl(["handoff", "check", file(note({ extra: `See ${h.teamCite}—then ${h.teamCite}… and “${h.teamCite}”.` }))], {});
    expect(r.err).toBe(""); expect(r.out).toMatch(/3 citation\(s\)/);
  });
});

describe("fences follow CommonMark", () => {
  const fenced = (open: string, inner: string[], close: string) => note({ title: false, drop: "Goal", extra: [open, ...inner, close, "", "# Real title", "", "## Goal", "", "Synthetic goal."].join("\n") });
  it("a shorter run or a run with an info string does not close a fence, so a heading inside it is not a section", () => {
    for (const [open, close] of [["````", "```"], ["```", "```bash"], ["~~~~", "~~~"]] as const) {
      const text = [open, "inside the fence", close, "## Goal", "still inside the fence", open].join("\n");
      const c = checkHandoff(note({ drop: "Goal", extra: text }));
      expect(c.problems.map((p) => p.code), `${open} closed by ${close}`).toContain("section.missing:Goal");
    }
  });
  it("a backtick run with a backtick in its info string is inline code, not a fence", () => {
    const c = checkHandoff(fenced("```x```", [], ""));
    expect(c.title).toBe("Real title");
  });
});

// PR #27 final-pass nits.
describe("final-pass nits", () => {
  it("a note over the reference's 16 MiB input limit reports size.over-budget instead of crashing", async () => {
    const r = await kl(["handoff", "check", file(note({ extra: "x".repeat(17 * 1024 * 1024) }))], {});
    expect(r.code).toBe(1); expect(r.err).toMatch(/^size\.over-budget/m); expect(r.err).not.toMatch(/Error|\n\s+at /);
  });
  it("a heading inside an HTML comment is not a section, and a section holding only a comment is empty", () => {
    const hidden = checkHandoff(note({ drop: "Goal", extra: "<!--\n## Goal\nhidden\n-->" }));
    expect(hidden.problems.map((p) => p.code)).toContain("section.missing:Goal");
    const onlyComment = checkHandoff(note().replace("Synthetic goal text .", "<!-- to do -->"));
    expect(onlyComment.problems.map((p) => p.code)).toContain("section.empty:Goal");
    const inline = checkHandoff(note({ extra: "Text <!-- a note --> after, and `<!--` in code." }));
    expect(inline.problems).toEqual([]);
  });
  it("loadGuardRules returns null for a missing or unreadable reference, and the rules for the real one", async () => {
    const { loadGuardRules } = await import("../cli/kl/src/handoff.ts");
    expect(loadGuardRules(new URL("file:///nonexistent/deny.template.json"))).toBeNull();
    const bad = join(dir, "bad-reference.json"); writeFileSync(bad, "{ not json");
    expect(loadGuardRules(pathToFileURL(bad))).toBeNull();
    const real = loadGuardRules(new URL("../policy/deny.template.json", import.meta.url));
    expect(real?.contentPatterns.length).toBeGreaterThan(2);
  });
});
