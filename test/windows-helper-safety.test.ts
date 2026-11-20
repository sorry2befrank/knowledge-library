import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HelperClient } from "../cli/kl/src/fs/windows-helper.ts";

// This suite exercises the real client against a process transport model. No helper
// executable, native process, filesystem mutation, or real-time delay is involved.
const transport = vi.hoisted(() => ({ spawn: vi.fn(), executableExists: true }));
vi.mock("node:child_process", () => {
  const forbidden = () => { throw new Error("native process execution is forbidden in this model"); };
  return { spawn: transport.spawn, spawnSync: forbidden, exec: forbidden, execFile: forbidden, execSync: forbidden, execFileSync: forbidden, fork: forbidden };
});
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => transport.executableExists }));

class ModelChild extends EventEmitter {
  pid: number;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killCalls = 0;
  killRefuses = false;
  killThrows = false;
  writeThrows = false;
  writes: string[] = [];
  writeCallbacks: ((error?: Error | null) => void)[] = [];
  constructor(pid: number) {
    super(); this.pid = pid;
    vi.spyOn(this.stdin, "write").mockImplementation((...args: unknown[]) => {
      if (this.writeThrows) throw new Error("modeled write failure");
      this.writes.push(String(args[0]));
      const callback = args.find((arg) => typeof arg === "function");
      if (callback) this.writeCallbacks.push(callback as (error?: Error | null) => void);
      return true;
    });
  }
  kill() {
    this.killed = true; this.killCalls++;
    if (this.killThrows) throw new Error("modeled kill failure");
    return !this.killRefuses;
  }
}

let children: ModelChild[];
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function observed<T>(promise: Promise<T>) {
  const result: { settled: boolean; value?: T; error?: string } = { settled: false };
  promise.then(value => Object.assign(result, { settled: true, value }), error => Object.assign(result, { settled: true, error: String(error) }));
  return result;
}
const unknown = (reply: unknown) => expect(reply).toEqual({ ok: false, code: "closed-handle", effect: "unknown" });
function harness() {
  const client = new HelperClient("MODEL-ONLY-helper.exe"), start = children.length;
  let invalidations = 0;
  // The production adapter detaches the invalidated generation in this callback.
  client.onExit(() => { invalidations++; client.reset(); });
  return { client, child: (index: number) => children[start + index]!, invalidations: () => invalidations };
}
function reply(child: ModelChild, id: number, value: unknown) { child.stdout.write(JSON.stringify({ id, ok: true, value }) + "\n"); }

