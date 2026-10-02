// Nested `ctx.runQuery` / `ctx.runMutation` in queries and mutations (STUDY-41), as Convex's `1.0/runUdf`:
// one transaction (the caller's writes, time and read set), a nested mutation rolled back when it throws,
// checks and the depth limit with Convex's messages, `useStaleSnapshot`, `transactionLimits`.
import { expect, test } from "bun:test";
import { CommitterStoppedError, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";

/** A named function, so its frame shows in the nested error. */
async function throwsBoom(): Promise<never> {
  throw new Error("boom");
}

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()), log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    names: internalQuery(async ({ db }) => (await db.query("items").collect()).map((d) => d.n)),
    countVia: query(async ({ runQuery }) => runQuery("m:count")),
    add: mutation(async ({ db }, { n }: { n: string }) => {
      await db.insert("items", { n });
    }),
    addThenFail: internalMutation(async ({ db }, { n }: { n: string }) => {
      await db.insert("items", { n });
      throw new BunvexError({ code: "nope", n });
    }),
    badReturn: mutation({
      args: { n: v.string() },
      returns: v.number(),
      handler: async ({ db }, { n }) => {
        await db.insert("items", { n });
        return n as unknown as number;
      },
    }),
    /** A mutation that writes, calls queries and mutations, and catches a failed one. */
    composite: mutation(async ({ db, runQuery, runMutation }) => {
      await db.insert("items", { n: "parent" });
      const seenBefore = await runQuery("m:count");
      await runMutation("m:add", { n: "child" });
      const seenAfter = await db.query("items").collect();
      let caught: unknown = null;
      try {
        await runMutation("m:addThenFail", { n: "rolled back" });
      } catch (e) {
        caught = {
          message: (e as Error).message,
          data: (e as BunvexError<never>).data,
          isBunvex: e instanceof BunvexError,
        };
      }
      const names = await runQuery("m:names");
      return { seenBefore, seenAfter: seenAfter.length, caught, names };
    }),
    keepsBadReturnWrites: mutation(async ({ runMutation }) => {
      try {
        await runMutation("m:badReturn", { n: "kept" });
      } catch (e) {
        return (e as Error).message;
      }
    }),
    errors: mutation(async ({ runQuery, runMutation }) => {
      const out: string[] = [];
      for (const f of [
        () => runQuery("m:add", { n: "x" }),
        () => runMutation("m:count"),
        () => runQuery("m:nope"),
        () => runMutation("m:badReturn", { n: 1 }),
      ])
        try {
          await f();
        } catch (e) {
          out.push((e as Error).message);
        }
      return out;
    }),
    queryCannotMutate: query(async (ctx) => typeof (ctx as { runMutation?: unknown }).runMutation),
    deep: query(async ({ runQuery }, { level }: { level: number }) =>
      level === 0 ? "bottom" : runQuery("m:deep", { level: level - 1 }),
    ),
    stale: mutation(async ({ db, runQuery }) => {
      await db.insert("items", { n: "pending" });
      return {
        fresh: await runQuery("m:count"),
        stale: await runQuery("m:count", {}, { useStaleSnapshot: true }),
      };
    }),
    staleFromQuery: query(async ({ runQuery }) => {
      try {
        await (runQuery as (n: string, a: object, o: object) => Promise<unknown>)(
          "m:count",
          {},
          { useStaleSnapshot: true },
        );
      } catch (e) {
        return (e as Error).message;
      }
    }),
    limited: query(async ({ runQuery }) => {
      try {
        return await runQuery("m:count", {}, { transactionLimits: { documentsRead: 2 } });
      } catch (e) {
        return (e as Error).message;
      }
    }),
    time: query(async ({ runQuery }) => ({ outer: Date.now(), inner: await runQuery("m:now") })),
    now: query(async () => Date.now()),
    serialized: mutation(async ({ runMutation, runQuery }) => {
      await Promise.all([runMutation("m:addCount"), runMutation("m:addCount"), runMutation("m:addCount")]);
      return runQuery("m:names");
    }),
    newTableThenFail: internalMutation(async ({ db }) => {
      await db.insert("fresh", { n: 1 });
      throw new Error("no");
    }),
    tryNewTable: mutation(async ({ db, runMutation }) => {
      await db.insert("items", { n: "kept" });
      await runMutation("m:newTableThenFail").catch(() => {});
    }),
    /** A nested function whose error has a stack frame of its own. */
    boom: internalQuery(async () => throwsBoom()),
    catchesBoom: query(async ({ runQuery }) => {
      try {
        await runQuery("m:boom");
      } catch (e) {
        return (e as Error).message;
      }
    }),
    /** Two reads in a nested call allowed one database query. */
    twoReads: internalQuery(async ({ db }) => {
      await db.query("items").collect();
      await db.query("log").collect();
      return "read";
    }),
    queriesLimited: query(async ({ db, runQuery }) => {
      try {
        await runQuery("m:twoReads", {}, { transactionLimits: { databaseQueries: 1 } });
      } catch (e) {
        // The caller's own limit is back: it can read more.
        await db.query("items").collect();
        await db.query("log").collect();
        return (e as Error).message;
      }
    }),
    scheduleTwo: internalMutation(async ({ scheduler }, { bytes }: { bytes?: boolean }) => {
      await scheduler.runAfter(1000, "m:count", bytes ? { pad: "x".repeat(40) } : {});
      await scheduler.runAfter(1000, "m:count", {});
    }),
    schedulingLimited: mutation(async ({ runMutation, scheduler }) => {
      const out: string[] = [];
      for (const limits of [{ functionsScheduled: 1 }, { scheduledFunctionArgsBytes: 30 }])
        try {
          await runMutation(
            "m:scheduleTwo",
            { bytes: "scheduledFunctionArgsBytes" in limits },
            { transactionLimits: limits },
          );
        } catch (e) {
          out.push((e as Error).message.split("\n")[0]!);
        }
      // Restored: the caller schedules as many as it likes.
      await scheduler.runAfter(1000, "m:count", {});
      await scheduler.runAfter(1000, "m:count", {});
      return out;
    }),
    /** A store failure inside a nested call: the caller cannot catch it. */
    storeFails: internalQuery(async () => {
      throw new CommitterStoppedError(new Error("disk gone"));
    }),
    catchesStoreFailure: query(async ({ runQuery }) => {
      try {
        await runQuery("m:storeFails");
      } catch {
        return "caught";
      }
    }),
    addCount: internalMutation(async ({ db }) => {
      const n = (await db.query("items").collect()).length;
      await Bun.sleep(1);
      await db.insert("items", { n: `#${n}` });
    }),
  });
  return { engine, fns };
}

