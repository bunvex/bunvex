import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ users: defineTable({ name: v.string() }) });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function engine(path: string | null = null) {
  const p = await MemoryPersistence.open(path, { durable: false });
  return { e: await new Engine(schema, p).init(), p };
}

describe("tables are created on first insert, as Convex (STUDY-14)", () => {
  test("an insert into an undeclared table creates it; it is read like any other", async () => {
    const { e } = await engine();
    const id = await e.mutation((db) => db.insert("notes", { text: "hi", any: [1n] }));
    const t = e.catalog.table("notes");
    expect(t.number).toBeGreaterThan(10_001); // after the declared `users` (10001)
    expect(decodeId(id).tableNumber).toBe(t.number);
    expect(await e.query((db) => db.get("notes", id))).toMatchObject({ text: "hi" });
    expect(await e.query((db) => db.query("notes").collect())).toHaveLength(1);
  });

  // Convex's transaction registers the table it creates, so the ids it hands out work at once, by every method.
  test("the transaction that creates a table reads and writes its ids, one argument or two", async () => {
    const { e } = await engine();
    const seen = await e.mutation(async (db) => {
      const a = await db.insert("fresh", { n: 1 });
      const b = await db.insert("fresh", { n: 2 });
      const got = [await db.get(a), await db.get("fresh", a)];
      await db.patch(a, { n: 10 });
      await db.patch("fresh", b, { n: 20 });
      const patched = [(await db.get(a))?.n, (await db.get(b))?.n];
      await db.replace(a, { n: 100 });
      await db.replace("fresh", b, { n: 200 });
      const replaced = [(await db.get(a))?.n, (await db.get(b))?.n];
      const c = await db.insert("fresh", { n: 3 });
      const d = await db.insert("fresh", { n: 4 });
      await db.delete(c);
      await db.delete("fresh", d);
      return { got: got.map((x) => x?.n), patched, replaced, gone: [await db.get(c), await db.get(d)], a };
    });
    expect(seen).toMatchObject({ got: [1, 1], patched: [10, 20], replaced: [100, 200], gone: [null, null] });
    expect((await e.query((db) => db.query("fresh").collect())).map((x) => x.n)).toEqual([100, 200]);
    // Another table's id is still refused by name, in the transaction that created it.
    await expect(e.mutation(async (db) => db.get("users", await db.insert("other", { n: 1 })))).rejects.toThrow(
      'expected to be an Id<"users">, got Id<"other"> instead.',
    );
  });

  test("reading a table that does not exist gives nothing, and re-runs once it is created", async () => {
    const { e } = await engine();
    const q = (db: any) => db.query("later").collect();
    expect(await e.query(q, "k")).toEqual([]);
    expect(await e.query((db) => db.query("later").withIndex("by_anything").first())).toBeNull();
    await e.mutation((db) => db.insert("later", { a: 1 }));
    expect(await e.query(q, "k")).toHaveLength(1); // the cached [] was invalidated by the creation
  });

  test("concurrent first inserts into the same new table create it once", async () => {
    const { e } = await engine();
    await Promise.all(Array.from({ length: 20 }, (_, i) => e.mutation((db) => db.insert("race", { i }))));
    expect(await e.query((db) => db.query("race").collect())).toHaveLength(20);
    const tables = [...e.catalog.tables.values()].filter((t) => t.name === "race");
    expect(tables).toHaveLength(1);
    const numbers = [...e.catalog.tables.values()].map((t) => t.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  test("a created table survives a restart; a mutation that fails creates nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-implicit-"));
    dirs.push(dir);
    const path = join(dir, "log");
    const a = await engine(path);
    await a.e.mutation((db) => db.insert("kept", { x: 1 }));
    await expect(
      a.e.mutation(async (db) => {
        await db.insert("dropped", { x: 1 });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(a.e.catalog.tables.has("dropped")).toBe(false);
    await a.p.close();
    const b = await engine(path);
    expect(await b.e.query((db) => db.query("kept").collect())).toHaveLength(1);
    expect(b.e.catalog.tables.has("dropped")).toBe(false);
    await b.p.close();
  });

  test("names follow the identifier rule", async () => {
    const { e } = await engine();
    await expect(e.mutation((db) => db.insert("bad-name", {}))).rejects.toThrow("Invalid table name");
    await expect(e.mutation((db) => db.insert("_mine", {}))).rejects.toThrow(
      "System tables (prefixed with `_`) are read-only.",
    );
  });
});
