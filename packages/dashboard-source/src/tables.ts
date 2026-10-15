// The Data screen over a bunvex deployment (STUDY-149 PR 2), as Convex's dashboard reads it
// (`dashboard-common/src/features/data`, `lib/useTableMetadata.tsx`): the table mapping (`getTableMapping`, kept
// subscribed as Convex's sidebar keeps it), each table's indexes (`indexes`) and size (`tableSize`), the schema
// (`getSchemas`), a page of documents (`paginatedTableDocuments`, the contract's FilterExpression translated
// to Convex's), documents by id (`listById`), and the inferred shapes (`/api/shapes2`, which Convex's dashboard
// polls every 60 s). A watched table is live as Convex's grid is: its size and the pages served for it stay
// subscribed, and any new result of one of them is the change `watchTable` reports (STUDY-12 D3).
import {
  type CallOptions,
  DataSourceError,
  type Document,
  type DocumentQuery,
  type FieldFilter,
  type FilterExpression,
  type IndexInfo,
  type IndexListEntry,
  type Page,
  type TableInfo,
  type Unsubscribe,
  type ValidatorJson,
} from "@bunvex/dashboard/data-source";
import { canonicalFilter, validateFilter } from "@bunvex/dashboard/filters";
import { decodeId, toJsonValue, type Value } from "@bunvex/values";
import type { AdminHttp } from "./admin-http.ts";
import { type AdminSync, type Args, errorOfFailure } from "./sync.ts";

const GET_TABLE_MAPPING = "_system/frontend/getTableMapping";
const PAGINATED_TABLE_DOCUMENTS = "_system/frontend/paginatedTableDocuments";
const TABLE_SIZE = "_system/frontend/tableSize";
const INDEXES = "_system/frontend/indexes";
const LIST_BY_ID = "_system/frontend/listById";
const GET_SCHEMAS = "_system/frontend/getSchemas";

/** How long one `/api/shapes2` answer serves every caller: SWR's default `dedupingInterval`, as Convex's hook. */
export const SHAPES_DEDUPE_MS = 2000;
/** The most pages of one table kept live while it is watched (two generations of a scrolled grid). */
const MAX_LIVE_PAGES = 200;
/** The most documents read by id (the open document, previews) kept live per table, newest kept. */
const MAX_LIVE_DOCUMENTS = 50;

/** `indexes`' answer (Convex's `_system/frontend/indexes.ts`): the contract's index list entry as it is. */
type IndexJson = IndexListEntry;
/** A refused clause (Convex's `FilterValidationError`), returned as the page's items. */
type FilterValidationError = { error: string; filter: number };
/** `/api/shapes2`'s shape of a table (Convex's `dashboard_shape_json`). */
export type DashboardShape =
  | { type: "Unknown" | "Never" | "Null" | "Int64" | "Boolean" | "String" | "Bytes" | "Float64" }
  | { type: "Id"; tableName: string }
  | { type: "Object"; fields: { fieldName: string; optional: boolean; shape: DashboardShape }[] }
  | { type: "Array"; shape: DashboardShape }
  | { type: "Record"; keyShape: DashboardShape; valueShape: { optional: boolean; shape: DashboardShape } }
  | { type: "Union"; shapes: DashboardShape[] };

const SYSTEM_INDEXES: IndexInfo[] = [
  { name: "by_id", fields: ["_id"], system: true, state: "ready" },
  { name: "by_creation_time", fields: ["_creationTime"], system: true, state: "ready" },
];

const notFound = (table: string) => new DataSourceError("not_found", `Table "${table}" does not exist.`);
const badRequest = (message: string, clause?: string) =>
  new DataSourceError("invalid_request", message, clause === undefined ? {} : { clause });

/** A document as the contract carries it: int64 and bytes in their JSON encodings. */
export const toDocument = (v: unknown) => toJsonValue(v as Value) as unknown as Document;
/** A result's JSON, to tell a new result from the one already seen. */
const fingerprint = (v: unknown) => JSON.stringify(toJsonValue((v ?? null) as Value));

