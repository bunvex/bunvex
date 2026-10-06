// Tablet ids are never reused (STUDY-04 §7): Convex's tables have random UUIDs, bunvex's integer tablets come
// from `_next_tablet_id`, so a table created after another was purged never gets its id.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import type { Persistence } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";

const dirs: string[] = [];
const open: Persistence[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const p of open.splice(0)) await Promise.resolve(p.close()).catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-tablets-"));
  dirs.push(d);
  return join(d, "log");
}
async function engine(path: string, schema: SchemaDefinition = defineSchema({})) {
  const p = await MemoryPersistence.open(path, { durable: false });
  open.push(p);
  const e = await new Engine(schema, p).init();
  engines.push(e);
  return e;
}
const counter = async (e: Engine) => {
  const rows = (await e.query((db) => db.asSystem(() => db.query("_next_tablet_id").collect()))) as unknown as {
    nextId: bigint;
  }[];
  expect(rows).toHaveLength(1);
  return rows[0]!.nextId;
};
const allTablets = (e: Engine) => [...e.catalog.tables.values()].map((t) => t.id);
/** Delete `name` and wait until the deletion worker purged it (its `_tables` document gone). */
async function purge(e: Engine, name: string) {
  const tablet = e.catalog.table(name).id;
  await e.deleteTable(name);
  e.startTableDeletion();
  for (let i = 0; i < 500 && e.catalog.byTablet(tablet); i++) await Bun.sleep(5);
  expect(e.catalog.byTablet(tablet)).toBeUndefined();
  const metas = (await e.query((db) => db.asSystem(() => db.query("_tables").collect()))) as unknown as {
    tablet: number;
  }[];
  expect(metas.some((m) => m.tablet === tablet)).toBe(false);
  return tablet;
}

describe("tablet ids, never reused (STUDY-04 §7)", () => {
  test("a fresh store has the counter (number 9997), one above the highest tablet", async () => {
    const e = await engine(logPath());
    expect(e.catalog.table("_next_tablet_id").number).toBe(9997);
    expect(Number(await counter(e))).toBe(Math.max(...allTablets(e)) + 1);
  });

  test("a purged table's tablet is not given to the next table, also after a restart", async () => {
    const path = logPath();
    const e = await engine(path);
    await e.mutation((db) => db.insert("gone", { a: 1 }));
    // The newest table has the highest tablet: the one `max + 1` would hand out again.
    expect(e.catalog.table("gone").id).toBe(Math.max(...allTablets(e)));
    const purged = await purge(e, "gone");
    const before = await counter(e);
    await e.mutation((db) => db.insert("next", { a: 1 }));
    expect(e.catalog.table("next").id).toBe(Number(before));
    expect(e.catalog.table("next").id).toBeGreaterThan(purged);
    // Again across a restart, with a hidden table (an import's) this time.
    const purgedNext = await purge(e, "next");
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    await open.pop()!.close();
    const again = await engine(path);
    const hidden = await again.createHiddenTable("other");
    expect(hidden.id).toBeGreaterThan(purgedNext);
    expect(await counter(again)).toBe(BigInt(hidden.id + 1));
  });

  test("a table the schema declares at a start does not get a purged table's tablet", async () => {
    const path = logPath();
    const e = await engine(path);
    await e.mutation((db) => db.insert("gone", { a: 1 }));
    const purged = await purge(e, "gone");
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    await open.pop()!.close();
    const again = await engine(path, defineSchema({ fresh: defineTable(v.any()) }));
    expect(again.catalog.table("fresh").id).toBeGreaterThan(purged);
  });
});
