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
        body: JSON.stringify({ path, args }),
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
