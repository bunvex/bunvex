// Convex's MAX_USER_TABLES (STUDY-101): at most 10 000 active user tables. A new one past it is refused with
// Convex's `TooManyTables` ("Number of tables cannot exceed 10000."); system, hidden and deleting tables do
// not count, and a table that already exists is not new.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { MAX_USER_TABLES, planCatalog, type TableMeta, TooManyTablesError } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const meta = (n: number, name = `t${n}`, state: TableMeta["state"] = "active"): TableMeta => ({
  _id: `id${n}`,
  name,
  number: 10_001 + n,
  tablet: 100 + n,
  state,
});
const user = (count: number) => Array.from({ length: count }, (_, i) => meta(i));
const declare = (name: string) => ({ name, indexes: {}, document: v.any() });

test("the 10 000th user table is created; the 10 001st is refused with Convex's error", () => {
  expect(planCatalog([declare("new")], user(MAX_USER_TABLES - 1), []).insertTables).toHaveLength(1);
  const refused = () => planCatalog([declare("new")], user(MAX_USER_TABLES), []);
  expect(refused).toThrow(TooManyTablesError);
  expect(refused).toThrow("Number of tables cannot exceed 10000.");
  try {
    refused();
  } catch (e) {
    expect((e as TooManyTablesError).code).toBe("TooManyTables");
  }
});

test("only new, active, user tables count", () => {
  const full = user(MAX_USER_TABLES);
  // An existing table is not new.
  expect(planCatalog([declare("t5")], full, []).insertTables).toEqual([]);
  // A system table is never refused, and system tables do not count.
  expect(planCatalog([declare("_scheduled_functions")], full, []).insertTables).toHaveLength(1);
  const withSystem = [...user(MAX_USER_TABLES - 1), meta(20_000, "_storage")];
  expect(planCatalog([declare("new")], withSystem, []).insertTables).toHaveLength(1);
  // Hidden (an import's) and deleting tables are not active.
  const inactive = [...user(MAX_USER_TABLES - 1), meta(20_001, "h", "hidden"), meta(20_002, "d", "deleting")];
  expect(planCatalog([declare("new")], inactive, []).insertTables).toHaveLength(1);
  // A hidden table for a system table's import is not a user table.
  expect(planCatalog([declare("\u0000hidden")], full, [], false).insertTables).toHaveLength(1);
  expect(() => planCatalog([declare("\u0000hidden")], full, [])).toThrow(TooManyTablesError);
});

test("tables created in one plan count as they are added", () => {
  const two = [declare("a"), declare("b")];
  expect(planCatalog(two, user(MAX_USER_TABLES - 2), []).insertTables).toHaveLength(2);
  expect(() => planCatalog(two, user(MAX_USER_TABLES - 1), [])).toThrow(TooManyTablesError);
});

test("in an engine: a push past the cap is refused; at the cap, a write to a new table is refused", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const tables = (n: number) =>
    defineSchema(Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, defineTable(v.any())])));
  const e = await new Engine(defineSchema({}), p).init();
  await expect(e.startSchemaPush(tables(MAX_USER_TABLES + 1))).rejects.toThrow("Number of tables cannot exceed 10000.");
  await e.startSchemaPush(tables(MAX_USER_TABLES));
  await expect(e.mutation((db) => db.insert("one_more", {}))).rejects.toThrow("Number of tables cannot exceed 10000.");
  await e.mutation((db) => db.insert("t0", {})); // an existing table
  await e.close();
});
