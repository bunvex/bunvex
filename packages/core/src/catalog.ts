// The catalog: which tables and indexes exist and the ids persistence stores for them (STUDY-04). As in
// Convex, metadata is data: every table is a document of the system table `_tables`, every index one of
// `_index`, read and written by ordinary transactions. Ids are assigned once and never reused, so
// reordering or editing the declared schema never re-points existing data.
//
// `_tables` and `_index` themselves have FIXED ids — that is how startup finds everything else (Convex
// keeps their ids in persistence globals instead).
import { opaqueToInspect } from "./inspect.ts";
import { type DeclaredTable, type IndexDef, SYSTEM_INDEXES, type TableDef } from "./schema.ts";

export const TABLES_TABLE = "_tables";
export const INDEX_TABLE = "_index";
/** The instance secret (and name) when none is configured (STUDY-17, DV-07, DV-159). */
export const INSTANCE_TABLE = "_instance";
/** The database's globals (STUDY-126), as Convex's `_db`: the data's version and the pinned storage type. */
export const DATABASE_GLOBALS_TABLE = "_db";
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
/** Pushed schemas (STUDY-35), as Convex's: `pending` → `active`, or `overwritten` / `failed`. */
export const SCHEMAS_TABLE = "_schemas";
/** The deployed auth providers (STUDY-129), as Convex's `_auth`: one document per provider. */
export const AUTH_TABLE = "_auth";
/** Deployment environment variables (STUDY-37), as Convex's: `{ name, value }`, indexed `by_name`. */
export const ENVIRONMENT_VARIABLES_TABLE = "_environment_variables";
/** Snapshot exports (STUDY-42), as Convex's `_exports`: one row per export and its state. */
export const EXPORTS_TABLE = "_exports";
/** The deployment's canonical URLs (STUDY-49), as Convex's `_canonical_urls`: `{requestDestination, url}`. */
export const CANONICAL_URLS_TABLE = "_canonical_urls";
/** The deployment's audit log (STUDY-48), as Convex's `_deployment_audit_log`: one document per event. */
export const DEPLOYMENT_AUDIT_LOG_TABLE = "_deployment_audit_log";
/** Log streams (STUDY-59), as Convex's `_log_sinks`: `{status, config}`, one per sink type. */
export const LOG_SINKS_TABLE = "_log_sinks";
/** Usage limits (STUDY-61), as Convex's `_usage_limits`: `{metric, window, limitType, limit, enabled}`. */
export const USAGE_LIMITS_TABLE = "_usage_limits";
/** Data sync progress (STUDY-69), as Convex's `_data_sync_progress`: one row per sync, its state. */
export const DATA_SYNC_PROGRESS_TABLE = "_data_sync_progress";
/** Function handles (STUDY-50), as Convex's `_function_handles`: `{component, path, deletedTs}`. */
export const FUNCTION_HANDLES_TABLE = "_function_handles";
/** The deployment's run state (STUDY-63), as Convex's `_backend_state`: `{system, usage_limit, user}`. */
export const BACKEND_STATE_TABLE = "_backend_state";
/** Snapshot imports (STUDY-42), as Convex's `_snapshot_imports`: one row per import, its state and checkpoints. */
export const SNAPSHOT_IMPORTS_TABLE = "_snapshot_imports";
/** Cron jobs (STUDY-30 §1.5): the specs, each one's next run, and the last runs' logs. Not visible to apps. */
export const CRON_JOBS_TABLE = "_cron_jobs";
export const CRON_NEXT_RUN_TABLE = "_cron_next_run";
export const CRON_JOB_LOGS_TABLE = "_cron_job_logs";
/** Progress checkpoints of index backfills (Convex's `_index_backfills`, STUDY-29). */
export const INDEX_BACKFILLS_TABLE = "_index_backfills";
export const INDEX_BACKFILLS_INDEX = "by_index_id";
/**
 * Search index workers' state (Convex's `_index_worker_metadata`, STUDY-111): per search or vector index (its
 * `_index` row's id), the ts it was fast-forwarded to.
 */
