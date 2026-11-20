// Lint (DESIGN §8.1 Library-side tripwire, repo half): under persona/ only the manifest, NORTHSTAR.md,
// DIRECTIVE.md and build-turnovers/YYYY-MM-DD-<slug>.md are allowed. Anything else is a hard failure.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ALLOWED = [/^persona\/understudy\.librarian\.frank-epps\.manifest\.json$/, /^persona\/NORTHSTAR\.md$/, /^persona\/DIRECTIVE\.md$/, /^persona\/build-turnovers\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.md$/];
function walk(dir: string, out: string[] = []): string[] { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else out.push(p.replace(/\\/g, "/")); } return out; }
const bad = walk("persona").filter((p) => !ALLOWED.some((re) => re.test(p)));
if (bad.length) { for (const b of bad) console.error(`persona/: path not allowed: ${b}`); process.exit(1); }
console.log("lint-persona: ok");
