// A string with a lone surrogate in a write or a query (STUDY-135): Convex sends the value to Rust as
// `JSON.stringify` text and serde refuses the escape, so the call fails with "Received invalid json: …" and
// serde's column in that text. The columns are the ones Convex's local backend answered (STUDY-135 §1.2).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const H = "\ud800";
const L = "\udc00";

async function engine() {
  const schema = defineSchema({ a: defineTable(v.any()).index("by_k", ["k"]).index("by_k_n", ["k", "n"]) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
}

const END = (column: number) => `Received invalid json: unexpected end of hex escape at line 1 column ${column}`;
const LONE = (column: number) =>
  `Received invalid json: lone leading surrogate in hex escape at line 1 column ${column}`;

describe("writes", () => {
  test("db.insert: serde's message and column for each kind of lone surrogate", async () => {
    const e = await engine();
    const insert = (doc: Record<string, unknown>) => message(e.mutation((db) => db.insert("a", doc)));
    expect(await insert({ k: H })).toBe(END(34));
    expect(await insert({ k: L })).toBe(LONE(33));
    expect(await insert({ k: H + H })).toBe(LONE(39));
    expect(await insert({ k: L + H })).toBe(LONE(33));
    expect(await insert({ k: `a${H}b` })).toBe(END(35));
    expect(await insert({ x: 1, y: { z: [1, H] } })).toBe(END(48));
    // The text has its fields sorted, as Convex's `convexToJson` writes them.
    expect(await insert({ z: H, a: 1 })).toBe(END(40));
    // A valid pair is a character like any other.
    await e.mutation((db) => db.insert("a", { k: "😀" }));
    expect(await e.query((db) => db.query("a").collect())).toHaveLength(1);
  });

  test("db.patch and db.replace: the id comes first in the text", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("a", { k: "ok" }));
    // `{"id":"<id>","value":{"k":"` precedes the escape (62 for a 32-character id, as Convex answered).
    expect(await message(e.mutation((db) => db.patch("a", id, { k: H })))).toBe(END(id.length + 30));
    expect(await message(e.mutation((db) => db.replace("a", id, { k: H })))).toBe(END(id.length + 30));
    // A patch's `undefined` field is written as `{"$undefined":null}` before it, sorted with the others.
    expect(await message(e.mutation((db) => db.patch("a", id, { b: undefined, k: H })))).toBe(
      END(id.length + 30 + '"b":{"$undefined":null},'.length),
    );
    expect(await e.query((db) => db.get("a", id))).toMatchObject({ k: "ok" });
  });

  test("the error can be caught, and the mutation goes on", async () => {
    const e = await engine();
    const caught = await e.mutation(async (db) => {
      try {
        await db.insert("a", { k: H });
      } catch (err) {
        await db.insert("a", { k: "after" });
        return (err as Error).message;
      }
    });
    expect(caught).toBe(END(34));
    expect(await e.query((db) => db.query("a").collect())).toMatchObject([{ k: "after" }]);
  });
});

describe("queries", () => {
  // `{"query":{"source":…,"operators":[…]}…}`: the column moves with what precedes the value.
  test("withIndex and filter: Convex's columns (115 and 139)", async () => {
    const e = await engine();
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .withIndex("by_k", (q) => q.eq("k", H))
            .collect(),
        ),
      ),
    ).toBe(END(115));
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .filter((q) => q.eq(q.field("k"), H))
            .collect(),
        ),
      ),
    ).toBe(END(139));
  });

  test("the order, a later bound, take, first and paginate", async () => {
    const e = await engine();
    // `"order":"desc"` instead of `"order":null` comes before the operators: 2 more for a filter.
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .order("desc")
            .filter((q) => q.eq(q.field("k"), H))
            .collect(),
        ),
      ),
    ).toBe(END(141));
    // A second bound: `{"type":"Eq",…,"value":"x"},` before it.
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .withIndex("by_k_n", (q) => q.eq("k", "x").gt("n", H))
            .first(),
        ),
      ),
    ).toBe(END(115 + '{"type":"Eq","fieldPath":"k","value":"x"},'.length + 2));
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .withIndex("by_k", (q) => q.eq("k", L))
            .take(3),
        ),
      ),
    ).toBe(LONE(114));
    expect(
      await message(
        e.query((db) =>
          db
            .query("a")
            .withIndex("by_k", (q) => q.eq("k", H))
            .paginate({ numItems: 1, cursor: null }),
        ),
      ),
    ).toBe(END(115));
  });

  test("a query with no lone surrogate runs as before", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("a", { k: "😀" }));
    expect(
      await e.query((db) =>
        db
          .query("a")
          .withIndex("by_k", (q) => q.eq("k", "😀"))
          .collect(),
      ),
    ).toHaveLength(1);
  });
});