export const INDEX_WORKER_METADATA_TABLE = "_index_worker_metadata";
export const INDEX_WORKER_METADATA_INDEX = "by_index_doc_id";
/** The next index id to hand out (STUDY-128), as Convex's `_next_persistence_index_id`: `{nextId}`. */
export const NEXT_PERSISTENCE_INDEX_ID_TABLE = "_next_persistence_index_id";

/** Convex numbers: system tables from 513 (`_tables` 513, `_index` 514), user tables from 10 001. */
const FIRST_USER_TABLE_NUMBER = 10_001;
const FIRST_SYSTEM_TABLE_NUMBER = 513;

/**
 * Each system table's fixed number (STUDY-42 X9): Convex's (`DefaultTableNumber` in crates/model/src/lib.rs,
 * 512 + n, "to make import/export more likely to work nicely") for the tables Convex has — a virtual table
 * (`_storage`, `_scheduled_functions`) shares its system table's — and numbers Convex does not use for
 * bunvex's own, counted down from the top of the system range (below 10 000, as Convex's). A table created before keeps its number.
 */
export const SYSTEM_TABLE_NUMBERS: Readonly<Record<string, number>> = {
  _tables: 513,
  _index: 514,
  _exports: 516,
  _udf_config: 518,
  _auth: 519,
  _db: 520,
  _modules: 521,
  _source_packages: 524,
  _environment_variables: 525,
  _deployment_audit_log: 527,
  _session_requests: 529,
  _cron_jobs: 531,
  _schemas: 532,
  _cron_job_logs: 533,
  _scheduled_functions: 539,
  _storage: 540,
  _snapshot_imports: 541,
  _log_sinks: 535,
  _function_handles: 545,
  _canonical_urls: 546,
  _backend_state: 536,
  _cron_next_run: 547,
  _data_sync_progress: 553,
  _usage_limits: 552,
  _index_backfills: 548,
  _index_worker_metadata: 542,
  _next_persistence_index_id: 554,
  // bunvex's own.
  _instance: 9_999,
  _storage_deletions: 9_998,
};
const RESERVED_SYSTEM_NUMBERS = new Set(Object.values(SYSTEM_TABLE_NUMBERS));

/**
 * A table's lifecycle (STUDY-42 PR 2), as Convex's `TableState`: `active` (the one table of its name that
 * functions see), `hidden` (being filled — an import's — invisible to functions, possibly sharing an active
 * table's name and number, made active by `activate`), `deleting` (replaced or deleted: invisible, its
 * documents removed in the background, then its metadata).
 */
export type TableState = "active" | "hidden" | "deleting";
export type TableMeta = { _id: string; name: string; number: number; tablet: number; state: TableState };
/** Convex's `MAX_USER_TABLES` (crates/database/src/bootstrap_model/table.rs): active user tables, at most. */
export const MAX_USER_TABLES = 10_000;

/** Convex's `TooManyTables` (`index_validation_error::too_many_tables`), when a new table would pass the cap. */
export class TooManyTablesError extends Error {
  readonly code = "TooManyTables";
  constructor() {
    super(`Number of tables cannot exceed ${MAX_USER_TABLES}.`);
    this.name = "TooManyTablesError";
  }
}

/** The active tables of a `_tables` listing (old rows have no state: active). */
export const activeTables = (tables: TableMeta[]) => tables.filter((t) => (t.state ?? "active") === "active");
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

/**
 * The database indexes' `_index` rows: a search or vector index's row (STUDY-111) has Convex's `config` instead
 * of `fields`, and the catalog of tables and database indexes leaves it out.
 */
export const databaseIndexRows = (rows: Record<string, unknown>[]): IndexMeta[] =>
  rows.filter((r) => r.config === undefined) as unknown as IndexMeta[];

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

