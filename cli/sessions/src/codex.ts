// Codex rollout files, as openai/codex writes them (codex-rs at 9b39316). rollout/src/rollout_file_name.rs names a rollout
// rollout-<time>-<thread>[_<rollout>].jsonl, where the rollout id differs from the thread id after a revert, and recorder.rs
// takes <time> from the LOCAL clock. compression.rs replaces a rollout idle for 7 days with <name>.zst and deletes the plain
// file, leaving the database path on the plain name. The first line is the session_meta record; a fork names the thread its
// history depends on in payload.history_base.thread_id (paginated forks) or payload.forked_from_id.
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_NAME = new RegExp(`^rollout-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl(\\.zst)?$`, "i");
/** A Claude session id or a Codex thread id: a UUID, nothing that could name a path. */
export const SESSION_ID = new RegExp(`^${UUID}$`, "i");
const FIRST_LINE_MAX = 4 * 1024 * 1024;

export interface RolloutName { threadId: string; rolloutId: string; compressed: boolean; startedAt: number }
export function parseRolloutName(name: string): RolloutName | undefined {
  const m = ROLLOUT_NAME.exec(name);
  if (!m) return undefined;
  const startedAt = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
  return { threadId: m[7]!.toLowerCase(), rolloutId: (m[8] ?? m[7]!).toLowerCase(), compressed: !!m[9], startedAt };
}

/** The first line of a rollout, plain or zstd-compressed, at most 4 MiB; undefined when it cannot be read. */
export async function readFirstLine(path: string): Promise<string | undefined> {
  if (!path.endsWith(".zst")) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buf = Buffer.alloc(64 * 1024);
        const n = readSync(fd, buf, 0, buf.length, total);
        if (n === 0) break;
        const nl = buf.subarray(0, n).indexOf(0x0a);
        chunks.push(buf.subarray(0, nl >= 0 ? nl : n)); total += n;
        if (nl >= 0 || total >= FIRST_LINE_MAX) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0, done = false;
    const source = createReadStream(path), unzip = createZstdDecompress();
    const finish = (v: string | undefined) => { if (done) return; done = true; source.destroy(); unzip.destroy(); resolve(v); };
    source.on("error", () => finish(undefined));
    unzip.on("error", () => finish(undefined));
    unzip.on("data", (c: Buffer) => {
      const nl = c.indexOf(0x0a);
      chunks.push(nl >= 0 ? c.subarray(0, nl) : c); total += c.length;
      if (nl >= 0 || total >= FIRST_LINE_MAX) finish(Buffer.concat(chunks).toString("utf8"));
    });
    unzip.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    source.pipe(unzip);
  });
}

/** The threads a rollout's history depends on, from its first line; undefined when the line is not a session_meta record. */
export function lineageRefs(firstLine: string): string[] | undefined {
  let o: { type?: unknown; payload?: { history_base?: { thread_id?: unknown }; forked_from_id?: unknown } };
  try { o = JSON.parse(firstLine); } catch { return undefined; }
  if (!o || o.type !== "session_meta" || !o.payload) return undefined;
  return [o.payload.history_base?.thread_id, o.payload.forked_from_id].filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
}
