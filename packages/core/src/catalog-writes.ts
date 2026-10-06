// Writing a schema change's catalog rows (STUDY-133 §5.2), as Convex's `TableModel::insert_table_metadata` and
// `IndexModel::add_application_index`: each new table's `_tables` row first — its id's internal id IS the new
// table's tablet — then each new index's `_index` row, naming its table by that tablet; the index's id is its
// own row's internal id. Then the `persistenceIndexId` allocator (STUDY-128).
import {
  type CatalogChanges,
  INDEX_TABLE,
  type IndexMeta,
  indexMeta,
  indexRow,
  indexStatePatch,
  type NewIndex,
  TABLES_TABLE,
  type TableMeta,
  tableRow,
} from "./catalog.ts";
import { writeNextIndexId } from "./index-ids.ts";
import { tabletOf } from "./internal-id.ts";
import type { TabletId } from "./persistence/index.ts";
import type { Tx } from "./tx.ts";

/**
 * Write `changes` in `db`; `createdLowerBound` is a backfilling index's `indexCreatedLowerBound`. Returns the new
 * tables' rows (by name) and the new indexes' rows, as the catalog reads them.
 */
export async function writeCatalogChanges(
  db: Tx,
  changes: CatalogChanges,
  createdLowerBound: bigint,
): Promise<{ tables: Map<string, TableMeta>; indexes: IndexMeta[] }> {
  const tables = new Map<string, TableMeta>();
  const tablets = new Map<string, TabletId>();
  for (const t of changes.insertTables) {
    const _id = await db.insert(TABLES_TABLE, tableRow(t));
    tables.set(t.name, { _id, ...t, tablet: tabletOf(_id) });
    tablets.set(t.name, tabletOf(_id));
  }
  for (const id of changes.deleteIndexes) await db.delete(INDEX_TABLE, id);
  for (const r of changes.restageIndexes) await db.patch(INDEX_TABLE, r._id, indexStatePatch(r, {}));
  const indexes: IndexMeta[] = [];
  for (const i of changes.insertIndexes) {
    const row = newIndexRow(i, tablets, createdLowerBound);
    const _id = await db.insert(INDEX_TABLE, row);
    indexes.push(indexMeta({ _id, ...row }));
  }
  await writeNextIndexId(db, changes.nextIndexId);
  return { tables, indexes };
}

/** A new index's `_index` row, its table's tablet resolved. */
export function newIndexRow(i: NewIndex, tablets: Map<string, TabletId>, createdLowerBound: bigint) {
  const { table, tablet, ...rest } = i;
  const t = tablet ?? tablets.get(table);
  if (t === undefined) throw new Error(`index ${table}.${i.name}: its table has no tablet`);
  return indexRow({ ...rest, tablet: t, createdLowerBound });
}
