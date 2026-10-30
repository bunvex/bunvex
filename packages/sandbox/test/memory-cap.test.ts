// The memory cap under the `process` executor (STUDY-188 R12, DV-553): a query, mutation or action that holds more
// than a call's 64 MiB (a 512 MiB or 4 GiB `ArrayBuffer`, a 512 MiB `Blob`, typed arrays, objects, strings) fails
// with Convex's message alone, whatever it catches, and the next call runs in a new child; one under the cap, and one
// that allocates far more than the cap in garbage, succeed. Under `vm` (the default), nothing is capped (DV-553).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor, type ProcessExecutor } from "../src/executor.ts";

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const MODULE = `
import { query, mutation, action } from ${SERVER};
const MiB = 1024 * 1024;
const probes = {
  // Held across an operation: one dropped before the child's next message may be collected first (STUDY-188 §X17b).
  arrayBuffer: async (op) => { const b = new ArrayBuffer(512 * MiB); await op(); return b.byteLength; },
  arrayBuffer4g: async (op) => { const b = new ArrayBuffer(4 * 1024 * MiB); await op(); return b.byteLength; },
  blob: () => new Blob([new Uint8Array(512 * MiB)]).size,
  typedArrays: () => { const kept = []; for (let i = 0; i < 512; i++) kept.push(new Uint8Array(MiB).fill(i)); return kept.length; },
  objects: () => { const kept = []; for (let i = 0; i < 1 << 23; i++) kept.push({ i, s: "row " + i }); return kept.length; },
  strings: () => { const kept = []; const d = new TextDecoder(); for (let i = 0; i < 512; i++) kept.push(d.decode(new Uint8Array(MiB).fill(97 + (i % 26)))); return kept.length; },
  under: () => {
    const bytes = new Uint8Array(16 * MiB).fill(1);
    const text = "x".repeat(16 * MiB);
    const rows = Array.from({ length: 100000 }, (_, i) => ({ i }));
    return bytes.length + text.length + rows.length;
  },
  churn: () => {
    let n = 0;
    for (let i = 0; i < 1024; i++) n += new Uint8Array(MiB).fill(1)[i % MiB];
    for (let i = 0; i < 512; i++) n += JSON.parse(JSON.stringify({ s: "y".repeat(MiB) })).s.length > 0 ? 1 : 0;
    return n;
  },
};
const run = async (probe, op) => {
  try {
    return { value: await probes[probe](op) };
  } catch (e) {
    return { caught: String(e) };
  }
};
export const q = query(async (ctx, { probe }) => run(probe, () => ctx.db.query("items").first()));
export const m = mutation(async (ctx, { probe }) => run(probe, () => ctx.db.query("items").first()));
export const a = action(async (ctx, { probe }) => run(probe, () => ctx.runQuery("m:ping", {})));
/** After a read: the cap holds past an operation too. */
export const afterRead = query(async (ctx, { probe }) => { await ctx.db.query("items").first(); return run(probe, () => ctx.db.query("items").first()); });
/** Holds the memory across an operation, then answers. */
export const heldAcross = mutation(async (ctx) => {
  const kept = [];
  for (let i = 0; i < 512; i++) { kept.push(new Uint8Array(MiB).fill(i)); if (i % 32 === 0) await ctx.db.insert("items", { i }); }
  return kept.length;
});
export const ping = query(async () => "pong");
/** Grows forever, never yielding: only the watchdog can stop it before its time limit. */
export const forever = query(async () => { const kept = []; for (;;) kept.push({ n: kept.length, s: "row " + kept.length }); });
/** Reads, one after the other, for a while: running when another call of its child goes past the cap. */
export const slow = query(async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.db.query("items").first(); return "slow"; });
`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});
let executor: ProcessExecutor | null = null;
provideProcessExecutor(() => {
  executor = createProcessExecutor() as ProcessExecutor;
  return executor;
});

