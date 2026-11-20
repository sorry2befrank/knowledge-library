// S2d item 1: the three required tests (ignore files, incomplete roots, Obsidian state), each with its positive control.
import { describe, it, expect } from "vitest";
import { MemoryInventorySource } from "@kl/core";
import { seedTree, inventory, refsTo, filePaths, refKeys, VAULT, ORRERY } from "./helpers/s2d-tree.ts";

describe("ignore files never hide anything", () => {
  it("with .ignore, .rgignore, .gitignore and .kopiaignore at the root and in a subfolder, the file set and the reference set equal the plain tree's", async () => {
    const plain = await inventory(seedTree());
    const src = seedTree();
    const ignores = [".ignore", ".rgignore", ".gitignore", ".kopiaignore"];
    for (const dir of [VAULT, `${VAULT}/desk`]) for (const name of ignores) src.seedFile(`${dir}/${name}`, "*\nalpha.md\nkappa.md\n");
    const r = await inventory(src);
    const ignoreFiles = new Set([VAULT, `${VAULT}/desk`].flatMap((d) => ignores.map((n) => `${d}/${n}`)));
    expect(filePaths(r).filter((p) => !ignoreFiles.has(p))).toEqual(filePaths(plain));
    expect(refKeys(r).filter((k) => ![...ignoreFiles].some((f) => k.startsWith(f + "|")))).toEqual(refKeys(plain));
    expect(refsTo(r, `${VAULT}/desk/alpha.md`).length).toBe(refsTo(plain, `${VAULT}/desk/alpha.md`).length);
    expect(r.candidates.map((c) => c.path)).toEqual(plain.candidates.map((c) => c.path));
    // positive control: a declared exclusion really does remove a file, and says so
    expect(filePaths(r).some((p) => p.startsWith(`${VAULT}/node_modules/`))).toBe(false);
    expect(r.generation.declaredExclusions).toContainEqual({ root: "vault", path: `${VAULT}/node_modules`, reason: "node_modules" });
    expect(plain.files.length).toBeGreaterThan(20);
  });
});

describe("incomplete roots protect", () => {
  it("one unreadable file in one root makes the generation incomplete, names that root, and marks every candidate coverage-incomplete", async () => {
    const src = seedTree();
    src.setReadError(`${ORRERY}/lib/armillary/ripple-rot.ts`, "in-use");
    const r = await inventory(src);
    expect(r.generation.complete).toBe(false);
    expect(r.generation.incompleteRoots).toEqual(["orrery"]);
    expect(r.generation.readErrors).toEqual([{ root: "orrery", path: `${ORRERY}/lib/armillary/ripple-rot.ts`, code: "in-use" }]);
    expect(r.generation.roots.find((x) => x.id === "vault")!.complete).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(5);
    expect(r.candidates.every((c) => c.coverage === "coverage-incomplete")).toBe(true);
    // positive control: with the file readable, the generation is complete and every candidate is complete
    src.setReadError(`${ORRERY}/lib/armillary/ripple-rot.ts`, null);
    const ok = await inventory(src);
    expect(ok.generation.complete).toBe(true); expect(ok.generation.incompleteRoots).toEqual([]); expect(ok.generation.readErrors).toEqual([]);
    expect(ok.candidates.every((c) => c.coverage === "complete")).toBe(true);
    // an unlistable directory and an unreadable stat are read errors too
    const src2 = seedTree().setUnlistable(`${VAULT}/kept`);
    const r2 = await inventory(src2);
    expect(r2.generation.incompleteRoots).toEqual(["vault"]); expect(r2.generation.readErrors[0]).toMatchObject({ root: "vault", path: `${VAULT}/kept`, code: "unreadable" });
  });
});

describe("Obsidian state", () => {
  it("a note open in a tab, one in lastOpenFiles, a bookmarked note and a note on a canvas each appear as references; an unreferenced note does not", async () => {
    const r = await inventory(seedTree());
    const ws = `${VAULT}/.obsidian/workspace.json`, bm = `${VAULT}/.obsidian/bookmarks.json`;
    expect(refsTo(r, `${VAULT}/desk/epsilon.md`).map((x) => `${x.source}|${x.kind}|${x.detail}`)).toEqual([`${ws}|obsidian|open-leaf`]);
    expect(refsTo(r, `${VAULT}/desk/zeta.md`).map((x) => `${x.source}|${x.kind}|${x.detail}`)).toEqual([`${ws}|obsidian|last-open`]);
    expect(refsTo(r, `${VAULT}/desk/eta.md`).map((x) => `${x.source}|${x.kind}|${x.detail}`)).toEqual([`${bm}|obsidian|bookmark`]); // the duplicate bookmark collapses
    expect(refsTo(r, `${VAULT}/desk/theta.md`).map((x) => `${x.source}|${x.kind}`).sort()).toEqual([`${VAULT}/boards/overview.canvas|canvas`, `${VAULT}/kept/index.md|name`]);
    expect(refsTo(r, `${VAULT}/desk/nu.md`).map((x) => `${x.source}|${x.kind}`)).toEqual([`${VAULT}/boards/table.base|base`]);
    // positive control: a note nothing references has no inbound reference at all
    expect(refsTo(r, `${VAULT}/desk/iota.md`)).toEqual([]);
    // a lastOpenFiles entry naming a file that does not exist protects nothing
    expect(r.references.some((x) => x.token === "desk/missing.md")).toBe(false);
    // a plain .obsidian file that is not state is not read
    expect(r.files.some((f) => f.path === `${VAULT}/.obsidian/app.json`)).toBe(false);
    expect(new MemoryInventorySource().implementation).toBe("memory");
  });
});