/** UTF-8, then base64: what `paginatedTableDocuments` decodes (Convex's dashboard sends js-base64's form). */
function base64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A declared index as the contract lists it: its fields as declared (without the implied `_creationTime`). */
export function indexInfoOf(ix: IndexJson): IndexInfo | null {
  // a search or vector index is not read by the grid; a staged one is not in the schema's indexes
  if (!Array.isArray(ix.fields) || ix.staged) return null;
  const fields = ix.fields.at(-1) === "_creationTime" ? ix.fields.slice(0, -1) : ix.fields;
  if (ix.backfill.state === "done") return { name: ix.name, fields, system: false, state: "ready" };
  const stats = ix.backfill.stats;
  return {
    name: ix.name,
    fields,
    system: false,
    state: "backfilling",
    ...(stats && {
      progress: { indexed: stats.numDocsIndexed, ...(stats.totalDocs !== null && { total: stats.totalDocs }) },
    }),
  };
}

/**
 * The contract's expression in Convex's form (`lib/filters.ts` `FilterExpression`): the contract's rules are
 * Convex's (DV-479), so the clauses pass as they are, the type `int64` named `bigint`. `origins` names each
 * server clause's contract clause (the server names a refused clause by its position).
 */
export function toServerFilter(expr: FilterExpression): { json: Record<string, unknown>; origins: string[] } {
  const clauses = (expr.clauses as FieldFilter[]).map((c) => ({
    id: c.id,
    field: c.field,
    enabled: c.enabled,
    op: c.op,
    value: (c.op === "type" || c.op === "notype") && c.value === "int64" ? "bigint" : c.value,
  }));
  const origins = clauses.map((c) => c.id);
  const json: Record<string, unknown> = { clauses, order: expr.order };
  if (expr.index) {
    // The enabled equalities (a prefix), then the range on the next field.
    const eq = expr.index.eq.filter((e) => e.enabled).map((e) => ({ type: "indexEq", enabled: true, value: e.value }));
    const r = expr.index.range;
    const range =
      r && (r.lower || r.upper)
        ? [
            {
              type: "indexRange",
              enabled: true,
              ...(r.lower && { lowerOp: r.lower.op, lowerValue: r.lower.value }),
              ...(r.upper && { upperOp: r.upper.op, upperValue: r.upper.value }),
            },
          ]
        : [];
    json.index = { name: expr.index.name, clauses: [...eq, ...range] };
  }
  return { json, origins };
}

/** A shape as a document type (Convex's `displaySchemaFromShape`, as a validator): null for an empty table. */
export function validatorOfShape(shape: DashboardShape, root = true): ValidatorJson | null {
  switch (shape.type) {
    case "Never":
      // no document at all; a nested Never (an empty array's elements) is `v.any()`, as Convex's
      return root ? null : { type: "any" };
    case "Unknown":
      return { type: "any" };
    case "Null":
      return { type: "null" };
    case "Int64":
      return { type: "bigint" };
    case "Float64":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "String":
      return { type: "string" };
    case "Bytes":
      return { type: "bytes" };
    case "Id":
      return { type: "id", tableName: shape.tableName };
    case "Array":
      return { type: "array", value: validatorOfShape(shape.shape, false)! };
    case "Record":
      return {
        type: "record",
        keys: validatorOfShape(shape.keyShape, false)!,
        values: { fieldType: validatorOfShape(shape.valueShape.shape, false)!, optional: false },
      };
    case "Object":
      return {
        type: "object",
        value: Object.fromEntries(
          shape.fields
            // the system fields are not part of a document type (Convex's `filterSystemFields`)
            .filter((f) => !(root && (f.fieldName === "_id" || f.fieldName === "_creationTime")))
            .map((f) => [f.fieldName, { fieldType: validatorOfShape(f.shape, false)!, optional: f.optional }]),
        ),
      };
    case "Union":
      // still the root: a union's objects are documents
      return { type: "union", value: shape.shapes.map((s) => validatorOfShape(s, root) ?? { type: "any" }) };
  }
}

/** A live subscription of one page or document read, kept while its table is watched. */
type LiveRead = {
  udfPath: string;
  args: Args;
  /** The page's generation (`null` for a document read): the grid's pages since its last first page. */
  generation: number | null;
  /** The last result seen (JSON), so a change between the read and the watch is not missed. */
  last?: string;
  off?: () => void;
};

type TableState = {
  reads: Map<string, LiveRead>;
  generation: number;
  /** The filter key of the current generation (`canonicalFilter`). */
  filterKey: string | null;
  watchers: Set<{ onChange: (c: { count?: number }) => void }>;
  count?: number;
  pending: boolean;
};

