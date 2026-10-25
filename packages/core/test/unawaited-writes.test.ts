// A mutation's writes it did not await are part of it (STUDY-187 §2.1): Convex runs a query's or mutation's
// syscalls to the end before it answers (environment/udf/mod.rs), its tests `danglingMutation` (one `db.insert` not
// awaited: one row) and `doublyDanglingMutation` (two chained inserts in an unawaited function: two rows). Before,
// bunvex committed when the handler settled: an insert that creates its table, or a write chained after a read of
// a slow store, came after the commit and was lost while its promise answered an id.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

/** A store whose reads answer a few ms later, as a remote database's do. */
async function slowStore() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const slow =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      await Bun.sleep(3);
      return await f(...a);
    };
  p.get = slow(p.get.bind(p)) as never;
  p.scan = slow(p.scan.bind(p)) as never;
  return p;
}

const stores = {
  memory: () => MemoryPersistence.open(null, { durable: false }),
  sqlite: async () =>
    new SqlitePersistence(join(mkdtempSync(join(tmpdir(), "unawaited-")), "db.sqlite"), { durable: false }),
  slow: slowStore,
};

const count = (e: Engine, table: string) => e.query(async (db) => (await db.query(table).collect()).length);

for (const [store, open] of Object.entries(stores))
  for (const declared of [false, true])
    test(`${store}, ${declared ? "a declared table" : "a table the insert creates"}: Convex's dangling mutations`, async () => {
      const schema = declared
        ? defineSchema({ test: defineTable({}), other: defineTable({ n: v.optional(v.number()) }) })
        : defineSchema({});
      const e = await new Engine(schema, await open()).init();
      let id: unknown = null;
      // danglingMutation: one insert, not awaited.
      await e.mutation(async (db: Tx) => {
        void db.insert("test", {}).then((x) => {
          id = x;
        });
      });
      expect(await count(e, "test")).toBe(1);
      expect(await e.query((db) => db.get("test", id as string))).not.toBeNull();
      // doublyDanglingMutation: two chained inserts in an async function nothing awaits.
      await e.mutation(async (db: Tx) => {
        void (async () => {
          await db.insert("other", {});
          await db.insert("other", {});
        })();
      });
      expect(await count(e, "other")).toBe(2);
      // A write chained after an unawaited read: on a slow store, the read answers after the handler returned.
      await e.mutation(async (db: Tx) => {
        void db
          .query("other")
          .first()
          .then((d) => db.patch("other", d!._id as string, { n: 7 }));
      });
      expect(await e.query(async (db) => (await db.query("other").first())?.n)).toBe(7);
    });

test("a handler that throws fails at once: its dangling writes are not waited for, nor committed", async () => {
  const e = await new Engine(defineSchema({}), await slowStore()).init();
  await expect(
    e.mutation(async (db: Tx) => {
      void db.insert("lost", {});
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await Bun.sleep(30);
  expect(await count(e, "lost")).toBe(0);
});

test("a query's result is what its handler returned: a dangling read does not hold it", async () => {
  const e = await new Engine(defineSchema({}), await slowStore()).init();
  await e.mutation((db: Tx) => db.insert("t", { x: 1 }));
  const seen: unknown[] = [];
  const result = await e.query(async (db) => {
    void db
      .query("t")
      .first()
      .then((d) => seen.push(d));
    return seen;
  });
  expect(result).toEqual([]);
});

test("a close begun while a mutation waits for its unawaited writes lets it commit first", async () => {
  // The mutation's handler has returned; its insert (which creates the table) is still in flight when the close
  // starts. The close waits for it to reach the committer, so it commits before the store closes.
  const file = join(mkdtempSync(join(tmpdir(), "unawaited-close-")), "db.sqlite");
  const e = await new Engine(defineSchema({}), new SqlitePersistence(file, { durable: false })).init();
  let returned!: () => void;
  const handlerReturned = new Promise<void>((r) => (returned = r));
  const done = e.mutation(async (db: Tx) => {
    void db.insert("late", { n: 1 });
    returned();
  });
  await handlerReturned;
  const closing = e.close();
  await done;
  await closing;
  const again = await new Engine(defineSchema({}), new SqlitePersistence(file, { durable: false })).init();
  expect(await count(again, "late")).toBe(1);
  await again.close();
});

test("a mutation retrying an OCC conflict when the engine closes fails, and reads no closed store", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "unawaited-retry-")), "db.sqlite");
  const e = await new Engine(defineSchema({}), new SqlitePersistence(file, { durable: false }), {
    occInitialBackoffMs: 50,
    occMaxBackoffMs: 50,
  }).init();
  const id = await e.mutation((db: Tx) => db.insert("c", { n: 0 }));
  let attempts = 0;
  let lost!: () => void;
  const firstLost = new Promise<void>((r) => (lost = r));
  const saved = Math.random;
  Math.random = () => 1; // the full 50 ms backoff, so the close lands in it
  let failure: unknown;
  try {
    const retrying = e
      .mutation(async (db: Tx) => {
        attempts++;
        await db.get("c", id);
        // A rival commits a write to what this attempt read: it loses, and backs off.
        if (attempts === 1) await e.mutation((r: Tx) => r.patch("c", id, { n: 1 }));
        await db.patch("c", id, { n: 2 });
        if (attempts === 1) queueMicrotask(lost);
      })
      .catch((x) => (failure = x));
    await firstLost;
    await e.close();
    await retrying;
  } finally {
    Math.random = saved;
  }
  expect(attempts).toBe(1);
  expect(String(failure)).toContain("the engine closed");
});
