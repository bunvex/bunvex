// The read-set of a scan that stops early ends at the last key it reached, as Convex's `IndexRange`
// (STUDY-06 D3 / §9, STUDY-08 D10, DV-57): `take(n)`, `first()`, `unique()`, a full page and a `for await`
// that breaks record [start, last key] in scan order (desc: [last key, end]); a scan that runs out records the
// whole range; `take(0)` records nothing; rows a filter drops were scanned and count.
//
// Each case reads at a snapshot, commits one write, and asks the committer whether the write lands in the
// read-set (`changedBetween`, the check OCC validation and invalidation both use). The narrower read-set must
// still catch every write that could change the result, and nothing past the last key reached.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

/** An engine holding items n = 0, 10, …, 90 (or `ns`). */
async function engine(ns = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], opts: Record<string, number> = {}) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), opts).init();
  await e.mutation(async (db) => {
    for (const n of ns) await db.insert("items", { n });
  });
  return e;
}

async function idOf(e: Engine, n: number): Promise<string> {
  const d = await e.query((db) =>
    db
      .query("items")
      .withIndex("by_n", (q) => q.eq("n", n))
      .unique(),
  );
  if (!d) throw new Error(`no item ${n}`);
  return d._id;
}

type Write = { insert: number } | { delete: number } | { move: [number, number] };

async function apply(e: Engine, w: Write) {
  if ("insert" in w) await e.mutation((db) => db.insert("items", { n: w.insert }));
  else if ("delete" in w) {
    const id = await idOf(e, w.delete);
    await e.mutation((db) => db.delete("items", id));
  } else {
    const id = await idOf(e, w.move[0]);
    await e.mutation((db) => db.patch("items", id, { n: w.move[1] }));
  }
}

/** Whether `write`, committed after `read` ran, lands in `read`'s read-set. A fresh engine per call. */
async function conflicts(read: (db: Tx) => Promise<unknown>, write: Write, ns?: number[]): Promise<boolean> {
  const e = await engine(ns);
  const r = await e.queryTracked(read);
  if (!r.ok) throw r.error;
  const from = r.ts;
  await apply(e, write);
  return e.committer.changedBetween(r.reads, from, e.committer.visibleTs);
}

const byN = (db: Tx) => db.query("items").withIndex("by_n");
const byNDesc = (db: Tx) => db.query("items").withIndex("by_n").order("desc");

describe("a scan that stops early reads up to its last key (asc)", () => {
  const take3 = (db: Tx) => byN(db).take(3); // 0, 10, 20

  test("writes before or at the last key returned conflict", async () => {
    expect(await conflicts(take3, { insert: -1 })).toBe(true);
    expect(await conflicts(take3, { insert: 15 })).toBe(true);
    expect(await conflicts(take3, { delete: 0 })).toBe(true);
    // The inclusive edge: the last row returned is in the read-set.
    expect(await conflicts(take3, { delete: 20 })).toBe(true);
    expect(await conflicts(take3, { move: [20, 21] })).toBe(true);
    expect(await conflicts(take3, { move: [90, 19] })).toBe(true);
  });

  test("writes past the last key do not", async () => {
    expect(await conflicts(take3, { insert: 21 })).toBe(false);
    expect(await conflicts(take3, { insert: 1000 })).toBe(false);
    // The very next key: a scan that read one row too far would conflict here.
    expect(await conflicts(take3, { delete: 30 })).toBe(false);
    expect(await conflicts(take3, { move: [30, 35] })).toBe(false);
  });

  test("first() is [start, first key]: the queue-head read", async () => {
    const first = (db: Tx) => byN(db).first();
    expect(await conflicts(first, { insert: 1000 })).toBe(false);
    expect(await conflicts(first, { delete: 10 })).toBe(false);
    expect(await conflicts(first, { delete: 0 })).toBe(true);
    expect(await conflicts(first, { insert: -5 })).toBe(true);
    // By creation time (no index named): appending is always past the head.
    const head = (db: Tx) => db.query("items").first();
    expect(await conflicts(head, { insert: 5 })).toBe(false);
    expect(await conflicts(head, { delete: 0 })).toBe(true);
  });

  test("take(n) that gets exactly the rest of the range stops at its last key, as Convex's limit operator", async () => {
    const take10 = (db: Tx) => byN(db).take(10); // all 10 rows, but the limit is met: no read past 90
    expect(await conflicts(take10, { insert: 95 })).toBe(false);
    expect(await conflicts(take10, { delete: 90 })).toBe(true);
    const take11 = (db: Tx) => byN(db).take(11); // runs out of the range: the whole range
    expect(await conflicts(take11, { insert: 95 })).toBe(true);
  });

  test("within a sub-range, the read never reaches past the range's own end", async () => {
    const r = (db: Tx) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.gte("n", 20).lt("n", 50))
        .take(2); // 20, 30
    expect(await conflicts(r, { insert: 25 })).toBe(true);
    expect(await conflicts(r, { insert: 35 })).toBe(false);
    expect(await conflicts(r, { insert: 15 })).toBe(false);
  });
});

