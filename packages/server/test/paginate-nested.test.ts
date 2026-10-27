// Pagination across nested calls, as Convex d7402d6 and 8449d41 (`runUdf` and `query_page` in
// crates/isolate/src/environment/udf/async_syscall.rs): one paginated query per query function, a mutation
// unlimited; a query called from a mutation gets a fresh scope; a query called from a query reads its caller's
// journal, and its page becomes its caller's when it returns, a second one refused in the caller.
import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, internalQuery, mutation, query } from "../src/functions.ts";
import { collectLogs } from "../src/logs.ts";

const MULTIPLE =
  "This query function ran multiple paginated queries. bunvex only supports a single paginated query in each query function.";
const message = (e: unknown) => (e as Error).message;

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
    // The callee pages and catches its own errors: it sees none.
    pageCaught: internalQuery(async ({ db }) => {
      try {
        console.log("callee paged");
        return { page: (await pageOf(db)).page.map((d) => d.n) };
      } catch (e) {
        return { calleeCaught: message(e) };
      }
    }),
    pageThenQuery: query(async ({ db, runQuery }) => {
      await pageOf(db);
      try {
        return await runQuery("m:pageCaught" as never, {} as never);
      } catch (e) {
        return { callerCaught: message(e) };
      }
    }),
    pageThenThrow: internalQuery(async ({ db }) => {
      await pageOf(db);
      throw new Error("after the page");
    }),
    failedThenPage: query(async ({ db, runQuery }) => {
      const caught = await runQuery("m:pageThenThrow" as never, {} as never).catch(message);
      return { caught, page: (await pageOf(db)).page.map((d) => d.n) };
    }),
    nested: query(async ({ runQuery }) => runQuery("m:onePage" as never, {} as never)),
  });
  await fns.runMutation("m:seed", {});
  return { fns, engine };
}

describe("pagination across nested calls, as Convex d7402d6 and 8449d41", () => {
  test("a mutation calls two queries that each paginate once", async () => {
    const { fns } = await setup();
    expect(await fns.runMutation("m:callsTwoQueries", {})).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(await fns.runMutation("m:pagesThenQueries", {})).toEqual([0, 1]);
  });

  test("a query that paginates twice fails, called from a mutation too", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("m:twoPages", {})).rejects.toThrow(MULTIPLE);
    await expect(fns.runMutation("m:callsTwoPages", {})).rejects.toThrow(MULTIPLE);
  });

  test("a query calling two paginating queries shares its scope: it fails, called from a mutation too", async () => {
    const { fns } = await setup();
    await expect(fns.runQuery("m:twoQueries", {})).rejects.toThrow(MULTIPLE);
    await expect(fns.runMutation("m:callsTwoQueriesQuery", {})).rejects.toThrow(MULTIPLE);
  });

  test("a callee's page is refused in its caller, where the call returns: the callee's own catch sees nothing", async () => {
    const { fns } = await setup();
    const out = await collectLogs(() => fns.runQuery("m:pageThenQuery", {}));
    expect(out).toMatchObject({ ok: true, value: { callerCaught: MULTIPLE } });
    // The refused call's lines are dropped, as Convex emits them only once the call is taken.
    expect(out.logLines).toEqual([]);
  });

  test("a callee that fails leaves no page: its caller pages after it", async () => {
    const { fns } = await setup();
    const out = (await fns.runQuery("m:failedThenPage", {})) as { caught: string; page: number[] };
    expect(out.caught).toStartWith("Uncaught Error: after the page");
    expect(out.page).toEqual([0, 1]);
  });

  test("a callee's page is its caller's: its end cursor is the run's journal, and a re-run keeps its end", async () => {
    const { fns, engine } = await setup();
    const body = fns.queryBody("m:nested", {}, false);
    const first = await engine.queryTracked(body);
    expect(first).toMatchObject({ ok: true, value: [0, 1] });
    expect(typeof first.journal.endCursor).toBe("string");
    await fns.runMutation("m:seed", {});
    // The seed's rows again: the page holds the new 0, and ends at the first 1, as before.
    const again = await engine.queryTracked(body, first.journal);
    expect(again).toMatchObject({ ok: true, value: [0, 0, 1] });
    expect(again.journal.endCursor).toBe(first.journal.endCursor);
  });
});
