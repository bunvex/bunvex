// `Tx.watch` (STUDY-188 §X16): a function's promise that can never resolve fails once nothing is in flight, a turn
// of the event loop later, as Convex fails it ("Returned promise will never resolve", `environment/udf/mod.rs`).
// A promise waiting on a read, on reads chained one after the other, on work counted with `track`, or on
// `crypto.subtle` work (counted by the execution, `onWork`), is not taken for one. Nested watches fail the innermost.
import { expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

class Never extends Error {}
const never = () => new Never("never");
const forever = () => new Promise<never>(() => {});

/** A store whose reads answer a few ms later, as a remote database's do. */
async function slowStore() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const slow =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      await Bun.sleep(2);
      return await f(...a);
    };
  p.get = slow(p.get.bind(p)) as never;
  p.scan = slow(p.scan.bind(p)) as never;
  return p;
}

async function engine() {
  const e = await new Engine(defineSchema({}), await slowStore()).init();
  await e.mutation(async (db) => {
    for (const k of [1, 2, 3]) await db.insert("items", { k });
  });
  return e;
}

test("a promise that can never resolve fails, after a read too", async () => {
  const e = await engine();
  await expect(e.query((db: Tx) => db.watch(() => forever(), never))).rejects.toBeInstanceOf(Never);
  const afterRead = async (db: Tx) => {
    await db.query("items").first();
    return forever();
  };
  await expect(e.query((db: Tx) => db.watch(() => afterRead(db), never))).rejects.toBeInstanceOf(Never);
  // A mutation's write is not committed.
  const writes = async (db: Tx) => {
    await db.insert("items", { k: 9 });
    return forever();
  };
  await expect(e.mutation((db: Tx) => db.watch(() => writes(db), never))).rejects.toBeInstanceOf(Never);
  expect(await e.query(async (db) => (await db.query("items").collect()).length)).toBe(3);
  await e.close();
});

test("reads chained one after the other, tracked work and crypto.subtle are waited for", async () => {
  const e = await engine();
  const chained = async (db: Tx) => {
    const seen: number[] = [];
    let doc = await db.query("items").first();
    while (doc) {
      const k = doc.k as number;
      seen.push(k);
      doc = await db
        .query("items")
        .filter((q) => q.gt(q.field("k"), k))
        .first();
    }
    return seen;
  };
  expect(await e.query((db: Tx) => db.watch(() => chained(db), never))).toEqual([1, 2, 3]);
  const tracked = async (db: Tx) => {
    const later = Bun.sleep(20).then(() => "slept");
    db.track(later);
    return await later;
  };
  expect(await e.query((db: Tx) => db.watch(() => tracked(db), never))).toBe("slept");
  const digest = async () => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(8 << 20))).length;
  expect(await e.query((db: Tx) => db.watch(() => digest(), never))).toBe(32);
  // Untracked, the same wait is taken for a promise that never resolves.
  await expect(e.query((db: Tx) => db.watch(() => Bun.sleep(20), never))).rejects.toBeInstanceOf(Never);
  await e.close();
});

test("nested watches: the innermost fails first, and its caller may go on", async () => {
  const e = await engine();
  const outer = async (db: Tx) => {
    try {
      await db.watch(() => forever(), never);
      return "not failed";
    } catch (err) {
      return { caught: err instanceof Never, rows: (await db.query("items").collect()).length };
    }
  };
  expect(await e.query((db: Tx) => db.watch(() => outer(db), never))).toEqual({ caught: true, rows: 3 });
  await e.close();
});
