// A filter's errors name a value's type as Convex's `type_name` does (STUDY-161 §14): `Null`, `Int64`, `Float64`,
// `Boolean`, `String`, `Bytes`, `Array`, `Object`, and `undefined` for a missing field. Each checked against Convex's
// backend (`Cannot negate …`, `Cannot use value … as a Boolean`, `Cannot add … and …`).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await e.mutation((db) => db.insert("items", { k: 1 }));
  return e;
}

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not fail");
}

// biome-ignore lint/suspicious/noExplicitAny: a filter builder over any document
type Q = any;

test("each type's name in Convex's words", async () => {
  const e = await engine();
  const run = (f: (q: Q) => unknown) =>
    message(
      e.query((db) =>
        db
          .query("items")
          .filter(f as never)
          .collect(),
      ),
    );
  const cases: [unknown, string][] = [
    [null, "null (type Null)"],
    [true, "true (type Boolean)"],
    ["s", '"s" (type String)'],
    [new Uint8Array([1, 2]).buffer, 'b"AQI=" (type Bytes)'],
    [[1], "[1.0] (type Array)"],
    [{ a: 1 }, "{a: 1.0} (type Object)"],
  ];
  for (const [x, shown] of cases) expect(await run((q) => q.eq(q.neg(x), 0))).toBe(`Cannot negate ${shown}`);
  expect(await run((q) => q.eq(q.neg(q.field("missing")), 0))).toBe("Cannot negate undefined (type undefined)");
  expect(await run(() => 1.5)).toBe("Cannot use value 1.5 (type Float64) as a Boolean");
  expect(await run((q) => q.eq(q.mul(1n, 1.5), 0))).toBe("Cannot multiply 1 (type Int64) and 1.5 (type Float64)");
  expect(await run((q) => q.eq(q.add("s", [1]), 0))).toBe('Cannot add "s" (type String) and [1.0] (type Array)');
});