/** The user tables of a table mapping, sorted (Convex's sidebar: the mapping without `_` names). */
const userTables = (mapping: Record<string, string>) =>
  Object.values(mapping)
    .filter((n) => !n.startsWith("_"))
    .sort();

export class Tables {
  private mappingSub: { off: () => void; value?: Record<string, string>; error?: DataSourceError } | null = null;
  private mappingWaiters: { resolve: (m: Record<string, string>) => void; reject: (e: unknown) => void }[] = [];
  private readonly listWatchers = new Set<{ onChange: () => void; onError: (e: DataSourceError) => void }>();
  private readonly tables = new Map<string, TableState>();
  private shapes: { at: number; promise: Promise<Record<string, DashboardShape>> } | null = null;
  private closed = false;

  constructor(
    private readonly sync: AdminSync,
    private readonly http: AdminHttp,
    private readonly clock: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- the table mapping

  /** The table mapping (number → name), from a subscription kept for the source's life. */
  mapping(signal?: AbortSignal): Promise<Record<string, string>> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const sub = this.mappingSub;
    if (sub?.value) return Promise.resolve(sub.value);
    if (sub?.error) return Promise.reject(sub.error);
    if (!sub) {
      const holder: NonNullable<Tables["mappingSub"]> = { off: () => {} };
      this.mappingSub = holder;
      holder.off = this.sync.watch(GET_TABLE_MAPPING, {}, (r) => {
        if (r.success) {
          const before = holder.value;
          holder.value = r.value as Record<string, string>;
          holder.error = undefined;
          // a table created or deleted: the list's watchers hear it (Convex's sidebar re-renders on the mapping)
          if (before && userTables(before).join("\0") !== userTables(holder.value).join("\0"))
            for (const w of this.listWatchers) w.onChange();
        } else {
          holder.error = errorOfFailure(GET_TABLE_MAPPING, r);
          for (const w of this.listWatchers) w.onError(holder.error);
          // a refusal is not kept: the next read asks again
          if (!holder.value) {
            holder.off();
            if (this.mappingSub === holder) this.mappingSub = null;
          }
        }
        const waiters = this.mappingWaiters.splice(0);
        for (const w of waiters) holder.value ? w.resolve(holder.value) : w.reject(holder.error);
      });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.mappingWaiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          this.mappingWaiters = this.mappingWaiters.filter((w) => w !== waiter);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** The user tables' names, sorted (Convex's sidebar: the mapping without `_` names). */
  async tableNames(signal?: AbortSignal): Promise<string[]> {
    return userTables(await this.mapping(signal));
  }

  /**
   * The contract's `watchTables`: told when the user tables change (a table created or deleted), from the table
   * mapping's subscription (kept for the source's life, as Convex's sidebar keeps `getTableMapping`).
   */
  watchTables(onChange: () => void, onError: (e: DataSourceError) => void): () => void {
    const w = { onChange, onError };
    this.listWatchers.add(w);
    this.mapping().catch((e: unknown) => {
      if (this.listWatchers.has(w))
        onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e)));
    });
    return () => void this.listWatchers.delete(w);
  }

  /** Throws `not_found` for a table the mapping does not have. */
  private async requireTable(table: string, signal?: AbortSignal) {
    if (!(await this.tableNames(signal)).includes(table)) throw notFound(table);
  }

  // ---------------------------------------------------------------- tables

  /** A table's indexes: the two system ones, then the declared ones by name. */
  private async indexesOf(table: string, signal?: AbortSignal): Promise<IndexInfo[]> {
    const json = await this.sync.query<IndexJson[] | null>(INDEXES, { tableName: table, tableNamespace: null }, signal);
    const declared = (json ?? []).map(indexInfoOf).filter((i): i is IndexInfo => i !== null);
    return [...SYSTEM_INDEXES, ...declared.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))];
  }

  async listTables(o?: CallOptions): Promise<TableInfo[]> {
    const signal = o?.signal;
    const [names, schemas] = await Promise.all([
      this.tableNames(signal),
      this.sync.query<{ active?: string }>(GET_SCHEMAS, {}, signal),
    ]);
    const declared = new Set(
      schemas.active
        ? (JSON.parse(schemas.active) as { tables: { tableName: string }[] }).tables.map((t) => t.tableName)
        : [],
    );
    return Promise.all(
      names.map(async (name) => {
        const [indexes, documentCount] = await Promise.all([
          this.indexesOf(name, signal),
          this.sync.query<number>(TABLE_SIZE, { tableName: name }, signal),
        ]);
        return { name, indexes, documentCount, declared: declared.has(name) };
      }),
    );
  }

  // ---------------------------------------------------------------- documents

  async listDocuments(q: DocumentQuery, o?: CallOptions): Promise<Page<Document>> {
    const signal = o?.signal;
    if (!Number.isInteger(q.numItems) || q.numItems < 1)
      throw badRequest(`numItems must be a positive integer, not ${q.numItems}.`);
    await this.requireTable(q.table, signal);
    let filters: string | null = null;
    let origins: string[] = [];
    if (q.filter) {
      // The declared indexes are read only when the expression names one.
      const named = q.filter.index?.name;
      const indexes =
        named === undefined || SYSTEM_INDEXES.some((i) => i.name === named)
          ? SYSTEM_INDEXES
          : await this.indexesOf(q.table, signal);
      validateFilter(q.filter, indexes);
      const server = toServerFilter(q.filter);
      filters = base64(JSON.stringify(server.json));
      origins = server.origins;
    }
    const args = { table: q.table, filters, paginationOpts: { numItems: q.numItems, cursor: q.cursor } };
    const result = await this.sync
      .query<Page<Record<string, unknown>>>(PAGINATED_TABLE_DOCUMENTS, args, signal)
      .catch((e: unknown) => {
        throw pageError(e);
      });
    const refused = result.page.filter((d): d is FilterValidationError & Record<string, unknown> => !("_id" in d));
    if (refused.length > 0) {
      const first = refused[0]!;
      throw badRequest(first.error, first.filter === -1 ? "index" : origins[first.filter]);
    }
    this.servedPage(q, args, result);
    return { ...result, page: result.page.map(toDocument) };
  }

  async getDocument(table: string, id: string, o?: CallOptions): Promise<Document | null> {
    await this.requireTable(table, o?.signal);
    const args = { ids: [{ id, tableName: table }] };
    const [doc] = await this.sync.query<(Record<string, unknown> | null)[]>(LIST_BY_ID, args, o?.signal);
    this.servedRead(table, { udfPath: LIST_BY_ID, args, generation: null, last: fingerprint([doc ?? null]) });
    return doc ? toDocument(doc) : null;
  }

  /** The user table an id is of (Convex's `getReferencedTableName`), or null. */
  async tableOfId(id: string, o?: CallOptions): Promise<string | null> {
    let number: number;
    try {
      number = decodeId(id).tableNumber;
    } catch {
      return null;
    }
    // the mapping's system tables are the two ids can point into (`_file_storage`, `_scheduled_jobs`), as Convex's
    return (await this.mapping(o?.signal))[String(number)] ?? null;
  }

  // ---------------------------------------------------------------- shapes

  /** `/api/shapes2`, one answer shared by every caller within SWR's deduping interval. */
  private tableShapes(signal?: AbortSignal): Promise<Record<string, DashboardShape>> {
    const now = this.clock();
    if (!this.shapes || now - this.shapes.at >= SHAPES_DEDUPE_MS) {
      const promise = this.http.json<Record<string, DashboardShape>>("/api/shapes2");
      this.shapes = { at: now, promise };
      promise.catch(() => {
        if (this.shapes?.promise === promise) this.shapes = null;
      });
    }
    const p = this.shapes.promise;
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      p.then(resolve, reject);
    });
  }

  async inferDocumentType(table: string, o?: CallOptions): Promise<ValidatorJson | null> {
    await this.requireTable(table, o?.signal);
    const shape = (await this.tableShapes(o?.signal))[table];
    return shape ? validatorOfShape(shape) : null;
  }

  // ---------------------------------------------------------------- live tables

  private state(table: string): TableState {
    let s = this.tables.get(table);
    if (!s) {
      s = { reads: new Map(), generation: 0, filterKey: null, watchers: new Set(), pending: false };
      this.tables.set(table, s);
    }
    return s;
  }

  /** Remembers a page the grid loaded: a first page starts a generation; a page of another query is not kept. */
  private servedPage(q: DocumentQuery, args: Args, result: unknown) {
    const s = this.state(q.table);
    const key = canonicalFilter(q.table, q.filter);
    if (q.cursor === null) {
      s.generation++;
      s.filterKey = key;
      // two generations at most: the pages a refetch asks again keep their subscription
      for (const [k, r] of s.reads)
        if (r.generation !== null && r.generation < s.generation - 1) {
          r.off?.();
          s.reads.delete(k);
        }
    } else if (key !== s.filterKey) return;
    if ([...s.reads.values()].filter((r) => r.generation !== null).length >= MAX_LIVE_PAGES) return;
    this.servedRead(q.table, {
      udfPath: PAGINATED_TABLE_DOCUMENTS,
      args,
      generation: s.generation,
      last: fingerprint(result),
    });
  }

  private servedRead(table: string, read: LiveRead) {
    const s = this.state(table);
    const k = `${read.udfPath}:${JSON.stringify(read.args)}`;
    const known = s.reads.get(k);
    if (known) {
      if (read.generation !== null) known.generation = read.generation;
      return;
    }
    s.reads.set(k, read);
    if (read.generation === null) {
      const docs = [...s.reads].filter(([, r]) => r.generation === null);
      for (const [key, r] of docs.slice(0, Math.max(0, docs.length - MAX_LIVE_DOCUMENTS))) {
        r.off?.();
        s.reads.delete(key);
      }
    }
    if (s.watchers.size > 0) this.subscribe(s, read);
  }

  private subscribe(s: TableState, read: LiveRead) {
    read.off = this.sync.watch(read.udfPath, read.args, (r) => {
      const json = r.success ? fingerprint(r.value) : JSON.stringify(r.errorMessage);
      if (read.last !== undefined && json !== read.last) this.changed(s);
      read.last = json;
    });
  }

  /** Coalesces the changes of one transition into one call per watcher. */
  private changed(s: TableState) {
    if (s.pending) return;
    s.pending = true;
    setTimeout(() => {
      s.pending = false;
      if (this.closed) return;
      for (const w of [...s.watchers]) w.onChange(s.count === undefined ? {} : { count: s.count });
    }, 0);
  }

  /**
   * The contract's `watchIndexes`: `indexes` for the table kept subscribed, as Convex's index list keeps it; each
   * new answer passed on as it is (null for a table that does not exist).
   */
  watchIndexes(
    table: string,
    onIndexes: (indexes: IndexListEntry[] | null) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe {
    return this.sync.watch(INDEXES, { tableName: table, tableNamespace: null }, (r) => {
      if (!r.success) onError(errorOfFailure(INDEXES, r));
      else onIndexes((r.value as IndexJson[] | null) ?? null);
    });
  }

  watchTable(
    table: string,
    onChange: (change: { count?: number }) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe {
    let stopped = false;
    let offSize = () => {};
    const watcher = { onChange };
    const s = this.state(table);
    const start = () => {
      s.watchers.add(watcher);
      if (s.watchers.size === 1) for (const read of s.reads.values()) this.subscribe(s, read);
      let first = true;
      offSize = this.sync.watch(TABLE_SIZE, { tableName: table }, (r) => {
        if (!r.success) return onError(errorOfFailure(TABLE_SIZE, r));
        const count = r.value as number;
        const changed = !first && count !== s.count;
        first = false;
        s.count = count;
        if (changed) this.changed(s);
      });
    };
    this.requireTable(table).then(
      () => {
        if (!stopped) start();
      },
      (e: unknown) => {
        if (!stopped) onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e)));
      },
    );
    return () => {
      if (stopped) return;
      stopped = true;
      offSize();
      if (!s.watchers.delete(watcher) || s.watchers.size > 0) return;
      for (const read of s.reads.values()) {
        read.off?.();
        read.off = undefined;
      }
    };
  }

  close() {
    this.closed = true;
    this.listWatchers.clear();
    this.mappingSub?.off();
    this.mappingSub = null;
    for (const s of this.tables.values()) for (const r of s.reads.values()) r.off?.();
    this.tables.clear();
  }
}

/** A failed page read: a cursor or an expression the server refuses is the caller's mistake. */
export function pageError(e: unknown): unknown {
  if (!(e instanceof DataSourceError) || e.code !== "unavailable") return e;
  if (/InvalidCursor|Failed to parse cursor|Invalid filters|at least 1 document|options\.numItems/.test(e.message))
    return new DataSourceError("invalid_request", e.message);
  return e;
}
