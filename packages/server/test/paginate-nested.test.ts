// Pagination across nested calls, as Convex 8449d41 (`runUdf` and `query_page` in
// crates/isolate/src/environment/udf/async_syscall.rs): one paginated query per query function, a mutation
// unlimited; a query called from a mutation gets a fresh scope, a query called from a query shares its caller's.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, internalQuery, mutation, query } from "../src/functions.ts";

const MULTIPLE =
  "This query function ran multiple paginated queries. Only a single paginated query is supported in each query function.";

async function setup() {
  const schema = defineSchema({ items: defineTable({ n: v.number() }).index("by_n", ["n"]) });
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  const pageOf = (db: { query(t: string): unknown }) =>
    (db.query("items") as { withIndex(i: string): { paginate(o: unknown): Promise<{ page: { n: number }[] }> } })
      .withIndex("by_n")
      .paginate({ numItems: 2, cursor: null });
  const fns = new Functions(engine).register("m", {
    seed: mutation(async ({ db }) => {
      for (let n = 0; n < 5; n++) await db.insert("items" as never, { n } as never);
    }),
    onePage: internalQuery(async ({ db }) => (await pageOf(db)).page.map((d) => d.n)),
    twoPages: query(async ({ db }) => {
      await pageOf(db);
      return (await pageOf(db)).page.map((d) => d.n);
    }),
    twoQueries: query(async ({ runQuery }) => {
      await runQuery("m:onePage" as never, {} as never);
      return runQuery("m:onePage" as never, {} as never);
    }),
    callsTwoQueries: mutation(async ({ runQuery }) => [
      await runQuery("m:onePage" as never, {} as never),
      await runQuery("m:onePage" as never, {} as never),
    ]),
    pagesThenQueries: mutation(async ({ db, runQuery }) => {
      await pageOf(db);
      await runQuery("m:onePage" as never, {} as never);
      await pageOf(db);
      return runQuery("m:onePage" as never, {} as never);
    }),
    callsTwoPages: mutation(async ({ runQuery }) => runQuery("m:twoPages" as never, {} as never)),
    callsTwoQueriesQuery: mutation(async ({ runQuery }) => runQuery("m:twoQueries" as never, {} as never)),
  });
  await fns.runMutation("m:seed", {});
  return fns;
}

describe("pagination across nested calls, as Convex 8449d41", () => {
  test("a mutation calls two queries that each paginate once", async () => {
    const fns = await setup();
    expect(await fns.runMutation("m:callsTwoQueries", {})).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(await fns.runMutation("m:pagesThenQueries", {})).toEqual([0, 1]);
  });

  test("a query that paginates twice fails, called from a mutation too", async () => {
    const fns = await setup();
    await expect(fns.runQuery("m:twoPages", {})).rejects.toThrow(MULTIPLE);
    await expect(fns.runMutation("m:callsTwoPages", {})).rejects.toThrow(MULTIPLE);
  });

  test("a query calling two paginating queries shares its scope: it fails, called from a mutation too", async () => {
    const fns = await setup();
    await expect(fns.runQuery("m:twoQueries", {})).rejects.toThrow(MULTIPLE);
    await expect(fns.runMutation("m:callsTwoQueriesQuery", {})).rejects.toThrow(MULTIPLE);
  });
});
