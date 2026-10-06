// A store's bootstrap and the start's first read of it (STUDY-133 §5.2), as Convex's `Database::initialize` and
// `Database::load` (crates/database/src/database.rs).
//
// A new store gets, at ts 0 and before any commit, Convex's ten bootstrap tables: a `_tables` row for each (its
// id's internal id is the table's tablet, `_tables` and `_index` included), their `by_id` and `by_creation_time`
// `_index` rows (`_index` has only `by_id`), then their declared system indexes, all enabled, with
// `persistenceIndexId` 1, 2, … in that order, and the `_next_persistence_index_id` row. Four persistence globals
// name `_tables`' and `_index`' tablets and `by_id` indexes. A start reads those four, then `_index` and `_tables`
// through their `by_id` indexes, and checks what Convex checks; a store whose globals are missing is refused
// with Convex's messages.
import { encodeId } from "@bunvex/values";
import {
  type BootstrapIds,
  bootstrapCatalog,
  buildCatalog,
  Catalog,
  CatalogError,
  databaseIndexRows,
  INDEX_TABLE,
  type IndexMeta,
  indexRow,
  NEXT_PERSISTENCE_INDEX_ID_TABLE,
  SYSTEM_TABLE_NUMBERS,
  TABLES_TABLE,
  type TableMeta,
  tableMeta,
  tableRow,
} from "./catalog.ts";
import { nextUp, outsideExecution, preciseClock, wallClock } from "./determinism.ts";
import { indexIdOf, internalIdBytes, internalIdString } from "./internal-id.ts";
import { hasRetention, type IndexId, type Persistence, type TabletId } from "./persistence/index.ts";
import { SYSTEM_INDEXES } from "./schema.ts";
import { Tx } from "./tx.ts";

/** Convex's persistence global keys (crates/common/src/persistence/mod.rs `PersistenceGlobalKey`). */
export const BOOTSTRAP_GLOBALS = {
  tablesTablet: "tables_table_id",
  indexTablet: "index_table_id",
  tablesById: "tables_by_id",
  indexById: "index_by_id",
} as const;

/**
 * Convex's bootstrap tables (`bootstrap_system_tables()`, crates/database/src/bootstrap_model/defaults.rs), in its
 * order, with their declared system indexes (each table's `indexes()`).
 */
export const BOOTSTRAP_TABLES: readonly { name: string; indexes: Record<string, string[]> }[] = [
  { name: "_tables", indexes: { by_name: ["name"] } },
  { name: "_index", indexes: {} },
  { name: "_schemas", indexes: { by_state: ["state"] } },
  { name: "_index_backfills", indexes: { by_index_id: ["indexId", "_creationTime"] } },
  { name: "_index_worker_metadata", indexes: { by_index_doc_id: ["index_id"] } },
  { name: "_next_persistence_index_id", indexes: {} },
  { name: "_component_definitions", indexes: {} },
  { name: "_components", indexes: { by_parent_and_name: ["parent", "name"] } },
  { name: "_schema_validation_progress", indexes: { by_validation_id: ["validationId", "_creationTime"] } },
  {
    name: "_schema_validations",
    indexes: { by_schema_id_and_table_name: ["schemaId", "tableName", "_creationTime"] },
  },
];

/** A new internal id, as Convex's generator (STUDY-01): 14 random bytes, then the day number (big-endian). */
function newInternalId(nowMs: number): Uint8Array {
  const internal = new Uint8Array(16);
  outsideExecution(() => crypto.getRandomValues(internal.subarray(0, 14)));
  const day = Math.floor(nowMs / 86_400_000);
  internal[14] = day >> 8;
  internal[15] = day & 0xff;
  return internal;
}

const globalsOf = (p: Persistence) => p;

/**
 * Bootstrap a new store (Convex's `Database::initialize`), or do nothing if it has been: the writes at ts 0,
 * then the four globals. Needs the store's lease. A store with rows but no globals is refused.
 */
