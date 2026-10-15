// Tx.afterCommit: callbacks that run once a mutation has committed (STUDY-164 §3.4: a mutation's broadcasts).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const open = async () =>
  new Engine(defineSchema({ t: defineTable(v.any()) }), await MemoryPersistence.open(null, { durable: false })).init();

describe("Tx.afterCommit", () => {
  test("runs after the commit, once, in order", async () => {
    const e = await open();
    const seen: string[] = [];
    await e.mutation(async (db) => {
      db.afterCommit(() => seen.push("a"));
      await db.insert("t", {});
      db.afterCommit(() => seen.push("b"));
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["a", "b"]);
  });
  test("runs for a mutation with no writes too", async () => {
    const e = await open();
    const seen: string[] = [];
    await e.mutation(async (db) => void db.afterCommit(() => seen.push("x")));
    expect(seen).toEqual(["x"]);
  });
  test("runs after the commit is visible to a read", async () => {
    const e = await open();
    let read: Promise<unknown[]> | undefined;
    await e.mutation(async (db) => {
      db.afterCommit(() => {
        read = e.query((q) => q.query("t").collect());
      });
      await db.insert("t", {});
    });
    expect((await read)?.length).toBe(1);
  });
  test("an async callback that rejects is logged, and the mutation still resolves", async () => {
    const e = await open();
    const errs: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(
        await e.mutation(async (db) => {
          db.afterCommit(async () => {
            throw new Error("late");
          });
          await db.insert("t", {});
          return 2;
        }),
      ).toBe(2);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.error = real;
      process.off("unhandledRejection", onUnhandled);
    }
    expect(errs).toEqual(["bunvex: an after-commit callback failed: late"]);
    expect(unhandled).toEqual([]);
  });
  test("never runs when the commit fails and the committer stops", async () => {
    const mem = await MemoryPersistence.open(null, { durable: false });
    const e = await new Engine(defineSchema({ t: defineTable(v.any()) }), mem).init();
    const seen: string[] = [];
    const real = mem.apply.bind(mem);
    mem.apply = () => {
      throw new Error("disk gone");
    };
    const out = await e
      .mutation(async (db) => {
        db.afterCommit(() => seen.push("x"));
        await db.insert("t", {});
      })
      .then(
        () => "committed",
        (err: Error) => err.constructor.name,
      );
    mem.apply = real;
    expect(out).not.toBe("committed");
    expect(seen).toEqual([]);
  });
  test("never runs for a mutation that throws", async () => {
    const e = await open();
    const seen: string[] = [];
    await e
      .mutation(async (db) => {
        db.afterCommit(() => seen.push("x"));
        throw new Error("no");
      })
      .catch(() => {});
    expect(seen).toEqual([]);
  });
  test("an OCC retry drops the failed attempt's callbacks", async () => {
    const e = await open();
    const seen: number[] = [];
    let attempt = 0;
    const id = await e.mutation((db) => db.insert("t", { n: 0 }));
    await e.mutation(async (db) => {
      const n = ++attempt;
      db.afterCommit(() => seen.push(n));
      await db.get(id);
      if (n === 1) await e.mutation((db2) => db2.patch(id, { n: 1 })); // conflicts with this attempt's read
      await db.patch(id, { n: 2 });
    });
    expect(attempt).toBe(2);
    expect(seen).toEqual([2]);
  });
  test("a rollback to a savepoint drops what was registered after it", async () => {
    const e = await open();
    const seen: string[] = [];
    await e.mutation(async (db) => {
      db.afterCommit(() => seen.push("kept"));
      const sp = db.begin();
      db.afterCommit(() => seen.push("dropped"));
      db.rollback(sp);
    });
    expect(seen).toEqual(["kept"]);
  });
  test("a throwing callback is logged and does not fail the mutation, nor skip the next", async () => {
    const e = await open();
    const errs: string[] = [];
    const seen: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => errs.push(a.join(" "));
    try {
      expect(
        await e.mutation(async (db) => {
          db.afterCommit(() => {
            throw new Error("boom");
          });
          db.afterCommit(() => {
            throw "plain";
          });
          db.afterCommit(() => seen.push("next"));
          await db.insert("t", {});
          return 1;
        }),
      ).toBe(1);
    } finally {
      console.error = real;
    }
    expect(errs).toEqual([
      "bunvex: an after-commit callback failed: boom",
      "bunvex: an after-commit callback failed: plain",
    ]);
    expect(seen).toEqual(["next"]);
  });
});
