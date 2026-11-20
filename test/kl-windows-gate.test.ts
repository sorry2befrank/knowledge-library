// S2e item C: the conformance gate's rules, exercised on Linux with synthetic vitest reports (the real report comes from the Windows job).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gate } from "./fs-windows-gate.ts";

const HASH = "a".repeat(64);
const tag = (id: string, platform = "win32", impl = "windows-native", hash = HASH) => `fs contract (windows-native) ${id} something ${platform === "win32" ? "native" : "else"} [${platform}:${impl}:${hash}]`;
const passed = (id: string, extra: Partial<{ platform: string; impl: string; hash: string }> = {}) => ({ fullName: tag(id, extra.platform, extra.impl, extra.hash), status: "passed" });
const heldFail = (id: string, reason: string) => ({ fullName: tag(id), status: "failed", failureMessages: [`Error: held:${reason}\n at x`] });
const report = (assertions: { fullName: string; status: string; failureMessages?: string[] }[], counts: Partial<{ numPendingTests: number; numTodoTests: number }> = {}) => ({ numPendingTests: 0, numTodoTests: 0, numFailedTests: assertions.filter((a) => a.status === "failed").length, testResults: [{ name: "x", assertionResults: assertions }], ...counts });
const manifest = (ids: Record<string, { status: "established" | "held" | "differs"; reason?: string }>) => ({ ids: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, { property: k, ...v }])) });

describe("fs-windows-gate", () => {
  it("passes when every manifest id is established by a passing win32 windows-native test with the built helper's hash, or held with a reason and a held: failure or no test", () => {
    const r = gate(report([passed("N01"), heldFail("N10R", "no ReFS volume"), passed("P01")]), manifest({ N01: { status: "established" }, N10R: { status: "held", reason: "no ReFS volume in the job" }, P06: { status: "held", reason: "later" }, P01: { status: "established" } }), {}, HASH);
    expect(r.problems).toEqual([]); expect(r.ok).toBe(true);
    expect(r.established).toEqual(["N01", "P01"]); expect(r.held).toEqual({ N10R: "no ReFS volume in the job", P06: "later" });
  });
  it("fails on a non-win32 platform, a non-native implementation, a foreign helper hash, a missing helper, an unlisted test, or no native test at all", () => {
    expect(gate(report([passed("N01", { platform: "linux" })]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N01: platform linux, not win32");
    expect(gate(report([passed("N01", { impl: "memory-model" })]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N01: implementation memory-model, not windows-native");
    expect(gate(report([passed("N01", { hash: "b".repeat(64) })]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual(`N01: helper hash ${"b".repeat(64)} is not the built helper's ${HASH}`);
    expect(gate(report([passed("N01", { hash: "missing" })]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N01: no helper executable was hashed");
    expect(gate(report([passed("N01"), passed("N99")]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N99: not in the manifest");
    expect(gate(report([]), manifest({ P06: { status: "held", reason: "later" } }), {}, HASH).problems).toContainEqual("no native test ran (no tagged test in the report)");
  });
  it("fails when an established id did not run or did not pass, when a held id's test passed (stale manifest) or failed for another reason, when a held id has no reason, and when anything was skipped", () => {
    expect(gate(report([]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N01: manifest says established but no test ran");
    expect(gate(report([heldFail("N01", "no volume")]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("N01: manifest says established but the test was held (no volume)");
    expect(gate(report([{ fullName: tag("N01"), status: "failed", failureMessages: ["AssertionError: expected 'in-use' to be 'reparse'"] }]), manifest({ N01: { status: "established" } }), {}, HASH).problems[0]).toMatch(/N01: manifest says established but the test did not pass \(failed: AssertionError/);
    expect(gate(report([passed("N10R")]), manifest({ N10R: { status: "held", reason: "x" } }), {}, HASH).problems).toContainEqual("N10R: manifest says held but the test established it; update the manifest");
    expect(gate(report([{ fullName: tag("N10R"), status: "failed", failureMessages: ["TypeError: boom"] }]), manifest({ N10R: { status: "held", reason: "x" } }), {}, HASH).problems[0]).toMatch(/N10R: manifest says held but the test failed for another reason: TypeError: boom/);
    expect(gate(report([heldFail("N10R", "x")]), manifest({ N10R: { status: "held" } }), {}, HASH).problems).toContainEqual("N10R: held without a reason");
    expect(gate(report([passed("N01"), { fullName: "unrelated skipped test", status: "skipped" }]), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("skipped/pending/todo tests in the run: 0/0/1");
    expect(gate(report([passed("N01")], { numTodoTests: 1 }), manifest({ N01: { status: "established" } }), {}, HASH).problems).toContainEqual("skipped/pending/todo tests in the run: 0/1/0");
  });
  it("a declared difference is reported as differs and can never be established", () => {
    const diffs = { FS27: { difference: "case folding differs for one range" } };
    expect(gate(report([passed("FS27")]), manifest({ FS27: { status: "established" } }), diffs, HASH).problems).toContainEqual("FS27: a declared difference cannot be established");
    const r = gate(report([{ fullName: tag("FS27"), status: "failed", failureMessages: ["AssertionError: x"] }]), manifest({ FS27: { status: "differs" } }), diffs, HASH);
    expect(r.ok).toBe(true); expect(r.differs).toEqual({ FS27: "case folding differs for one range" });
    expect(gate(report([passed("FS27")]), manifest({ FS27: { status: "differs" } }), {}, HASH).problems).toContainEqual("FS27: manifest says differs but test/fs-windows-differences.json has no entry");
  });
  it("the committed manifest lists every native, DPAPI, §12.2 and contract id the Windows files tag, and every held entry has a reason", () => {
    const m = JSON.parse(readFileSync("test/fs-windows-manifest.json", "utf8")) as { ids: Record<string, { status: string; reason?: string }> };
    const sources = ["test/fs-windows-native.test.ts", "test/fs-windows-dpapi.test.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    const ids = new Set([...sources.matchAll(/(?:withHarness|test)\(\s*[`"]([A-Z]+\d+[A-Z]?)\b/g)].map((x) => x[1]!));
    for (const [id, kind] of [["N10R", "ReFS"], ["N10N", "network"], ["N10S", "removable with a changed serial"]]) { void kind; ids.add(id!); }
    for (const id of ids) expect(m.ids[id], id).toBeDefined();
    for (const id of ["FS02", "FS03", "FS04", "FS06", "FS07", "FS09", "FS10", "FS11", "FS12", "FS14", "FS15", "FS16", "FS18", "FS19", "FS20", "FS21", "FS22", "FS23", "FS27", "FS30", "FS31", "FS32"]) expect(m.ids[id], id).toBeDefined();
    for (const [id, e] of Object.entries(m.ids)) if (e.status === "held") expect(e.reason, id).toBeTruthy();
  });
});