export async function bootstrapStore(p: Persistence): Promise<void> {
  const store = globalsOf(p);
  if ((await store.getGlobal(BOOTSTRAP_GLOBALS.tablesById)) !== null) return;
  // Convex bootstraps a store that is new; one with rows but without its globals cannot be read.
  if (hasRetention(store) && (await store.readDocumentLog(-1n, (1n << 63n) - 1n, 1)).length)
    throw new CatalogError("missing _tables.by_id global");
  const now = wallClock();
  let creationTime = preciseClock();
  const nextCreationTime = () => {
    const t = creationTime;
    creationTime = nextUp(creationTime); // Convex's `CreationTime::increment`
    return t;
  };
  // Step 0, as Convex's: every table's tablet first.
  const tablets = new Map<string, Uint8Array>();
  for (const t of BOOTSTRAP_TABLES) tablets.set(t.name, newInternalId(now));
  const tabletOfName = (name: string): TabletId => internalIdString(tablets.get(name)!);
  // The catalog the writes are staged against: every bootstrap table with all of its indexes, ids made now.
  type Ix = { name: string; fields: string[]; id: IndexId; rowId: string; persistenceIndexId: number };
  const indexes = new Map<string, Ix[]>(BOOTSTRAP_TABLES.map((t) => [t.name, []]));
  let persistenceIndexId = 1;
  const addIndex = (table: string, name: string, fields: string[]) => {
    const rowId = encodeId(SYSTEM_TABLE_NUMBERS[INDEX_TABLE]!, newInternalId(now));
    indexes.get(table)!.push({ name, fields, id: indexIdOf(rowId), rowId, persistenceIndexId: persistenceIndexId++ });
  };
  for (const t of BOOTSTRAP_TABLES) {
    addIndex(t.name, "by_id", SYSTEM_INDEXES.by_id!);
    if (t.name !== INDEX_TABLE) addIndex(t.name, "by_creation_time", SYSTEM_INDEXES.by_creation_time!);
  }
  for (const t of BOOTSTRAP_TABLES)
    for (const [name, fields] of Object.entries(t.indexes)) addIndex(t.name, name, fields);
  const catalog = new Catalog();
  for (const t of BOOTSTRAP_TABLES)
    catalog.add(
      t.name,
      tabletOfName(t.name),
      SYSTEM_TABLE_NUMBERS[t.name]!,
      indexes.get(t.name)!.map((i) => ({ name: i.name, fields: i.fields, id: i.id })),
    );
  const tx = new Tx(catalog, p, 0n, true, creationTime, true);
  const tablesDef = catalog.table(TABLES_TABLE);
  const indexDef = catalog.table(INDEX_TABLE);
  // Step 1: per table, its `_tables` row, then its default indexes' `_index` rows; then the declared ones.
  const byTable = (name: string) => indexes.get(name)!;
  const writeIndexRow = (table: string, ix: Ix) =>
    tx.importInsert(indexDef, {
      _id: ix.rowId,
      _creationTime: nextCreationTime(),
      ...indexRow({
        tablet: tabletOfName(table),
        name: ix.name,
        fields: ix.fields,
        persistenceIndexId: ix.persistenceIndexId,
        state: "enabled",
      }),
    });
  for (const t of BOOTSTRAP_TABLES) {
    await tx.importInsert(tablesDef, {
      _id: encodeId(SYSTEM_TABLE_NUMBERS[TABLES_TABLE]!, tablets.get(t.name)!),
      _creationTime: nextCreationTime(),
      ...tableRow({ name: t.name, number: SYSTEM_TABLE_NUMBERS[t.name]!, state: "active" }),
    });
    for (const ix of byTable(t.name)) if (ix.name in SYSTEM_INDEXES) await writeIndexRow(t.name, ix);
  }
  for (const t of BOOTSTRAP_TABLES)
    for (const ix of byTable(t.name)) if (!(ix.name in SYSTEM_INDEXES)) await writeIndexRow(t.name, ix);
  await tx.importInsert(catalog.table(NEXT_PERSISTENCE_INDEX_ID_TABLE), {
    _creationTime: nextCreationTime(),
    nextId: BigInt(persistenceIndexId),
  });
  // Steps 2–3: every row at ts 0, with no previous version; then the globals that name the bootstrap tables.
  const { docs, idx } = tx.toWrites();
  p.apply(0n, docs, idx);
  await p.flush();
  await store.setGlobal(BOOTSTRAP_GLOBALS.tablesTablet, tabletOfName(TABLES_TABLE));
  await store.setGlobal(BOOTSTRAP_GLOBALS.indexTablet, tabletOfName(INDEX_TABLE));
  await store.setGlobal(BOOTSTRAP_GLOBALS.tablesById, byTable(TABLES_TABLE)[0]!.id);
  await store.setGlobal(BOOTSTRAP_GLOBALS.indexById, byTable(INDEX_TABLE)[0]!.id);
}

/** The four globals (Convex's `get_meta_ids`), with its messages when one is missing or not a string. */
export async function readBootstrapIds(p: Persistence): Promise<BootstrapIds> {
  const store = globalsOf(p);
  const read = async (key: string, missing: string, notString: string) => {
    const v = await store.getGlobal(key);
    if (v === null || v === undefined) throw new CatalogError(missing);
    if (typeof v !== "string") throw new CatalogError(notString);
    internalIdBytes(v);
    return v;
  };
  return {
    tablesById: await read(BOOTSTRAP_GLOBALS.tablesById, "missing _tables.by_id global", "_tables.by_id is not string"),
    indexById: await read(BOOTSTRAP_GLOBALS.indexById, "missing _index.by_id global", "_index.by_id is not string"),
    tablesTablet: await read(
      BOOTSTRAP_GLOBALS.tablesTablet,
      "missing _tables table ID global",
      "_tables table ID is not string",
    ),
    indexTablet: await read(
      BOOTSTRAP_GLOBALS.indexTablet,
      "missing _index table ID global",
      "_index table ID is not string",
    ),
  };
}

/**
 * The stored catalog at `ts` (Convex's `load_table_and_index_metadata`): every `_index` row, then every `_tables`
 * row, read through their `by_id` indexes from the bootstrap ids.
 */
export async function loadCatalogRows(
  p: Persistence,
  ids: BootstrapIds,
  ts: bigint,
): Promise<{ tables: TableMeta[]; indexes: IndexMeta[]; indexRows: Record<string, unknown>[] }> {
  const tx = new Tx(bootstrapCatalog(ids), p, ts, false, wallClock(), true);
  const indexRows = (await tx.query(INDEX_TABLE).collect()) as Record<string, unknown>[];
  const tables = (await tx.query(TABLES_TABLE).collect()).map(tableMeta);
  return { tables, indexes: databaseIndexRows(indexRows), indexRows };
}

/** The catalog of a store at its latest commit, for tools that read without the lease. */
export async function loadCatalog(p: Persistence, ts: bigint): Promise<Catalog> {
  const { tables, indexes } = await loadCatalogRows(p, await readBootstrapIds(p), ts);
  return buildCatalog(tables, indexes);
}