async function deployment(sandbox: "vm" | "process", userTimeoutMs?: number) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
  });
  stops.push(() => s.shutdown());
  if (userTimeoutMs !== undefined) functions.userTimeoutMs = userTimeoutMs;
  await s.codeReady;
  await s.deployCode([{ path: "m.js", source: MODULE, environment: "isolate" }]);
  const call = async (kind: "query" | "mutation" | "action", path: string, args: object = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status?: string; value?: unknown; errorMessage?: string; code?: string; message?: string };
  return { call };
}

const OOM = "Server Error\nJavaScript execution ran out of memory (maximum memory usage: 64 MB)\n";
/** The answer without its request id. */
const answer = (r: { status?: string; value?: unknown; errorMessage?: string }) =>
  r.errorMessage === undefined ? r : { ...r, errorMessage: r.errorMessage.replace(/^\[Request ID: [0-9a-f]+\] /, "") };

const OVER = ["arrayBuffer", "arrayBuffer4g", "blob", "typedArrays", "objects", "strings"];
const KINDS = [
  ["query", "m:q"],
  ["mutation", "m:m"],
  ["action", "m:a"],
] as const;

describe("under process", () => {
  test("past the cap, each kind fails with Convex's message, uncaught; the next call runs", async () => {
    const d = await deployment("process");
    for (const [kind, path] of KINDS)
      for (const probe of OVER) {
        expect({ kind, probe, r: answer(await d.call(kind, path, { probe })) }).toEqual({
          kind,
          probe,
          r: { status: "error", errorMessage: OOM },
        });
        expect(await d.call("query", "m:ping")).toMatchObject({ status: "success", value: "pong" });
      }
  }, 120_000);

  test("past the cap after an operation, the same", async () => {
    const d = await deployment("process");
    expect(answer(await d.call("query", "m:afterRead", { probe: "typedArrays" }))).toEqual({
      status: "error",
      errorMessage: OOM,
    });
    expect(answer(await d.call("mutation", "m:heldAcross"))).toEqual({ status: "error", errorMessage: OOM });
    expect(await d.call("query", "m:ping")).toMatchObject({ status: "success", value: "pong" });
  }, 60_000);

  test("code that never yields is stopped at the cap, before its time limit", async () => {
    // A time limit the loop would reach after allocating a few hundred MiB: the cap stops it well before.
    const d = await deployment("process", 600);
    const started = performance.now();
    expect(answer(await d.call("query", "m:forever"))).toEqual({ status: "error", errorMessage: OOM });
    expect(performance.now() - started).toBeLessThan(600);
    expect(await d.call("query", "m:ping")).toMatchObject({ status: "success", value: "pong" });
  }, 60_000);

  test("under the cap, and garbage far past it, succeed", async () => {
    const d = await deployment("process");
    for (const [kind, path] of KINDS) {
      expect(await d.call(kind, path, { probe: "under" })).toMatchObject({
        status: "success",
        value: { value: 33_654_432 },
      });
      expect(await d.call(kind, path, { probe: "churn" })).toMatchObject({ status: "success", value: { value: 1536 } });
    }
    // The child that ran them is the one that runs the next call: none of them was stopped.
    const before = await executor!.children();
    expect(await d.call("query", "m:ping")).toMatchObject({ status: "success" });
    expect(await executor!.children()).toEqual(before);
  }, 60_000);

  test("a call running beside one past the cap fails with it (the child is the calls')", async () => {
    const d = await deployment("process");
    const started = performance.now();
    const [slow, over] = await Promise.all([
      d.call("query", "m:slow", { n: 20_000 }),
      // Once the slow call runs: its reads take seconds.
      Bun.sleep(100).then(() => d.call("query", "m:q", { probe: "typedArrays" })),
    ]);
    expect(answer(over)).toEqual({ status: "error", errorMessage: OOM });
    expect(answer(slow)).toEqual({ status: "error", errorMessage: OOM });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await d.call("query", "m:slow", { n: 3 })).toMatchObject({ status: "success", value: "slow" });
  }, 60_000);
});

describe("under vm", () => {
  test("nothing is capped (DV-553)", async () => {
    const d = await deployment("vm");
    expect(await d.call("query", "m:q", { probe: "arrayBuffer" })).toMatchObject({
      status: "success",
      value: { value: 512 * 1024 * 1024 },
    });
  });
});
