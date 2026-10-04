// Search usage (STUDY-71 PR 4): a text search is charged its index's indexed bytes (DV-317: each document's
// search field and filter values, Convex's `estimate_size`); a vector search its vectors × dimensions × 4,
// and each result 37 bytes of vector egress (in the v1 database read bytes, not the v2); writes their text
// and vector index sizes; `searchQueryGb` sums the searches.
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import type { FunctionLog, UsageStats } from "../src/function-log.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { UsageMeter } from "../src/usage-limits.ts";

/** A text document's metered bytes: the body's UTF-8 bytes and `kind`'s sort key (tag, bytes, terminator). */
const textBytes = (body: string, kind: string) => Buffer.byteLength(body) + (kind.length + 2);

async function setup() {
  const engine = await new Engine(
    defineSchema({
      notes: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["kind"] }),
      points: defineTable(v.any()).vectorIndex("by_v", { vectorField: "v", dimensions: 3 }),
    }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await engine.searchReady();
  const runs: UsageStats[] = [];
  const functions = new Functions(engine).register("m", {
    note: mutation(({ db }, { body, kind }: { body: string; kind: string }) => db.insert("notes", { body, kind })),
    edit: mutation(({ db }, { id, body }: { id: string; body: string }) => db.patch(id as never, { body })),
    drop: mutation(({ db }, { id }: { id: string }) => db.delete(id as never)),
    point: mutation(({ db }, { v }: { v?: number[] }) => db.insert("points", v ? { v } : {})),
    search: query(({ db }, { q }: { q: string }) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (s) => s.search("body", q))
        .collect(),
    ),
    nearest: action(({ vectorSearch }) => vectorSearch("points", "by_v", { vector: [1, 0, 0], limit: 1 })),
  });
  const meter = new UsageMeter();
  functions.usageMeter = meter;
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") runs.push(p.usageStats);
    },
  } as unknown as FunctionLog;
  return { functions, meter, last: () => runs.at(-1)! };
}

test("text: a write is its indexed bytes; a search is charged every indexed document's", async () => {
  const { functions, meter, last } = await setup();
  await functions.runMutation("m:note", { body: "hello world", kind: "a" });
  expect(last().textIndexWriteQueryBytes).toBe(textBytes("hello world", "a"));
  await functions.runMutation("m:note", { body: "olá mundo", kind: "bb" });
  const indexed = textBytes("hello world", "a") + textBytes("olá mundo", "bb");
  const hits = (await functions.runQuery("m:search", { q: "hello" })) as unknown[];
  expect(hits).toHaveLength(1);
  // The whole index, whatever matched.
  expect(last().textIndexQueryBytes).toBe(indexed);
  expect(meter.usage("searchQueryGb", "day")).toBe(indexed / 2 ** 30);
  await functions.runQuery("m:search", { q: "" });
  expect(last().textIndexQueryBytes).toBe(0);
  // An edit replaces the document's bytes; a delete removes them.
  const id = (await functions.runMutation("m:note", { body: "x", kind: "a" })) as string;
  await functions.runMutation("m:edit", { id, body: "a longer body" });
  // (A new term each time: a cached query has no usage, as Convex's.)
  await functions.runQuery("m:search", { q: "world" });
  expect(last().textIndexQueryBytes).toBe(indexed + textBytes("a longer body", "a"));
  await functions.runMutation("m:drop", { id });
  await functions.runQuery("m:search", { q: "mundo" });
  expect(last().textIndexQueryBytes).toBe(indexed);
});

test("vector: a write in the index is its vector and id; a search its vectors × dimensions × 4", async () => {
  const { functions, meter, last } = await setup();
  await functions.runMutation("m:point", { v: [1, 0, 0] });
  expect(last()).toMatchObject({ vectorIndexWriteQueryBytes: 3 * 4 + 33 });
  expect(last().vectorIndexWriteBytes).toBe(last().databaseWriteBytes);
  await functions.runMutation("m:point", { v: [0, 1, 0] });
  // Not in the index: no vector bytes.
  await functions.runMutation("m:point", {});
  expect(last()).toMatchObject({ vectorIndexWriteQueryBytes: 0, vectorIndexWriteBytes: 0 });
  await functions.runAction("m:nearest", {});
  expect(last()).toMatchObject({
    vectorIndexReadQueryBytes: 2 * 3 * 4,
    vectorIndexReadBytes: 37,
    databaseReadBytes: 37,
    databaseIoReadBytes: 0,
  });
  expect(meter.usage("searchQueryGb", "day")).toBe((2 * 3 * 4) / 2 ** 30);
});
