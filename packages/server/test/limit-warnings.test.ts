// Approaching-limit warnings (STUDY-76), as Convex's `add_warnings_to_log_lines`: past
// FUNCTION_LIMIT_WARNING_RATIO of a limit (and not past it), a function ends with a WARN system line per
// limit, in Convex's order and words, after its own lines and never cut; the log streams carry its
// `system_code`. Tests lower the ratio (Convex's knob) so that small functions cross it.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, NODE_FUNCTIONS, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { collectLogs } from "../src/logs.ts";

const HELP =
  "Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.";

afterEach(() => {
  delete process.env.FUNCTION_LIMIT_WARNING_RATIO;
});
const ratio = (r: number) => {
  process.env.FUNCTION_LIMIT_WARNING_RATIO = String(r);
};

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const ids = await engine.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) out.push(await db.insert("items", { i }));
    return out;
  });
  const nodeAction = action(async () => "x");
  NODE_FUNCTIONS.add(nodeAction);
  const functions = new Functions(engine).register("m", {
    read: query(async ({ db }) => {
      console.log("mine");
      return db.query("items").collect();
    }),
    gets: query(async ({ db }, { n }: { n: number }) => {
      for (let i = 0; i < n; i++) await db.get(ids[i % ids.length] as never);
      return null;
    }),
    write: mutation(async ({ db, scheduler }) => {
      await db.insert("items", { deep: { a: { b: 1 } } });
      await scheduler.runAfter(1e9, "m:read" as never, { pad: "x".repeat(10) });
    }),
    failing: mutation(async ({ db }) => {
      await db.query("items").collect();
      throw new Error("app error");
    }),
    noisy: query(async ({ db }) => {
      for (let i = 0; i < 300; i++) console.log(i);
      return (await db.query("items").collect()).length;
    }),
    leaves: action(async (ctx) => {
      void ctx.runQuery("m:read" as never, {});
      void ctx.runQuery("m:read" as never, {});
      void fetch("http://127.0.0.1:1/").catch(() => null);
      return "done";
    }),
    nodeAction,
  });
  const consoleEvents: Record<string, any>[] = [];
  functions.functionLog = { append: () => {} } as never;
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "console") consoleEvents.push(eventJsonV2(x));
    },
  } as never;
  const lines = async (run: () => Promise<unknown>) => {
    const r = await collectLogs(run);
    return r.logLines.filter((l) => l.startsWith("[WARN]"));
  };
  return { engine, functions, lines, consoleEvents, ids };
}

test("a query's read warnings, in Convex's words, after its own lines", async () => {
  const t = await setup();
  ratio(0.0000001);
  const r = await collectLogs(() => t.functions.runQuery("m:read", {}));
  const warnings = r.logLines.filter((l) => l.startsWith("[WARN]"));
  expect(r.logLines[0]).toBe("[LOG] 'mine'");
  const docs = (r as { value: { length: number } }).value.length;
  expect(warnings).toContain(
    `[WARN] Many documents read in a single function execution (actual: ${docs}, limit: 32000). ${HELP}`,
  );
  expect(warnings.some((l) => l.startsWith("[WARN] Many reads in a single function execution (actual: "))).toBe(true);
  expect(
    warnings.some((l) =>
      /^\[WARN\] Many bytes read in a single function execution \(actual: \d+ bytes, limit: 16777216 bytes\)\. Consider/.test(
        l,
      ),
    ),
  ).toBe(true);
  expect(warnings.some((l) => l.startsWith("[WARN] Large size of the function arguments (actual: "))).toBe(true);
  expect(warnings.some((l) => l.startsWith("[WARN] Large size of the function return value (actual: "))).toBe(true);
  // The log streams carry each with its system code; the function's own line has none.
  const codes = t.consoleEvents.map((e) => e.system_code);
  expect(codes[0]).toBeNull();
  expect(codes).toContain("warning:TooManyDocumentsRead");
  expect(codes).toContain("warning:TooLargeFunctionResult");
});

test("the threshold: past the ratio's floor, never at it, never past the limit", async () => {
  const t = await setup();
  ratio(0.5); // 4096 read intervals: 2048 is not past it, 2049 is
  const reads = (n: number) =>
    t.lines(() => t.functions.runQuery("m:gets", { n })).then((w) => w.filter((l) => l.includes("Many reads")));
  expect(await reads(2047)).toEqual([]); // 2047 gets + 1 table read = 2048 intervals
  expect(await reads(2048)).toEqual([
    `[WARN] Many reads in a single function execution (actual: 2049, limit: 4096). ${HELP}`,
  ]);
});

