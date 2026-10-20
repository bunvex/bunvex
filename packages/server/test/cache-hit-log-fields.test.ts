// A cache hit's log entry describes the run it reused (STUDY-174 F4), as Convex's `log_query`
// (crates/application/src/function_log.rs) logs the cached outcome's fields: its user time, memory, execution
// timestamp and identity, in the function log, the log streams and the dashboard's logs alike. The hit keeps its
// own log time, wall time, request, execution id and caller, reads nothing, and meters no compute (Convex's
// `CallType::CachedQuery`). The time is virtual (STUDY-132): a function "works" BUSY_MS by moving the test
// runtime's clock, so the user times are exact.
import { expect, test } from "bun:test";
import { type Caller, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
import { v } from "@bunvex/values";
import type { Completion, FunctionLog } from "../src/function-log.ts";
import { Functions, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { ISOLATE_MEMORY_MB, UsageMeter } from "../src/usage-limits.ts";

const BUSY_MS = 40;
const STORE_MS = 60;
const USER: Caller = {
  identity: { tokenIdentifier: "issuer|alice", subject: "alice", issuer: "issuer" },
  key: "alice",
};

async function setup() {
  const rt = new TestRuntime();
  const store = await MemoryPersistence.open(null, { durable: false });
  let slow = false;
  // Every document read waits STORE_MS once `slow` is on, so a second caller finds the first one's run under way.
  const get = store.get.bind(store);
  store.get = (async (...a: Parameters<typeof get>) => {
    if (slow) await rt.sleep(STORE_MS);
    return get(...a);
  }) as unknown as typeof store.get;
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), store, { runtime: rt }).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 1 }));
  slow = true;
  let runs = 0;
  const functions = new Functions(engine).register("m", {
    // Reads no identity: one run is stored for every caller (STUDY-27).
    spins: query(async ({ db }) => {
      runs++;
      console.log("spinning");
      await db.get(id as never);
      rt.blockFor(BUSY_MS);
      return 1;
    }),
  });
  const completions: Completion[] = [];
  functions.functionLog = {
    append: (p: { kind: string }) => {
      if (p.kind === "Completion") completions.push(p as Completion);
    },
  } as unknown as FunctionLog;
  const events: Record<string, any>[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "function_execution") events.push(eventJsonV2(x));
    },
  } as never;
  const meter = new UsageMeter(() => rt.now());
  const metered: Parameters<UsageMeter["recordExecution"]>[0][] = [];
  const record = meter.recordExecution.bind(meter);
  meter.recordExecution = (e) => {
    metered.push(e);
    record(e);
  };
  functions.usageMeter = meter;
  const call = (caller?: Caller) => rt.runUntilSettled(functions.runQuery("m:spins", {}, true, caller));
  return { rt, engine, functions, completions, events, meter, metered, call, runs: () => runs };
}

test("a hit logs the user time, memory, start and identity of the run it reused, and its own time and request", async () => {
  const t = await setup();
  await t.call(USER);
  // Later, an anonymous caller: the run read no identity, so its result answers it.
  t.rt.blockFor(500);
  await t.call();
  expect(t.runs()).toBe(1);
  const [miss, hit] = t.completions;
  expect([miss!.cachedResult, hit!.cachedResult]).toEqual([false, true]);
  expect(miss!.userExecutionTime).toBe(BUSY_MS / 1000);
  expect(hit).toMatchObject({
    userExecutionTime: miss!.userExecutionTime,
    executionTimestamp: miss!.executionTimestamp,
    identityType: "user",
    usageStats: { memoryUsedMb: ISOLATE_MEMORY_MB, databaseReadDocuments: 0, databaseReadBytes: 0 },
  });
  expect(JSON.stringify(hit!.logLines)).toContain("spinning");
  // The hit's own: logged at its time, after its own (instant) wall time, in its own request and execution.
  expect(hit!.timestamp).toBeGreaterThanOrEqual(miss!.timestamp + 0.5);
  expect(hit!.executionTime).toBe(0);
  expect(hit!.executionTimestamp).toBeLessThan(hit!.timestamp - 0.5);
  expect(hit!.requestId).not.toBe(miss!.requestId);
  expect(hit!.executionId).not.toBe(miss!.executionId);
  expect(hit!.caller).toBe(miss!.caller);
  await t.engine.close();
});

test("the log streams' function_execution of a hit carries the same user time and memory", async () => {
  const t = await setup();
  await t.call();
  t.rt.blockFor(500);
  await t.call();
  const [miss, hit] = t.events;
  expect([miss!.function.cached, hit!.function.cached]).toEqual([false, true]);
  expect(hit!.user_execution_time_ms).toBe(BUSY_MS);
  expect(hit!.user_execution_time_ms).toBe(miss!.user_execution_time_ms);
  expect(hit!.usage.memory_used_mb).toBe(ISOLATE_MEMORY_MB);
  expect(hit!.usage.database_read_documents).toBe(0);
  // The event's own time is the hit's.
  expect(hit!.timestamp).toBeGreaterThanOrEqual(miss!.timestamp + 500);
  await t.engine.close();
});

test("a caller that waited for another's run logs a hit with that run's figures", async () => {
  const t = await setup();
  // Both start before the first run's store read returns: the second waits for it (Convex's `CacheOp::Wait`), and
  // may be served before the run's own entry is logged.
  await t.rt.runUntilSettled(
    Promise.all([t.functions.runQuery("m:spins", {}, true, USER), t.functions.runQuery("m:spins", {}, true, USER)]),
  );
  expect(t.runs()).toBe(1);
  const miss = t.completions.find((c) => !c.cachedResult)!;
  const hit = t.completions.find((c) => c.cachedResult)!;
  expect(hit).toMatchObject({
    userExecutionTime: BUSY_MS / 1000,
    executionTimestamp: miss.executionTimestamp,
    identityType: "user",
    usageStats: { memoryUsedMb: ISOLATE_MEMORY_MB },
  });
  await t.engine.close();
});

test("a hit meters a call and no compute, as Convex's cached query", async () => {
  const t = await setup();
  await t.call();
  const compute = t.meter.usage("queryMutationComputeGbHours", "day");
  expect(compute).toBeGreaterThan(0);
  t.rt.blockFor(500);
  // The hit takes a while of its own (its cache lookup), which a hit meters no compute for either.
  const cache = (t.engine as unknown as { cache: { find: (...a: unknown[]) => unknown } }).cache;
  const find = cache.find.bind(cache);
  cache.find = (...a) => {
    t.rt.blockFor(BUSY_MS);
    return find(...a);
  };
  await t.call();
  expect(t.completions[1]).toMatchObject({ cachedResult: true, executionTime: BUSY_MS / 1000 });
  expect(t.meter.usage("functionCalls", "day")).toBe(2);
  expect(t.meter.usage("queryMutationComputeGbHours", "day")).toBe(compute);
  expect(t.meter.usage("databaseIoGb", "day")).toBe(t.metered[0]!.databaseIoBytes);
  // What the meter is given for the hit: no time, user time or memory, though its log entry shows its run's.
  expect(t.metered[1]).toMatchObject({ executionTime: 0, userExecutionTime: null, memoryMb: 0, databaseIoBytes: 0 });
  await t.engine.close();
});
