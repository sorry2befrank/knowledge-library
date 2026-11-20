// A synthetic vault + fleet tree for the inventory tests (S2d item 1). Every path and name is fictional.
import { MemoryInventorySource, runInventory, type InventoryConfig, type InventoryResult, type InventoryPolicy } from "@kl/core";

export const VAULT = "/vault";
export const ORRERY = "/orrery";
export const NOW = "2026-10-06T12:00:00.000Z";

export const POLICY: InventoryPolicy = {
  codeTypes: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".ps1", ".sh", ".bat", ".cmd", ".json", ".yaml", ".yml", ".toml", ".ini"],
  commonStems: ["README", "STATUS", "notes", "index", "todo", "draft"],
  fleet: { textExt: [".md", ".txt", ".ts", ".mjs", ".js", ".json", ".yaml", ".yml"], ignoreDirs: ["node_modules", "dist", ".git"], maxBytes: 512 * 1024 },
  targetFolder: `${VAULT}/desk`,
};

export function config(overrides: Partial<InventoryConfig> = {}): InventoryConfig {
  return {
    roots: [{ id: "vault", path: VAULT, hostPaths: ["X:/synthetic-vault", "X:\\synthetic-vault"], sets: ["vault", "fleet"] }, { id: "orrery", path: ORRERY, hostPaths: ["X:/synthetic-orrery"], sets: ["fleet"] }],
    policy: POLICY, mode: "full", now: NOW, ...overrides,
  };
}

/** The standard tree: a desk folder with candidates, a kept note that links one of them, Obsidian state, an Orrery fleet file, a dependency file and instruction files. */
export function seedTree(src = new MemoryInventorySource()): MemoryInventorySource {
  src.seedFile(`${VAULT}/desk/alpha.md`, "# Alpha\nStandalone candidate with no inbound references.");
  src.seedFile(`${VAULT}/desk/beta.md`, "# Beta\nAnother candidate; see [[gamma]] for the plan.");
  src.seedFile(`${VAULT}/desk/gamma.md`, "# Gamma\nThe plan.");
  src.seedFile(`${VAULT}/desk/delta.md`, "# Delta\nMentioned by path from the kept note.");
  src.seedFile(`${VAULT}/desk/epsilon.md`, "# Epsilon\nOpen in an Obsidian tab.");
  src.seedFile(`${VAULT}/desk/zeta.md`, "# Zeta\nIn lastOpenFiles.");
  src.seedFile(`${VAULT}/desk/eta.md`, "# Eta\nBookmarked.");
  src.seedFile(`${VAULT}/desk/theta.md`, "# Theta\nOn a canvas.");
  src.seedFile(`${VAULT}/desk/iota.md`, "# Iota\nReferenced by nothing at all.");
  src.seedFile(`${VAULT}/desk/kappa.md`, "# Kappa\nMentioned from the fleet by its ripple token.");
  src.seedFile(`${VAULT}/desk/lambda.md`, "# Lambda\nNamed by a dependency file.");
  src.seedFile(`${VAULT}/desk/mu.md`, "# Mu\nNamed by an instruction file.");
  src.seedFile(`${VAULT}/desk/nu.md`, "# Nu\nIn a .base file.");
  src.seedFile(`${VAULT}/desk/plan.md`, "# Plan (desk)\nOne of two plans.");
  src.seedFile(`${VAULT}/archive/plan.md`, "# Plan (archive)\nThe other plan.");
  src.seedFile(`${VAULT}/kept/index.md`, "# Kept\nLinks: [[beta]], [[plan]] (ambiguous), path desk/delta.md, absolute X:\\synthetic-vault\\desk\\delta.md, file:///X:/synthetic-vault/desk/delta.md, bare name theta and README.");
  src.seedFile(`${VAULT}/desk/ARCHIVED.md`, "# Archived\nA generated view; never inventory.");
  src.seedFile(`${VAULT}/.obsidian/workspace.json`, JSON.stringify({ main: { children: [{ type: "leaf", state: { type: "markdown", state: { file: "desk/epsilon.md" } } }] }, lastOpenFiles: ["desk/zeta.md", "desk/missing.md"] }));
  src.seedFile(`${VAULT}/.obsidian/bookmarks.json`, JSON.stringify({ items: [{ type: "file", path: "desk/eta.md" }, { type: "group", items: [{ type: "file", path: "desk/eta.md" }] }] }));
  src.seedFile(`${VAULT}/.obsidian/app.json`, JSON.stringify({ readableLineLength: true }));
  src.seedFile(`${VAULT}/boards/overview.canvas`, JSON.stringify({ nodes: [{ id: "1", type: "file", file: "desk/theta.md" }, { id: "2", type: "text", text: "no file" }], edges: [] }));
  src.seedFile(`${VAULT}/boards/table.base`, "filters:\n  and:\n    - file.path == \"desk/nu.md\"\nviews:\n  - type: table\n");
  src.seedFile(`${VAULT}/tools/build.mjs`, "import x from './x.mjs';\n// depends on lambda.md and desk/mu.md is not ours\nconst note = 'lambda.md';\n");
  src.seedFile(`${VAULT}/.claude/skills/review/SKILL.md`, "# Review skill\nRead desk/mu.md before anything else.\n");
  src.seedFile(`${VAULT}/.codex/sessions/2026-10-06.jsonl`, "{\"transcript\":\"desk/alpha.md\"}\n");
  src.seedFile(`${VAULT}/node_modules/pkg/README.md`, "# pkg\nMentions desk/alpha.md but is a dependency tree.\n");
  src.seedFile(`${VAULT}/.git/HEAD`, "ref: refs/heads/main\n");
  src.seedFile(`${ORRERY}/lib/armillary/ripple-rot.ts`, "// synthetic\nconst refs = ['desk/kappa.md'];\nexport default refs;\n");
  src.seedFile(`${ORRERY}/_UNDERSTUDY/turnover/old.md`, "historical mention of desk/alpha.md\n");
  src.seedFile(`${ORRERY}/dist/bundle.js`, "desk/alpha.md in a build output\n");
  return src;
}

export async function inventory(src: MemoryInventorySource, overrides: Partial<InventoryConfig> = {}): Promise<InventoryResult> {
  return runInventory(src, config(overrides));
}

export const refsTo = (r: InventoryResult, target: string) => r.references.filter((x) => x.target === target);
export const refsFrom = (r: InventoryResult, source: string) => r.references.filter((x) => x.source === source);
export const filePaths = (r: InventoryResult) => r.files.map((f) => f.path).sort();
export const refKeys = (r: InventoryResult) => r.references.map((x) => `${x.source}|${x.kind}|${x.target ?? (x.candidates ?? []).join("+")}|${x.detail ?? ""}`).sort();
