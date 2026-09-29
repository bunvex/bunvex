import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, Schema } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-catalog-"));
  dirs.push(dir);
  const path = join(dir, "log");
  // Each open replays the log: a restart of the same store.
  return async (schema: Schema, fn: (e: Engine) => Promise<void>) => {
    const p = await MemoryPersistence.open(path, { durable: false });
    await fn(await new Engine(schema, p).init());
    await p.close();
  };
}
const numbers = (e: Engine) => Object.fromEntries([...e.catalog.tables.values()].map((t) => [t.name, t.number]));

describe("catalog (_tables / _index)", () => {
  test("a fresh store numbers user tables from 10001, as Convex does", async () => {
    const open = store();
    await open(new Schema().table("users", {}).table("posts", { by_author: ["author"] }), async (e) => {
      expect(numbers(e)).toEqual({ _tables: 513, _index: 514, users: 10001, posts: 10002 });
      expect([...e.catalog.table("posts").indexes.keys()]).toEqual(["by_id", "by_creation_time", "by_author"]);
    });
  });

  test("reordering the schema, or declaring a table before the others, keeps every document in its table", async () => {
    const open = store();
    const ids: Record<string, string> = {};
    await open(new Schema().table("users", {}).table("posts", {}), async (e) => {
      ids.user = await e.mutation((db) => db.insert("users", { name: "ada" }));
      ids.post = await e.mutation((db) => db.insert("posts", { title: "hi" }));
    });
    const reordered = new Schema().table("audit", {}).table("posts", {}).table("users", {});
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
    await open(new Schema().table("items", {}), async (e) => {
      for (let i = 0; i < 2500; i++) await e.mutation((db) => db.insert("items", { n: i % 7 }));
    });
    await open(new Schema().table("items", { by_n: ["n"] }), async (e) => {
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
    await open(new Schema().table("items", { by_x: ["a"], by_y: ["b"] }), async (e) => {
      await e.mutation((db) => db.insert("items", { a: 2, b: 1 }));
      await e.mutation((db) => db.insert("items", { a: 1, b: 2 }));
    });
    let oldId = 0;
    await open(new Schema().table("items", { by_x: ["a"], by_y: ["b"] }), async (e) => {
      oldId = e.catalog.table("items").indexes.get("by_x")!.id;
    });
    await open(new Schema().table("items", { by_x: ["b"] }), async (e) => {
      const t = e.catalog.table("items");
      expect(t.indexes.get("by_x")!.id).not.toBe(oldId);
      expect(t.indexes.has("by_y")).toBe(false);
      const byB = await e.query((db) => db.query("items").withIndex("by_x").collect());
      expect(byB.map((d: Doc) => d.b)).toEqual([1, 2]);
    });
  });

  test("an unchanged schema commits nothing on open", async () => {
    const open = store();
    const schema = new Schema().table("items", { by_n: ["n"] });
    let ts = 0;
    await open(schema, async (e) => {
      ts = e.committer.visibleTs;
    });
    await open(schema, async (e) => {
      expect(e.committer.visibleTs).toBe(ts);
    });
  });

  test("names follow Convex's identifier rule; system names are reserved", () => {
    expect(() => new Schema().table("_users", {})).toThrow("reserved");
    expect(() => new Schema().table("9lives", {})).toThrow("Invalid table name");
    expect(() => new Schema().table("a-b", {})).toThrow("Invalid table name");
    expect(() => new Schema().table("x".repeat(65), {})).toThrow("Invalid table name");
    expect(() => new Schema().table("t", { by_id: ["x"] })).toThrow("reserved");
    expect(() => new Schema().table("t", { _ix: ["x"] })).toThrow("reserved");
    expect(() => new Schema().table("t", {}).table("t", {})).toThrow("Duplicate");
    expect(() => new Schema().table("ok_Name_1", { by_a: ["a"] })).not.toThrow();
  });

  test("app code cannot read or write the system tables", async () => {
    const open = store();
    await open(new Schema().table("items", {}), async (e) => {
      await expect(e.query((db) => db.query("_tables").collect())).rejects.toThrow("System table");
      await expect(e.mutation((db) => db.insert("_index", {}))).rejects.toThrow("System table");
    });
  });
});
