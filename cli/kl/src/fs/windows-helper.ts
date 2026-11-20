// Bounded JSON requests/replies, correlated by id. Channel failure has unknown effects;
// logical invalidation is not proof of native process exit.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type HelperReply = { ok: true; value: unknown } | { ok: false; code: string; effect: "none" | "unknown" };

const REQUEST_MS = 30_000;
const STOP_GRACE_MS = 2_000;
const STOP_MS = 4_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_PENDING = 64;
const MAX_RETIRED = 4;
const unknown = (): HelperReply => ({ ok: false, code: "closed-handle", effect: "unknown" });
type Pending = { resolve: (reply: HelperReply) => void; timer: ReturnType<typeof setTimeout> };
type Generation = {
  child: ChildProcess;
  retired: boolean;
  terminal: boolean;
  notified: boolean;
  pending: Map<number, Pending>;
  parts: Buffer[];
  bytes: number;
  terminalListeners: Set<() => void>;
};

/** Where the helper is: KL_FS_HELPER, else the Release build next to this checkout. */
export function helperPath(env: Record<string, string | undefined> = process.env): string {
  if (env.KL_FS_HELPER) return env.KL_FS_HELPER;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "kl-fs", "bin", "Release", "net8.0", "kl-fs.exe");
}

export class HelperClient {
  readonly exe: string;
  #current: Generation | null = null;
  // Retained until exit/close, including after error, reset, timeout, or a failed kill.
  #retired = new Set<Generation>();
  #next = 1;
  #onExit: (() => void)[] = [];
  #stopping = false;
  #stopPromise: Promise<void> | null = null;

  constructor(exe: string) { this.exe = exe; }