test("one transaction: a nested query sees the caller's writes, the caller sees a nested mutation's; a failed one is rolled back", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runMutation("m:composite", {})).toEqual({
    seenBefore: 1,
    seenAfter: 2,
    caught: { message: '{"code":"nope","n":"rolled back"}', data: { code: "nope", n: "rolled back" }, isBunvex: true },
    names: ["parent", "child"],
  });
  // The caller caught the failure and committed: its writes and the first nested mutation's are there.
  expect(await fns.runQuery("m:names", {}, false)).toEqual(["parent", "child"]);
  await engine.close();
});

test("a nested result that fails its returns check keeps its writes, as Convex", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runMutation("m:keepsBadReturnWrites", {})).toStartWith("ReturnsValidationError:");
  expect(await fns.runQuery("m:names", {}, false)).toEqual(["kept"]);
  await engine.close();
});

test("Convex's messages: wrong kind, missing function, arguments; a query has no runMutation", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runMutation("m:errors", {})).toEqual([
    "Trying to execute m.js:add as Query, but it is defined as Mutation.",
    "Trying to execute m.js:count as Mutation, but it is defined as Query.",
    "Could not find public function for 'm:nope'.",
    expect.stringContaining("ArgumentValidationError:"),
  ]);
  expect(await fns.runQuery("m:queryCannotMutate", {})).toBe("undefined");
  await engine.close();
});

