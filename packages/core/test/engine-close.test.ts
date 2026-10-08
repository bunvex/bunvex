// Closing an engine is done once (STUDY-133 §12 M15): the server's shutdown closes it and so may its owner
// (`bunvex-local-backend` does both); a second call waits for the first instead of flushing the search indexes
// again after the SQLite lock is released ("another process holds this SQLite store").
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const schema = defineSchema({ notes: defineTable(v.any()).searchIndex("search_body", { searchField: "body" }) });

function blobs(): SearchSegmentStore {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    put: async (d) => {
      const key = `k${++n}`;
      map.set(key, d);
      return key;
    },
    get: async (k) => map.get(k) ?? null,
    delete: async (k) => {
      map.delete(k);
    },
  };
}

test("a second close waits for the first: nothing is written after the lock is released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-close-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const store = blobs();
  const open = async () => {
    const e = await new Engine(schema, new SqlitePersistence(path, { durable: true }), {
      searchStorage: store,
      searchWorkers: { pollIntervalMs: 2 ** 30, minCommits: 0, maxCheckpointAgeMs: 3_600_000 },
    }).init();
    await e.searchReady();
    return e;
  };
  const e = await open();
  await e.mutation(async (db) => {
    for (let i = 0; i < 10; i++) await db.insert("notes", { body: `hello ${i}` });
  });
  const fatal: unknown[] = [];
  e.committer.onFatal((err) => fatal.push(err));
  await Promise.all([e.close(), e.close()]);
  await e.close();
  expect(fatal).toEqual([]);
  expect(e.committer.stopped).toBeNull();
  // The store opens again, with its documents.
  const again = await open();
  expect(await again.query((db) => db.query("notes").collect())).toHaveLength(10);
  await again.close();
});
