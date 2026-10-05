// `.paginate()` at a transaction limit (STUDY-108) from an app's function: the page comes back split instead
// of the function failing; before any document, a first page is a system error the function cannot catch.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** Lower a function's documents-read limit (the transaction's own field; Convex's is a knob). */
const limitReads = (db: unknown, n: number) => {
  (db as { limits: { documentsRead: number } }).limits.documentsRead = n;
};

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  stops.push(() => engine.close());
  await engine.mutation(async (db) => {
    for (let n = 0; n < 10; n++) await db.insert("items", { n });
  });
  const functions = new Functions(engine).register("m", {
    page: query(async ({ db }, { limit }: { limit: number }) => {
      limitReads(db, limit);
      const p = await db.query("items").withIndex("by_n").paginate({ numItems: 8, cursor: null });
      return { n: p.page.map((d) => d.n), status: p.pageStatus, done: p.isDone };
    }),
    pageCaught: query(async ({ db }) => {
      limitReads(db, 0);
      try {
        await db.query("items").withIndex("by_n").paginate({ numItems: 8, cursor: null });
        return "paged";
      } catch {
        return "caught";
      }
    }),
    collect: query(async ({ db }) => {
      limitReads(db, 3);
      try {
        await db.query("items").collect();
        return null;
      } catch (e) {
        return { name: (e as Error).name, message: (e as Error).message, keys: Object.keys(e as Error) };
      }
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  return { functions, s };
}

test("from an app's query: the page is split at the limit, not failed", async () => {
  const { functions } = await setup();
  expect(await functions.runQuery("m:page", { limit: 3 })).toEqual({
    n: [0, 1, 2],
    status: "SplitRequired",
    done: false,
  });
});

test("outside paginate the app sees Convex's plain error, no code", async () => {
  const { functions } = await setup();
  expect(await functions.runQuery("m:collect", {})).toEqual({
    name: "Error",
    message:
      "Too many documents read in a single function execution (limit: 3). Consider using smaller limits in your queries, paginating your queries, or using indexed queries with a selective index range expressions.",
    keys: [],
  });
});

test("before any document: a system error the function cannot catch", async () => {
  const { s } = await setup();
  const res = await fetch(`http://127.0.0.1:${s.server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:pageCaught", args: {} }),
  });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    code: "InternalServerError",
    message: "Your request couldn't be completed. Try again later.",
  });
});
