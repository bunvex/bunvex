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
/** The sync protocol's committed session mutations, for idempotent resends (session-requests.ts). */
export const SESSION_REQUESTS_TABLE = "_session_requests";
/** Scheduled functions (scheduled-jobs.ts, STUDY-30). Apps read them through `db.system`. */
export const SCHEDULED_FUNCTIONS_TABLE = "_scheduled_functions";
/**
 * Stored files (STUDY-32 F1): `_storage` holds Convex's public fields plus hidden ones (the URL's UUID and
 * the blob's key); apps read it through `db.system`. `_storage_deletions` queues the blobs of deleted
 * files, removed once the delete commits (F3).
 */
export const STORAGE_TABLE = "_storage";
export const STORAGE_DELETIONS_TABLE = "_storage_deletions";
/** Pushed code (STUDY-35), as Convex's: each module's metadata, the packages they live in, the import phase. */
export const MODULES_TABLE = "_modules";
export const SOURCE_PACKAGES_TABLE = "_source_packages";
export const UDF_CONFIG_TABLE = "_udf_config";
/** Cron jobs (STUDY-30 §1.5): the specs, each one's next run, and the last runs' logs. Not visible to apps. */
export const CRON_JOBS_TABLE = "_cron_jobs";
export const CRON_NEXT_RUN_TABLE = "_cron_next_run";
export const CRON_JOB_LOGS_TABLE = "_cron_job_logs";
/** Progress checkpoints of index backfills (Convex's `_index_backfills`, STUDY-29). */
export const INDEX_BACKFILLS_TABLE = "_index_backfills";
export const INDEX_BACKFILLS_INDEX = "by_index_id";

/** Convex numbers: system tables from 513 (`_tables` 513, `_index` 514), user tables from 10 001. */
const FIRST_USER_TABLE_NUMBER = 10_001;
const FIRST_SYSTEM_TABLE_NUMBER = 513;

export type TableMeta = { _id: string; name: string; number: number; tablet: number; state: "active" };
/**
 * An index's lifecycle, as Convex's `DatabaseIndexState` (STUDY-29): `backfilling` (the worker is copying
 * the table into it; every write already maintains it), `backfilled` (complete, not yet enabled: the
 * schema's "push" enables it, or it is staged), `enabled` (serves queries). An index of a new table starts
 * `enabled`. `staged` (backfilling / backfilled only): never enabled while the schema declares it staged.
 */
export type IndexState = "backfilling" | "backfilled" | "enabled";
export type IndexMeta = {
  _id: string;
  tablet: number;
  name: string;
  fields: string[];
  indexId: number;
  state: IndexState;
  staged?: boolean;
};

/** A `_index_backfills` document: where the backfill of one index has got to (Convex's `IndexBackfillMetadata`). */
export type IndexBackfillMeta = {
  _id: string;
  /** The `_index` document of the index. */
  indexId: string;
  numDocsIndexed: number;
  /** Documents in the table when the backfill began, when known (bunvex has no table summaries: null). */
  totalDocs: number | null;
  /** The last document id written into the index, and the snapshot the backfill began at. */
  cursor: { snapshotTs: number; cursor: string | null } | null;
};

/** A query on an index that is still being built (Convex's `IndexBackfillingError`, a bad request). */
export class IndexBackfillingError extends Error {
  readonly code = "IndexBackfillingError";
  constructor(index: string) {
    super(`Index ${index} is currently backfilling and not available to query yet.`);
    this.name = "IndexBackfillingError";
  }
}

/** A query on a staged index (Convex's `IndexStagedError`, a bad request). */
export class IndexStagedError extends Error {
  readonly code = "IndexStagedError";
  constructor(index: string) {
    super(`Index ${index} is currently staged and not available to query until it is enabled.`);
    this.name = "IndexStagedError";
  }
}

/** An index as `Catalog.add` takes it; without `state` it is enabled. */
export type CatalogIndex = {
  name: string;
  fields: string[];
  id: number;
  state?: IndexState;
  staged?: boolean;
  metaId?: string;
};

