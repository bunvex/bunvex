// The search and vector indexes of a table are grouped when the set changes (forTablet runs on every write):
// an index a push adds on another table indexes that table's new writes, and one it drops stops.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await f()); i++) await Bun.sleep(5);
};

test("a push adding a search index on another table: that table's new writes are searchable", async () => {
  const first = defineSchema({
    a: defineTable(v.any()).searchIndex("s", { searchField: "body" }),
    b: defineTable(v.any()),
  });
  const second = defineSchema({
    a: defineTable(v.any()).searchIndex("s", { searchField: "body" }),
    b: defineTable(v.any()).searchIndex("s", { searchField: "body" }),
  });
  const e = await new Engine(first, await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  await e.mutation((db) => db.insert("a", { body: "apple" }));
  const p = await e.startSchemaPush(second);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
  await e.searchReady();
  await e.mutation((db) => db.insert("b", { body: "banana" }));
  await e.mutation((db) => db.insert("a", { body: "avocado" }));
  const found = (table: "a" | "b", term: string) =>
    e.query(async (db) =>
      (
        await db
          .query(table)
          .withSearchIndex("s", (q) => q.search("body", term))
          .collect()
      ).map((d) => d.body),
    );
  expect(await found("b", "banana")).toEqual(["banana"]);
  expect(await found("a", "avocado")).toEqual(["avocado"]);
  await e.close();
});