test("a mutation's write and scheduling warnings, the biggest document by id", async () => {
  const t = await setup();
  ratio(0.0000001);
  const w = await t.lines(() => t.functions.runMutation("m:write", {}));
  const id = await t.engine.query(async (db) => (await db.query("items").collect()).at(-1)!._id);
  expect(w).toContain("[WARN] Many writes in a single function execution (actual: 1, limit: 16000).");
  expect(w.some((l) => l.startsWith("[WARN] Many bytes written in a single function execution (actual: "))).toBe(true);
  expect(w).toContain("[WARN] Many functions scheduled by this mutation (actual: 1, limit: 1000).");
  expect(w.some((l) => l.startsWith("[WARN] Large total size of the arguments of scheduled functions"))).toBe(true);
  expect(
    w.some((l) => l.startsWith("[WARN] Large arguments for a single scheduled function from this mutation (actual: ")),
  ).toBe(true);
  expect(w.some((l) => l.startsWith(`[WARN] Large document written with ID "${id}" (actual: `))).toBe(true);
  expect(w).toContain(`[WARN] Deeply nested document written with ID "${id}" (actual: 3 levels, limit: 16 levels).`);
});

test("a function that throws the app's error still gets its warnings, with no result's", async () => {
  const t = await setup();
  ratio(0.00001);
  const w = await t.lines(() => t.functions.runMutation("m:failing", {}).catch(() => null));
  expect(w.some((l) => l.includes("Many documents read"))).toBe(true);
  expect(w.some((l) => l.includes("return value"))).toBe(false);
});

test("warnings are kept past the 256-line limit", async () => {
  const t = await setup();
  ratio(0.00001);
  const r = await collectLogs(() => t.functions.runQuery("m:noisy", {}));
  expect(r.logLines.filter((l) => l.startsWith("[ERROR] Log overflow"))).toHaveLength(1);
  expect(r.logLines.at(-1)!.startsWith("[WARN]")).toBe(true);
  expect(r.logLines.length).toBeGreaterThan(256);
});

test("the duration warning, in Rust's Duration form", async () => {
  const t = await setup();
  ratio(0.0000001);
  const w = await t.lines(() => t.functions.runQuery("m:read", {}));
  expect(
    w.some((l) =>
      /^\[WARN\] Function execution took a long time\. \(maximum duration: 1s, actual duration: [\d.]+(µs|ms)\)\.$/.test(
        l,
      ),
    ),
  ).toBe(true);
});

test("an action: its arguments, its unawaited operations by name, its duration, its result", async () => {
  const t = await setup();
  ratio(0.0000001);
  await t.functions.runAction("m:leaves", {});
  // The action's own lines (the queries it ran have theirs); its dangling calls settle before the next test.
  const w = t.consoleEvents
    .filter((e) => e.function.path === "m.js:leaves" && e.system_code !== null)
    .map((e) => `[${e.log_level}] ${e.message}`);
  await Bun.sleep(100);
  expect(w[0]!.startsWith("[WARN] Large size of the action arguments (actual: ")).toBe(true);
  expect(w[1]).toBe(
    "[WARN] 3 unawaited operations: [fetch, query]. Async operations should be awaited or they might not run.",
  );
  expect(
    w[2]!.startsWith("[WARN] Function execution took a long time. (maximum duration: 1800s, actual duration: "),
  ).toBe(true);
  expect(w[3]!.startsWith("[WARN] Large size of the action return value (actual: ")).toBe(true);
  expect(t.consoleEvents.find((e) => e.message.includes("unawaited"))!.system_code).toBe("UnawaitedOperations");
});

test("a Node action has none", async () => {
  const t = await setup();
  ratio(0.0000001);
  expect(await t.lines(() => t.functions.runAction("m:nodeAction", {}))).toEqual([]);
});

test("below the default ratio, nothing", async () => {
  const t = await setup();
  expect(await t.lines(() => t.functions.runQuery("m:read", {}))).toEqual([]);
  expect(await t.lines(() => t.functions.runMutation("m:write", {}))).toEqual([]);
});

test("a system function warns too: its clients get the lines, as Convex's", async () => {
  const t = await setup();
  ratio(0.0000001);
  const w = await t.lines(() =>
    t.functions.runQuery(
      "_system/cli/tableData",
      { table: "items", order: "asc", paginationOpts: { numItems: 10, cursor: null } },
      false,
    ),
  );
  expect(w.some((l) => l.startsWith("[WARN] Many documents read in a single function execution (actual: 3,"))).toBe(
    true,
  );
  expect(w.some((l) => l.startsWith("[WARN] Function execution took a long time. (maximum duration: 1s,"))).toBe(true);
});
