// Serializability with read-sets that end at the last key read (STUDY-06 §9, DV-57): random mutations that
// stop their scans early (take, first, unique, filters, for-await with break, paginate; asc and desc) run
// concurrently against inserts, deletes and moves, interleaved at random points between their reads and
// their writes. Every committed mutation's result must be the one it returns when the committed mutations are
// replayed one at a time in commit-ts order, and the final state must match. A read-set that misses a key the
// scan depended on lets a stale result commit, and the replay tells.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

/** mulberry32: a seeded generator, so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]), log: defineTable(v.any()) });

type Op =
  | { kind: "pop"; desc: boolean; k: number; mod: number }
  | { kind: "unique"; lo: number }
  | { kind: "iterate"; desc: boolean; k: number }
  | { kind: "page"; desc: boolean; k: number; mod: number }
  | { kind: "insert"; n: number }
  | { kind: "move"; from: number; to: number };

const ns = (docs: (Doc | null)[]) => docs.map((d) => (d ? (d.n as number) : null));

/** One mutation body per op. `pause` yields to the other workers between reads and writes. */
function body(op: Op, pause: () => Promise<void>) {
  return async (db: Tx): Promise<unknown> => {
    const byN = () => {
      const q = db.query("items").withIndex("by_n");
      return "desc" in op && op.desc ? q.order("desc") : q;
    };
    let out: unknown;
    if (op.kind === "pop") {
      // take k (of the rows with n % mod == 0), delete the first one
      const q = op.mod > 1 ? byN().filter((f) => f.eq(f.mod(f.field("n"), op.mod), 0)) : byN();
      const got = await q.take(op.k);
      await pause();
      if (got[0]) await db.delete("items", got[0]._id);
      out = ns(got);
    } else if (op.kind === "unique") {
      // the single row in [lo, lo + 5), or an error when there are two
      try {
        const d = await db
          .query("items")
          .withIndex("by_n", (r) => r.gte("n", op.lo).lt("n", op.lo + 5))
          .unique();
        await pause();
        if (d) await db.patch("items", d._id, { n: d.n as number });
        out = d ? (d.n as number) : null;
      } catch {
        out = "two";
      }
    } else if (op.kind === "iterate") {
      // the first k rows by iteration, then delete the last of them
      const got: Doc[] = [];
      for await (const d of byN()) {
        got.push(d);
        if (got.length >= op.k) break;
        await pause();
      }
      await pause();
      if (got.length) await db.delete("items", got[got.length - 1]._id);
      out = ns(got);
    } else if (op.kind === "page") {
      const q = op.mod > 1 ? byN().filter((f) => f.eq(f.mod(f.field("n"), op.mod), 0)) : byN();
      const p = await q.paginate({ numItems: op.k, cursor: null });
      await pause();
      if (p.page.length) await db.delete("items", p.page[p.page.length - 1]._id);
      out = [ns(p.page), p.isDone];
    } else if (op.kind === "insert") {
      await pause();
      await db.insert("items", { n: op.n });
      out = null;
    } else {
      // move the first row at or above `from` to `to`
      const d = await db
        .query("items")
        .withIndex("by_n", (r) => r.gte("n", op.from))
        .first();
      await pause();
      if (d) await db.patch("items", d._id, { n: op.to });
      out = d ? (d.n as number) : null;
    }
    // Every op writes, so every op commits at its own ts and is validated.
    await db.insert("log", {});
    return out;
  };
}

async function state(e: Engine) {
  return ns(await e.query((db) => db.query("items").withIndex("by_n").collect()));
}

async function run(seed: number) {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  // Unique values: inserts and moves never collide, so a result names rows by value alone.
  const pool = Array.from({ length: 4000 }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const fresh = () => pool.pop()!;
  const initial = Array.from({ length: 24 }, fresh);
  const newOp = (): Op => {
    const desc = r() < 0.5;
    switch (pick(6)) {
      case 0:
        return { kind: "pop", desc, k: 1 + pick(3), mod: pick(2) === 0 ? 1 : 2 + pick(2) };
      case 1:
        return { kind: "unique", lo: pick(4000) };
      case 2:
        return { kind: "iterate", desc, k: 1 + pick(3) };
      case 3:
        return { kind: "page", desc, k: 1 + pick(3), mod: pick(2) === 0 ? 1 : 2 };
      case 4:
        return { kind: "insert", n: fresh() };
      default:
        return { kind: "move", from: pick(4000), to: fresh() };
    }
  };
  const W = 6;
  const PER = 14;
  const plans = Array.from({ length: W }, () => Array.from({ length: PER }, newOp));
  const pauses = Array.from({ length: 4096 }, () => pick(4));
  let p = 0;
  const pause = async () => {
    for (let i = pauses[p++ % pauses.length]; i > 0; i--) await new Promise((res) => setImmediate(res));
  };

  const opts = { occInitialBackoffMs: 0, occMaxBackoffMs: 1, maxRetries: 1000 };
  const live = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), opts).init();
  await live.mutation(async (db) => {
    for (const n of initial) await db.insert("items", { n });
  });
  const committed: { ts: bigint; op: Op; value: unknown }[] = [];
  await Promise.all(
    plans.map(async (plan) => {
      for (const op of plan) {
        const { value, ts } = await live.mutationWithTs(body(op, pause));
        committed.push({ ts, op, value });
      }
    }),
  );

  const serial = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), opts).init();
  await serial.mutation(async (db) => {
    for (const n of initial) await db.insert("items", { n });
  });
  committed.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const replayed: unknown[] = [];
  for (const c of committed) replayed.push(await serial.mutation(body(c.op, async () => {})));
  return {
    live: committed.map((c) => c.value),
    replayed,
    liveState: await state(live),
    serialState: await state(serial),
    retries: live.stats.retries,
  };
}

test("concurrent early-stopping scans are serializable: each result is its serial replay's", async () => {
  let retries = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = await run(seed);
    retries += r.retries;
    expect({ seed, results: r.live }).toEqual({ seed, results: r.replayed });
    expect({ seed, state: r.liveState }).toEqual({ seed, state: r.serialState });
  }
  expect(retries).toBeGreaterThan(0); // the workload does contend
}, 60_000);
