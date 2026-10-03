// `ctx.vectorSearch` in actions (STUDY-51): Convex's arguments, its filter builder and JS-side errors.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation } from "../src/functions.ts";

test("an action searches with q.eq / q.or; Convex's argument errors", async () => {
  const engine = await new Engine(
    defineSchema({
      docs: defineTable(v.any()).vectorIndex("by_e", { vectorField: "e", dimensions: 2, filterFields: ["kind"] }),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.searchReady();
  const functions = new Functions(engine).register("m", {
    seed: mutation(async ({ db }) => {
      await db.insert("docs", { kind: "a", e: [1, 0] });
      await db.insert("docs", { kind: "b", e: [0, 1] });
      await db.insert("docs", { kind: "c", e: [1, 1] });
    }),
    search: action(async (ctx, { kinds }: { kinds: string[] }) =>
      ctx.vectorSearch("docs", "by_e", {
        vector: [1, 0],
        limit: 5,
        filter: (q) => q.or(...kinds.map((k) => q.eq("kind", k))),
      }),
    ),
    empty: action((ctx) => ctx.vectorSearch("docs", "by_e", { vector: [] })),
    badEq: action((ctx) => ctx.vectorSearch("docs", "by_e", { vector: [1, 0], filter: (q) => q.eq(1 as never, "a") })),
  });
  await functions.runMutation("m:seed", {});
  const hits = (await functions.runAction("m:search", { kinds: ["a", "b"] })) as { _id: string; _score: number }[];
  expect(hits.map((h) => h._score)).toEqual([1, 0]);
  await expect(functions.runAction("m:empty", {})).rejects.toThrow(
    "`vector` must be a non-empty Array in vectorSearch",
  );
  await expect(functions.runAction("m:badEq", {})).rejects.toThrow(
    "The first argument to `q.eq` must be a field name.",
  );
});
