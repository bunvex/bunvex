// A function that returns a query object instead of its results fails with Convex's message (STUDY-66 §3,
// registration_impl.ts `validateReturnValue`), before its `returns` validator runs.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";

const MESSAGE =
  "Return value is a Query. Results must be retrieved with `.collect()`, `.take(n), `.unique()`, or `.first()`.";

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    initializer: query(({ db }) => db.query("items") as never),
    indexed: query(async ({ db }) => db.query("items").withIndex("by_n") as never),
    filtered: query(({ db }) => db.query("items").filter((q) => q.eq(q.field("n"), 1)) as never),
    system: query(({ db }) => db.system.query("_storage") as never),
    fromMutation: mutation(async ({ db }) => {
      await db.insert("items", { n: 1 });
      return db.query("items") as never;
    }),
    // Checked before `returns`: the message is this one, not the validator's.
    withReturns: query({ args: {}, returns: v.array(v.any()), handler: ({ db }) => db.query("items") as never }),
    nested: query(({ db }) => ({ q: db.query("items") }) as never),
    viaRunQuery: query(async (ctx) => {
      try {
        await ctx.runQuery("m:initializer", {});
        return "no error";
      } catch (e) {
        return (e as Error).message;
      }
    }),
    results: query(({ db }) => db.query("items").collect()),
  });
  return { engine, fns };
}

describe("returning a query object", () => {
  test("from a query or a mutation, any link of the chain, db.system's too: Convex's error", async () => {
    const { fns, engine } = await setup();
    for (const name of ["m:initializer", "m:indexed", "m:filtered", "m:system", "m:withReturns"])
      await expect(fns.runQuery(name, {})).rejects.toThrow(MESSAGE);
    await expect(fns.runMutation("m:fromMutation", {})).rejects.toThrow(MESSAGE);
    // The mutation failed, so nothing it wrote committed.
    expect(await engine.query((db) => db.query("items").collect())).toEqual([]);
    expect(await fns.runQuery("m:viaRunQuery", {})).toContain(MESSAGE);
  });

  test("only the top-level value is checked, as Convex's; results are fine", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("m:nested", {})).rejects.not.toThrow(MESSAGE);
    expect(await fns.runQuery("m:results", {})).toEqual([]);
  });
});
