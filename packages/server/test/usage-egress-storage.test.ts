// Egress, storage and system-function usage (STUDY-71 PR 3), as Convex meters them: an isolate action's
// `fetch` request bodies (not headers, URL or response; nothing for a failed request; nothing for a Node
// action), its storage calls with the bytes stored and read; `dataEgressGb` and `functionCalls` from them;
// `_system/` functions' compute and bandwidth without their call.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import type { FunctionLog, UsageStats } from "../src/function-log.ts";
import { action, Functions, NODE_FUNCTIONS } from "../src/functions.ts";
import { FileStorage } from "../src/storage.ts";
import { UsageMeter } from "../src/usage-limits.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const server = Bun.serve({ port: 0, fetch: async (req) => new Response(`got ${(await req.text()).length}`) });
  stops.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}/x`;
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.mutation((db) => db.insert("items", { n: 1 }));
  const nodeFetch = action(async () => (await fetch(url, { method: "POST", body: "x".repeat(100) })).text());
  NODE_FUNCTIONS.add(nodeFetch);
  const functions = new Functions(engine).register("m", {
    fetches: action(async () => {
      await (await fetch(url, { method: "POST", body: "hello" })).text(); // 5
      await (await fetch(url, { method: "POST", body: new Uint8Array(7) })).text(); // 7
      await (await fetch(new Request(url, { method: "POST", body: "abc" }))).text(); // 3
      await (await fetch(url, { method: "POST", body: new Blob(["four"]) })).text(); // 4
      await (await fetch(url)).text(); // no body
      // A failed request is not charged.
      await fetch("http://127.0.0.1:1/", { method: "POST", body: "lost" }).catch(() => null);
      return null;
    }),
    nodeFetch,
    files: action(async ({ storage }) => {
      const id = await storage.store(new Blob(["0123456789"])); // 10 written
      const blob = await storage.get(id); // 10 read
      await storage.get(id); // 10 read
      return blob && null;
    }),
  });
  functions.fileStorage = new FileStorage(engine, new MemoryBlobStore(), "http://127.0.0.1:1");
  const meter = new UsageMeter();
  functions.usageMeter = meter;
  const runs: UsageStats[] = [];
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") runs.push(p.usageStats);
    },
  } as unknown as FunctionLog;
  return { functions, meter, last: () => runs.at(-1)!, logged: () => runs.length };
}

test("an action's fetch request bodies are its network egress, and dataEgressGb", async () => {
  const { functions, meter, last } = await setup();
  await functions.runAction("m:fetches", {});
  expect(last().networkEgressBytes).toBe(5 + 7 + 3 + 4);
  expect(meter.usage("dataEgressGb", "day")).toBe(19);
  expect(meter.usage("functionCalls", "day")).toBe(1);
});

test("a Node action's fetch is not metered, as Convex self-hosted", async () => {
  const { functions, meter, last } = await setup();
  await functions.runAction("m:nodeFetch", {});
  expect(last().networkEgressBytes).toBe(0);
  expect(meter.usage("dataEgressGb", "day")).toBe(0);
});

test("an action's storage calls: bytes stored and read, egress, and each call a function call", async () => {
  const { functions, meter, last } = await setup();
  await functions.runAction("m:files", {});
  expect(last()).toMatchObject({ storageWriteBytes: 10, storageReadBytes: 20, networkEgressBytes: 0 });
  expect(meter.usage("dataEgressGb", "day")).toBe(20);
  expect(meter.usage("functionCalls", "day")).toBe(1 + 3);
});

test("a system function is metered without its call, and not logged", async () => {
  const { functions, meter, logged } = await setup();
  const before = logged();
  await functions.runQuery("_system/cli/tables", { paginationOpts: { numItems: 10, cursor: null } }, false);
  expect(logged()).toBe(before);
  expect(meter.usage("functionCalls", "day")).toBe(0);
  // (Its compute is metered too, but a sub-millisecond run is 0 ms long, as Convex's `duration_millis`.)
  // Its reads of user tables are metered (the CLI's `data` reads the `items` document).
  await functions.runQuery(
    "_system/cli/tableData",
    { table: "items", order: "asc", paginationOpts: { numItems: 10, cursor: null } },
    false,
  );
  expect(meter.usage("databaseIoGb", "day")).toBeGreaterThan(0);
  expect(meter.usage("functionCalls", "day")).toBe(0);
});
