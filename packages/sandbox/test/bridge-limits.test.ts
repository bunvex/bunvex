// The bridge's limits and its checks (STUDY-171 §8.3, §8.6): user time counted in the child and charged to the
// engine's timer (round trips are not user time, STUDY-168 §13.1); a function past its time fails with Convex's
// message, even one that never yields (the host's backstop kills its child); a dead child's calls fail as the
// engine's internal error and the next call gets a new child; and a child that forges what its function may not do
// is killed, its write never made.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor, ProcessExecutor } from "../src/executor.ts";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const MODULE = `
import { query, mutation } from ${SERVER};
export const busy = query(async (ctx, { iterations }) => { let x = 0; for (let i = 0; i < iterations; i++) x = (x + i * 7) % 1000003; return x; });
export const forever = query(async () => { for (;;) {} });
export const read = query(async (ctx) => (await ctx.db.query("items").collect()).length);
export const inserts = mutation(async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.db.insert("items", { i }); return n; });
export const who = query(async (ctx) => ctx.auth.getUserIdentity());
const ran = { snap: 0, plain: 0 };
export const snap = query(async (ctx) => { ran.snap++; return typeof ctx.meta.getSnapshotTs(); });
export const plain = query(async () => { ran.plain++; return 1; });
export const runs = query(async (ctx, { i }) => [ran.snap, ran.plain, i]);
export const whoFromMutation = mutation(async (ctx) => ctx.runQuery("m:who", {}));
`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  provideProcessExecutor(createProcessExecutor);
});
provideProcessExecutor(createProcessExecutor);

type Completion = { identifier: string; cachedResult: boolean; userExecutionTime: number };

async function deployment(sandbox: "vm" | "process", userTimeoutMs?: number, cacheClock?: () => number) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    cacheClock ? { cacheClock } : {},
  ).init();
  const functions = new Functions(engine);
  const runs: Completion[] = [];
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
  // The function log's completions, as the engine records them (its user time, whether the cache answered).
  const log = functions.functionLog!;
  type Entry = Parameters<typeof log.append>[0];
  functions.functionLog = new Proxy(log, {
    get(target, p) {
      if (p !== "append") return Reflect.get(target, p, target);
      return (entry: Entry) => {
        if ((entry as { kind?: string }).kind === "Completion") runs.push(entry as unknown as Completion);
        return target.append(entry);
      };
    },
  });
  await s.codeReady;
  await s.deployCode([{ path: "m.js", source: MODULE, environment: "isolate" }]);
  const call = async (kind: "query" | "mutation", path: string, args: object = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status?: string; value?: unknown; errorMessage?: string; code?: string; message?: string };
  return { engine, functions, call, runs };
}

/** A system error's answer (Convex's internal error): the function's child is gone, not its code's fault. */
const INTERNAL = { code: "InternalServerError", message: "Your request couldn't be completed. Try again later." };

const firstLine = (m: string | undefined) =>
  (m ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "").split("\n")[0];

describe("user time", () => {
  test("is the child's JavaScript, not the round trips: inserts whose wall time is past the limit succeed", async () => {
    // 60 ms of user time; 1500 inserts are 1500 round trips, well past it on the wall clock.
    const d = await deployment("process", 60);
    const started = performance.now();
    const r = await d.call("mutation", "m:inserts", { n: 1500 });
    const wall = performance.now() - started;
    expect(r).toMatchObject({ status: "success", value: 1500 });
    expect(wall).toBeGreaterThan(60);
  });

  test("past the limit, a function fails with Convex's message, as under vm", async () => {
    const [vm, proc] = await Promise.all([deployment("vm", 50), deployment("process", 50)]);
    const args = { iterations: 300_000_000 };
    const [a, b] = await Promise.all([vm.call("query", "m:busy", args), proc.call("query", "m:busy", args)]);
    expect(firstLine(a.errorMessage)).toBe("Uncaught Error: Function execution timed out (maximum duration: 50ms)");
    expect(firstLine(b.errorMessage)).toBe(firstLine(a.errorMessage));
  });
});

describe("what the engine records", () => {
  test("the child's user time is the engine's: the function log has it", async () => {
    const d = await deployment("process");
    const started = performance.now();
    expect(await d.call("query", "m:busy", { iterations: 60_000_000 })).toMatchObject({ status: "success" });
    const wall = (performance.now() - started) / 1000;
    const user = d.runs.at(-1)!.userExecutionTime;
    // Charged from the child (the engine's own clock is paused for the call): most of the wall time, never 0.
    expect(user).toBeGreaterThan(0.02);
    expect(user).toBeGreaterThan(wall * 0.5);
    expect(user).toBeLessThanOrEqual(wall);
  });

  test("a query that read the snapshot's time expires from the cache, one that did not stays, as under vm", async () => {
    for (const sandbox of ["vm", "process"] as const) {
      const skew = { ms: 0 };
      const d = await deployment(sandbox, undefined, () => Date.now() + skew.ms);
      let i = 0;
      // How many times each handler ran (module state, the version's own): a cached result runs none.
      const runs = async () => ((await d.functions.runQuery("m:runs", { i: i++ })) as number[]).slice(0, 2);
      for (const path of ["m:snap", "m:snap", "m:plain", "m:plain"]) await d.functions.runQuery(path, {});
      expect({ sandbox, runs: await runs() }).toEqual({ sandbox, runs: [1, 1] });
      skew.ms = 18_000; // past MAX_CACHE_AGE_MS
      for (const path of ["m:snap", "m:plain"]) await d.functions.runQuery(path, {});
      // `snap` read the time: expired, run again; `plain` did not: still the cached result.
      expect({ sandbox, runs: await runs() }).toEqual({ sandbox, runs: [2, 1] });
    }
  });
});

describe("the backstop", () => {
  test("a function that never yields is stopped with the timeout's message; the next call gets a new child", async () => {
    const d = await deployment("process", 100);
    const started = performance.now();
    const r = await d.call("query", "m:forever");
    expect(firstLine(r.errorMessage)).toBe("Uncaught Error: Function execution timed out (maximum duration: 100ms)");
    // The limit, plus the slack, plus the kill: not the 15 s system limit, and never forever.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await d.call("query", "m:read")).toMatchObject({ status: "success", value: 0 });
  });

  test("a call waiting on the stopped child fails as an internal error, which the client may retry", async () => {
    const d = await deployment("process", 100);
    const [stuck, other] = await Promise.all([
      d.call("query", "m:forever"),
      // Sent after the loop started: its child is stuck, then killed under it.
      Bun.sleep(30).then(() => d.call("query", "m:read")),
    ]);
    expect(firstLine(stuck.errorMessage)).toContain("Function execution timed out");
    expect(other).toEqual(INTERNAL);
    expect(await d.call("query", "m:read")).toMatchObject({ status: "success", value: 0 });
  });
});

describe("a child that forges operations is killed", () => {
  const forging = async (mode: string) => {
    const entry = join(import.meta.dir, `fixtures/children/forge-${mode}.ts`);
    provideProcessExecutor(() => new ProcessExecutor({ entry }));
    return deployment("process");
  };

  const items = (d: Awaited<ReturnType<typeof deployment>>) =>
    d.engine.query(async (db) => (await db.query("items").collect()).length);

  for (const mode of ["unknownOp", "otherCall", "badTag", "tooManyArgs", "badLevel", "auditNotJson"])
    test(mode, async () => {
      const d = await forging(mode);
      expect(await d.call("query", "m:who")).toEqual(INTERNAL);
      // The next call gets a new child.
      expect(await d.call("query", "m:read")).toMatchObject({ status: "success", value: 0 });
    });

  test("a line past the console's cut is cut again, as the console cuts it (STUDY-171 §11)", async () => {
    const d = await forging("longLine");
    const r = (await d.call("query", "m:who")) as { status: string; logLines?: string[] };
    expect(r.status).toBe("success");
    expect(r.logLines).toEqual([`[LOG] ${"z".repeat(32768)} (truncated due to length)`]);
  });

  test("a write from a query run by a mutation (its `db` a reader, with no writes): killed, nothing written", async () => {
    const d = await forging("insert");
    expect(await d.call("mutation", "m:whoFromMutation")).toEqual(INTERNAL);
    expect(await items(d)).toBe(0);
  });

  test("a write from a query's own transaction: the engine refuses it, as it refuses the app's own", async () => {
    // A query's `db` is its transaction, which has the writes and refuses them (core's `Tx`): not a forgery.
    const d = await forging("insert");
    expect(firstLine((await d.call("query", "m:who")).errorMessage)).toBe("Uncaught Error: queries cannot write");
    expect(await items(d)).toBe(0);
  });
});