describe("descending: the read-set starts at the last key read", () => {
  const take3 = (db: Tx) => byNDesc(db).take(3); // 90, 80, 70

  test("writes at or after the last key conflict", async () => {
    expect(await conflicts(take3, { insert: 1000 })).toBe(true);
    expect(await conflicts(take3, { insert: 75 })).toBe(true);
    expect(await conflicts(take3, { delete: 90 })).toBe(true);
    expect(await conflicts(take3, { delete: 70 })).toBe(true); // the inclusive edge
    expect(await conflicts(take3, { move: [70, 69] })).toBe(true);
    expect(await conflicts(take3, { move: [0, 71] })).toBe(true);
  });

  test("writes below it do not", async () => {
    expect(await conflicts(take3, { insert: 69 })).toBe(false);
    expect(await conflicts(take3, { delete: 60 })).toBe(false);
    expect(await conflicts(take3, { insert: -1 })).toBe(false);
  });
});

describe("whole range, empty read-set", () => {
  test("first() on an empty range records the whole range", async () => {
    const none = (db: Tx) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.gte("n", 41).lt("n", 50))
        .first();
    expect(await conflicts(none, { insert: 45 })).toBe(true);
    expect(await conflicts(none, { insert: 49 })).toBe(true);
    expect(await conflicts(none, { insert: 50 })).toBe(false);
    const empty = (db: Tx) => byN(db).first();
    expect(await conflicts(empty, { insert: 1e9 }, [])).toBe(true);
  });

  test("take(0) reads nothing", async () => {
    const e = await engine();
    const r = await e.queryTracked((db) => byN(db).take(0));
    const ix = e.catalog.table("items").indexes.get("by_n")!.id;
    expect(r.reads.filter((i) => i.index === ix)).toEqual([]); // (`withIndex` still reads the index's metadata)
    expect(await conflicts((db) => byN(db).take(0), { insert: -1 })).toBe(false);
  });

  test("collect() reads the whole range", async () => {
    expect(await conflicts((db) => byN(db).collect(), { insert: 1000 })).toBe(true);
  });

  test("unique() reads up to its second row, or the whole range when there is one", async () => {
    const one = (db: Tx) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.gte("n", 30).lt("n", 40))
        .unique();
    // A second row would make unique() throw: it must conflict.
    expect(await conflicts(one, { insert: 35 })).toBe(true);
  });
});

describe("filters: rows a filter drops were scanned", () => {
  const firstAtLeast30 = (db: Tx) =>
    byN(db)
      .filter((q) => q.gte(q.field("n"), 30))
      .first(); // scans 0, 10, 20, 30

  test("the scanned prefix includes the rows filtered out", async () => {
    expect(await conflicts(firstAtLeast30, { delete: 10 })).toBe(true);
    expect(await conflicts(firstAtLeast30, { insert: 15 })).toBe(true);
    expect(await conflicts(firstAtLeast30, { move: [10, 31] })).toBe(true);
    expect(await conflicts(firstAtLeast30, { delete: 30 })).toBe(true);
  });

  test("and ends at the row that met the limit", async () => {
    expect(await conflicts(firstAtLeast30, { insert: 31 })).toBe(false);
    expect(await conflicts(firstAtLeast30, { delete: 40 })).toBe(false);
  });

  test("a filter that matches nothing scans (and reads) the whole range", async () => {
    const nothing = (db: Tx) =>
      byN(db)
        .filter((q) => q.eq(q.field("n"), -1))
        .first();
    expect(await conflicts(nothing, { insert: 1000 })).toBe(true);
  });
});

