// A deleted table through the document retention window, as Convex's (STUDY-195 §1, DV-580): its `_index` rows go
// with the deletion; its `_tables` row stays `deleting`, its number taken and its documents stored, while document
// retention has not passed the deletion (an old id never becomes another table's); once it has, while the server
// runs, retention purges its rows (PERSIST-01 C18, no new revision) and removes its `_tables` row.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { DELETED_TABLES_GLOBAL, Engine } from "../src/engine.ts";
import { internalIdOf } from "../src/internal-id.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema } from "../src/schema.ts";

const MAX = (1n << 63n) - 1n;
const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tableRow = (e: Engine, tablet: string) =>
  e.query(async (db) =>
    db.asSystem(async () =>
      (await db.query("_tables").collect()).find((r) => internalIdOf(r._id as string) === tablet),
    ),
  );
const indexRowsOf = (e: Engine, tablet: string) =>
  e.query(async (db) =>
    db.asSystem(async () => (await db.query("_index").collect()).filter((r) => r.table_id === tablet)),
  );

/** `ta` with 3 documents and an index, deleted; `tb` beside it. */
async function seeded(e: Engine) {
  const ids = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) out.push((await db.insert("ta", { n: i })) as string);
    await db.insert("tb", { n: 0 });
    return out;
  });
  const t = e.catalog.table("ta");
  await e.deleteTable("ta");
  return { ids, tablet: t.id, number: t.number };
}

describe("a deleted table", () => {
  test("inside the window: invisible, its `_index` rows gone, its row, number and documents kept", async () => {
    const e = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    engines.push(e);
    const { ids, tablet, number } = await seeded(e);
    expect(e.catalog.tables.has("ta")).toBe(false);
    expect(await indexRowsOf(e, tablet)).toEqual([]);
    expect((await tableRow(e, tablet))?.state).toBe("deleting");
    // A new table never takes its number, and an old id never becomes the new table's.
    const tc = (await e.mutation((db) => db.insert("tc", { n: 9 }))) as string;
    expect(decodeId(tc).tableNumber).not.toBe(number);
    expect(await e.query((db) => db.normalizeId("tc", ids[0]!))).toBeNull();
    expect(await e.query((db) => db.get(ids[0] as never))).toBeNull();
    // A purge pass keeps it: the window has not passed it.
    await e.tablesDeleted();
    expect(e.catalog.deleting.has(tablet)).toBe(true);
    expect(await e.persistence.get(tablet, internalIdOf(ids[0]!), MAX)).not.toBeNull();
    expect(e.retention!.waitingTablets().has(tablet)).toBe(true);
  });

  test("once retention passes the deletion, while the server runs: its rows and its `_tables` row go", async () => {
    // The windows trail by nothing and advance every 20 ms: the background loops find the table past it.
    const e = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
      retention: {
        indexDelayMs: 0,
        documentDelayMs: 0,
        advanceEveryMs: 20,
        checkpointEveryMs: 0,
        documentEveryMs: 20,
        documentRatePerSec: 1_000_000,
      },
    }).init();
    engines.push(e);
    const { ids, tablet } = await seeded(e);
    // A commit after the deletion moves the windows past it.
    await e.mutation((db) => db.insert("tb", { n: 1 }));
    // Waited by time, not by a count of sleeps: under a loaded run each sleep stretches.
    const until = Date.now() + 20_000;
    while (Date.now() < until && e.catalog.deleting.has(tablet)) await Bun.sleep(10);
    expect(e.catalog.deleting.has(tablet)).toBe(false);
    expect(await tableRow(e, tablet)).toBeUndefined();
    for (const id of ids) expect(await e.persistence.get(tablet, internalIdOf(id), MAX)).toBeNull();
    expect(e.retention!.stats.tabletRowsDeleted).toBeGreaterThan(0);
    // `tb` is untouched.
    expect(await e.query((db) => db.query("tb").collect())).toHaveLength(2);
  }, 30_000);

  test("across a restart: the indexes recorded for it are purged with its documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-deleted-"));
    dirs.push(dir);
    const open = async () => {
      const e = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
        retention: { documentRatePerSec: 1_000_000 },
      }).init();
      engines.push(e);
      return e;
    };
    const e = await open();
    const { ids, tablet } = await seeded(e);
    const deletedDef = e.catalog.deleting.get(tablet)!;
    const indexIds = [...deletedDef.indexes.values()].map((i) => i.id);
    expect(indexIds.length).toBeGreaterThan(0);
    // Its index rows are still stored, with its documents.
    const stored = await Promise.all(
      indexIds.map((index) =>
        e.persistence.scan(tablet, index, new Uint8Array(), Uint8Array.of(0xff), MAX, 100, false),
      ),
    );
    expect(stored.some((rows) => rows.length === 3)).toBe(true);
    // Recorded, for a start that no longer has its `_index` rows.
    for (let i = 0; i < 100 && !(await e.persistence.getGlobal(DELETED_TABLES_GLOBAL)); i++) await Bun.sleep(5);
    expect(Object.keys((await e.persistence.getGlobal(DELETED_TABLES_GLOBAL)) as object)).toEqual([tablet]);
    await e.close();
    const again = await open();
    expect(again.retention!.waitingTablets().has(tablet)).toBe(true);
    again.retention!.minDocumentTs = again.committer.visibleTs + 1n;
    await again.tablesDeleted();
    expect(again.catalog.deleting.has(tablet)).toBe(false);
    for (const index of indexIds)
      expect(
        await again.persistence.scan(tablet, index, new Uint8Array(), Uint8Array.of(0xff), MAX, 100, false),
      ).toEqual([]);
    expect(await again.persistence.get(tablet, internalIdOf(ids[0]!), MAX)).toBeNull();
    expect((await again.persistence.getGlobal(DELETED_TABLES_GLOBAL)) as object).toEqual({});
  });
});