  /** Channel usability; false does not establish native process absence. */
  get alive(): boolean { return this.#current !== null && !this.#current.retired && !this.#stopping; }
  get pid(): number | undefined { return this.#current?.child.pid; }
  /** Once per current generation when its handle authority is invalidated, possibly before native exit. */
  onExit(fn: () => void): void { this.#onExit.push(fn); }

  #kill(g: Generation): void {
    if (g.terminal) return;
    try { g.child.kill("SIGKILL"); } catch { /* No absence claim: keep this generation tracked. */ }
  }

  #invalidate(g: Generation, kill = true): void {
    if (g.retired) return;
    g.retired = true;
    if (!g.terminal) this.#retired.add(g);
    g.parts = []; g.bytes = 0;
    const pending = [...g.pending.values()];
    g.pending.clear();
    for (const p of pending) { clearTimeout(p.timer); p.resolve(unknown()); }
    if (kill) this.#kill(g);
    // WindowsFs.reset() may detach this generation from inside a callback.
    if (!g.notified && this.#current === g) {
      g.notified = true;
      for (const fn of [...this.#onExit]) {
        try { fn(); } catch { /* One observer cannot prevent invalidation of the others. */ }
      }
    }
  }

  #terminal(g: Generation): void {
    if (g.terminal) return;
    g.terminal = true;
    this.#invalidate(g, false);
    this.#retired.delete(g);
    for (const stream of [g.child.stdin, g.child.stdout, g.child.stderr]) stream?.destroy();
    for (const fn of [...g.terminalListeners]) fn();
    g.terminalListeners.clear();
  }

  #line(g: Generation, line: Buffer): void {
    if (g.retired) return;
    let msg: unknown;
    try { msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { this.#invalidate(g); return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) { this.#invalidate(g); return; }
    const m = msg as Record<string, unknown>;
    const success = m.ok === true && Object.hasOwn(m, "value") && !Object.hasOwn(m, "code") && !Object.hasOwn(m, "effect");
    const failure = m.ok === false && typeof m.code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(m.code) && (m.effect === "none" || m.effect === "unknown") && !Object.hasOwn(m, "value");
    const id = m.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1 || (!success && !failure)) { this.#invalidate(g); return; }
    const p = g.pending.get(id as number);
    // Duplicate, unsolicited, and wrong-generation replies cannot establish success.
    if (!p) { this.#invalidate(g); return; }
    g.pending.delete(id as number); clearTimeout(p.timer);
    p.resolve(success ? { ok: true, value: m.value } : { ok: false, code: m.code as string, effect: m.effect as "none" | "unknown" });
  }

  #data(g: Generation, chunk: Buffer): void {
    if (g.retired) return;
    let at = 0;
    while (at < chunk.length && !g.retired) {
      const newline = chunk.indexOf(10, at);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(at, end);
      if (g.bytes + part.length > MAX_LINE_BYTES) { this.#invalidate(g); return; }
      if (part.length) { g.parts.push(part); g.bytes += part.length; }
      if (newline < 0) return;
      const line = Buffer.concat(g.parts, g.bytes);
      g.parts = []; g.bytes = 0;
      this.#line(g, line);
      at = newline + 1;
    }
  }

  start(): void {
    if (this.#stopping) throw new Error("kl-fs helper is stopping");
    if (this.#current) return;
    if (this.#retired.size >= MAX_RETIRED) throw new Error("kl-fs helper cleanup is unconfirmed");
    if (!existsSync(this.exe)) throw new Error(`kl-fs helper not found at ${this.exe} (set KL_FS_HELPER or build cli/kl-fs)`);
    const child = spawn(this.exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const g: Generation = { child, retired: false, terminal: false, notified: false, pending: new Map(), parts: [], bytes: 0, terminalListeners: new Set() };
    this.#current = g;
    child.on("exit", () => this.#terminal(g));
    child.on("close", () => this.#terminal(g));
    child.on("error", () => this.#invalidate(g));
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => this.#invalidate(g));
    if (!child.stdin || !child.stdout || !child.stderr) { this.#invalidate(g); return; }
    child.stdout.on("data", (chunk: Buffer) => this.#data(g, chunk));
    child.stdout.on("end", () => this.#invalidate(g));
    child.stderr.on("data", () => { /* Drained diagnostics, never a result or a retained unbounded log. */ });
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<HelperReply> {
    if (this.#stopping) return Promise.resolve(unknown());
    try { if (!this.#current) this.start(); } catch { return Promise.resolve(unknown()); }
    const g = this.#current;
    if (!g || g.retired || !g.child.stdin?.writable) {
      if (g) this.#invalidate(g);
      return Promise.resolve(unknown());
    }
    if (g.pending.size >= MAX_PENDING || !Number.isSafeInteger(this.#next)) return Promise.resolve({ ok: false, code: "limit", effect: "none" });
    const id = this.#next++;
    let line: string;
    try {
      if (typeof op !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(op)) throw new Error("invalid op");
      // Caller data cannot override the correlation id or operation.
      line = JSON.stringify({ ...params, id, op }) + "\n";
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("request too large");
      const wire = JSON.parse(line) as { id?: unknown; op?: unknown } | null;
      if (!wire || wire.id !== id || wire.op !== op) throw new Error("invalid request serialization");
    } catch { return Promise.resolve({ ok: false, code: "limit", effect: "none" }); }
    // Serialization can invoke caller getters/toJSON. Do not write after a reentrant reset/stop.
    if (this.#current !== g || g.retired || this.#stopping) return Promise.resolve(unknown());
    return new Promise((res) => {
      const timer = setTimeout(() => this.#invalidate(g), REQUEST_MS);
      g.pending.set(id, { resolve: res, timer });
      try { g.child.stdin!.write(line, (error) => { if (error) this.#invalidate(g); }); }
      catch { this.#invalidate(g); }
    });
  }

  /** Invalidate authority and request kill; actual native exit remains separately tracked. */
  kill(): void { if (this.#current) this.#invalidate(this.#current); }
  /** Detach without losing pending replies or the native cleanup obligation. */
  reset(): void {
    const g = this.#current;
    if (!g) return;
    this.#invalidate(g);
    if (this.#current === g) this.#current = null;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    const generations = new Set(this.#retired);
    if (this.#current) generations.add(this.#current);
    for (const g of generations) {
      this.#invalidate(g, false);
      if (!g.terminal) { try { g.child.stdin?.end(); } catch { this.#kill(g); } }
    }
    const wait = new Promise<void>((resolveStop, rejectStop) => {
      let finished = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(grace); clearTimeout(deadline);
        for (const g of generations) g.terminalListeners.delete(check);
        if (error) rejectStop(error); else resolveStop();
      };
      const check = () => { if ([...generations].every(g => g.terminal)) finish(); };
      for (const g of generations) if (!g.terminal) g.terminalListeners.add(check);
      grace = setTimeout(() => { for (const g of generations) this.#kill(g); }, STOP_GRACE_MS);
      deadline = setTimeout(() => finish(new Error("kl-fs helper stop timed out; process cleanup is unknown")), STOP_MS);
      check();
    });
    this.#stopPromise = wait.finally(() => {
      if (this.#current?.retired) this.#current = null;
      this.#stopping = false;
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }
}

/** DPAPI (CurrentUser) through the helper. Both directions take and return raw bytes. */
export async function dpapi(client: HelperClient, direction: "protect" | "unprotect", bytes: Uint8Array): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: string }> {
  const r = await client.request(`dpapi-${direction}`, { data: Buffer.from(bytes).toString("base64") });
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, bytes: new Uint8Array(Buffer.from(String(r.value), "base64")) };
}
