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
    await expect(e.mutation((db) => db.insert("_mine", {}))).rejects.toThrow("System table _mine is not accessible");
  });
});
