// The catalog: which tables and indexes exist and the ids persistence stores for them (STUDY-04). As in
// Convex, metadata is data: every table is a document of the system table `_tables`, every index one of
// `_index`, read and written by ordinary transactions. Ids are assigned once and never reused, so
// reordering or editing the declared schema never re-points existing data.
//
// `_tables` and `_index` themselves have FIXED ids — that is how startup finds everything else (Convex
// keeps their ids in persistence globals instead).
import { type DeclaredTable, type IndexDef, SYSTEM_INDEXES, type TableDef } from "./schema.ts";

export const TABLES_TABLE = "_tables";
export const INDEX_TABLE = "_index";
/** The deployment's own settings, starting with the instance secret when none is configured (STUDY-17). */
export const INSTANCE_TABLE = "_instance";

/** Convex numbers: system tables from 513 (`_tables` 513, `_index` 514), user tables from 10 001. */
const FIRST_USER_TABLE_NUMBER = 10_001;
const FIRST_SYSTEM_TABLE_NUMBER = 513;

export type TableMeta = { _id: string; name: string; number: number; tablet: number; state: "active" };
export type IndexMeta = {
  _id: string;
  tablet: number;
  name: string;
  fields: string[];
  indexId: number;
  state: "backfilling" | "enabled";
};

export class Catalog {
  readonly tables = new Map<string, TableDef>();
  private readonly numbers = new Map<number, TableDef>();

  add(name: string, tablet: number, number: number, indexes: { name: string; fields: string[]; id: number }[]) {
    const t: TableDef = { id: tablet, number, name, indexes: new Map(), byId: undefined as never };
    for (const ix of indexes) {
      const def: IndexDef = { id: ix.id, table: name, name: ix.name, fields: ix.fields };
      t.indexes.set(ix.name, def);
    }
    t.byId = t.indexes.get("by_id")!;
    this.tables.set(name, t);
    this.numbers.set(number, t);
    return t;
  }

  /** The table an id's number names, if any. */
  byNumber(number: number): TableDef | undefined {
    return this.numbers.get(number);
  }

  table(name: string): TableDef {
    const t = this.tables.get(name);
    if (!t) throw new Error(`unknown table ${name}`);
    return t;
  }
}

const systemIndexes = (first: number) =>
  Object.entries(SYSTEM_INDEXES).map(([name, fields], i) => ({ name, fields, id: first + i }));

/** The catalog before anything is read: only the two bootstrap tables, at their fixed ids. */
export function bootstrapCatalog(): Catalog {
  const c = new Catalog();
  c.add(TABLES_TABLE, 1, 513, systemIndexes(1));
  c.add(INDEX_TABLE, 2, 514, systemIndexes(3));
  return c;
}
/** The first persistence ids handed out to user tables and indexes. */
const FIRST_TABLET = 3;
const FIRST_INDEX_ID = 5;

export type CatalogChanges = {
  insertTables: Omit<TableMeta, "_id">[];
  insertIndexes: Omit<IndexMeta, "_id">[];
  deleteIndexes: string[]; // `_index` document ids
};

const sameFields = (a: string[], b: string[]) => a.length === b.length && a.every((f, i) => f === b[i]);

/**
 * Compare what is stored with what the schema declares: new tables get the next free Convex number and a
 * fresh tablet; a new index (or one whose fields changed) gets a fresh index id and must be backfilled
 * unless its table is new; an index the schema no longer declares is dropped. Pure: the caller commits.
 */
export function planCatalog(
  declared: Iterable<DeclaredTable>,
  tables: TableMeta[],
  indexes: IndexMeta[],
): CatalogChanges {
  const changes: CatalogChanges = { insertTables: [], insertIndexes: [], deleteIndexes: [] };
  let nextTablet = Math.max(FIRST_TABLET - 1, ...tables.map((t) => t.tablet)) + 1;
  let nextIndexId = Math.max(FIRST_INDEX_ID - 1, ...indexes.map((i) => i.indexId)) + 1;
  // The bootstrap tables' fixed numbers are taken too (they have no `_tables` document of their own).
  const usedNumbers = new Set([513, 514, ...tables.map((t) => t.number)]);
  for (const d of declared) {
    let tablet = tables.find((t) => t.name === d.name)?.tablet;
    const isNew = tablet === undefined;
    if (tablet === undefined) {
      // System tables take the first free number above 512, user tables above 10 000 (Convex).
      let number = d.name.startsWith("_") ? FIRST_SYSTEM_TABLE_NUMBER : FIRST_USER_TABLE_NUMBER;
      while (usedNumbers.has(number)) number++;
      usedNumbers.add(number);
      tablet = nextTablet++;
      changes.insertTables.push({ name: d.name, number, tablet, state: "active" });
    }
    const stored = indexes.filter((i) => i.tablet === tablet);
    // As in Convex, every user index ends with an implicit `_creationTime` (then `_id`, in the key), so
    // documents with equal indexed values come back in creation order.
    const userIndexes = Object.fromEntries(Object.entries(d.indexes).map(([n, f]) => [n, [...f, "_creationTime"]]));
    const wanted = { ...SYSTEM_INDEXES, ...userIndexes };
    for (const [name, fields] of Object.entries(wanted)) {
      const have = stored.find((i) => i.name === name);
      if (have && sameFields(have.fields, fields)) continue;
      if (have) changes.deleteIndexes.push(have._id);
      changes.insertIndexes.push({
        tablet,
        name,
        fields,
        indexId: nextIndexId++,
        state: isNew ? "enabled" : "backfilling",
      });
    }
    for (const i of stored) if (!(i.name in wanted)) changes.deleteIndexes.push(i._id);
  }
  return changes;
}

export const hasChanges = (c: CatalogChanges) =>
  c.insertTables.length + c.insertIndexes.length + c.deleteIndexes.length > 0;

/** Build the resolved catalog from the stored metadata (bootstrap tables included). */
export function buildCatalog(tables: TableMeta[], indexes: IndexMeta[]): Catalog {
  const c = bootstrapCatalog();
  for (const t of tables)
    c.add(
      t.name,
      t.tablet,
      t.number,
      indexes.filter((i) => i.tablet === t.tablet).map((i) => ({ name: i.name, fields: i.fields, id: i.indexId })),
    );
  return c;
}
