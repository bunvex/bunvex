// Vector search (STUDY-51), as Convex's: `vectorIndex` and its push-time checks, exact cosine similarity in
// f32 over L2-normalized vectors, `limit`, OR filters on the filter fields, Convex's errors and ordering,
// and an index kept up to date by commits.
import { expect, test } from "bun:test";
import { decodeId, v } from "@bunvex/values";
import { defineSchema, defineTable, Engine } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

const schema = () =>
  defineSchema({
    docs: defineTable(v.any())
      .index("by_kind", ["kind"])
      .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["kind", "lang"] })
      .vectorIndex("staged", { vectorField: "other", dimensions: 2, staged: true }),
  });

async function engine() {
  const e = await new Engine(schema(), await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  return e;
}

test("push-time checks, with Convex's messages", () => {
  const t = () => defineTable(v.any());
  expect(() => defineSchema({ a: t().vectorIndex("x", { vectorField: "e", dimensions: 1 }) })).toThrow(
    "Dimensions 1 must be between 2 and 4096.",
  );
  expect(() => defineSchema({ a: t().vectorIndex("x", { vectorField: "e", dimensions: 4097 }) })).toThrow(
    "Dimensions 4097 must be between 2 and 4096.",
  );
  const many = Array.from({ length: 17 }, (_, i) => `f${i}`);
  expect(() =>
    defineSchema({ a: t().vectorIndex("x", { vectorField: "e", dimensions: 2, filterFields: many }) }),
  ).toThrow("Search indexes may have up to 16 filter fields.");
  expect(() =>
    defineSchema({
      a: t()
        .vectorIndex("x", { vectorField: "e", dimensions: 2 })
        .vectorIndex("y", { vectorField: "e", dimensions: 2 }),
    }),
  ).toThrow('In table "a" vector index "x" and vector index "y" have the same `vectorField`.');
  // The same field with other dimensions is allowed.
  defineSchema({
    a: t().vectorIndex("x", { vectorField: "e", dimensions: 2 }).vectorIndex("y", { vectorField: "e", dimensions: 3 }),
  });
  expect(() =>
    defineSchema({ a: t().index("x", ["f"]).vectorIndex("x", { vectorField: "e", dimensions: 2 }) }),
  ).toThrow('Table "a" has two or more definitions of index "x".');
  expect(() => defineSchema({ a: t().vectorIndex("by_id", { vectorField: "e", dimensions: 2 }) })).toThrow(
    "because the name is reserved",
  );
});

test("nearest by cosine similarity in f32; documents without a fitting vector are left out", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    await db.insert("docs", { name: "x", embedding: [1, 0, 0] });
    await db.insert("docs", { name: "xy", embedding: [1, 1, 0] });
    await db.insert("docs", { name: "y", embedding: [0, 2, 0] });
    await db.insert("docs", { name: "short", embedding: [1, 0] });
    await db.insert("docs", { name: "int", embedding: [1n, 0, 0] });
    await db.insert("docs", { name: "none" });
  });
  const names = async (hits: { _id: string }[]) =>
    Promise.all(hits.map(async (h) => ((await e.query((db) => db.get(h._id))) as unknown as { name: string }).name));
  const hits = e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0] });
  expect(await names(hits)).toEqual(["x", "xy", "y"]);
  expect(hits[0]!._score).toBe(1);
  expect(hits[1]!._score).toBe(Math.fround(Math.fround(1 / Math.fround(Math.sqrt(2)))));
  expect(hits[2]!._score).toBe(0);
  expect(e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0], limit: 1 })).toHaveLength(1);
  expect(e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0], limit: 0 })).toEqual([]);
});

test("filters: q.eq values per field, fields ORed, values compared as Convex's (int64 ≠ float64)", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    await db.insert("docs", { kind: "a", lang: "en", embedding: [1, 0, 0] });
    await db.insert("docs", { kind: "b", lang: "pt", embedding: [1, 0, 0] });
    await db.insert("docs", { kind: 1n, embedding: [1, 0, 0] });
  });
  const count = (filter: unknown) => e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0], filter }).length;
  const eq = (f: string, x: unknown) => ({ $eq: [{ $field: f }, { $literal: x }] });
  expect(count(eq("kind", "a"))).toBe(1);
  expect(count({ $or: [eq("kind", "a"), eq("kind", "b")] })).toBe(2);
  expect(count({ $or: [eq("kind", "a"), eq("lang", "pt")] })).toBe(2);
  expect(count(eq("kind", 1n))).toBe(1);
  expect(count(eq("kind", 1))).toBe(0);
  expect(count(eq("lang", undefined))).toBe(1); // a missing field
  expect(() => count(eq("name", "x"))).toThrow(
    'Vector query against docs.by_embedding contains a filter on "name" but that field isn\'t indexed for filtering in `filterFields`.',
  );
  expect(() => count({ $and: [] })).toThrow("Filters should be a combination of `q.eq` and `q.or`.");
  const many = { $or: Array.from({ length: 65 }, (_, i) => eq("kind", `k${i}`)) };
  expect(() => count(many)).toThrow(
    "Vector query against docs.by_embedding has too many conditions. Max: 64 Actual: 65",
  );
});

