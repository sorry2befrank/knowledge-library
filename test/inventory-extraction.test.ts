// S2d item 1: coverage sets and extraction (DESIGN §6.3). Each assertion was watched failing under a named mutation (turnover).
import { describe, it, expect } from "vitest";
import { MemoryInventorySource, rippleToken, isHistorical } from "@kl/core";
import { seedTree, inventory, refsTo, refsFrom, VAULT, ORRERY, POLICY } from "./helpers/s2d-tree.ts";

describe("coverage sets", () => {
  it("classifies every file into the five sets, skips declared exclusions and session transcripts, and reads only through list()", async () => {
    const src = seedTree();
    const r = await inventory(src);
    const sets = (p: string) => r.files.find((f) => f.path === p)?.sets;
    expect(sets(`${VAULT}/desk/alpha.md`)).toEqual(["vault", "fleet"]);
    expect(sets(`${VAULT}/.obsidian/workspace.json`)).toEqual(["obsidian"]);
    expect(sets(`${VAULT}/.obsidian/app.json`)).toBeUndefined(); // only workspace.json and bookmarks.json are Obsidian state
    expect(sets(`${VAULT}/boards/overview.canvas`)).toEqual(["obsidian"]);
    expect(sets(`${VAULT}/boards/table.base`)).toEqual(["obsidian"]);
    expect(sets(`${VAULT}/tools/build.mjs`)).toEqual(["fleet", "dependency"]);
    expect(sets(`${VAULT}/.claude/skills/review/SKILL.md`)).toEqual(["instruction"]);
    expect(sets(`${ORRERY}/lib/armillary/ripple-rot.ts`)).toEqual(["fleet", "dependency"]);
    expect(sets(`${ORRERY}/_UNDERSTUDY/turnover/old.md`)).toEqual(["fleet"]);
    expect(r.files.find((f) => f.path === `${ORRERY}/_UNDERSTUDY/turnover/old.md`)!.historical).toBe(true);
    expect(r.files.some((f) => f.path.includes("/node_modules/"))).toBe(false);
    expect(r.files.some((f) => f.path.endsWith(".jsonl"))).toBe(false);
    expect(r.files.some((f) => f.path.endsWith("/ARCHIVED.md"))).toBe(false);
    expect(sets(`${ORRERY}/dist/bundle.js`)).toEqual(["dependency"]); // the pinned detector ignores dist, so it is not a fleet file; it is still a code file
    const reasons = Object.fromEntries(r.generation.declaredExclusions.map((e) => [e.path, e.reason]));
    expect(reasons[`${VAULT}/node_modules`]).toBe("node_modules");
    expect(reasons[`${VAULT}/.git`]).toBe("git");
    expect(reasons[`${VAULT}/.codex/sessions`]).toBe("session-transcript");
    expect(reasons[`${VAULT}/desk/ARCHIVED.md`]).toBe("archived-md");
    expect(reasons[`${ORRERY}/dist/bundle.js`]).toBe("fleet-ignore-dir");
    expect(r.generation.complete).toBe(true);
    expect(r.generation.flags).toEqual([]);
    expect(r.generation.mode).toBe("full"); expect(r.generation.lastFullReadAt).toBe(r.generation.finishedAt);
    expect(r.generation.filesRead).toBe(r.files.filter((f) => f.read === "read").length);
    expect(r.generation.bytesRead).toBeGreaterThan(0);
    expect(r.generation.roots.map((x) => `${x.id}:${x.complete}`)).toEqual(["vault:true", "orrery:true"]);
    expect(src.reads).toBe(r.generation.filesRead); // every read went through readShared, none through a path list
  });
  it("records fleet-exclusions-unpinned and treats every readable non-dot file up to 512 KiB as a fleet file when the detector values are absent", async () => {
    const src = seedTree().seedFile(`${ORRERY}/big.txt`, "x", { size: 512 * 1024 + 1 }).seedFile(`${ORRERY}/notes.bin`, "desk/kappa.md in a binary-looking file");
    const r = await inventory(src, { policy: { ...POLICY, fleet: null } });
    expect(r.generation.flags).toEqual(["fleet-exclusions-unpinned"]);
    expect(r.files.find((f) => f.path === `${ORRERY}/notes.bin`)?.sets).toEqual(["fleet"]); // not narrowed to a guessed extension set
    expect(r.files.find((f) => f.path === `${ORRERY}/dist/bundle.js`)?.sets).toEqual(["fleet", "dependency"]); // no guessed ignore dirs either
    expect(r.files.some((f) => f.path === `${ORRERY}/big.txt`)).toBe(false); // above the detector's 512 KiB limit: not a fleet file
    expect(refsTo(r, `${VAULT}/desk/kappa.md`).some((x) => x.source === `${ORRERY}/notes.bin` && x.kind === "ripple")).toBe(true);
    expect(r.generation.complete).toBe(true);
  });
  it("lists oversize vault files instead of reading them, and that makes the generation incomplete", async () => {
    const src = seedTree().seedFile(`${VAULT}/desk/huge.md`, "x", { size: 64 * 1024 * 1024 + 1 });
    const r = await inventory(src);
    expect(r.generation.oversizeListed).toEqual([{ root: "vault", path: `${VAULT}/desk/huge.md`, size: 64 * 1024 * 1024 + 1 }]);
    expect(r.files.find((f) => f.path === `${VAULT}/desk/huge.md`)?.read).toBe("oversize");
    expect(r.generation.complete).toBe(false); expect(r.generation.incompleteRoots).toEqual(["vault"]);
  });
});

