// Search and vector indexes while they are rebuilt after a start (STUDY-79), as Convex's bootstrapping:
// `SearchIndexesUnavailable` / `VectorIndexesUnavailable`, a system error a query cannot catch, HTTP 503 with
// its code; an action gets a plain Error it may catch; a sync query is skipped (no modification) and run
// again later; a sync mutation closes the session with 1013 and the code.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, updated, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_text", { searchField: "text" })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 2 }),
});

/** An engine restarted on a store with data, its search and vector rebuild held until `release()`. */
async function restarted() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-bootstrap-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const first = await new Engine(schema, new SqlitePersistence(path, { durable: true })).init();
  await first.mutation((db) => db.insert("notes", { text: "hello world", embedding: [1, 0] }));
  await first.close();
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const engine = await new Engine(schema, new SqlitePersistence(path, { durable: true }), {
    beforeSearchBackfillPage: () => held,
  }).init();
  stops.push(() => engine.close());
  const functions = new Functions(engine).register("m", {
    find: query(async ({ db }, { text }: { text: string }) =>
      (
        await db
          .query("notes")
          .withSearchIndex("search_text", (q) => q.search("text", text))
          .collect()
      ).map((d) => d.text),
    ),
    findCaught: query(async ({ db }) => {
      try {
        await db
          .query("notes")
          .withSearchIndex("search_text", (q) => q.search("text", "hello"))
          .collect();
        return "found";
      } catch {
        return "caught";
      }
    }),
    findThenWrite: mutation(async ({ db }) => {
      await db
        .query("notes")
        .withSearchIndex("search_text", (q) => q.search("text", "hello"))
        .collect();
    }),
    write: mutation(async ({ db }) => db.insert("notes", { text: "written meanwhile", embedding: [0, 1] })),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:findThenWrite" as never, {} as never)),
    job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    nearest: action(async ({ vectorSearch }) => {
      try {
        return (await vectorSearch("notes", "by_embedding", { vector: [1, 0] })).length;
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    }),
  });
  return { engine, functions, release };
}

test("a query: Convex's message; the function cannot catch it; writes still work", async () => {
  const { engine, functions, release } = await restarted();
  await expect(functions.runQuery("m:find", { text: "hello" })).rejects.toMatchObject({
    code: "SearchIndexesUnavailable",
    message: "Search indexes bootstrapping and not yet available for use",
  });
  await expect(functions.runQuery("m:findCaught", {})).rejects.toMatchObject({ code: "SearchIndexesUnavailable" });
  // Empty searches find nothing, as Convex's, even now.
  expect(await functions.runQuery("m:find", { text: "" })).toEqual([]);
  // Writing to the table is fine; the rebuilt index has the write.
  await functions.runMutation("m:write", {});
  release();
  await engine.searchReady();
  expect(await functions.runQuery("m:find", { text: "meanwhile" })).toEqual(["written meanwhile"]);
  expect(await functions.runQuery("m:findCaught", {})).toBe("found");
});

test("an action's vectorSearch: a plain Error with Convex's message, which it may catch", async () => {
  const { engine, functions, release } = await restarted();
  expect(await functions.runAction("m:nearest", {})).toBe(
    "Error: Vector indexes are bootstrapping and not yet available for use",
  );
  release();
  await engine.searchReady();
  expect(await functions.runAction("m:nearest", {})).toBe(1);
});

test("the HTTP API answers 503 with the code and message", async () => {
  const { engine, functions } = await restarted();
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const res = await fetch(`http://127.0.0.1:${s.server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:find", args: { text: "hello" } }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    code: "SearchIndexesUnavailable",
    message: "Search indexes bootstrapping and not yet available for use",
  });
});

test("sync: the query is skipped, not failed, and answered once the index is rebuilt", async () => {
  const { engine, functions, release } = await restarted();
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  s.sync.unavailableRetryMs = 50;
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:find", { text: "hello" }), add(2, "m:find", { text: "" })]);
  const first = await c.transition(0);
  // The empty search answers; the other is skipped: no modification for it, the transition still sent.
  expect(first.modifications.map((m) => [m.type, "queryId" in m ? m.queryId : null])).toEqual([["QueryUpdated", 2]]);
  // Retried after the delay, still unavailable: nothing more is sent for it.
  await Bun.sleep(150);
  expect(c.transitions().flatMap((t) => t.modifications.filter((m) => m.type !== "QueryUpdated"))).toEqual([]);
  release();
  await engine.searchReady();
  const answered = await c.until(() => c.transitions().find((t) => updated(t)[1] !== undefined));
  expect(updated(answered)[1]).toEqual(["hello world"]);
});

test("sync: a mutation that needs the index closes the session with 1013 and the code", async () => {
  const { engine, functions } = await restarted();
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  c.mutate(1, "m:findThenWrite");
  const closed = await c.closed;
  expect([closed.code, closed.reason]).toEqual([1013, "SearchIndexesUnavailable"]);
});

test("a scheduled mutation that needs the index is delayed, not failed", async () => {
  const { engine, functions, release } = await restarted();
  const executor = new ScheduledJobExecutor(engine, functions, { errorInitialBackoffMs: 5, errorMaxBackoffMs: 20 });
  executor.start();
  stops.push(() => executor.stop());
  const id = (await functions.runMutation("m:later", {})) as string;
  const kind = async () => ((await functions.runQuery("m:job", { id })) as { state: { kind: string } }).state.kind;
  await Bun.sleep(100);
  expect(await kind()).toBe("pending");
  release();
  await engine.searchReady();
  for (let i = 0; i < 400 && (await kind()) !== "success"; i++) await Bun.sleep(10);
  expect(await kind()).toBe("success");
});
