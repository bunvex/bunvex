import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, Schema } from "../src/schema.ts";

async function engine() {
  return new Engine(
    new Schema().table("items", { by_n: ["n"] }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
}

describe("values are copied at the call (STUDY-10 D3, STUDY-08 D3)", () => {
  test("mutating an object after insert or patch does not change what is written", async () => {
    const e = await engine();
    const id = await e.mutation(async (db) => {
      const fields = { n: 1, tags: ["a"] };
      const id = await db.insert("items", fields);
      fields.n = 99;
      fields.tags.push("b");
      const patch = { extra: { deep: 1 } };
      await db.patch("items", id, patch);
      patch.extra.deep = 2;
      return id;
    });
    expect(await e.query((db) => db.get("items", id))).toMatchObject({ n: 1, tags: ["a"], extra: { deep: 1 } });
    const byN = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 1))
        .collect(),
    );
    expect(byN).toHaveLength(1); // the index agrees with the document
  });

  test("mutating a document read back in the same mutation does not change it", async () => {
    const e = await engine();
    const id = await e.mutation(async (db) => {
      const id = await db.insert("items", { n: 1 });
      const d = (await db.get("items", id)) as Doc;
      d.n = 5;
      return id;
    });
    expect(await e.query((db) => db.get("items", id))).toMatchObject({ n: 1 });
  });

  test("a cached query result mutated by one caller is intact for the next", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const q = (db: any) => db.query("items").collect();
    const first = (await e.query(q, "k")) as Doc[];
    first[0].n = 666;
    first.push({ _id: "x", _creationTime: 0 });
    const second = (await e.query(q, "k")) as Doc[];
    expect(second).toHaveLength(1);
    expect(second[0].n).toBe(1);
    expect(await e.queryJson(q, "k")).toBe(JSON.stringify(second));
  });
});
