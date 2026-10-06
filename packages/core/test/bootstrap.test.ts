// A store's bootstrap and its load (STUDY-133 §5.2), as Convex's `Database::initialize` / `Database::load`: the ten
// bootstrap tables written at ts 0 with their `_tables` / `_index` rows (each `_tables` row's internal id is the
// table's tablet), `persistenceIndexId` 1…26 in Convex's order, `_next_persistence_index_id` at 27, the four
// globals naming `_tables`' and `_index`' tablets and `by_id` indexes; a reopen finds the same catalog; a store
// that lacks the globals or a table's `by_id` is refused with Convex's messages.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeId, v } from "@bunvex/values";
import { INDEX_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { decodeDoc } from "../src/tx.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const d = mkdtempSync(join(tmpdir(), "bunvex-bootstrap-"));
  dirs.push(d);
  return join(d, "log");
}
async function open(path: string | null) {
  const p = await MemoryPersistence.open(path, { durable: false });
  const e = new Engine(schema, p);
  engines.push(e);
  await e.init();
  return { p, e };
}
async function close(e: Engine) {
  engines.splice(engines.indexOf(e), 1);
  await e.close();
}
const internal = (id: string) => Buffer.from(decodeId(id).internalId).toString("base64url");
type Row = Record<string, unknown> & { _id: string; _creationTime: number };

/** Every document written at ts 0, decoded, in `_creationTime` order (the order Convex writes them in). */
async function tsZeroRows(p: MemoryPersistence) {
  const out: { table: string; row: Row }[] = [];
  for (const r of p.readDocumentLog(-1n, 0n, 10)) {
    expect(r.ts).toBe(0n);
    out.push({ table: r.table, row: decodeDoc((await p.get(r.table, r.id, 0n))!) as Row });
  }
  return out.sort((a, b) => a.row._creationTime - b.row._creationTime);
}

const BOOTSTRAP = [
  ["_tables", 513],
  ["_index", 514],
  ["_schemas", 532],
  ["_index_backfills", 548],
  ["_index_worker_metadata", 542],
  ["_next_persistence_index_id", 554],
  ["_component_definitions", 543],
  ["_components", 544],
  ["_schema_validation_progress", 549],
  ["_schema_validations", 555],
] as const;

test("a fresh store: Convex's bootstrap rows at ts 0, in its order, with its ids and persistence index ids", async () => {
  const { p, e } = await open(null);
  const rows = await tsZeroRows(p);
  const tablesTablet = e.catalog.table("_tables").id;
  const indexTablet = e.catalog.table(INDEX_TABLE).id;
  // `_tables`: one row per bootstrap table, Convex's numbers (int64), its id's internal id the table's tablet.
  const tables = rows.filter((r) => r.table === tablesTablet).map((r) => r.row);
  expect(tables.map((t) => [t.name, t.number])).toEqual(BOOTSTRAP.map(([n, num]) => [n, BigInt(num)]));
  for (const t of tables) {
    expect(Object.keys(t).sort()).toEqual(["_creationTime", "_id", "name", "number", "state"]);
    expect(t.state).toBe("active");
    expect(decodeId(t._id).tableNumber).toBe(513);
    expect(internal(t._id)).toBe(e.catalog.table(t.name as string).id);
  }
  // `_index`: by_id and by_creation_time per table (none for `_index`), then the declared indexes.
  const nameOf = new Map(tables.map((t) => [internal(t._id), t.name as string]));
  const indexes = rows.filter((r) => r.table === indexTablet).map((r) => r.row);
  const want: string[] = [];
  for (const [n] of BOOTSTRAP) {
    want.push(`${n}.by_id`);
    if (n !== "_index") want.push(`${n}.by_creation_time`);
  }
  want.push(
    "_tables.by_name",
    "_schemas.by_state",
    "_index_backfills.by_index_id",
    "_index_worker_metadata.by_index_doc_id",
    "_components.by_parent_and_name",
    "_schema_validation_progress.by_validation_id",
    "_schema_validations.by_schema_id_and_table_name",
  );
  expect(indexes.map((i) => `${nameOf.get(i.table_id as string)}.${i.descriptor}`)).toEqual(want);
  expect(indexes.map((i) => (i.config as { persistenceIndexId: bigint }).persistenceIndexId)).toEqual(
    want.map((_, k) => BigInt(k + 1)),
  );
  for (const i of indexes) {
    expect(Object.keys(i).sort()).toEqual(["_creationTime", "_id", "config", "descriptor", "table_id"]);
    expect((i.config as { onDiskState: unknown }).onDiskState).toEqual({ type: "Enabled" });
    // An index's id is its row's internal id.
    const t = e.catalog.table(nameOf.get(i.table_id as string)!);
    expect(t.indexes.get(i.descriptor as string)!.id).toBe(internal(i._id));
  }
  expect(indexes.find((i) => i.descriptor === "by_id")!.config).toEqual({
    type: "database",
    fields: [],
    onDiskState: { type: "Enabled" },
    persistenceIndexId: 1n,
  });
  // The allocator's row, last, at 27.
  const last = rows[rows.length - 1]!;
  expect(last.table).toBe(e.catalog.table("_next_persistence_index_id").id);
  expect(last.row.nextId).toBe(27n);
  expect(rows).toHaveLength(10 + 26 + 1);
  // Nothing else at ts 0: the application's tables come in the first ordinary commit.
  expect(e.catalog.table("items").id).not.toBeUndefined();
  expect(rows.some((r) => r.table === e.catalog.table("items").id)).toBe(false);
});

