// CI entry: credential shapes over the whole tree and workstation paths outside docs/ (S1c E1). Fails closed on a git error.
import { scanTree } from "./lib/scan-secrets.ts";
const r = scanTree(process.cwd());
if (r.error) { console.error(`scan-secrets: ${r.error}`); process.exit(2); }
// Report locations, never the matching value (including binary payloads).
for (const h of r.hits) console.error(`${h.pattern}: ${/^(.+?:\d+):/.exec(h.line)?.[1] ?? "matching file"}`);
if (!r.ok) { console.error(`scan-secrets: ${r.hits.length} credential-shaped string(s) or workstation path(s) found`); process.exit(1); }
console.log("scan-secrets: ok");
