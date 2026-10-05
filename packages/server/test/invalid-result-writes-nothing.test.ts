// A mutation whose result is not a value fails, and fails as a whole: none of its writes commit. Convex
// converts the result inside the function run (`invokeMutation`, registration_impl.ts), so the failure is
// the function's own error and the transaction is dropped. Found by the differential tests (STUDY-129).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    // Each result holds something that is not a value.
    undefinedInArray: mutation(async ({ db }) => [await db.insert("items", { n: 1 }), undefined]),
    aFunction: mutation(async ({ db }) => ({ id: await db.insert("items", { n: 2 }), f: () => 1 })),
    aSymbol: mutation(async ({ db }) => {
      await db.insert("items", { n: 3 });
      return Symbol("x");
    }),
    aClass: mutation(async ({ db }) => {
      await db.insert("items", { n: 4 });
      return new Date(0);
    }),
    // A nested mutation that fails this way rolls back its own writes; the caller may catch and go on.
    nested: mutation(async (ctx) => {
      await ctx.db.insert("items", { n: 5 });
      // biome-ignore lint/suspicious/noExplicitAny: a function reference by path
      const bad = await ctx.runMutation("m:undefinedInArray" as any, {}).then(
        () => "returned",
        (e: Error) => e.message,
      );
      return bad;
    }),
    // `undefined` fields are dropped, as in Convex: this result is a value.
    undefinedField: mutation(async ({ db }) => ({ id: await db.insert("items", { n: 6 }), gone: undefined })),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  return { functions, port: server!.port };
}

const BAD = ["undefinedInArray", "aFunction", "aSymbol", "aClass"];

test("in process: the mutation throws and writes nothing", async () => {
  const { functions } = await setup();
  for (const name of BAD) await expect(functions.runMutation(`m:${name}`, {})).rejects.toThrow();
  expect(await functions.runQuery("m:count", {})).toBe(0);
});

test("nested: the inner mutation's writes roll back, the caller's stay", async () => {
  const { functions } = await setup();
  expect(await functions.runMutation("m:nested", {})).toContain("undefined is not a valid value");
  expect(await functions.runQuery("m:count", {})).toBe(1);
});

test("a result with undefined fields is a value: the mutation commits", async () => {
  const { functions } = await setup();
  await functions.runMutation("m:undefinedField", {});
  expect(await functions.runQuery("m:count", {})).toBe(1);
});

test("HTTP: the mutation answers an error and writes nothing", async () => {
  const { port } = await setup();
  const call = async (kind: string, path: string) =>
    (await fetch(`http://127.0.0.1:${port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {}, format: "json" }),
    }).then((r) => r.json())) as { status: string; value?: unknown; errorMessage?: string };
  for (const name of BAD) expect((await call("mutation", `m:${name}`)).status).toBe("error");
  expect((await call("query", "m:count")).value).toBe(0);
});