test("the four bootstrap globals are JSON strings naming the bootstrap tablets and `by_id` indexes", async () => {
  const { p, e } = await open(null);
  expect(p.getGlobal("tables_table_id")).toBe(e.catalog.table("_tables").id);
  expect(p.getGlobal("index_table_id")).toBe(e.catalog.table(INDEX_TABLE).id);
  expect(p.getGlobal("tables_by_id")).toBe(e.catalog.table("_tables").byId.id);
  expect(p.getGlobal("index_by_id")).toBe(e.catalog.table(INDEX_TABLE).byId.id);
  for (const k of ["tables_table_id", "index_table_id", "tables_by_id", "index_by_id"])
    expect(p.getGlobal(k) as string).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test("a reopen loads the same catalog: same tablets and index ids, nothing bootstrapped again", async () => {
  const path = logPath();
  const a = await open(path);
  await a.e.mutation((db) => db.insert("items", { n: 1 }));
  const before = new Map(
    [...a.e.catalog.tables.values()].map((t) => [t.name, [t.id, [...t.indexes.values()].map((i) => i.id).sort()]]),
  );
  const zero = (await tsZeroRows(a.p)).length;
  await close(a.e);
  const b = await open(path);
  const after = new Map(
    [...b.e.catalog.tables.values()].map((t) => [t.name, [t.id, [...t.indexes.values()].map((i) => i.id).sort()]]),
  );
  expect(after).toEqual(before);
  expect((await tsZeroRows(b.p)).length).toBe(zero);
  expect(await b.e.query((db) => db.query("items").collect())).toHaveLength(1);
});

test("a store with rows but without its bootstrap globals is refused: Convex's `missing _tables.by_id global`", async () => {
  const path = logPath();
  const a = await open(path);
  await close(a.e);
  const log = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith('{"global":"tables_by_id"'))
    .join("\n");
  writeFileSync(path, log);
  const p = await MemoryPersistence.open(path, { durable: false });
  const e = new Engine(schema, p);
  engines.push(e);
  await expect(e.init()).rejects.toThrow("missing _tables.by_id global");
});

test("a table without its `by_id` index is refused at load: Convex's `Missing \\`by_id\\` index for …`", async () => {
  const path = logPath();
  const a = await open(path);
  const tablet = a.e.catalog.table("items").id;
  await (a.e as unknown as { runMutation(b: unknown, system: boolean): Promise<unknown> }).runMutation(
    async (db: { query(t: string): { collect(): Promise<Row[]> }; delete(t: string, id: string): Promise<void> }) => {
      const row = (await db.query(INDEX_TABLE).collect()).find(
        (r) => r.table_id === tablet && r.descriptor === "by_id",
      )!;
      await db.delete(INDEX_TABLE, row._id);
    },
    true,
  );
  await close(a.e);
  const p = await MemoryPersistence.open(path, { durable: false });
  const e = new Engine(schema, p);
  engines.push(e);
  await expect(e.init()).rejects.toThrow("Missing `by_id` index for items");
});
