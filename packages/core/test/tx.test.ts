import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, Schema } from "../src/schema.ts";
import type { IndexRangeBuilder, Tx } from "../src/tx.ts";

async function engine() {
  const schema = new Schema().table("items", { by_n: ["n"] });
  return new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
}

const ns = (docs: Doc[]) => docs.map((d) => d.n);

describe("read-own-writes inside a mutation", () => {
  test("an insert is seen by a later query of the same mutation", async () => {
    const e = await engine();
    const seen = await e.mutation(async (db) => {
      await db.insert("items", { n: 2 });
      await db.insert("items", { n: 1 });
      return ns(await db.query("items").withIndex("by_n").collect());
    });
    expect(seen).toEqual([1, 2]);
  });

  test("a delete hides the document, from index ranges and from get", async () => {
    const e = await engine();
    const id = await e.mutation((db) => db.insert("items", { n: 5 }));
    const seen = await e.mutation(async (db) => {
      await db.delete("items", id);
      return {
        byN: await db.query("items").withIndex("by_n").collect(),
        byTime: await db.query("items").collect(),
        get: await db.get("items", id),
      };
    });
    expect(seen).toEqual({ byN: [], byTime: [], get: null });
  });

  test("a patch moves the document out of one range and into another, reordering", async () => {
    const e = await engine();
    const a = await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.mutation((db) => db.insert("items", { n: 2 }));
    const seen = await e.mutation(async (db) => {
      await db.patch("items", a, { n: 9 });
      return {
        low: ns(
          await db
            .query("items")
            .withIndex("by_n", (q) => q.lt("n", 5))
            .collect(),
        ),
        high: ns(
          await db
            .query("items")
            .withIndex("by_n", (q) => q.gte("n", 5))
            .collect(),
        ),
        all: ns(await db.query("items").withIndex("by_n").order("desc").collect()),
      };
    });
    expect(seen).toEqual({ low: [2], high: [9], all: [9, 2] });
  });

  test("take(n) and first() fill up past the entries this mutation removed", async () => {
    const e = await engine();
    const ids: string[] = [];
    for (let n = 1; n <= 6; n++) ids.push(await e.mutation((db) => db.insert("items", { n })));
    const seen = await e.mutation(async (db) => {
      await db.delete("items", ids[0]);
      await db.patch("items", ids[1], { n: 100 });
      await db.insert("items", { n: 3.5 });
      return {
        take3: ns(await db.query("items").withIndex("by_n").take(3)),
        first: (await db.query("items").withIndex("by_n").order("desc").first())?.n,
      };
    });
    expect(seen).toEqual({ take3: [3, 3.5, 4], first: 100 });
  });

  test("a document written twice in one mutation appears once, at its latest key", async () => {
    const e = await engine();
    const seen = await e.mutation(async (db) => {
      const id = await db.insert("items", { n: 1 });
      await db.patch("items", id, { n: 7 });
      await db.patch("items", id, { n: 3 });
      return ns(await db.query("items").withIndex("by_n").collect());
    });
    expect(seen).toEqual([3]);
  });

  test("property: every query inside a mutation equals a reference model of its own view", async () => {
    // Random writes interleaved with random queries; the model is the snapshot plus this mutation's
    // writes. After the commit, the same queries run as plain queries must see exactly the same.
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const e = await engine();
    const model = new Map<string, Doc>();
    for (let i = 0; i < 30; i++) {
      const n = rnd(10);
      const id = await e.mutation((db) => db.insert("items", { n }));
      const doc = await e.query((db) => db.get("items", id));
      model.set(id, doc as Doc);
    }

    type Q = {
      index: "by_n" | "by_creation_time";
      eq?: number;
      gte?: number;
      lt?: number;
      desc: boolean;
      take?: number;
    };
    const randomQuery = (): Q => {
      const q: Q = { index: rnd(3) ? "by_n" : "by_creation_time", desc: rnd(2) === 1 };
      if (q.index === "by_n") {
        const shape = rnd(4);
        if (shape === 1) q.eq = rnd(12);
        if (shape >= 2) q.gte = rnd(12);
        if (shape === 3) q.lt = (q.gte ?? 0) + 1 + rnd(6);
      }
      if (rnd(2)) q.take = 1 + rnd(8);
      return q;
    };
    const runQuery = (db: Tx, q: Q) => {
      let b = db.query("items").withIndex(q.index, (r: IndexRangeBuilder) => {
        if (q.eq !== undefined) r.eq("n", q.eq);
        if (q.gte !== undefined) r.gte("n", q.gte);
        if (q.lt !== undefined) r.lt("n", q.lt);
        return r;
      });
      b = b.order(q.desc ? "desc" : "asc");
      return q.take === undefined ? b.collect() : b.take(q.take);
    };
    const expected = (q: Q) => {
      const field = q.index === "by_n" ? "n" : "_creationTime";
      const rows = [...model.values()].filter(
        (d) =>
          (q.eq === undefined || d.n === q.eq) &&
          (q.gte === undefined || (d.n as number) >= q.gte) &&
          (q.lt === undefined || (d.n as number) < q.lt),
      );
      rows.sort((x, y) => {
        // Convex's order: the indexed field, then the implicit _creationTime, then _id.
        const c = (x[field] as number) - (y[field] as number) || x._creationTime - y._creationTime;
        return c !== 0 ? c : x._id < y._id ? -1 : x._id > y._id ? 1 : 0;
      });
      if (q.desc) rows.reverse();
      return q.take === undefined ? rows : rows.slice(0, q.take);
    };

    let checked = 0;
    for (let round = 0; round < 60; round++) {
      const asked: Q[] = [];
      const mismatches = await e.mutation(async (db) => {
        let bad = 0;
        for (let step = 0; step < 12; step++) {
          const ids = [...model.keys()];
          const op = rnd(4);
          if (op === 0 || ids.length === 0) {
            const id = await db.insert("items", { n: rnd(10) });
            model.set(id, (await db.get("items", id)) as Doc);
          } else if (op === 1) {
            const id = ids[rnd(ids.length)];
            await db.patch("items", id, { n: rnd(10) });
            model.set(id, (await db.get("items", id)) as Doc);
          } else if (op === 2) {
            const id = ids[rnd(ids.length)];
            await db.delete("items", id);
            model.delete(id);
          }
          const q = randomQuery();
          asked.push(q);
          if (JSON.stringify(await runQuery(db, q)) !== JSON.stringify(expected(q))) bad++;
          checked++;
        }
        return bad;
      });
      expect(mismatches).toBe(0);
      for (const q of asked) expect(await e.query((db) => runQuery(db, q))).toEqual(expected(q));
    }
    expect(checked).toBe(720);
  });
});