test("the depth limit: 8 nested levels, then Convex's message", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runQuery("m:deep", { level: 8 })).toBe("bottom");
  await expect(fns.runQuery("m:deep", { level: 9 })).rejects.toThrow(
    "Cross component call depth limit exceeded. Do you have an infinite loop in your app?",
  );
  await engine.close();
});

test("useStaleSnapshot: the transaction's snapshot without its writes; refused from a query", async () => {
  const { engine, fns } = await setup();
  await fns.runMutation("m:add", { n: "committed" });
  expect(await fns.runMutation("m:stale", {})).toEqual({ fresh: 2, stale: 1 });
  expect(await fns.runQuery("m:staleFromQuery", {})).toBe(
    "`useStaleSnapshot` is only supported in mutations, not queries.",
  );
  await engine.close();
});

test("transactionLimits lowers the nested call's limits; the caller's are restored", async () => {
  const { engine, fns } = await setup();
  for (const n of ["a", "b", "c"]) await fns.runMutation("m:add", { n });
  expect(await fns.runQuery("m:limited", {})).toStartWith(
    "Uncaught Error: Too many documents read in a single function execution (limit: 2).",
  );
  expect(await fns.runQuery("m:countVia", {})).toBe(3);
  await engine.close();
});

test("the same time; concurrent nested calls run one at a time, in order", async () => {
  const { engine, fns } = await setup();
  const t = (await fns.runQuery("m:time", {})) as { outer: number; inner: number };
  expect(t.inner).toBe(t.outer);
  expect(await fns.runMutation("m:serialized", {})).toEqual(["#0", "#1", "#2"]);
  await engine.close();
});

test("a nested query's reads are the caller's: its cached result is invalidated by a write to them", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runQuery("m:countVia", {})).toBe(0);
  expect(await fns.runQuery("m:countVia", {})).toBe(0); // cached
  await fns.runMutation("m:add", { n: "x" });
  expect(await fns.runQuery("m:countVia", {})).toBe(1);
  await engine.close();
});

test("a rolled-back nested mutation leaves no table it created", async () => {
  const { engine, fns } = await setup();
  await fns.runMutation("m:tryNewTable", {});
  expect(engine.catalog.tables.has("fresh")).toBe(false);
  expect(await fns.runQuery("m:names", {}, false)).toEqual(["kept"]);
  await engine.close();
});

test("a nested error reaches the caller as Convex's JsError display: the uncaught line and the nested frames (N2)", async () => {
  const { engine, fns } = await setup();
  const message = (await fns.runQuery("m:catchesBoom", {})) as string;
  expect(message).toStartWith("Uncaught Error: boom\n    at throwsBoom (");
  expect(message).toEndWith("\n");
  await engine.close();
});

test("transactionLimits budgets database queries, scheduled functions and their argument bytes (N3)", async () => {
  const { engine, fns } = await setup();
  expect(await fns.runQuery("m:queriesLimited", {})).toStartWith(
    "Uncaught Error: Too many reads in a single function execution (limit: 1).",
  );
  expect(await fns.runMutation("m:schedulingLimited", {})).toEqual([
    "Uncaught Error: Too many functions scheduled by this mutation (limit: 1)",
    // 30 on top of the 4 bytes the first, rolled-back call scheduled: as Convex, a rollback does not give
    // back scheduling usage (`scheduled_size` is not part of a subtransaction).
    "Uncaught Error: Too large total size of the arguments of scheduled functions from this mutation (limit: 34 bytes)",
  ]);
  await engine.close();
});

test("a store failure inside a nested call cannot be caught: the whole call fails (N6)", async () => {
  const { engine, fns } = await setup();
  await expect(fns.runQuery("m:catchesStoreFailure", {})).rejects.toBeInstanceOf(CommitterStoppedError);
  await engine.close();
});