describe("extraction", () => {
  it("links: a wikilink resolves by Obsidian name rules; a name shared by two files is ambiguous with both candidates", async () => {
    const r = await inventory(seedTree());
    expect(refsTo(r, `${VAULT}/desk/gamma.md`).map((x) => `${x.source}|${x.kind}`)).toEqual([`${VAULT}/desk/beta.md|link`]);
    const amb = refsFrom(r, `${VAULT}/kept/index.md`).find((x) => x.kind === "ambiguous" && x.token === "plan")!;
    expect(amb).toBeDefined(); expect(amb.target).toBeNull(); expect(amb.candidates).toEqual([`${VAULT}/archive/plan.md`, `${VAULT}/desk/plan.md`]);
    expect(refsFrom(r, `${VAULT}/kept/index.md`).some((x) => x.kind === "link" && x.target === `${VAULT}/desk/beta.md`)).toBe(true);
  });
  it("explicit path mentions resolve the four ways (absolute with either slash, file:///, relative to the file, the target folder and the vault root) and a dead path with a known basename is ambiguous", async () => {
    const src = seedTree();
    src.seedFile(`${VAULT}/kept/paths.md`, ["desk/delta.md", "X:/synthetic-vault/desk/delta.md", "x:\\SYNTHETIC-VAULT\\desk\\DELTA.md", "/x/synthetic-vault/desk/delta.md", "file:///X:/synthetic-vault/desk/delta.md", "file:///X:/synthetic-vault/desk/delta%2Emd", "./../desk/delta.md", "elsewhere/plan.md", "nowhere/nothing.md", "Y:/other-drive/desk/delta.md"].join("\n"));
    const r = await inventory(src);
    const from = refsFrom(r, `${VAULT}/kept/paths.md`);
    expect(from.filter((x) => x.kind === "path" && x.target === `${VAULT}/desk/delta.md`).map((x) => x.token).sort()).toEqual(["./../desk/delta.md", "/x/synthetic-vault/desk/delta.md", "X:/synthetic-vault/desk/delta.md", "desk/delta.md", "file:///X:/synthetic-vault/desk/delta%2Emd", "file:///X:/synthetic-vault/desk/delta.md", "x:\\SYNTHETIC-VAULT\\desk\\DELTA.md"].sort());
    const amb = from.find((x) => x.token === "elsewhere/plan.md")!;
    expect(amb).toBeDefined(); expect(amb.kind).toBe("ambiguous"); expect(amb.candidates).toEqual([`${VAULT}/archive/plan.md`, `${VAULT}/desk/plan.md`]);
    expect(from.some((x) => x.token === "nowhere/nothing.md")).toBe(false); // no file of that name anywhere: nothing to protect
    const other = from.find((x) => x.token.startsWith("Y:/"))!; // an absolute path under no known root resolves to no file, but its last component is a candidate's basename: ambiguous, and it protects
    expect(other.kind).toBe("ambiguous"); expect(other.target).toBeNull(); expect(other.candidates).toEqual([`${VAULT}/desk/delta.md`]);
    // relative to the target folder: a bare "delta.md" written from a file outside the desk still resolves through the target folder
    src.seedFile(`${VAULT}/kept/target-rel.md`, "see sub/../delta.md");
    const r2 = await inventory(src);
    expect(refsFrom(r2, `${VAULT}/kept/target-rel.md`).some((x) => x.kind === "path" && x.target === `${VAULT}/desk/delta.md`)).toBe(true);
  });
  it("name mentions: a bare name.md or stem as a whole token counts, common stems never do, and the file never mentions itself", async () => {
    const src = seedTree().seedFile(`${VAULT}/desk/todo.md`, "# Todo\nA note whose stem is a common stem.").seedFile(`${VAULT}/kept/mentions.md`, "The todo is pending; theta too; and theta.md once more.");
    const r = await inventory(src);
    const mentions = refsFrom(r, `${VAULT}/kept/mentions.md`);
    expect(mentions.filter((x) => x.kind === "name").map((x) => x.target).sort()).toEqual([`${VAULT}/desk/theta.md`, `${VAULT}/desk/theta.md`]); // the stem and the name.md form; never todo (a common stem)
    expect(mentions.some((x) => x.target === `${VAULT}/desk/todo.md`)).toBe(false);
    const kept = refsFrom(r, `${VAULT}/kept/index.md`);
    expect(kept.some((x) => x.kind === "name" && x.target === `${VAULT}/desk/theta.md`)).toBe(true);
    expect(kept.some((x) => x.target === `${VAULT}/kept/index.md`)).toBe(false); // "index" is a common stem and its own name
    expect(r.references.some((x) => x.kind === "name" && x.source === x.target)).toBe(false);
    expect(r.references.some((x) => x.kind === "name" && x.target === `${VAULT}/desk/alpha.md`)).toBe(false); // nothing names alpha
  });
  it("ripple tokens: a fleet file containing a candidate's last-two-component token, or a path ending in /basename, references it; historical sources are flagged, not skipped", async () => {
    const r = await inventory(seedTree());
    expect(rippleToken("/vault/desk/kappa.md")).toBe("desk/kappa.md"); expect(rippleToken("/v/a/b.md")).toBe("a/b.md"); expect(rippleToken("/v/xx/yy")).toBe("xx/yy"); expect(rippleToken("/v/x/y")).toBe("y"); // under 5 characters: the basename
    expect(refsTo(r, `${VAULT}/desk/kappa.md`).map((x) => `${x.source}|${x.kind}`).sort()).toEqual([`${ORRERY}/lib/armillary/ripple-rot.ts|dependency`, `${ORRERY}/lib/armillary/ripple-rot.ts|ripple`]); // a code file in the fleet is both
    const hist = refsTo(r, `${VAULT}/desk/alpha.md`).find((x) => x.source === `${ORRERY}/_UNDERSTUDY/turnover/old.md`);
    expect(hist?.kind).toBe("ripple"); expect(r.files.find((f) => f.path === hist!.source)!.historical).toBe(true);
    expect(isHistorical("/x/notes-passdown.md")).toBe(true); expect(isHistorical("/x/desk/alpha.md")).toBe(false); expect(isHistorical("/x/Accepted/y.md")).toBe(true);
  });
  it("code, config and instruction references, including injected scheduled-task command lines", async () => {
    const r = await inventory(seedTree(), { scheduledTaskCommandLines: ["powershell -File X:\\synthetic-vault\\desk\\alpha.md", "cmd /c echo iota.md"] });
    expect(refsTo(r, `${VAULT}/desk/lambda.md`).map((x) => `${x.source}|${x.kind}`)).toEqual([`${VAULT}/tools/build.mjs|dependency`]);
    expect(refsTo(r, `${VAULT}/desk/mu.md`).map((x) => `${x.source}|${x.kind}`).sort()).toEqual([`${VAULT}/.claude/skills/review/SKILL.md|instruction`, `${VAULT}/tools/build.mjs|dependency`, `${VAULT}/tools/build.mjs|ripple`]); // build.mjs is a fleet file too, and it contains desk/mu.md
    expect(refsTo(r, `${VAULT}/desk/alpha.md`).some((x) => x.source === "task:0" && x.kind === "instruction")).toBe(true);
    expect(refsTo(r, `${VAULT}/desk/iota.md`).map((x) => `${x.source}|${x.kind}`)).toEqual(["task:1|instruction"]);
  });
  it("an incremental read re-extracts only files whose identity, size, mtime or ChangeTime moved, and keeps the last full read time", async () => {
    const src = seedTree().seedFile(`${VAULT}/desk/quiet.md`, "# Quiet\nSame-size edit caught only by ChangeTime: [[beta]]", { identity: { volumeSerial: "SYNTH-VOL", fileId: "quiet-01" } });
    const full = await inventory(src);
    src.seedFile(`${VAULT}/desk/beta.md`, "# Beta\nNow links [[delta]] instead.", { times: { changed: "2026-10-06T13:00:00.000Z" } });
    // the same identity, size and mtime: only ChangeTime moved
    src.seedFile(`${VAULT}/desk/quiet.md`, "# Quiet\nSame-size edit caught only by ChangeTime: [[iota]]", { identity: { volumeSerial: "SYNTH-VOL", fileId: "quiet-01" }, times: { changed: "2026-10-06T13:00:00.000Z" } });
    const reads = src.reads;
    const inc = await inventory(src, { mode: "incremental", now: "2026-10-06T14:00:00.000Z", previous: full });
    expect(src.reads - reads).toBe(2); // only the two moved files
    expect(inc.generation.mode).toBe("incremental"); expect(inc.generation.lastFullReadAt).toBe(full.generation.lastFullReadAt);
    expect(refsFrom(inc, `${VAULT}/desk/beta.md`).map((x) => x.target)).toEqual([`${VAULT}/desk/delta.md`]);
    expect(refsFrom(inc, `${VAULT}/desk/quiet.md`).map((x) => x.target)).toEqual([`${VAULT}/desk/iota.md`]);
    expect(refsFrom(inc, `${VAULT}/kept/index.md`).length).toBe(refsFrom(full, `${VAULT}/kept/index.md`).length); // reused
    // an unknown ChangeTime is not "unchanged": the file is re-read and the generation says so
    src.seedFile(`${VAULT}/desk/alpha.md`, "# Alpha\nStandalone candidate with no inbound references.", { times: { changed: null } });
    const inc2 = await inventory(src, { mode: "incremental", now: "2026-10-06T15:00:00.000Z", previous: inc });
    expect(inc2.generation.flags).toContain("change-time-unknown");
    expect(src.reads - reads).toBeGreaterThan(2);
  });
});
