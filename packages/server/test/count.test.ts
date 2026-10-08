// `db.query(table).count()` from an app's functions (STUDY-107): a subscription re-runs on a write to the
// table; while the table summaries are built, Convex's `TableSummariesUnavailable` — a system error the
// function cannot catch, HTTP 503 with its code, a sync query skipped and answered later.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, updated, v1Client } from "./v1-client.ts";

/** `count()` is internal: not in the public types, as Convex's. */
const count = (q: unknown) => (q as { count(): Promise<number> }).count();
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()), other: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { summaryCheckpoints: false }, // none written while the test unbuilds the summaries
  ).init();
  stops.push(() => engine.close());
  await engine.summariesReady();
  const functions = new Functions(engine).register("m", {
    count: query(async ({ db }) => count(db.query("items"))),
    countCaught: query(async ({ db }) => {
      try {
        return await count(db.query("items"));
      } catch {
        return "caught";
      }
    }),
    add: mutation(async ({ db }, { table }: { table: string }) => db.insert(table as never, {})),
    addAndCount: mutation(async ({ db }) => {
      await db.insert("items", {});
      return count(db.query("items"));
    }),
    churnThenFail: mutation(async ({ db }) => {
      await db.insert("items", {});
      await db.insert("items", {});
      const first = await db.query("items").first();
      if (first) await db.delete(first._id);
      throw new Error("rolled back");
    }),
    /** Counts around a nested mutation that writes, then fails and is caught. */
    nestedRollback: mutation(async ({ db, runMutation }) => {
      await db.insert("items", {});
      const before = await count(db.query("items"));
      try {
        await runMutation("m:churnThenFail" as never, {} as never);
      } catch {}
      return [before, await count(db.query("items"))];
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  return { engine, functions, s };
}

/** Make the summaries unbuilt, as at a start; the returned function finishes the build. */
function unbuilt(engine: Engine) {
  (engine.tableSummaries as unknown as { queued: unknown[] | null }).queued = [];
  return () => engine.tableSummaries.finish();
}

test("from an app's query and mutation, with the mutation's own insert", async () => {
  const { functions } = await setup();
  expect(await functions.runQuery("m:count", {})).toBe(0);
  expect(await functions.runMutation("m:addAndCount", {})).toBe(1);
  await functions.runMutation("m:add", { table: "items" });
  expect(await functions.runQuery("m:count", {})).toBe(2);
});

test("a nested mutation rolled back takes its inserts and deletes out of the caller's count (Convex aad76a4)", async () => {
  const { functions } = await setup();
  await functions.runMutation("m:add", { table: "items" });
  expect(await functions.runMutation("m:nestedRollback", {})).toEqual([2, 2]);
  expect(await functions.runQuery("m:count", {})).toBe(2);
});

test("sync: the subscription is re-run on a write to the table", async () => {
  const { functions, s } = await setup();
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:count")]);
  expect(updated(await c.transition(0))[1]).toBe(0);
  await functions.runMutation("m:add", { table: "items" });
  const next = await c.until(() => c.transitions().find((t) => updated(t)[1] === 1));
  expect(updated(next)[1]).toBe(1);
});

test("while the summaries are built: uncatchable, Convex's message; HTTP 503 with the code", async () => {
  const { engine, functions, s } = await setup();
  const finish = unbuilt(engine);
  const unavailable = { code: "TableSummariesUnavailable", message: "Table count unavailable while bootstrapping" };
  await expect(functions.runQuery("m:countCaught", {})).rejects.toMatchObject(unavailable);
  const res = await fetch(`http://127.0.0.1:${s.server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:count", args: {} }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual(unavailable);
  finish();
  expect(await functions.runQuery("m:countCaught", {})).toBe(0);
});

test("sync: while the summaries are built the query is skipped, then answered", async () => {
  const { engine, s } = await setup();
  const finish = unbuilt(engine);
  s.sync.unavailableRetryMs = 50;
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:count")]);
  const first = await c.transition(0);
  expect(updated(first)[1]).toBeUndefined();
  finish();
  const answered = await c.until(() => c.transitions().find((t) => updated(t)[1] !== undefined));
  expect(updated(answered)[1]).toBe(0);
});