test("Convex's errors; a missing table has no results", async () => {
  const e = await engine();
  const s = (index: string, q: { vector: number[]; limit?: number }) => () => e.vectorSearch("docs", index, q);
  expect(s("by_embedding", { vector: [1, 0] })).toThrow("Expected a vector with dimensions 3, received 2.");
  expect(s("by_embedding", { vector: new Array(4097).fill(0) })).toThrow(
    "Expected a vector with dimensions 4096, received 4097.",
  );
  expect(s("by_embedding", { vector: [1, 0, 0], limit: 257 })).toThrow(
    "Vector queries can fetch at most 256 results, requested 257.",
  );
  expect(s("nope", { vector: [1, 0, 0] })).toThrow("Index docs.nope not found.");
  expect(s("by_kind", { vector: [1, 0, 0] })).toThrow("Index docs.by_kind is not a vector index");
  expect(s("staged", { vector: [1, 0] })).toThrow("Index docs.staged is currently staged");
  expect(e.vectorSearch("nothing", "by_embedding", { vector: [1, 0, 0] })).toEqual([]);
});

test("commits update the index; equal scores order by internal id, descending", async () => {
  const e = await engine();
  const ids = await e.mutation(async (db) => [
    await db.insert("docs", { embedding: [1, 0, 0] }),
    await db.insert("docs", { embedding: [1, 0, 0] }),
    await db.insert("docs", { embedding: [1, 0, 0] }),
  ]);
  const hits = e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0] }).map((h) => h._id);
  const byInternalDesc = [...ids].sort((a, b) =>
    Buffer.compare(Buffer.from(decodeId(b).internalId), Buffer.from(decodeId(a).internalId)),
  );
  expect(hits).toEqual(byInternalDesc);
  await e.mutation(async (db) => {
    await db.delete(ids[0]!);
    await db.patch(ids[1]!, { embedding: [0, 1, 0] });
  });
  const after = e.vectorSearch("docs", "by_embedding", { vector: [1, 0, 0] });
  expect(after.map((h) => h._id)).toEqual([ids[2], ids[1]]);
  expect(after[1]!._score).toBe(0);
});

test("a vector index is backfilled from the documents already there", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const first = await new Engine(defineSchema({ docs: defineTable(v.any()) }), p).init();
  await first.mutation((db) => db.insert("docs", { embedding: [0, 0, 1] }));
  await first.close?.();
  const second = await new Engine(schema(), p).init();
  await second.searchReady();
  expect(second.vectorSearch("docs", "by_embedding", { vector: [0, 0, 1] })).toHaveLength(1);
});

test("vector indexes in the schema JSON: staged apart, filter fields sorted, round-trips", () => {
  const schema = defineSchema({
    docs: defineTable(v.any())
      .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["lang", "kind"] })
      .vectorIndex("staged", { vectorField: "other", dimensions: 2, staged: true }),
  });
  const json = schemaToJson(schema);
  expect(json.tables[0]).toMatchObject({
    vectorIndexes: [
      { indexDescriptor: "by_embedding", vectorField: "embedding", dimensions: 3, filterFields: ["kind", "lang"] },
    ],
    stagedVectorIndexes: [{ indexDescriptor: "staged", vectorField: "other", dimensions: 2, filterFields: [] }],
  });
  const back = schemaFromJson(json);
  expect(back.tables.get("docs")!.stagedVector).toEqual(["staged"]);
  expect(back.tables.get("docs")!.vectorIndexes!.by_embedding!.dimensions).toBe(3);
  expect(schemaToJson(back)).toEqual(json);
  // A table without vector indexes has no such keys, as Convex's optional fields.
  expect("vectorIndexes" in schemaToJson(defineSchema({ plain: defineTable({}) })).tables[0]!).toBe(false);
});
