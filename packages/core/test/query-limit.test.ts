// `.limit(n)` and the 256-operator cap, as Convex's (STUDY-66 §1): operators apply in chain order, a full limit
// ends the stream before anything more is read, `n` is checked when the query starts, `filter` refuses the
// 257th operator, and the start refuses more than 256 (the terminal's limit included).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import fc from "fast-check";
import { Engine } from "../src/engine.ts";
import type { FilterBuilder } from "../src/filter.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { MAX_QUERY_OPERATORS } from "../src/query-ops.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { QueryCursorError, type Tx, type TxQuery } from "../src/tx.ts";
import { runs } from "./property-runs.ts";

const schema = defineSchema({
  items: defineTable(v.any()).index("by_n", ["n"]).searchIndex("search_body", { searchField: "body" }),
});

async function engine(ns: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.mutation(async (db) => {
    for (const n of ns) await db.insert("items", { n, body: "word" });
  });
  return e;
}

const ns = (docs: (Doc | null)[]) => docs.map((d) => d?.n);
const byN = (db: Tx) => db.query("items").withIndex("by_n");
const even = (q: FilterBuilder) => q.eq(q.mod(q.field("n"), 2), 0);

describe("limit(n), in chain order", () => {
  test("before and after a filter, several times, with take / first / unique / collect", async () => {
    const e = await engine();
    expect(ns(await e.query((db) => byN(db).limit(3).collect()))).toEqual([0, 1, 2]);
    // The first five, then the even ones among them.
    expect(ns(await e.query((db) => byN(db).limit(5).filter(even).collect()))).toEqual([0, 2, 4]);
    // The even ones, then the first five of them.
    expect(ns(await e.query((db) => byN(db).filter(even).limit(5).collect()))).toEqual([0, 2, 4, 6, 8]);
    expect(ns(await e.query((db) => byN(db).limit(6).limit(2).collect()))).toEqual([0, 1]);
    expect(ns(await e.query((db) => byN(db).limit(2).limit(6).collect()))).toEqual([0, 1]);
    expect(ns(await e.query((db) => byN(db).limit(4).take(10)))).toEqual([0, 1, 2, 3]);
    expect(ns(await e.query((db) => byN(db).order("desc").limit(4).take(2)))).toEqual([9, 8]);
    expect((await e.query((db) => byN(db).limit(3).first()))?.n).toBe(0);
    expect((await e.query((db) => byN(db).limit(1).unique()))?.n).toBe(0);
    expect(await e.query((db) => byN(db).limit(0).collect())).toEqual([]);
    // On the initializer (a full table scan), and on the system reader's queries.
    expect(ns(await e.query((db) => db.query("items").limit(2).collect()))).toEqual([0, 1]);
  });

  test("for await stops at a full limit; search queries take limits too", async () => {
    const e = await engine();
    const seen = await e.query(async (db) => {
      const out: number[] = [];
      for await (const d of byN(db).filter(even).limit(3)) out.push(d.n as number);
      return out;
    });
    expect(seen).toEqual([0, 2, 4]);
    const hits = await e.query((db) =>
      db
        .query("items")
        .withSearchIndex("search_body", (q) => q.search("body", "word"))
        .limit(3)
        .collect(),
    );
    expect(hits).toHaveLength(3);
  });

  test("own writes are merged before the limit", async () => {
    const e = await engine([10, 20, 30]);
    const r = await e.mutation(async (db) => {
      await db.insert("items", { n: 5 });
      return ns(await byN(db).limit(2).collect());
    });
    expect(r).toEqual([5, 10]);
  });

  test("paginate: a full limit ends the page, not done, and the next page reads past it", async () => {
    const e = await engine();
    const page = (cursor: string | null) =>
      e.query((db) => byN(db).filter(even).limit(2).paginate({ numItems: 10, cursor }));
    const p1 = await page(null);
    expect([ns(p1.page), p1.isDone]).toEqual([[0, 2], false]);
    const p2 = await page(p1.continueCursor);
    expect([ns(p2.page), p2.isDone]).toEqual([[4, 6], false]);
    const p3 = await page(p2.continueCursor);
    expect([ns(p3.page), p3.isDone]).toEqual([[8], true]);
    // The page size still applies below the limit.
    const small = await e.query((db) => byN(db).limit(5).paginate({ numItems: 2, cursor: null }));
    expect(ns(small.page)).toEqual([0, 1]);
  });

  test("paginate over limit(0) is a system error, as Convex's (no cursor)", async () => {
    const e = await engine();
    const run = e.query((db) => byN(db).limit(0).paginate({ numItems: 5, cursor: null }));
    await expect(run).rejects.toBeInstanceOf(QueryCursorError);
    await expect(run).rejects.toThrow("Cursor was None");
  });

  test("the read-set ends at the document that filled the limit", async () => {
    const e = await engine([0, 10, 20, 30, 40]);
    const r = await e.queryTracked((db) =>
      byN(db)
        .limit(2)
        .filter(() => true)
        .collect(),
    );
    if (!r.ok) throw r.error;
    const from = r.ts;
    // Past 10 (the second document): outside the read-set.
    await e.mutation((db) => db.insert("items", { n: 35 }));
    expect(e.committer.changedBetween(r.reads, from, e.committer.visibleTs)).toBe(false);
    // Before it: inside.
    await e.mutation((db) => db.insert("items", { n: 5 }));
    expect(e.committer.changedBetween(r.reads, from, e.committer.visibleTs)).toBe(true);
  });
});

