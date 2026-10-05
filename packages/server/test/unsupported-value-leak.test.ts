// A function that hands the engine something that is not a value (a query, `ctx.db`, `ctx`, a class
// instance) gets an error that names it without opening it. Serialising it put the transaction (catalog,
// store state, writes, ids) in the error message, and that message reaches the client.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

class Vault {
  apiKey = "sk-live-SECRET-0123456789";
  store = { docs: Array.from({ length: 2000 }, (_, i) => ({ i, secret: `row-${i}-SECRET` })) };
}

// What the engine's objects hold, which no message may show.
const INTERNALS = /catalog|persistence|commits|leaseScope|SECRET|_tables/;

async function setup() {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), persistence).init();
  await engine.mutation(async (db) => {
    await db.insert("items", { secret: "OTHER-ROW-SECRET" });
  });
  const functions = new Functions(engine).register("m", {
    nestedQuery: query(({ db }) => ({ q: db.query("items") }) as never),
    db: query(({ db }) => db as never),
    ctx: query((ctx) => ctx as never),
    instance: query(() => ({ v: new Vault() }) as never),
    returnsQuery: query({ args: {}, returns: v.string(), handler: ({ db }) => db.query("items") as never }),
    withArgs: query({ args: {}, handler: () => null }),
    returnsDb: query({ args: {}, returns: v.string(), handler: ({ db }) => db as never }),
    returnsInstance: query({
      args: {},
      returns: v.object({ a: v.string() }),
      handler: () => ({ a: new Vault() }) as never,
    }),
    insertDb: mutation(async ({ db }) => {
      await db.insert("items", { db } as never);
    }),
    insertInstance: mutation(async ({ db }) => {
      await db.insert("items", { v: new Vault() } as never);
    }),
    argsNotObject: mutation(async (ctx) => {
      await ctx.runQuery("m:withArgs" as never, new Vault() as never);
    }),
    filterLiteral: query(({ db }) =>
      db
        .query("items")
        .filter((q) => q.add(q.field("n") as never, new Vault() as never) as never)
        .collect(),
    ),
    actionCtx: action((ctx) => ({ ctx }) as never),
  });
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const call = async (kind: string, path: string) => {
    const r = await fetch(`http://127.0.0.1:${server!.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {} }),
    });
    return (await r.json()) as { status: string; errorMessage: string };
  };
  return { call, engine };
}

describe("an unsupported value in a function's result, write or arguments", () => {
  test("the client's message names it and shows none of its internals", async () => {
    const { call, engine } = await setup();
    const cases: [string, string, string][] = [
      [
        "query",
        "m:nestedQuery",
        'QueryInitializerImpl {…} is not a supported value type (present at path .q in original object {"q":QueryInitializerImpl {…}}).',
      ],
      ["query", "m:db", "Tx {…} is not a supported value type."],
      ["query", "m:ctx", '"db":Tx {…}'],
      ["query", "m:instance", "Vault {…} is not a supported value type (present at path .v"],
      // A query object is refused before the validator, as Convex (its own message).
      ["query", "m:returnsQuery", "Return value is a Query."],
      [
        "query",
        "m:returnsDb",
        "ReturnsValidationError: Value does not match validator.\n\nValue: Tx {…}\nValidator: v.string()",
      ],
      ["query", "m:returnsInstance", "Value: Vault {…}\nValidator: v.string()"],
      ["mutation", "m:insertDb", "Tx {…} is not a supported value type (present at path .db"],
      ["mutation", "m:insertInstance", "Vault {…} is not a supported value type (present at path .v"],
      [
        "mutation",
        "m:argsNotObject",
        "Expected to receive an object as the function's argument. Instead received: Vault {…}",
      ],
      ["query", "m:filterLiteral", "Vault {…} (type object)"],
      ["action", "m:actionCtx", "is not a supported value type"],
    ];
    for (const [kind, path, expected] of cases) {
      const r = await call(kind, path);
      expect(r.status).toBe("error");
      // the message line, before the stack frames
      const line = r.errorMessage.split("\n    at ")[0];
      expect(line).toContain(expected);
      expect(line).not.toMatch(INTERNALS);
      expect(line.length).toBeLessThan(600);
    }
    // nothing the failed mutations tried to write committed
    expect((await engine.query((db) => db.query("items").collect())).length).toBe(1);
  });
});