export class Catalog {
  readonly tables = new Map<string, TableDef>();
  private readonly numbers = new Map<number, TableDef>();

  add(name: string, tablet: number, number: number, indexes: CatalogIndex[]) {
    const t: TableDef = { id: tablet, number, name, indexes: new Map(), pending: [], byId: undefined as never };
    for (const ix of indexes) {
      const def: IndexDef = { id: ix.id, table: name, name: ix.name, fields: ix.fields };
      if (ix.metaId !== undefined) def.metaId = ix.metaId;
      if (ix.state === undefined || ix.state === "enabled") t.indexes.set(ix.name, def);
      else {
        if (ix.staged) def.staged = true;
        t.pending.push(def);
      }
    }
    t.byId = t.indexes.get("by_id")!;
    this.tables.set(name, t);
    this.numbers.set(number, t);
    return t;
  }

  /** The table whose persistence id is `tablet`, if any. */
  byTablet(tablet: number): TableDef | undefined {
    for (const t of this.tables.values()) if (t.id === tablet) return t;
    return undefined;
  }

  /**
   * A copy with index state changes applied, for a commit that changed `_index` (enable, disable, drop):
   * transactions that began before it keep the catalog they started with, as Convex's index registry is
   * part of a snapshot. `enabled` indexes serve reads from `readyTs`, that commit's ts.
   */
  withIndexChanges(changes: { enable: number[]; disable: number[]; drop: number[] }, readyTs: number): Catalog {
    const c = new Catalog();
    for (const t of this.tables.values()) {
      const nt: TableDef = { ...t, indexes: new Map(), pending: [] };
      const all = [...t.indexes.values(), ...t.pending];
      for (const ix of all) {
        if (changes.drop.includes(ix.id)) continue;
        if (changes.enable.includes(ix.id)) {
          const { staged: _, ...enabled } = ix;
          nt.indexes.set(ix.name, { ...enabled, readyTs });
        } else if (changes.disable.includes(ix.id)) nt.pending.push({ ...ix, staged: true });
        else if (t.indexes.get(ix.name) === ix) {
          if (!nt.indexes.has(ix.name)) nt.indexes.set(ix.name, ix);
        } else nt.pending.push(ix);
      }
      nt.byId = nt.indexes.get("by_id")!;
      c.tables.set(nt.name, nt);
      c.numbers.set(nt.number, nt);
    }
    return c;
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
  /** Pending indexes whose `staged` flag the schema changed (Convex patches them when the push starts). */
  restageIndexes: { _id: string; staged: boolean }[];
};

const sameFields = (a: string[], b: string[]) => a.length === b.length && a.every((f, i) => f === b[i]);

/** What a declared table asks for: every index's full field list (the implicit `_creationTime` added), staged or not. */
function wantedIndexes(d: DeclaredTable): Map<string, { fields: string[]; staged: boolean }> {
  const staged = new Set(d.staged ?? []);
  const out = new Map<string, { fields: string[]; staged: boolean }>();
  for (const [name, fields] of Object.entries(SYSTEM_INDEXES)) out.set(name, { fields, staged: false });
  // As in Convex, every user index ends with an implicit `_creationTime` (then `_id`, in the key), so
  // documents with equal indexed values come back in creation order.
  for (const [name, fields] of Object.entries(d.indexes))
    out.set(name, { fields: [...fields, "_creationTime"], staged: staged.has(name) });
  return out;
}

/**
 * The first half of a schema change, as Convex's `prepare_new_and_mutated_indexes` (the push's start):
 * new tables get the next free Convex number and a fresh tablet; a new index (or a new version of one
 * whose fields changed) gets a fresh index id and starts `backfilling`, unless its table is new (then it
 * is `enabled` at once). A PENDING index the schema no longer asks for is dropped now; an ENABLED one keeps
 * serving until the push finishes (`finishCatalog`), so a changed index is replaced atomically. Pure: the
 * caller commits.
 */
export function planCatalog(
  declared: Iterable<DeclaredTable>,
  tables: TableMeta[],
  indexes: IndexMeta[],
): CatalogChanges {
  const changes: CatalogChanges = { insertTables: [], insertIndexes: [], deleteIndexes: [], restageIndexes: [] };
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
    const wanted = wantedIndexes(d);
    for (const [name, { fields, staged }] of wanted) {
      const enabled = stored.find((i) => i.name === name && i.state === "enabled");
      let pending = stored.find((i) => i.name === name && i.state !== "enabled");
      if (pending && !sameFields(pending.fields, fields)) {
        changes.deleteIndexes.push(pending._id);
        pending = undefined;
      }
      if (pending) {
        if ((pending.staged ?? false) !== staged) changes.restageIndexes.push({ _id: pending._id, staged });
        continue;
      }
      if (enabled && sameFields(enabled.fields, fields)) continue; // a staged flag on it waits for the finish
      // A new table is empty: its indexes need no backfill (a staged one is complete and waits).
      const state = !isNew ? "backfilling" : staged ? "backfilled" : "enabled";
      const meta: Omit<IndexMeta, "_id"> = { tablet, name, fields, indexId: nextIndexId++, state };
      if (state !== "enabled") meta.staged = staged;
      changes.insertIndexes.push(meta);
    }
    for (const i of stored) if (!wanted.has(i.name) && i.state !== "enabled") changes.deleteIndexes.push(i._id);
  }
  return changes;
}

