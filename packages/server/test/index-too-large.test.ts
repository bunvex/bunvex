// A write while an index's memory part is at its hard limit (STUDY-111, DV-228), as Convex's overloaded
// `TextIndexTooLarge` / `VectorIndexTooLarge`: HTTP 503 with its code and message; a sync mutation closes the
// session with 1013 and the code; an action's runMutation gets a plain Error it may catch; a scheduled mutation
// is retried later. The refusal wakes the flusher, and writes go through again once it has flushed.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const schema = defineSchema({
  notes: defineTable(v.any()).searchIndex("search_text", { searchField: "text" }),
});

const MESSAGE =
  "Too many writes to notes.search_text. Spread your writes out over time or throttle them to avoid errors. If you’re importing data into a new application, consider removing the index and adding it again after the import (you can re-add the index as a staged index to avoid blocking your pushes).";

function blobs(): SearchSegmentStore {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    put: async (d) => {
      const key = `k${++n}`;
      map.set(key, d);
      return key;
    },
    get: async (k) => map.get(k) ?? null,
    delete: async (k) => {
      map.delete(k);
    },
  };
}

/** An engine whose text memory part is never flushed by size, and refuses writes from 2000 bytes. */
async function full() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(schema, p, {
    searchStorage: blobs(),
    searchSegmentLimits: {
      textSoftLimitBytes: 2 ** 40,
      vectorSoftLimitBytes: 2 ** 40,
      textHardLimitBytes: 2000,
      vectorHardLimitBytes: 2000,
    },
  }).init();
  await engine.searchReady();
  stops.push(() => engine.close());
  const functions = new Functions(engine).register("m", {
    write: mutation(async ({ db }) => db.insert("notes", { text: "one more" })),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:write" as never, {} as never)),
    job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    viaAction: action(async ({ runMutation }) => {
      try {
        await runMutation("m:write" as never, {} as never);
        return "written";
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    }),
  });
  // Up to the limit: these writes go through (the limit is checked before each one).
  const index = () => engine.searchIndexes.all()[0]!.index;
  while (index().memoryBytes < 2000) await engine.mutation((db) => db.insert("notes", { text: "filler text here" }));
  return { engine, functions };
}

test("HTTP: 503 with the code and Convex's message; the write goes through once flushed", async () => {
  const { engine, functions } = await full();
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const call = () =>
    fetch(`http://127.0.0.1:${s.server.port}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:write", args: {} }),
    });
  const res = await call();
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ code: "TextIndexTooLarge", message: MESSAGE });
  await engine.searchFlushed();
  expect((await call()).status).toBe(200);
});

test("sync: the mutation closes the session with 1013 and the code", async () => {
  const { engine, functions } = await full();
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const c = await v1Client(syncUrl(s.server.port));
  stops.push(() => c.ws.close());
  c.mutate(1, "m:write");
  const closed = await c.closed;
  expect([closed.code, closed.reason]).toEqual([1013, "TextIndexTooLarge"]);
});

test("an action's runMutation: a plain Error with the message, which it may catch", async () => {
  const { functions } = await full();
  expect(await functions.runAction("m:viaAction", {})).toBe(`Error: ${MESSAGE}`);
});

test("a scheduled mutation is delayed, not failed", async () => {
  const { engine, functions } = await full();
  // Scheduling writes `_scheduled_functions` only: not refused.
  const id = (await functions.runMutation("m:later", {})) as string;
  const executor = new ScheduledJobExecutor(engine, functions, { errorInitialBackoffMs: 5, errorMaxBackoffMs: 20 });
  executor.start();
  stops.push(() => executor.stop());
  const kind = async () => ((await functions.runQuery("m:job", { id })) as { state: { kind: string } }).state.kind;
  for (let i = 0; i < 400 && (await kind()) !== "success"; i++) await Bun.sleep(10);
  expect(await kind()).toBe("success");
  expect(engine.searchStats.flushes).toBeGreaterThan(0);
});
