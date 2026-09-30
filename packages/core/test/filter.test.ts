import { describe, expect, test } from "bun:test";
import { compareValues, v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}
const ns = (docs: Doc[]) => docs.map((d) => d.n);

describe(".filter() with the filter builder (STUDY-15)", () => {
  test("comparisons, missing fields and boolean operators", async () => {
    const e = await engine();
    for (const d of [{ n: 1, c: "a" }, { n: 2, c: "b" }, { n: 3 }, { n: 4, c: null }])
      await e.mutation((db) => db.insert("items", d));
    const f = (p: (q: any) => any) => e.query((db) => db.query("items").filter(p).collect()).then(ns);
    expect(await f((q) => q.eq(q.field("c"), "a"))).toEqual([1]);
    expect(await f((q) => q.neq(q.field("c"), "a"))).toEqual([2, 3, 4]);
    expect(await f((q) => q.eq(q.field("c"), undefined))).toEqual([3]); // missing, not null
    expect(await f((q) => q.eq(q.field("c"), null))).toEqual([4]);
    expect(await f((q) => q.and(q.gte(q.field("n"), 2), q.lt(q.field("n"), 4)))).toEqual([2, 3]);
    expect(await f((q) => q.or(q.eq(q.field("n"), 1), q.not(q.lt(q.field("n"), 4))))).toEqual([1, 4]);
    // Cross-type comparisons follow index order: every string sorts above every number.
    expect(await f((q) => q.gt(q.field("c"), 999))).toEqual([1, 2]);
  });

  test("arithmetic on two int64s or two float64s, with Convex's errors", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 5, big: 10n }));
    const one = (p: (q: any) => any) => e.query((db) => db.query("items").filter(p).collect()).then(ns);
    expect(await one((q) => q.eq(q.add(q.field("n"), 1), 6))).toEqual([5]);
    expect(await one((q) => q.eq(q.mod(q.field("big"), 3n), 1n))).toEqual([5]);
    expect(await one((q) => q.eq(q.neg(q.field("big")), -10n))).toEqual([5]);
    await expect(one((q) => q.eq(q.add(q.field("big"), 1), 11))).rejects.toThrow(
      "Cannot add 10 (type int64) and 1.0 (type float64)",
    );
    await expect(one((q) => q.eq(q.div(q.field("big"), 0n), 1n))).rejects.toThrow("Cannot divide 10 by zero");
    await expect(one((q) => q.mul(q.field("big"), 2n ** 62n))).rejects.toThrow("out of range for Int64");
    await expect(one((q) => q.field("n"))).rejects.toThrow("Cannot use value 5.0 (type float64) as a Boolean");
  });

  test("take(n) keeps reading past the first pages until n documents pass", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      for (let i = 0; i < 700; i++) await db.insert("items", { n: i, hit: i >= 690 });
    });
    const got = await e.query((db) =>
      db
        .query("items")
        .filter((q) => q.eq(q.field("hit"), true))
        .take(3),
    );
    expect(ns(got)).toEqual([690, 691, 692]);
    const desc = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (r) => r.lt("n", 695))
        .order("desc")
        .filter((q) => q.eq(q.field("hit"), true))
        .first(),
    );
    expect(desc?.n).toBe(694);
  });

  test("property: filters over pages equal a model, with this mutation's writes merged in", async () => {
    let seed = 11;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const e = await engine();
    const model = new Map<string, Doc>();
    await e.mutation(async (db) => {
      for (let i = 0; i < 400; i++) {
        const id = await db.insert("items", { n: rnd(50), m: rnd(7) });
        model.set(id, (await db.get("items", id)) as Doc);
      }
    });
    const bad = await e.mutation(async (db) => {
      let mismatches = 0;
      for (let round = 0; round < 40; round++) {
        const ids = [...model.keys()];
        const op = rnd(3);
        if (op === 0) {
          const id = await db.insert("items", { n: rnd(50), m: rnd(7) });
          model.set(id, (await db.get("items", id)) as Doc);
        } else if (op === 1) {
          const id = ids[rnd(ids.length)];
          await db.patch("items", id, { m: rnd(7) });
          model.set(id, (await db.get("items", id)) as Doc);
        } else {
          const id = ids[rnd(ids.length)];
          await db.delete("items", id);
          model.delete(id);
        }
        const m = rnd(7);
        const lo = rnd(50);
        const desc = rnd(2) === 1;
        const limit = 1 + rnd(120);
        const got = await db
          .query("items")
          .withIndex("by_n", (r) => r.gte("n", lo))
          .order(desc ? "desc" : "asc")
          .filter((q) => q.neq(q.field("m"), m))
          .take(limit);
        const want = [...model.values()]
          .filter((d) => (d.n as number) >= lo && d.m !== m)
          .sort(
            (a, b) =>
              compareValues(a.n as number, b.n as number) ||
              a._creationTime - b._creationTime ||
              (a._id < b._id ? -1 : 1),
          );
        if (desc) want.reverse();
        if (JSON.stringify(got.map((d: Doc) => d._id)) !== JSON.stringify(want.slice(0, limit).map((d) => d._id)))
          mismatches++;
      }
      return mismatches;
    });
    expect(bad).toBe(0);
  });

  test("several filters combine with AND", async () => {
    const e = await engine();
    for (let i = 0; i < 10; i++) await e.mutation((db) => db.insert("items", { n: i }));
    const got = await e.query((db) =>
      db
        .query("items")
        .filter((q) => q.gt(q.field("n"), 2))
        .filter((q) => q.lt(q.field("n"), 5))
        .collect(),
    );
    expect(ns(got)).toEqual([3, 4]);
  });
});
