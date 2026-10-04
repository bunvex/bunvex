// Function handles (STUDY-50), as Convex's: `createFunctionHandle` in queries, mutations and actions;
// handles taken by `ctx.runQuery` / `runMutation` / `runAction` and the scheduler; Convex's errors; and the
// rows a push keeps (tombstoned when a function goes, revived when it returns).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, FUNCTION_HANDLES_TABLE } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { createFunctionHandle, resolveHandle, syncFunctionHandles } from "../src/function-handles.ts";
import { action, Functions, internalMutation, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    double: query((_ctx, { n }: { n: number }) => n * 2),
    note: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      await db.insert("log", { tag });
      return tag;
    }),
    shout: action((_ctx, { s }: { s: string }) => s.toUpperCase()),
    handleInQuery: query(() => createFunctionHandle("m:double")),
    handleInMutation: mutation(() => createFunctionHandle("m:note")),
    handleInAction: action(() => createFunctionHandle("m:shout")),
    viaMutation: mutation(async (ctx, { h }: { h: string }) => ctx.runQuery(h as never, { n: 21 })),
    viaAction: action(async (ctx, { q, m, a }: { q: string; m: string; a: string }) => [
      await ctx.runQuery(q as never, { n: 2 }),
      await ctx.runMutation(m as never, { tag: "from action" }),
      await ctx.runAction(a as never, { s: "hi" }),
    ]),
    schedule: mutation(async (ctx, { m }: { m: string }) => ctx.scheduler.runAfter(0, m as never, { tag: "later" })),
    missing: mutation(() => createFunctionHandle("m:nope")),
    system: mutation(() => createFunctionHandle("_system/cli/tables")),
    tags: query(async ({ db }) => (await db.query("log").collect()).map((d) => d.tag)),
  });
  const s = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(s.stop);
  await s.codeReady;
  const call = async (kind: string, path: string, args: object = {}) =>
    (await (
      await fetch(`http://127.0.0.1:${s.server!.port}/api/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args }),
      })
    ).json()) as { status: string; value?: any; errorMessage?: string };
  return { engine, call };
}

test("createFunctionHandle in a query, a mutation and an action: function://<id>#<path>", async () => {
  const { call } = await setup();
  const q = await call("query", "m:handleInQuery");
  const m = await call("mutation", "m:handleInMutation");
  const a = await call("action", "m:handleInAction");
  expect(q.value).toMatch(/^function:\/\/[0-9a-z]+#m:double$/);
  expect(m.value).toMatch(/^function:\/\/[0-9a-z]+#m:note$/);
  expect(a.value).toMatch(/^function:\/\/[0-9a-z]+#m:shout$/);
  // The same function, the same handle.
  expect((await call("query", "m:handleInQuery")).value).toBe(q.value);
});

test("handles run through runQuery / runMutation / runAction and the scheduler; only the id counts", async () => {
  const { call } = await setup();
  const q = (await call("query", "m:handleInQuery")).value as string;
  const m = (await call("mutation", "m:handleInMutation")).value as string;
  const a = (await call("action", "m:handleInAction")).value as string;
  expect((await call("mutation", "m:viaMutation", { h: q })).value).toBe(42);
  expect((await call("action", "m:viaAction", { q, m, a })).value).toEqual([4, "from action", "HI"]);
  // The fragment is advisory.
  const renamed = q.replace("#m:double", "#m:whatever");
  expect((await call("mutation", "m:viaMutation", { h: renamed })).value).toBe(42);
  await call("mutation", "m:schedule", { m });
  for (let i = 0; i < 100; i++) {
    if (((await call("query", "m:tags")).value as string[]).includes("later")) break;
    await Bun.sleep(10);
  }
  expect((await call("query", "m:tags")).value).toContain("later");
});

test("Convex's errors: an unknown function, a system function, outside a function", async () => {
  const { call } = await setup();
  expect((await call("mutation", "m:missing")).errorMessage).toContain("Function handle not found");
  expect((await call("mutation", "m:system")).errorMessage).toContain("Cannot create function handle for system UDF");
  await expect(createFunctionHandle("m:double")).rejects.toThrow("can only be called from");
});

test("a push keeps the rows: a removed function's handle stops resolving, and works again when it returns", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  await engine.mutation((db) => syncFunctionHandles(db, ["a.js:x", "a.js:y"]));
  const rows = (await engine.query((db) =>
    db.asSystem(() => db.query(FUNCTION_HANDLES_TABLE).collect()),
  )) as unknown as {
    _id: string;
    path: string;
    deletedTs: bigint | null;
    component: null;
  }[];
  expect(rows.map((r) => [r.path, r.component, r.deletedTs])).toEqual([
    ["a.js:x", null, null],
    ["a.js:y", null, null],
  ]);
  const y = `function://${rows[1]!._id}#a:y`;
  expect(await engine.query((db) => resolveHandle(db, y))).toBe("a.js:y");
  await engine.mutation((db) => syncFunctionHandles(db, ["a.js:x"]));
  await expect(engine.query((db) => resolveHandle(db, y))).rejects.toThrow("Function handle not found");
  await engine.mutation((db) => syncFunctionHandles(db, ["a.js:x", "a.js:y"]));
  expect(await engine.query((db) => resolveHandle(db, y))).toBe("a.js:y");
});
