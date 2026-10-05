import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-catalog-"));
  dirs.push(dir);
  const path = join(dir, "log");
  // Each open replays the log: a restart of the same store.
  return async (schema: SchemaDefinition, fn: (e: Engine) => Promise<void>) => {
    const p = await MemoryPersistence.open(path, { durable: false });
    const e = await new Engine(schema, p).init();
    // New indexes are backfilled in the background (STUDY-29): wait for them, as a push would.
    await e.indexesReady();
    await fn(e);
    await e.close();
  };
}
const numbers = (e: Engine) => Object.fromEntries([...e.catalog.tables.values()].map((t) => [t.name, t.number]));

describe("catalog (_tables / _index)", () => {
  test("a fresh store numbers user tables from 10001, as Convex does", async () => {
    const open = store();
    await open(
      defineSchema({ users: defineTable(v.any()), posts: defineTable(v.any()).index("by_author", ["author"]) }),
      async (e) => {
        expect(numbers(e)).toEqual({
          // Convex's fixed numbers (STUDY-42 X9), bunvex's own at the top of the system range.
          _tables: 513,
          _index: 514,
          _exports: 516,
          _udf_config: 518,
          _modules: 521,
          _source_packages: 524,
          _environment_variables: 525,
          _deployment_audit_log: 527,
          _canonical_urls: 546,
          _session_requests: 529,
          _cron_jobs: 531,
          _schemas: 532,
          _cron_job_logs: 533,
          _log_sinks: 535,
          _backend_state: 536,
          _scheduled_functions: 539,
          _storage: 540,
          _snapshot_imports: 541,
          _function_handles: 545,
          _cron_next_run: 547,
          _data_sync_progress: 553,
          _usage_limits: 552,
          _index_backfills: 548,
          _next_persistence_index_id: 554,
          _storage_deletions: 9998,
          _instance: 9999,
          users: 10001,
          posts: 10002,
        });
        expect([...e.catalog.table("posts").indexes.keys()]).toEqual(["by_id", "by_creation_time", "by_author"]);
      },
    );
  });

  test("reordering the schema, or declaring a table before the others, keeps every document in its table", async () => {
    const open = store();
    const ids: Record<string, string> = {};
    await open(defineSchema({ users: defineTable(v.any()), posts: defineTable(v.any()) }), async (e) => {
      ids.user = await e.mutation((db) => db.insert("users", { name: "ada" }));
      ids.post = await e.mutation((db) => db.insert("posts", { title: "hi" }));
    });
    const reordered = defineSchema({
      audit: defineTable(v.any()),
      posts: defineTable(v.any()),
      users: defineTable(v.any()),
    });
    await open(reordered, async (e) => {
      expect(numbers(e)).toMatchObject({ users: 10001, posts: 10002, audit: 10003 });
      expect(await e.query((db) => db.get("users", ids.user))).toMatchObject({ name: "ada" });
      expect(await e.query((db) => db.get("posts", ids.post))).toMatchObject({ title: "hi" });
      expect(await e.query((db) => db.query("audit").collect())).toEqual([]);
      expect(await e.query((db) => db.query("users").collect())).toHaveLength(1);
    });
  });

  test("an index added to a table that has documents is backfilled", async () => {
    const open = store();
    await open(defineSchema({ items: defineTable(v.any()) }), async (e) => {
      for (let i = 0; i < 2500; i++) await e.mutation((db) => db.insert("items", { n: i % 7 }));
    });
    await open(defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }), async (e) => {
      const sixes = await e.query((db) =>
        db
          .query("items")
          .withIndex("by_n", (q) => q.eq("n", 6))
          .collect(),
      );
      expect(sixes).toHaveLength(357);
      const all = await e.query((db) => db.query("items").withIndex("by_n").collect());
      expect(all.map((d: Doc) => d.n)).toEqual([...all.map((d: Doc) => d.n as number)].sort((a, b) => a - b));
      expect(all).toHaveLength(2500);
    });
  });

  test("changing an index's fields rebuilds it; removing one drops it", async () => {
    const open = store();
    await open(defineSchema({ items: defineTable(v.any()).index("by_x", ["a"]).index("by_y", ["b"]) }), async (e) => {
      await e.mutation((db) => db.insert("items", { a: 2, b: 1 }));
      await e.mutation((db) => db.insert("items", { a: 1, b: 2 }));
    });
    let oldId = 0;
    await open(defineSchema({ items: defineTable(v.any()).index("by_x", ["a"]).index("by_y", ["b"]) }), async (e) => {
      oldId = e.catalog.table("items").indexes.get("by_x")!.id;
    });
    await open(defineSchema({ items: defineTable(v.any()).index("by_x", ["b"]) }), async (e) => {
      const t = e.catalog.table("items");
      expect(t.indexes.get("by_x")!.id).not.toBe(oldId);
      expect(t.indexes.has("by_y")).toBe(false);
      const byB = await e.query((db) => db.query("items").withIndex("by_x").collect());
      expect(byB.map((d: Doc) => d.b)).toEqual([1, 2]);
    });
  });

  test("an unchanged schema commits nothing on open", async () => {
    const open = store();
    const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
    let ts = 0;
    await open(schema, async (e) => {
      ts = e.committer.visibleTs;
    });
    await open(schema, async (e) => {
      expect(e.committer.visibleTs).toBe(ts);
    });
  });

  test("names follow Convex's identifier rule; system names are reserved", () => {
    expect(() => defineSchema({ _users: defineTable(v.any()) })).toThrow("reserved");
    expect(() => defineSchema({ "9lives": defineTable(v.any()) })).toThrow("Invalid table name");
    expect(() => defineSchema({ "a-b": defineTable(v.any()) })).toThrow("Invalid table name");
    expect(() => defineSchema({ ["x".repeat(65)]: defineTable(v.any()) })).toThrow("Invalid table name");
    expect(() => defineSchema({ t: defineTable(v.any()).index("by_id", ["x"]) })).toThrow("reserved");
    expect(() => defineSchema({ t: defineTable(v.any()).index("_ix", ["x"]) })).toThrow("reserved");
    expect(() => defineSchema({ t: defineTable(v.any()).index("by_a", ["a"]).index("by_a", ["b"]) })).toThrow(
      'Table "t" has two or more definitions of index "by_a".',
    );
    expect(() => defineSchema({ ok_Name_1: defineTable(v.any()).index("by_a", ["a"]) })).not.toThrow();
  });

  test("app code cannot read or write the system tables", async () => {
    const open = store();
    await open(defineSchema({ items: defineTable(v.any()) }), async (e) => {
      await expect(e.query((db) => db.query("_tables").collect())).rejects.toThrow("System table");
      await expect(e.mutation((db) => db.insert("_index", {}))).rejects.toThrow("System table");
    });
  });
});

test("fixed system numbers: a table created before keeps its number; a system table without one skips the reserved", async () => {
  const { planCatalog } = await import("../src/catalog.ts");
  const anyDoc = v.any();
  // A store numbered in order before (its `_storage` at 522): nothing moves.
  const before = [{ _id: "x", name: "_storage", number: 522, tablet: 30, state: "active" as const }];
  expect(planCatalog([{ name: "_storage", indexes: {}, document: anyDoc }], before, []).insertTables).toEqual([]);
  // A new system table without a fixed number: the first free one that no system table reserves — with
  // 515 taken, not 516 (`_exports`'s) but 517.
  const with515 = [{ _id: "z", name: "_old", number: 515, tablet: 32, state: "active" as const }];
  const planned = planCatalog([{ name: "_new_system", indexes: {}, document: anyDoc }], with515, []).insertTables;
  expect(planned.map((t) => t.number)).toEqual([517]);
  // A fixed number already taken (an import moved a table there): the next free unreserved one.
  const taken = [{ _id: "y", name: "_other", number: 540, tablet: 31, state: "active" as const }];
  expect(planCatalog([{ name: "_storage", indexes: {}, document: anyDoc }], taken, []).insertTables[0]!.number).toBe(
    515,
  );
});