describe("limit(n) arguments, checked when the query starts", () => {
  test("no argument: TypeError at the call", async () => {
    const e = await engine();
    await expect(e.query(async (db) => (byN(db) as unknown as { limit(): TxQuery }).limit().collect())).rejects.toThrow(
      "Must provide arg 1 `n` to `limit`",
    );
  });

  test("a value that is not a usize, worded as Convex's backend", async () => {
    const e = await engine();
    const bad = async (n: unknown, run: (q: TxQuery) => Promise<unknown> = (q) => q.collect()) =>
      e
        .query(async (db) => run(byN(db).limit(n as number)))
        .then(
          () => "ok",
          (err: Error) => err.message,
        );
    expect(await bad(-1)).toBe(
      "Invalid argument `query` for `queryStream`: invalid value: integer `-1`, expected usize",
    );
    expect(await bad(1.5)).toBe(
      "Invalid argument `query` for `queryStream`: invalid type: floating point `1.5`, expected usize",
    );
    expect(await bad(1e21)).toBe(
      "Invalid argument `query` for `queryStream`: invalid type: floating point `1000000000000000000000.0`, expected usize",
    );
    expect(await bad(Number.NaN)).toBe(
      "Invalid argument `query` for `queryStream`: invalid type: null, expected usize",
    );
    expect(await bad("5")).toBe('Invalid argument `query` for `queryStream`: invalid type: string "5", expected usize');
    expect(await bad(true)).toBe(
      "Invalid argument `query` for `queryStream`: invalid type: boolean `true`, expected usize",
    );
    expect(await bad(-1, (q) => q.paginate({ numItems: 1, cursor: null }))).toBe(
      "Invalid argument `query` for `queryPage`: invalid value: integer `-1`, expected usize",
    );
    expect(await bad(2 ** 60)).toBe("ok");
  });
});

describe("at most 256 operators (MAX_QUERY_OPERATORS)", () => {
  const filters = (q: TxQuery, n: number) => {
    for (let i = 0; i < n; i++) q = q.filter(() => true);
    return q;
  };

  test("filter refuses the 257th operator; limit does not check", async () => {
    const e = await engine();
    expect(MAX_QUERY_OPERATORS).toBe(256);
    await expect(e.query(async (db) => filters(byN(db), 256).collect())).resolves.toHaveLength(10);
    await expect(e.query(async (db) => filters(byN(db), 257).collect())).rejects.toThrow(
      "Can't construct query with more than 256 operators",
    );
    await expect(
      e.query(async (db) =>
        filters(byN(db), 255)
          .limit(5)
          .filter(() => true),
      ),
    ).rejects.toThrow("Can't construct query with more than 256 operators");
  });

  test("the start counts every operator, the terminal's limit included", async () => {
    const e = await engine();
    const tooMany = (n: number) => `Invalid argument \`query\` for \`queryStream\`: Query has too many operators: ${n}`;
    await expect(e.query(async (db) => filters(byN(db), 256).take(1))).rejects.toThrow(tooMany(257));
    await expect(e.query(async (db) => filters(byN(db), 256).first())).rejects.toThrow(tooMany(257));
    await expect(e.query(async (db) => filters(byN(db), 255).limit(1).limit(1).collect())).rejects.toThrow(
      tooMany(257),
    );
    await expect(e.query(async (db) => filters(byN(db), 254).limit(9).take(1))).resolves.toHaveLength(1);
    await expect(
      e.query(async (db) => filters(byN(db), 256).limit(1).paginate({ numItems: 1, cursor: null })),
    ).rejects.toThrow("Invalid argument `query` for `queryPage`: Query has too many operators: 257");
    // `for await` starts the stream synchronously, as Convex's `queryStream` syscall.
    await expect(
      e.query(async (db) => {
        const q = filters(byN(db), 256).limit(1);
        q[Symbol.asyncIterator]();
      }),
    ).rejects.toThrow(tooMany(257));
  });
});

type Op = { filter: number } | { limit: number };

describe("limit and filter against a model of the pipeline", () => {
  test("any chain of filters (n % k === 0) and limits gives the model's documents", async () => {
    const data = Array.from({ length: 40 }, (_, i) => i);
    const e = await engine(data);
    const op = fc.oneof(
      fc.record({ filter: fc.integer({ min: 1, max: 4 }) }),
      fc.record({ limit: fc.integer({ min: 0, max: 30 }) }),
    ) as fc.Arbitrary<Op>;
    const terminal = fc.oneof(
      fc.constant({ kind: "collect" as const }),
      fc.record({ kind: fc.constant("take" as const), n: fc.integer({ min: 0, max: 30 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 6 }), fc.boolean(), terminal, async (ops, desc, end) => {
        // The model: each operator over the whole list, in order.
        let model = desc ? [...data].reverse() : [...data];
        for (const o of [...ops, ...(end.kind === "take" ? [{ limit: end.n }] : [])])
          model = "filter" in o ? model.filter((n) => n % o.filter === 0) : model.slice(0, o.limit);
        const got = await e.query(async (db) => {
          let q = byN(db).order(desc ? "desc" : "asc");
          for (const o of ops) {
            const k = "filter" in o ? o.filter : 0;
            q = "filter" in o ? q.filter((b) => b.eq(b.mod(b.field("n"), k), 0)) : q.limit(o.limit);
          }
          return end.kind === "take" ? q.take(end.n) : q.collect();
        });
        expect(ns(got)).toEqual(model);
      }),
      { numRuns: runs(200) },
    );
  });
});
