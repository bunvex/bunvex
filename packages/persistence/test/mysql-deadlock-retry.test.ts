// A flush that InnoDB picks as a deadlock victim (errno 1213) is retried by the committer, as Convex's write
// batcher since 1a9f5e1 (#59615): InnoDB rolled the whole transaction back, so the retry writes the same group
// at the same timestamp. Here MySQL's own classifier drives the committer over a memory store; the driver's
// behaviour against a real server is checked by the conformance suite (K20, K21).
import { describe, expect, test } from "bun:test";
import { Engine } from "@bunvex/core";
import type { Persistence } from "@bunvex/core/persistence";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { defineSchema, defineTable } from "@bunvex/core/schema";
import { MysqlPersistence } from "../src/mysql.ts";

const schema = defineSchema({ items: defineTable({}) });

/** The error mysql2 raises for a deadlock victim. */
const deadlock = () =>
  Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), {
    errno: 1213,
    code: "ER_LOCK_DEADLOCK",
    sqlState: "40001",
  });

describe("a MySQL deadlock in a flush (Convex 1a9f5e1)", () => {
  test("is retried: the commit is acknowledged at its own timestamp, without a fail-stop", async () => {
    const inner = await MemoryPersistence.open(null, { durable: false });
    const store: Persistence = Object.create(inner);
    store.isTransient = (e) => MysqlPersistence.prototype.isTransient.call(null, e);
    const applied: bigint[] = [];
    store.apply = (ts, docs, idx) => {
      applied.push(ts);
      return inner.apply(ts, docs, idx);
    };
    let fail = false;
    let flushes = 0;
    store.flush = async () => {
      flushes++;
      if (fail) {
        fail = false;
        throw deadlock(); // as InnoDB: nothing of the group was written
      }
      return inner.flush();
    };
    const retries: unknown[] = [];
    const e = await new Engine(schema, store, {
      flushRetry: { initialBackoffMs: 1, maxBackoffMs: 1, onRetry: (err) => retries.push(err) },
    }).init();
    const fatal: unknown[] = [];
    e.committer.onFatal((err) => fatal.push(err));
    applied.length = 0;
    flushes = 0;
    fail = true;

    await e.mutation((db) => db.insert("items", {}));

    expect(flushes).toBe(2);
    expect(retries).toHaveLength(1);
    expect((retries[0] as { errno: number }).errno).toBe(1213);
    expect(e.committer.stopped).toBeNull();
    expect(fatal).toHaveLength(0);
    // One commit, applied once, and durable at the timestamp it was given before the deadlock.
    expect(applied).toHaveLength(1);
    expect(await inner.maxTs()).toBe(applied[0]!);
    expect(await e.query((db) => db.query("items").collect())).toHaveLength(1);
  });
});