export const hasChanges = (c: CatalogChanges) =>
  c.insertTables.length + c.insertIndexes.length + c.deleteIndexes.length + c.restageIndexes.length > 0;

/** The second half, as Convex's `commit_indexes_for_schema` (the push's finish). */
export type FinishChanges = {
  /** Backfilled, not staged: enabled now. */
  enable: IndexMeta[];
  /** Enabled, now declared staged: back to backfilled (Convex's `disable_index`). */
  disable: IndexMeta[];
  /** Enabled, and replaced by a new version or no longer declared. */
  drop: IndexMeta[];
};

/**
 * The finish of a schema change, once no index it waits for is still backfilling (staged indexes never
 * hold it up): enable what is backfilled, disable what became staged, drop what was replaced or removed.
 * Null while an index of the change is still backfilling. Pure: the caller commits, atomically.
 */
export function finishCatalog(declared: Iterable<DeclaredTable>, tables: TableMeta[], indexes: IndexMeta[]) {
  const out: FinishChanges = { enable: [], disable: [], drop: [] };
  for (const d of declared) {
    const tablet = tables.find((t) => t.name === d.name)?.tablet;
    if (tablet === undefined) continue;
    const stored = indexes.filter((i) => i.tablet === tablet);
    const wanted = wantedIndexes(d);
    for (const i of stored) {
      const w = wanted.get(i.name);
      if (i.state === "backfilling") {
        if (!i.staged) return null;
        continue;
      }
      if (i.state === "backfilled") {
        if (!i.staged) out.enable.push(i);
        continue;
      }
      // Enabled.
      if (!w || !sameFields(w.fields, i.fields)) out.drop.push(i);
      else if (w.staged) out.disable.push(i);
    }
  }
  return out;
}

export const hasFinishChanges = (f: FinishChanges) => f.enable.length + f.disable.length + f.drop.length > 0;

/** Build the resolved catalog from the stored metadata (bootstrap tables included). */
export function buildCatalog(tables: TableMeta[], indexes: IndexMeta[]): Catalog {
  const c = bootstrapCatalog();
  for (const t of tables)
    c.add(
      t.name,
      t.tablet,
      t.number,
      indexes
        .filter((i) => i.tablet === t.tablet)
        .map((i) => ({
          name: i.name,
          fields: i.fields,
          id: i.indexId,
          state: i.state,
          staged: i.staged,
          metaId: i._id,
        })),
    );
  return c;
}
