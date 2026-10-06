// Tablet ids are never reused (STUDY-04 §7, STUDY-133 §5.2): as Convex's, a table's tablet is the internal id of
// its `_tables` document (random), so a table created after another was purged never gets its id.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
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
const allTablets = (e: Engine) => [...e.catalog.tables.values()].map((t) => t.id);
const internal = (id: string) => Buffer.from(decodeId(id).internalId).toString("base64url");
/** Delete `name` and wait until the deletion worker purged it (its `_tables` document gone). */
async function purge(e: Engine, name: string) {
  const tablet = e.catalog.table(name).id;
  await e.deleteTable(name);
  e.startTableDeletion();
  for (let i = 0; i < 500 && e.catalog.byTablet(tablet); i++) await Bun.sleep(5);
  expect(e.catalog.byTablet(tablet)).toBeUndefined();
  const metas = (await e.query((db) => db.asSystem(() => db.query("_tables").collect()))) as unknown as {
    _id: string;
  }[];
  expect(metas.some((m) => internal(m._id) === tablet)).toBe(false);
  return tablet;
}

describe("tablet ids, never reused (STUDY-04 §7)", () => {
  test("a table's tablet is the internal id of its `_tables` document, for every table", async () => {
    const e = await engine(logPath());
    await e.mutation((db) => db.insert("items", { a: 1 }));
    const rows = (await e.query((db) => db.asSystem(() => db.query("_tables").collect()))) as unknown as {
      _id: string;
      name: string;
    }[];
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(e.catalog.table(r.name).id).toBe(internal(r._id));
    expect(new Set(allTablets(e)).size).toBe(allTablets(e).length);
    expect(e.catalog.tables.has("_next_tablet_id")).toBe(false);
  });

  test("a purged table's tablet is not given to the next table, also after a restart", async () => {
    const path = logPath();
    const e = await engine(path);
    await e.mutation((db) => db.insert("gone", { a: 1 }));
    const purged = await purge(e, "gone");
    await e.mutation((db) => db.insert("gone", { a: 1 }));
    expect(e.catalog.table("gone").id).not.toBe(purged);
    // Again across a restart, with a hidden table (an import's) this time.
    const purgedNext = await purge(e, "gone");
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    await open.pop()!.close();
    const again = await engine(path);
    const hidden = await again.createHiddenTable("gone");
    expect([purged, purgedNext]).not.toContain(hidden.id);
  });

  test("a table the schema declares at a start does not get a purged table's tablet", async () => {
    const path = logPath();
    const e = await engine(path);
    await e.mutation((db) => db.insert("fresh", { a: 1 }));
    const purged = await purge(e, "fresh");
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    await open.pop()!.close();
    const again = await engine(path, defineSchema({ fresh: defineTable(v.any()) }));
    expect(again.catalog.table("fresh").id).not.toBe(purged);
  });
});