beforeEach(() => {
  vi.useFakeTimers(); children = []; transport.executableExists = true;
  transport.spawn.mockReset().mockImplementation(() => {
    const child = new ModelChild(9000 + children.length); children.push(child); return child;
  });
});
afterEach(async () => {
  // Only synthetic terminal events: do not invoke a process API for teardown.
  for (const child of children) { child.emit("exit", 0); child.emit("close", 0); }
  await flush(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("Windows helper channel safety (pure process model)", () => {
  it("an old error followed by a late exit cannot invalidate a new generation", async () => {
    const h = harness(), first = h.client.request("ping");
    h.child(0).emit("error", Error("old")); unknown(await first);
    const second = h.client.request("ping"); h.child(0).emit("exit", 1); reply(h.child(1), 2, "pong");
    expect(await second).toEqual({ ok: true, value: "pong" }); expect(h.client.alive).toBe(true); expect(h.invalidations()).toBe(1);
  });
  it("late child and stream errors cannot invalidate the replacement generation", async () => {
    const h = harness(), first = h.client.request("ping"); h.child(0).emit("error", Error("old")); await first;
    const second = h.client.request("ping"); h.child(0).emit("error", Error("late")); h.child(0).stdin.emit("error", Error("late stream"));
    reply(h.child(1), 2, "pong"); expect(await second).toEqual({ ok: true, value: "pong" }); expect(h.invalidations()).toBe(1);
  });
  it("old stdout cannot answer a replacement generation request", async () => {
    const h = harness(), first = h.client.request("ping"); h.child(0).emit("error", Error("old")); await first;
    const second = observed(h.client.request("ping")); reply(h.child(0), 2, "forged"); await flush(); expect(second.settled).toBe(false);
    reply(h.child(1), 2, "pong"); await flush(); expect(second.value).toEqual({ ok: true, value: "pong" });
  });
  it.each([
    ["invalid JSON", "{bad\n"], ["null reply", "null\n"], ["array reply", "[]\n"],
    ["truthy nonboolean ok", '{"id":1,"ok":"yes","value":true}\n'],
    ["missing success value", '{"id":1,"ok":true}\n'],
    ["missing failure effect", '{"id":1,"ok":false,"code":"io-error"}\n'],
    ["invalid failure effect", '{"id":1,"ok":false,"code":"io-error","effect":"complete"}\n'],
    ["unsolicited id", '{"id":99,"ok":true,"value":true}\n'],
    ["fractional id", '{"id":1.5,"ok":true,"value":true}\n'],
    ["conflicting success fields", '{"id":1,"ok":true,"value":true,"effect":"none"}\n'],
  ])("malformed protocol refuses with unknown effects: %s", async (_name, wire) => {
    const h = harness(), result = observed(h.client.request("append")); h.child(0).stdout.write(wire); await flush();
    expect(result.settled).toBe(true); expect(result.error).toBeUndefined(); unknown(result.value);
    expect(h.child(0).killed).toBe(true); expect(h.client.alive).toBe(false);
  });
  it("invalid UTF-8 cannot be silently accepted as replacement-character success", async () => {
    const h = harness(), result = observed(h.client.request("read"));
    h.child(0).stdout.write(Buffer.concat([Buffer.from('{"id":1,"ok":true,"value":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    await flush(); expect(result.settled).toBe(true); unknown(result.value);
  });
  it("an oversized unterminated reply fails without waiting for the request deadline", async () => {
    const h = harness(), result = observed(h.client.request("read")); h.child(0).stdout.write(Buffer.alloc(1_048_577, 32));
    await flush(); expect(result.settled).toBe(true); unknown(result.value); expect(vi.getTimerCount()).toBe(0);
  });
  it("a 30-second request deadline settles every in-flight effect as unknown", async () => {
    const h = harness(), a = observed(h.client.request("append")), b = observed(h.client.request("flush"));
    vi.advanceTimersByTime(29_999); await flush(); expect(a.settled).toBe(false);
    vi.advanceTimersByTime(1); await flush(); expect(a.settled).toBe(true); unknown(a.value); unknown(b.value);
    expect(vi.getTimerCount()).toBe(0); expect(h.child(0).killed).toBe(true);
  });
  it("a synchronous write failure resolves unknown without rejecting the request", async () => {
    const h = harness(); h.client.start(); h.child(0).writeThrows = true;
    const result = observed(h.client.request("append")); await flush(); expect(result.error).toBeUndefined(); unknown(result.value);
  });
  it("a stdin error settles pending effects instead of throwing an unhandled emitter error", async () => {
    const h = harness(), result = observed(h.client.request("append")); h.child(0).stdin.emit("error", Error("pipe"));
    await flush(); unknown(result.value);
  });
  it("reset settles the old request and retains responsibility for killing its child", async () => {
    const h = harness(), result = observed(h.client.request("append")); h.client.reset(); await flush();
    unknown(result.value); expect(h.child(0).killed).toBe(true); expect(h.invalidations()).toBe(1);
  });
  it("stop reports unconfirmed cleanup after its bound and tracks that child for a retry", async () => {
    const h = harness(); h.client.start(); h.child(0).killRefuses = true;
    const stopped = observed(h.client.stop()); vi.advanceTimersByTime(2_000); expect(h.child(0).killed).toBe(true);
    vi.advanceTimersByTime(2_000); await flush(); expect(stopped.settled).toBe(true); expect(stopped.error).toMatch(/cleanup is unknown/);
    const calls = h.child(0).killCalls, retried = observed(h.client.stop());
    vi.advanceTimersByTime(2_000); expect(h.child(0).killCalls).toBeGreaterThan(calls);
    h.child(0).emit("exit", 0); await flush(); expect(retried.settled).toBe(true); expect(retried.error).toBeUndefined();
  });
  it("successful stop clears its deadline so it cannot kill a later generation", async () => {
    const h = harness(); h.client.start(); const stopped = h.client.stop(); h.child(0).emit("exit", 0); await stopped;
    expect(vi.getTimerCount()).toBe(0); const pending = h.client.request("ping"); vi.advanceTimersByTime(4_000); reply(h.child(1), 1, "pong");
    expect(await pending).toEqual({ ok: true, value: "pong" }); expect(h.child(1).killed).toBe(false);
  });
  it("stop waits for retired and current children and refuses new work while waiting", async () => {
    const h = harness(), first = h.client.request("ping"); h.child(0).emit("error", Error("old")); await first;
    h.client.start(); const stopped = observed(h.client.stop()); unknown(await h.client.request("ping"));
    h.child(1).emit("exit", 0); await flush(); expect(stopped.settled).toBe(false);
    h.child(0).emit("exit", 0); await flush(); expect(stopped.settled).toBe(true); expect(stopped.error).toBeUndefined();
  });
  it("unconfirmed retired children limit new spawns until a terminal event releases capacity", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) { const pending = h.client.request("ping"); h.child(i).emit("error", Error("no exit")); unknown(await pending); }
    const count = children.length; unknown(await h.client.request("ping")); expect(children).toHaveLength(count);
    h.child(0).emit("exit", 0); const next = h.client.request("ping"); reply(h.child(4), 5, "pong");
    expect(await next).toEqual({ ok: true, value: "pong" });
  });
  it("the pending limit refuses only the unsent operation without poisoning valid replies", async () => {
    const h = harness(), pending = Array.from({ length: 64 }, () => observed(h.client.request("ping")));
    expect(await h.client.request("ping")).toEqual({ ok: false, code: "limit", effect: "none" }); expect(h.child(0).writes).toHaveLength(64);
    reply(h.child(0), 1, "pong"); await flush(); expect(pending[0]!.value).toEqual({ ok: true, value: "pong" });
  });
  it("caller parameters cannot replace the wire id or operation", async () => {
    const h = harness(), pending = h.client.request("ping", { id: 999, op: "dispose" });
    expect(JSON.parse(h.child(0).writes[0]!)).toMatchObject({ id: 1, op: "ping" });
    reply(h.child(0), 1, "pong"); expect(await pending).toEqual({ ok: true, value: "pong" });
  });
  it("toJSON cannot replace the complete request envelope", async () => {
    const h = harness();
    expect(await h.client.request("ping", { toJSON: () => ({ id: 999, op: "dispose" }) })).toEqual({ ok: false, code: "limit", effect: "none" });
    expect(h.child(0).writes).toHaveLength(0);
  });
  it("reentrant reset during serialization cannot send work to a retired child", async () => {
    const h = harness(), params = { get data() { h.client.reset(); return "data"; } };
    unknown(await h.client.request("append", params)); expect(h.child(0).writes).toHaveLength(0);
  });
  it("valid fragmented UTF-8, CRLF, out-of-order replies and definite refusals remain supported", async () => {
    const h = harness(), a = h.client.request("ping"), b = h.client.request("ping"), c = h.client.request("ping");
    const wire = Buffer.from('{"id":2,"ok":true,"value":"é"}\r\n{"id":1,"ok":true,"value":null}\n{"id":3,"ok":false,"code":"access-denied","effect":"none"}\n');
    const split = wire.indexOf(Buffer.from("é")) + 1; h.child(0).stdout.write(wire.subarray(0, split)); h.child(0).stdout.write(wire.subarray(split));
    expect(await a).toEqual({ ok: true, value: null }); expect(await b).toEqual({ ok: true, value: "é" });
    expect(await c).toEqual({ ok: false, code: "access-denied", effect: "none" }); expect(vi.getTimerCount()).toBe(0);
  });
  it("a duplicate reply cannot count twice and invalidates the remaining requests", async () => {
    const h = harness(), a = h.client.request("ping"), b = observed(h.client.request("append")); reply(h.child(0), 1, "pong"); await a;
    reply(h.child(0), 1, "duplicate"); await flush(); unknown(b.value); expect(h.invalidations()).toBe(1);
  });
  it("spawn failure produces an unknown reply instead of an uncaught request exception", async () => {
    const h = harness(); transport.spawn.mockImplementationOnce(() => { throw Error("modeled spawn failure"); });
    const result = observed(h.client.request("ping")); await flush(); expect(result.error).toBeUndefined(); unknown(result.value);
  });
  it("a late write callback failure cannot invalidate the replacement child", async () => {
    const h = harness(), a = h.client.request("ping"); h.child(0).emit("error", Error("old")); await a;
    const b = h.client.request("ping"); for (const callback of h.child(0).writeCallbacks) callback(Error("late write"));
    reply(h.child(1), 2, "pong"); expect(await b).toEqual({ ok: true, value: "pong" }); expect(h.invalidations()).toBe(1);
  });
  it("one throwing observer cannot prevent later authority invalidation", async () => {
    const client = new HelperClient("MODEL-ONLY-helper.exe"); let notified = 0;
    client.onExit(() => { throw Error("observer"); }); client.onExit(() => { notified++; client.reset(); });
    const pending = client.request("ping"); expect(() => children.at(-1)!.emit("error", Error("channel"))).not.toThrow();
    unknown(await pending); expect(notified).toBe(1);
  });
});
