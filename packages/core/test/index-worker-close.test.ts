// An engine that is closing starts no index worker (STUDY-174 S4, its second half): a schema push that lands while
// `close()` runs must not start the backfill after the worker was stopped. Otherwise the worker runs against a closed
// store, fails, and backs off and retries for as long as the process lives, holding it open with its timer. Convex's
// index worker is a task of the application's workers, which its shutdown aborts; nothing starts it again.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a push that lands during close() starts no index worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-worker-close-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const plain = defineSchema({ items: defineTable(v.any()) });
  const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
  const failures: unknown[] = [];
  const errors = console.error;
  console.error = (...a: unknown[]) => void failures.push(a);
  try {
    const e = await new Engine(defineSchema({}), new SqlitePersistence(path, { durable: true }), {
      storedSchema: true,
      indexBackfill: { chunkSize: 100, chunkRate: 1, initialBackoffMs: 1, maxBackoffMs: 5 },
    }).init();
    const p = await e.startSchemaPush(plain);
    for (let i = 0; (await e.schemaPushStatus(p.schemaId)).type === "inProgress"; i++) await Bun.sleep(5);
    await e.commitSchemaPush(p.schemaId, async () => {});
    await e.mutation(async (db) => {
      for (let i = 0; i < 500; i++) await db.insert("items", { n: i });
    });
    // The push of a new index on a table with documents, and a close that begins while its commit is being written:
    // the push goes on once its commit is durable, after the close stopped the (absent) worker.
    const store = e.persistence as unknown as { flush(): Promise<void> };
    const flush = store.flush.bind(store);
    let closing: Promise<void> | null = null;
    store.flush = async () => {
      if (!closing) {
        closing = e.close();
        await Bun.sleep(20); // the close is past the worker's stop, waiting for this commit
      }
      return flush();
    };
    const pushed = await e.startSchemaPush(indexed).then(
      () => "pushed",
      (err: Error) => err.message,
    );
    expect(pushed).toBe("pushed");
    await closing;
    await Bun.sleep(300);
    // No worker runs after the close: it neither indexes the closed store nor fails on it.
    const w = e.indexWorker as unknown as {
      running: Promise<void> | null;
      stats: { chunks: number; failures: number };
    } | null;
    expect(w?.running ?? null).toBeNull();
    expect(w?.stats.chunks ?? 0).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    console.error = errors;
  }
});