describe("async iteration", () => {
  test("a for-await that breaks reads up to the last row it was given", async () => {
    const two = async (db: Tx) => {
      const out: Doc[] = [];
      for await (const d of byN(db)) {
        out.push(d);
        if (out.length === 2) break;
      }
      return out; // 0, 10
    };
    expect(await conflicts(two, { delete: 10 })).toBe(true);
    expect(await conflicts(two, { insert: 5 })).toBe(true);
    expect(await conflicts(two, { insert: 15 })).toBe(false);
  });

  test("an iterator abandoned without return() still holds what it read", async () => {
    const one = async (db: Tx) => {
      const it = byN(db)[Symbol.asyncIterator]();
      return (await it.next()).value; // 0; never closed
    };
    expect(await conflicts(one, { delete: 0 })).toBe(true);
    expect(await conflicts(one, { insert: 5 })).toBe(false);
  });

  test("changing a returned document does not move the read-set", async () => {
    const changed = async (db: Tx) => {
      for await (const d of byN(db)) {
        d.n = 1000; // the app's object; the read-set is about the stored key (n = 0)
        break;
      }
    };
    expect(await conflicts(changed, { delete: 0 })).toBe(true);
    expect(await conflicts(changed, { insert: 999 })).toBe(false);
    const changedFirst = async (db: Tx) => {
      const d = await byN(db)
        .filter((q) => q.gte(q.field("n"), 10))
        .first();
      if (d) d.n = 1000;
    };
    expect(await conflicts(changedFirst, { delete: 10 })).toBe(true);
    expect(await conflicts(changedFirst, { insert: 999 })).toBe(false);
  });

  test("an iteration that runs out reads the whole range", async () => {
    const all = async (db: Tx) => {
      let n = 0;
      for await (const _ of byNDesc(db)) n++;
      return n;
    };
    expect(await conflicts(all, { insert: -1 })).toBe(true);
    expect(await conflicts(all, { insert: 1000 })).toBe(true);
  });
});

describe("pagination boundaries", () => {
  const page = (desc: boolean) => (db: Tx) => (desc ? byNDesc(db) : byN(db)).paginate({ numItems: 3, cursor: null });

  test("asc: [start, last key of the page]", async () => {
    expect(await conflicts(page(false), { delete: 20 })).toBe(true);
    expect(await conflicts(page(false), { insert: 19 })).toBe(true);
    expect(await conflicts(page(false), { insert: 21 })).toBe(false);
    expect(await conflicts(page(false), { delete: 30 })).toBe(false);
  });

  test("desc: [last key of the page, end]", async () => {
    expect(await conflicts(page(true), { delete: 70 })).toBe(true);
    expect(await conflicts(page(true), { insert: 71 })).toBe(true);
    expect(await conflicts(page(true), { insert: 69 })).toBe(false);
    expect(await conflicts(page(true), { delete: 60 })).toBe(false);
  });
});

describe("OCC and the query cache", () => {
  /** Run `a` up to its gate, commit `b`, then let `a` finish and commit; how many retries `a` took. */
  async function race(
    e: Engine,
    a: (db: Tx, gate: Promise<void>) => Promise<unknown>,
    b: (db: Tx) => Promise<unknown>,
  ) {
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let first = true;
    const before = e.stats.retries;
    const pa = e.mutation(async (db) => {
      const g = first ? gate : Promise.resolve();
      const out = a(
        db,
        g.then(() => {}),
      );
      if (first) {
        first = false;
        reached();
      }
      return out;
    });
    await atGate;
    await e.mutation(b);
    open();
    await pa;
    return e.stats.retries - before;
  }

  test("popping the head of a queue does not conflict with appends at the tail", async () => {
    const e = await engine(undefined, { occInitialBackoffMs: 1, occMaxBackoffMs: 2 });
    const pop = async (db: Tx, gate: Promise<void>) => {
      const head = await db.query("items").first();
      await gate;
      if (head) await db.delete("items", head._id);
    };
    expect(await race(e, pop, (db) => db.insert("items", { n: 100 }))).toBe(0);
    // A write to the head itself still conflicts.
    const headId = (await e.query((db) => db.query("items").first()))!._id;
    expect(await race(e, pop, (db) => db.patch("items", headId, { n: -1 }))).toBe(1);
  });

  test("the transaction's own writes are part of the scan, and so of its read-set", async () => {
    const e = await engine(undefined, { occInitialBackoffMs: 1, occMaxBackoffMs: 2 });
    // take(2) after its own insert of 5: [0, 5]. A concurrent insert of 3 changes that result.
    const own = async (db: Tx, gate: Promise<void>) => {
      await db.insert("items", { n: 5 });
      const two = await byN(db).take(2);
      await gate;
      await db.insert("log", { two: two.map((d) => d.n) });
    };
    expect(await race(e, own, (db) => db.insert("items", { n: 3 }))).toBe(1);
    expect(await race(e, own, (db) => db.insert("items", { n: 6 }))).toBe(0);
  });

  test("a cached first() survives a write past its head and is invalidated by one inside", async () => {
    const e = await engine();
    const head = () => e.query((db) => byN(db).first(), "head");
    await head();
    await apply(e, { insert: 1000 });
    const hits = e.stats.cacheHits;
    expect((await head())!.n).toBe(0);
    expect(e.stats.cacheHits - hits).toBe(1);
    await apply(e, { insert: -1 });
    expect((await head())!.n).toBe(-1);
    expect(e.stats.cacheHits - hits).toBe(1);
  });
});
