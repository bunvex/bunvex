// `db.vars.commitTs` through the function runtime (STUDY-53): a mutation's result resolved on the wire, a
// query that returns the placeholder refused with Convex's message, `v.commitTs()` in returns.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { CommitTsPlaceholder, v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("a mutation's result resolves on the wire; a query cannot return it", async () => {
  const engine = await new Engine(
    defineSchema({ events: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    write: mutation({
      args: {},
      returns: v.object({ at: v.commitTs(), id: v.id("events") }),
      handler: async ({ db }) => ({ at: db.vars.commitTs, id: await db.insert("events", { at: db.vars.commitTs }) }),
    }),
    read: query(async ({ db }, { id }: { id: string }) => (await db.get(id as never))?.at),
    leak: query(() => new CommitTsPlaceholder()),
  });
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(s.stop);
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server!.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "encoded_json" }),
      })
    ).json()) as { status: string; value?: any; errorMessage?: string };
  const w = await call("mutation", "m:write");
  expect(w.status).toBe("success");
  expect(Object.keys(w.value.at)).toEqual(["$integer"]);
  const r = await call("query", "m:read", { id: w.value.id });
  expect(r.value).toEqual(w.value.at);
  const leak = await call("query", "m:leak");
  expect(leak.errorMessage).toContain(
    "Function m:leak return value invalid: queries cannot return an unresolved commit timestamp",
  );
});

test("Convex's refusals (STUDY-53 PR 2): the token in client args, the placeholder in scheduled args and filters; a nested query is a reader", async () => {
  const engine = await new Engine(
    defineSchema({ t: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    echo: mutation(() => "ok"),
    sched: mutation(async ({ db, scheduler }) => scheduler.runAfter(0, "m:echo" as never, { at: db.vars.commitTs })),
    filt: mutation(async ({ db }) =>
      db
        .query("t")
        .filter((q) => q.eq(q.field("a"), db.vars.commitTs as never))
        .collect(),
    ),
    nested: mutation(async (ctx) => ctx.runQuery("m:peek" as never, {})),
    peek: query(async ({ db }) => [
      typeof (db as { vars?: unknown }).vars,
      typeof (db as { insert?: unknown }).insert,
      (await db.query("t").collect()).length,
    ]),
  });
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(s.stop);
  const call = async (path: string, args: unknown = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server!.port}/api/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "encoded_json" }),
      })
    ).json()) as { status: string; value?: any; errorMessage?: string };
  const token = await call("m:echo", { x: { $commitTs: null } });
  expect(token.errorMessage).toMatch(
    /Server Error\nInvalid arguments for m\.js:echo: Field name \$commitTs starts with '\$', which is reserved\.\n$/,
  );
  expect((await call("m:sched")).errorMessage).toContain(
    "Invalid arguments for m.js:echo: Field name $commitTs starts with '$', which is reserved.",
  );
  expect((await call("m:filt")).errorMessage).toContain("Field name $commitTs starts with '$', which is reserved.");
  expect((await call("m:nested")).value).toEqual(["undefined", "undefined", 0]);
});

test("a cron mutation's result holding the placeholder is logged resolved, as Convex's cron logs", async () => {
  const { CRON_JOB_LOGS_TABLE } = await import("@bunvex/core");
  const { cronJobs, cronSpecs } = await import("../src/cron.ts");
  const { CronJobExecutor } = await import("../src/cron-executor.ts");
  const { makeFunctionReference } = await import("@bunvex/protocol");
  const engine = await new Engine(
    defineSchema({ t: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    tick: mutation(async ({ db }) => ({ at: db.vars.commitTs })),
  });
  const c = cronJobs();
  c.interval("tick", { seconds: 1 }, makeFunctionReference<"mutation">("m:tick") as never);
  const ex = new CronJobExecutor(
    engine,
    functions,
    cronSpecs(c, (id, name) => functions.cronTarget(id, name)),
    {
      cronSplaySeconds: 0,
    },
  );
  stops.push(() => ex.stop());
  await ex.start();
  let logs: { status: { type: string; result?: { value: { at: unknown } } } }[] = [];
  for (let i = 0; i < 300 && logs.length === 0; i++) {
    logs = (await engine.query((db) => db.asSystem(() => db.query(CRON_JOB_LOGS_TABLE).collect()))) as never;
    if (!logs.length) await Bun.sleep(10);
  }
  expect(logs[0]!.status.type).toBe("success");
  expect(typeof logs[0]!.status.result!.value.at).toBe("bigint");
});