/**
 * A search or vector index still being rebuilt after the process started (STUDY-79): Convex's
 * `ErrorMetadata::feature_temporarily_unavailable` while its indexes bootstrap. A system error, not the
 * function's: a query or mutation cannot catch it, the HTTP API answers 503 with its code, and a sync query
 * hitting it is skipped and retried later. The table summaries' (`count()`, STUDY-107) are one too.
 *
 * Also a write refused because an index's memory part is too large (STUDY-111, `TextIndexTooLarge` /
 * `VectorIndexTooLarge`): Convex's `ErrorMetadata::overloaded`, which it handles as it does the above — HTTP
 * 503 with its code, a WebSocket closed with `Again` and the code, a system error a scheduled job retries, a
 * plain `Error` in an action.
 */
export class IndexesUnavailableError extends Error {
  constructor(
    readonly code:
      | "SearchIndexesUnavailable"
      | "VectorIndexesUnavailable"
      | "TableSummariesUnavailable"
      | "TextIndexTooLarge"
      | "VectorIndexTooLarge",
    message: string,
  ) {
    super(message);
    this.name = "IndexesUnavailableError";
  }
}

/** Convex's message while its text indexes bootstrap. */
export const searchIndexesUnavailable = () =>
  new IndexesUnavailableError("SearchIndexesUnavailable", "Search indexes bootstrapping and not yet available for use");
/** Convex's message while its vector indexes bootstrap. */
export const vectorIndexesUnavailable = () =>
  new IndexesUnavailableError(
    "VectorIndexesUnavailable",
    "Vector indexes are bootstrapping and not yet available for use",
  );

/**
 * Convex's refusal of a write to a table whose index has a memory part at its hard limit
 * (`Transaction::validate_memory_index_size`), in its words without the documentation link (DV-04).
 */
