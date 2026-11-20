// Build-session turnover writer (DESIGN §7.2). Takes a turnover/v1 document and renders Markdown.
// The structured document is the record; the Markdown is a view of it.
export interface TurnoverDoc {
  session: string; date: string; lane: "cloud" | "local"; branch: string; designRevision?: string; designStatusAtBuild?: "draft" | "final";
  built: string[]; exitEvidence: { check: string; result: "pass" | "fail" | "partial" | "pack-pending" | "not-run"; evidence?: string }[];
  decisions: { decision: string; why: string }[]; conflictsWithDesign: { where: string; conflict: string; chosen: string }[]; draftSectionsFollowed?: string[];
  packPending: { test: string; needs: string }[]; proposals?: string[]; gotchas?: string[]; learned?: string[];
  funding_source: "credit" | "purchased" | "plan" | "codex" | "unknown"; spend_usd: number | "unknown"; allocationRemainingUsd?: number | "unknown"; nextStep: string; remainingAsS1b?: string[];
}

export function renderTurnover(t: TurnoverDoc): string {
  const L: string[] = [];
  L.push(`# Turnover ${t.session} (${t.lane} lane), ${t.date}`, "", `Branch: \`${t.branch}\`. Design: ${t.designRevision ?? "n/a"} (${t.designStatusAtBuild ?? "unknown"} at build time).`, "");
  L.push("## What was built", "", ...t.built.map((b) => `- ${b}`), "");
  L.push("## Exit evidence", "", "| Check | Result | Evidence |", "|---|---|---|", ...t.exitEvidence.map((e) => `| ${e.check} | ${e.result} | ${e.evidence ?? ""} |`), "");
  L.push("## Decisions made and why", "", ...t.decisions.map((d) => `- **${d.decision}** ${d.why}`), "");
  L.push("## Conflicts with DESIGN.md", "", ...(t.conflictsWithDesign.length ? t.conflictsWithDesign.map((c) => `- **${c.where}:** ${c.conflict} Chosen: ${c.chosen}`) : ["- none"]), "");
  if (t.draftSectionsFollowed?.length) L.push("## Draft sections this code follows", "", ...t.draftSectionsFollowed.map((s) => `- ${s}`), "");
  L.push("## pack-pending tests", "", ...(t.packPending.length ? t.packPending.map((p) => `- \`${p.test}\` needs ${p.needs}`) : ["- none"]), "");
  if (t.proposals?.length) L.push("## Proposals for Frank (not applied)", "", ...t.proposals.map((p) => `- ${p}`), "");
  if (t.gotchas?.length) L.push("## Gotchas", "", ...t.gotchas.map((g) => `- ${g}`), "");
  if (t.learned?.length) L.push("## What the Understudy should learn", "", ...t.learned.map((g) => `- ${g}`), "");
  L.push("## Funding", "", `- funding_source: ${t.funding_source}`, `- spend_usd: ${t.spend_usd}`, `- allocation remaining: ${t.allocationRemainingUsd ?? "unknown"}`, "");
  L.push("## Exact next step", "", t.nextStep, "");
  if (t.remainingAsS1b?.length) L.push("## Remaining as S1b", "", ...t.remainingAsS1b.map((r) => `- ${r}`), "");
  return L.join("\n");
}
