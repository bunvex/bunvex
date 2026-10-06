// `db.system` (Convex's `DatabaseReader.system`): every query method keeps the public projection — the
// hidden `_storage` fields (`storageId`, `blobKey`) never leak, whatever the query shape — and only the
// `by_id` / `by_creation_time` indexes are reachable; system tables have no search indexes.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { STORAGE_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const PUBLIC_KEYS = ["_creationTime", "_id", "contentType", "sha256", "size"];

async function withFiles(sizes: number[]) {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  for (const [i, size] of sizes.entries()) {
    await e.mutation((db) =>
      db.asSystem(() =>
        db.insert(STORAGE_TABLE, {
          storageId: `uuid-${i}`,
          blobKey: `blob-${i}`,
          sha256: `sha-${i}`,
          size,
          ...(i % 2 ? { contentType: "text/plain" } : {}),
        }),
      ),
    );
  }
  return e;
}

const keysOf = (d: unknown) => Object.keys(d as object).sort();

test("every query shape returns the public projection only", async () => {
  const e = await withFiles([10, 20, 30, 40]);
  const r = await e.query(async (db) => {
    const q = () => db.system.query(STORAGE_TABLE);
    const iterated = [];
    for await (const d of q().order("desc")) iterated.push(d);
    return {
      take: await q().order("desc").take(2),
      first: await q().first(),
      unique: await q()
        .filter((f) => f.eq(f.field("size"), 30))
        .unique(),
      none: await q()
        .filter((f) => f.eq(f.field("size"), 99))
        .first(),
      noneUnique: await q()
        .filter((f) => f.eq(f.field("size"), 99))
        .unique(),
      byCreation: await q()
        .withIndex("by_creation_time", (b) => b.gt("_creationTime", 0))
        .collect(),
      scan: await q().fullTableScan().collect(),
      limited: await q().order("desc").limit(3).collect(),
      page: await q().paginate({ numItems: 3, cursor: null }),
      iterated,
    };
  });
  expect(r.take.map((d) => d.size)).toEqual([40, 30]);
  expect(r.first?.size).toBe(10);
  expect(r.first?.contentType).toBeNull(); // absent → null, as Convex's `_storage` document
  expect(r.unique).toMatchObject({ size: 30, sha256: "sha-2", contentType: null });
  expect(r.none).toBeNull();
  expect(r.noneUnique).toBeNull();
  expect(r.byCreation.map((d) => d.size)).toEqual([10, 20, 30, 40]);
  expect(r.scan.length).toBe(4);
  expect(r.limited.map((d) => d.size)).toEqual([40, 30, 20]);
  expect(r.page.page.map((d) => d.size)).toEqual([10, 20, 30]);
  expect(r.page.isDone).toBe(false);
  expect(r.iterated.map((d) => d.size)).toEqual([40, 30, 20, 10]);
  for (const d of [
    ...r.take,
    r.first,
    r.unique,
    ...r.byCreation,
    ...r.scan,
    ...r.limited,
    ...r.page.page,
    ...r.iterated,
  ]) {
    expect(keysOf(d)).toEqual(PUBLIC_KEYS);
  }
  await e.close();
});

test("only the public indexes; no search indexes; other system tables read as empty (STUDY-107)", async () => {
  const e = await withFiles([1]);
  await expect(
    e.query(async (db) => db.system.query(STORAGE_TABLE).withIndex("by_storage_id").collect()),
  ).rejects.toThrow("unknown index _storage.by_storage_id");
  await expect(
    e.query(async (db) =>
      db.system
        .query(STORAGE_TABLE)
        .withSearchIndex("s", (q) => q as never)
        .collect(),
    ),
  ).rejects.toThrow("Index _storage.s not found.");
  // Convex's `db.system.query` takes any `_` name; a function sees a private table's index as missing.
  expect(await e.query(async (db) => db.system.query("_tables").collect())).toEqual([]);
  const r = await e.query(async (db) => {
    const id = (await db.system.query(STORAGE_TABLE).first())!._id as string;
    return {
      byId: await db.system.get(id),
      byTable: await db.system.get(STORAGE_TABLE, id),
      normalized: db.system.normalizeId(STORAGE_TABLE, id),
      hiddenTable: db.system.normalizeId("_tables", id),
    };
  });
  expect(keysOf(r.byId)).toEqual(PUBLIC_KEYS);
  expect(r.byTable).toEqual(r.byId);
  expect(r.normalized).toBe(r.byId!._id as string);
  expect(r.hiddenTable).toBeNull();
  await e.close();
});
