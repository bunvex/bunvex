// A written `_id` or `_creationTime` that is not the document's (STUDY-161 §4), as Convex's `ResolvedDocument::new`
// words it: the `_id` field as a value, the creation time's message with the value being written (the insert's or
// replacement's value, or the merged patch, each with its `_id`), in Convex's display. Checked against Convex's backend.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const engine = async () =>
  new Engine(
    defineSchema({ free: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
}

/** The message with the document's creation time and id named. */
const named = (text: string, id: string) =>
  text.replace(/^Provided creation time [\d.]+ /, "Provided creation time <t> ").replaceAll(id, "<id>");

test("insert: the value with its `_id`, the written `_creationTime` in Convex's display", async () => {
  const e = await engine();
  const [text, id] = await e.mutation(async (db) => {
    const t = await message(db.insert("free", { _creationTime: 1, k: 2, s: "a" }));
    // the id the insert would have had is the next one the table's number gives; read it back from the text
    return [t, /_id: "([^"]+)"/.exec(t)![1]!] as const;
  });
  expect(named(text, id)).toBe(
    `Provided creation time <t> doesn't match '_creationTime' field in {_creationTime: 1.0, _id: "<id>", k: 2.0, s: "a"}`,
  );
});

test("patch: the merged document; replace: the new value; an int64 shown bare", async () => {
  const e = await engine();
  const id = await e.mutation((db) => db.insert("free", { k: 1, gone: true }));
  expect(named(await message(e.mutation((db) => db.patch(id, { _creationTime: 1, gone: undefined }))), id)).toBe(
    `Provided creation time <t> doesn't match '_creationTime' field in {_creationTime: 1.0, _id: "<id>", k: 1.0}`,
  );
  expect(named(await message(e.mutation((db) => db.patch(id, { _creationTime: 1n as never }))), id)).toBe(
    `Provided creation time <t> doesn't match '_creationTime' field in {_creationTime: 1, _id: "<id>", gone: true, k: 1.0}`,
  );
  expect(named(await message(e.mutation((db) => db.replace(id, { _creationTime: "x", z: 2 }))), id)).toBe(
    `Provided creation time <t> doesn't match '_creationTime' field in {_creationTime: "x", _id: "<id>", z: 2.0}`,
  );
});

test("`_id`: the field as a value, before the creation time", async () => {
  const e = await engine();
  const id = await e.mutation((db) => db.insert("free", { k: 1 }));
  expect(await message(e.mutation((db) => db.patch(id, { _id: 1 as never })))).toBe(
    `Provided document ID "${id}" doesn't match '_id' field 1.0`,
  );
  expect(await message(e.mutation((db) => db.patch(id, { _id: "x" as never, _creationTime: 1 })))).toBe(
    `Provided document ID "${id}" doesn't match '_id' field "x"`,
  );
});