export const indexTooLarge = (kind: "text" | "vector", index: string) =>
  new IndexesUnavailableError(
    kind === "text" ? "TextIndexTooLarge" : "VectorIndexTooLarge",
    `Too many writes to ${index}. Spread your writes out over time or throttle them to avoid errors. If you’re importing data into a new application, consider removing the index and adding it again after the import (you can re-add the index as a staged index to avoid blocking your pushes).`,
  );

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
  /** Hidden tables (an import's), by tablet: invisible to functions. */
  readonly hidden = new Map<number, TableDef>();
  /** Tables being deleted, by tablet: invisible; the deletion worker empties them. */
  readonly deleting = new Map<number, TableDef>();

  add(
    name: string,
    tablet: number,
    number: number,
    indexes: CatalogIndex[],
    state: TableState = "active",
    metaId?: string,
  ) {
    const t: TableDef = { id: tablet, number, name, indexes: new Map(), pending: [], byId: undefined as never };
    if (metaId !== undefined) t.metaId = metaId;
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
    if (state === "hidden") this.hidden.set(tablet, t);
    else if (state === "deleting") this.deleting.set(tablet, t);
    else {
      this.tables.set(name, t);
      this.numbers.set(number, t);
    }
    return t;
  }

  /**
   * A copy with tables moved between states (a committed activation or deletion): `delete` moves active
   * tables to `deleting` (an activation lists the tables it replaces there), `activate` makes hidden tables
   * active, `gone` drops a deleted table entirely.
   */
  withTableStates(c: { activate?: number[]; delete?: number[]; gone?: number[] }): Catalog {
    const out = new Catalog();
    for (const t of this.tables.values()) {
      out.tables.set(t.name, t);
      out.numbers.set(t.number, t);
    }
    for (const [k, t] of this.hidden) out.hidden.set(k, t);
    for (const [k, t] of this.deleting) out.deleting.set(k, t);
    for (const tablet of c.delete ?? []) {
      const hidden = out.hidden.get(tablet);
      if (hidden) {
        out.hidden.delete(tablet);
        out.deleting.set(tablet, hidden);
        continue;
      }
      const t = [...out.tables.values()].find((x) => x.id === tablet);
      if (!t) continue;
      out.tables.delete(t.name);
      if (out.numbers.get(t.number) === t) out.numbers.delete(t.number);
      out.deleting.set(tablet, t);
    }
    for (const tablet of c.activate ?? []) {
      const t = out.hidden.get(tablet);
      if (!t) continue;
      out.hidden.delete(tablet);
      out.tables.set(t.name, t);
      out.numbers.set(t.number, t);
    }
    for (const tablet of c.gone ?? []) out.deleting.delete(tablet);
    return out;
  }

  /** The table whose persistence id is `tablet`, if any. */
  byTablet(tablet: number): TableDef | undefined {
    for (const t of this.tables.values()) if (t.id === tablet) return t;
    return this.hidden.get(tablet) ?? this.deleting.get(tablet);
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
    for (const [k, t] of this.hidden) c.hidden.set(k, t);
    for (const [k, t] of this.deleting) c.deleting.set(k, t);
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
  /** The index id allocator's next value once `insertIndexes` took theirs (STUDY-128): the caller writes it. */
  nextIndexId: number;
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
 * whose fields changed) gets the next index id from the allocator (`nextIndexId`, from
 * `_next_persistence_index_id`: never a dropped index's, STUDY-128) and starts `backfilling`, unless its table is new (then it
 * is `enabled` at once). A PENDING index the schema no longer asks for is dropped now; an ENABLED one keeps
 * serving until the push finishes (`finishCatalog`), so a changed index is replaced atomically. Pure: the
 * caller commits. A new user table past `MAX_USER_TABLES` active ones throws `TooManyTablesError`; `userTables`
 * false skips that (a hidden table that will take a system table's name).
 */
export function planCatalog(
  declared: Iterable<DeclaredTable>,
  tables: TableMeta[],
  indexes: IndexMeta[],
  userTables = true,
  allocator?: number,
): CatalogChanges {
  let nextTablet = Math.max(FIRST_TABLET - 1, ...tables.map((t) => t.tablet)) + 1;
  // Only the store's first catalog commit runs before the allocator exists: nothing was dropped yet.
  let nextIndexId = allocator ?? Math.max(FIRST_INDEX_ID - 1, ...indexes.map((i) => i.indexId)) + 1;
  const changes: CatalogChanges = {
    insertTables: [],
    insertIndexes: [],
    deleteIndexes: [],
    restageIndexes: [],
    nextIndexId,
  };
  // The bootstrap tables' fixed numbers are taken too (they have no `_tables` document of their own).
  const usedNumbers = new Set([513, 514, ...tables.map((t) => t.number)]);
  const active = activeTables(tables);
  let userTableCount = active.filter((t) => !t.name.startsWith("_")).length;
  for (const d of declared) {
    let tablet = active.find((t) => t.name === d.name)?.tablet;
    const isNew = tablet === undefined;
    if (tablet === undefined) {
      if (userTables && !d.name.startsWith("_") && userTableCount++ >= MAX_USER_TABLES) throw new TooManyTablesError();
      // A system table takes its fixed number, else the first free one above 512 that no system table
      // reserves; a user table the first free one above 10 000 (Convex).
      const system = d.name.startsWith("_");
      const fixed = system ? SYSTEM_TABLE_NUMBERS[d.name] : undefined;
      let number: number;
      if (fixed !== undefined && !usedNumbers.has(fixed)) number = fixed;
      else {
        number = system ? FIRST_SYSTEM_TABLE_NUMBER : FIRST_USER_TABLE_NUMBER;
        while (usedNumbers.has(number) || (system && RESERVED_SYSTEM_NUMBERS.has(number))) number++;
      }
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
  changes.nextIndexId = nextIndexId;
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
    const tablet = activeTables(tables).find((t) => t.name === d.name)?.tablet;
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
      t.state ?? "active",
      t._id,
    );
  return c;
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Catalog);
