import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Each call opens the same store again: a restart with `schema`. */
function store() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-index-ids-"));
  dirs.push(dir);
  const path = join(dir, "log");
  return async (schema: SchemaDefinition, fn: (e: Engine) => Promise<void>) => {
    const p = await MemoryPersistence.open(path, { durable: false });
    const e = await new Engine(schema, p).init();
    await e.indexesReady();
    await fn(e);
    await e.close();
  };
}
const counter = async (e: Engine) => {
  const row = (await e.query((db) =>
    db.asSystem(() => db.query("_next_persistence_index_id").collect()),
  )) as unknown as {
    nextId: bigint;
  }[];
  expect(row).toHaveLength(1);
  return row[0]!.nextId;
};
/** Each database index's `persistenceIndexId`, by its id (its `_index` row's internal id). */
const pids = async (e: Engine) => {
  const rows = (await e.query((db) => db.asSystem(() => db.query("_index").collect()))) as unknown as {
    _id: string;
    config: { type: string; persistenceIndexId?: bigint };
  }[];
  return new Map(
    rows
      .filter((r) => r.config.type === "database")
      .map((r) => [Buffer.from(decodeId(r._id).internalId).toString("base64url"), Number(r.config.persistenceIndexId)]),
  );
};
/** Every persistence index id the catalog's indexes have, enabled or pending. */
const allIds = async (e: Engine) => {
  const m = await pids(e);
  return [...e.catalog.tables.values()].flatMap((t) => [...t.indexes.values(), ...t.pending].map((i) => m.get(i.id)!));
};
const pidOf = async (e: Engine, table: string, name: string) =>
  (await pids(e)).get(e.catalog.table(table).indexes.get(name)!.id)!;

describe("index ids, as Convex's `_next_persistence_index_id` (STUDY-128)", () => {
  test("a fresh store has the counter (number 554), one above the highest id given", async () => {
    await store()(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }), async (e) => {
      expect(e.catalog.table("_next_persistence_index_id").number).toBe(554);
      const next = await counter(e);
      expect(typeof next).toBe("bigint");
      expect(Number(next)).toBe(Math.max(...(await allIds(e))) + 1);
      // Convex's bootstrap takes 1–26; the first start's application tables follow.
      expect(Math.min(...(await allIds(e)))).toBe(1);
    });
  });

  test("a dropped index's id is never given again", async () => {
    const open = store();
    let dropped = 0;
    let before = 0n;
    // `by_z` is the last index created: the highest id.
    await open(defineSchema({ items: defineTable(v.any()).index("by_z", ["z"]) }), async (e) => {
      dropped = await pidOf(e, "items", "by_z");
      expect(dropped).toBe(Math.max(...(await allIds(e))));
      before = await counter(e);
    });
    await open(defineSchema({ items: defineTable(v.any()) }), async (e) => {
      expect(e.catalog.table("items").indexes.has("by_z")).toBe(false);
      expect(await counter(e)).toBe(before);
    });
    await open(defineSchema({ items: defineTable(v.any()).index("by_w", ["w"]) }), async (e) => {
      const fresh = await pidOf(e, "items", "by_w");
      expect(fresh).toBe(Number(before));
      expect(fresh).toBeGreaterThan(dropped);
      expect(await counter(e)).toBe(before + 1n);
    });
  });

  test("a write that creates a table, and an import's hidden table, take their ids from the counter", async () => {
    await store()(defineSchema({}), async (e) => {
      const start = await counter(e);
      await e.mutation((db) => db.insert("fresh", { a: 1 }));
      const fresh = e.catalog.table("fresh");
      const m = await pids(e);
      expect([...fresh.indexes.values()].map((i) => m.get(i.id))).toEqual([Number(start), Number(start) + 1]);
      expect(await counter(e)).toBe(start + 2n);
      const hidden = await e.createHiddenTable("other");
      const m2 = await pids(e);
      expect([...hidden.indexes.values()].map((i) => m2.get(i.id))).toEqual([Number(start) + 2, Number(start) + 3]);
      expect(await counter(e)).toBe(start + 4n);
    });
  });
});
