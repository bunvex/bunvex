// Table summaries (STUDY-52 PR 2), as Convex's TableSummary: count, size and counted shape per table, kept by
// every commit; removal lowers counts without narrowing a widened variant; built on start.
import { expect, test } from "bun:test";
import { v, valueSize } from "@bunvex/values";
import { defineSchema, defineTable, Engine, reduceShape } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { removeValue, ShapeRemovalError, shapeOf, tableShape } from "../src/shapes.ts";
import { TableSummaries, TableSummariesUnavailableError } from "../src/table-summaries.ts";

async function engine(p?: MemoryPersistence) {
  const e = await new Engine(
    defineSchema({ t: defineTable(v.any()) }),
    p ?? (await MemoryPersistence.open(null, { durable: false })),
  ).init();
  await e.summariesReady();
  return e;
}
const summary = (e: Engine) => e.tableSummaries.get(e.catalog.tables.get("t")!.id);
const shapeOfT = (e: Engine) => reduceShape(summary(e).shape, () => undefined);

test("inserts, patches and deletes keep the count, the size and the shape", async () => {
  const e = await engine();
  const [a, b] = await e.mutation(async (db) => [await db.insert("t", { x: 1n }), await db.insert("t", { x: "s" })]);
  expect(summary(e).count).toBe(2);
  const docs = await e.query((db) => db.query("t").collect());
  expect(summary(e).size).toBe(docs.reduce((n, d) => n + valueSize(d as never), 0));
  const fieldX = () =>
    (shapeOfT(e) as { fields: { fieldName: string; shape: unknown }[] }).fields.find((f) => f.fieldName === "x")!.shape;
  expect(fieldX()).toEqual({ type: "Union", shapes: [{ type: "Int64" }, { type: "String" }] });
  await e.mutation((db) => db.delete(b));
  expect(summary(e).count).toBe(1);
  expect(fieldX()).toEqual({ type: "Int64" }); // the variant's count reached 0
  await e.mutation((db) => db.patch(a, { x: 2.5 }));
  expect(fieldX()).toEqual({ type: "Float64", float64Range: { hasSpecialValues: false } });
  await e.mutation((db) => db.delete(a));
  expect(summary(e)).toEqual({ count: 0, size: 0, shape: { n: 0, v: { kind: "Never" } } });
});

test("removal never narrows a widened variant; an optional field present everywhere is required again", () => {
  const values = Array.from({ length: 17 }, (_, i) => `v${i}`);
  let s = tableShape(values as never);
  expect(s.v.kind).toBe("FieldName");
  for (const x of values.slice(1)) s = removeValue(s, x);
  expect(s).toEqual({ n: 1, v: { kind: "FieldName" } });
  // 17 kinds of object contract into one object with optional fields; removing all but the f0 ones makes
  // f0 required again and drops the fields with no values left.
  const objs = Array.from({ length: 17 }, (_, i) => ({ a: 1n, [`f${i}`]: 1n }));
  let o = tableShape([...objs, { a: 1n, f0: 2n }] as never);
  expect(o.v.kind).toBe("Object");
  for (const x of objs.slice(1)) o = removeValue(o, x as never);
  expect(reduceShape(o, () => undefined)).toEqual({
    type: "Object",
    fields: [
      { fieldName: "a", optional: false, shape: { type: "Int64" } },
      { fieldName: "f0", optional: false, shape: { type: "Int64" } },
    ],
  });
  expect(() => removeValue(shapeOf(1n), "x")).toThrow(ShapeRemovalError); // the value must be in the shape
  expect(() => removeValue(tableShape([[1n]] as never), "x")).toThrow(ShapeRemovalError);
});

test("countTable counts the transaction's own inserts and deletes", async () => {
  const e = await engine();
  const id = await e.mutation((db) => db.insert("t", {}));
  const counts = await e.mutation(async (db) => {
    const before = await db.asSystem(() => db.countTable("t"));
    await db.insert("t", {});
    await db.insert("t", {});
    await db.delete(id);
    return [before, await db.asSystem(() => db.countTable("t"))];
  });
  expect(counts).toEqual([1, 2]);
});

test("built on start from the documents already there; unavailable until then", async () => {
  const s = new TableSummaries();
  expect(() => s.get(1)).toThrow(TableSummariesUnavailableError);
  const p = await MemoryPersistence.open(null, { durable: false });
  const first = await engine(p);
  await first.mutation(async (db) => {
    for (let i = 0; i < 1500; i++) await db.insert("t", { i });
  });
  const second = await engine(p);
  expect(summary(second).count).toBe(1500);
});

test("commits that land while the summaries are being built are counted once", () => {
  const s = new TableSummaries();
  s.apply(5n, [{ tablet: 7, old: null, next: { _id: "a", _creationTime: 1, x: 1n } }]); // in the scan (ts ≤ 5)
  s.apply(9n, [{ tablet: 7, old: null, next: { _id: "b", _creationTime: 2, x: 2n } }]); // after it
  s.build(5n, 7, [{ _id: "a", _creationTime: 1, x: 1n }]);
  s.finish();
  expect(s.get(7).count).toBe(2);
});
