// Remaining reference-pack integrations (DESIGN section 12.1). Published inputs alone do not close a skip.
// Admission coverage now runs in reference-policy.test.ts (all 35 published cases, 41 public generic
// segments and base-before-extension precedence), reference-admission.test.ts (signed construction and
// real guard/Catalog boundaries), reference-ledgers.test.ts and reference-routes.test.ts (all five routes).
// Those synthetic tests do not install a private policy or authorize real-data admission.
// Scoring, source attribution, manifest adaptation and report projection now have working
// reference-scorer, reference-provenance and reference-learning regression suites.
// Correction parsing/projection exists, but its persistent authenticated ledger, supersession,
// confirmation receipts and access-filtered entry point remain an explicit integration hold.
import { describe, it, type TestContext } from "vitest";
import { existsSync } from "node:fs";

export const PACK = { deny: "policy/deny.template.json", perishability: "vendor/perishability.ts", mapping: "docs/reference/manifest-mapping.md", corrections: "docs/reference/corrections.md", reports: "docs/reference/reports-and-turnover.md", fixtures: "fixtures/reference/policy.cases.json", provenance: "docs/reference/provenance.json" };
export const skipReason = (p: string) => (existsSync(p) ? "pack published; S2 implements" : "pack-pending");
const pending = (p: string) => (name: string, _impl: () => void) => it(name, (ctx: TestContext) => { ctx.skip(skipReason(p)); });

describe("pack-pending", () => {
  pending(PACK.corrections)("pack-pending: persistent authenticated correction ledger and receipt-bound accessible projections", () => {
    throw new Error("pure reference adapters do not implement durable correction authority");
  });
});
