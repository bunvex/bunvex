// An index range selects exactly what the same comparison as a filter selects (TEST-01 §2): for random
// documents and a random bound, `withIndex(q => q.eq | gt | gte | lt | lte("n", c))` must return the
// documents whose `n` compares to `c` that way — no more (an eq range reaching values that merely start
// with c, like "\0…" for "", {"": x} for {}), no fewer (gt("") skipping "\0…"). Regression for the
// escaped-prefix bug (DV-310).
import { expect, test } from "bun:test";
import { compareValues, v } from "@bunvex/values";
import fc from "fast-check";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { runs } from "./property-runs.ts";
import { value } from "./value-arbitraries.ts";

// Values that end where another begins: the cases the escape byte decides.
const tricky = fc.constantFrom<unknown>(
  "",
  "\0",
  "\0x",
  "a",
  "a\0",
  {},
  { "": 1 },
  { "": "" },
  new ArrayBuffer(0),
  new Uint8Array([0]).buffer,
  [],
  [null],
);
const n = fc.oneof(tricky, value);
const op = fc.constantFrom("eq", "gt", "gte", "lt", "lte") as fc.Arbitrary<"eq" | "gt" | "gte" | "lt" | "lte">;
const holds = {
  eq: (c: number) => c === 0,
  gt: (c: number) => c > 0,
  gte: (c: number) => c >= 0,
  lt: (c: number) => c < 0,
  lte: (c: number) => c <= 0,
};

test("withIndex(eq | gt | gte | lt | lte) returns exactly the documents the comparison holds for", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(n, { minLength: 1, maxLength: 8 }), n, op, async (ns, c, o) => {
      const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
      const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
      for (const x of ns) await e.mutation((db) => db.insert("items", { n: x as never }));
      const got = await e.query((db) =>
        db
          .query("items")
          .withIndex("by_n", (q) => q[o]("n", c as never))
          .collect(),
      );
      const all = await e.query((db) => db.query("items").collect());
      const want = all.filter((d: Doc) => holds[o](compareValues(d.n as never, c as never)));
      expect(got.map((d: Doc) => d._id).sort()).toEqual(want.map((d: Doc) => d._id).sort());
    }),
    { numRuns: runs(150) },
  );
});
