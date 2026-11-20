// Lint: mutating SQL (INSERT/UPDATE/DELETE/REPLACE) is allowed only in the files that implement the one
// write path (DESIGN §2.1 principle 4). catalog.ts may touch only the usage/meta tables listed below.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findMutations } from "./lib/mutating-sql.ts";

const ROOTS = ["packages", "apps", "cli"];
const ALLOW: Record<string, RegExp | null> = {
  "packages/core/src/catalog/durability.ts": /^(meta|\$\{table\})$/, // explicit virgin scratch recovery only; schema/column allowlist and locked hashes checked before import
  "apps/api/src/cloudflare/recovery-rehearsal.ts": /^(meta|\$\{t\})$/, // separately packaged staging-only signed synthetic rehearsal; exact retained inventory, sealed revocation, fixed schema clear
  "cli/kl/src/archive/journal.ts": /^(archive_runs|archive_steps|archive_versions)$/i, // device-local upload journal only; never catalog state
  "packages/core/src/focus/admission-journal.ts": /^(admission_state|admission_events)$/i, // dedicated global-admission journal only; no catalog tables
  "packages/core/src/catalog/apply.ts": null,                        // the write path
  "packages/core/src/catalog/ledger.ts": /\b(events|values_)\b/,     // appendEvent/putValue: refuse outside apply()'s transaction
  "packages/core/src/catalog/outbox.ts": /\boutbox\b/,               // step completion only
  "packages/core/src/catalog/search-index.ts": /^(chunks|fts_\w*|\$\{table\})$/i, // projection step (chunks and the per-class FTS tables)
  "packages/core/src/catalog/schema.ts": /\bmeta\b/,                 // DDL + meta init
  "packages/core/src/catalog/catalog.ts": /\b(query_log|reads|audit|meta)\b/i, // usage/audit tables and setup flag
  "apps/api/src/handler.ts": /\b(multipart_pushes)\b/i, // upload-session bookkeeping, no catalog state
  "packages/core/src/inventory/store.ts": /^ref_\w+$/, // local refs.sqlite only (DESIGN §6.3); never catalog tables
};
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}

let violations = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = file.replace(/\\/g, "/");
    for (const { verb, table } of findMutations(readFileSync(file, "utf8"))) {
      if (!(rel in ALLOW)) { console.error(`${rel}: mutating SQL (${verb} ${table}) outside apply()`); violations++; continue; }
      const allowed = ALLOW[rel];
      if (allowed && !allowed.test(table)) { console.error(`${rel}: ${verb} ${table} is not in this file's allowance`); violations++; }
    }
  }
}
if (violations) { console.error(`lint-mutating-sql: ${violations} violation(s)`); process.exit(1); }
console.log("lint-mutating-sql: ok");
