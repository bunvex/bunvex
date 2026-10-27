// The Data screen's reads (STUDY-149 PR 2), as Convex's npm-packages/system-udfs/convex/_system/frontend: the
// table mapping (`getTableMapping.ts`), a page of a table under the dashboard's filters
// (`paginatedTableDocuments.ts` with `lib/filters.ts`), a table's indexes (`indexes.ts`) and documents by id
// (`listById.ts`, `getById.ts`). Same names, arguments, result shapes and errors; a `componentId` runs them in that
// component's namespace, as Convex's (`inSystemComponent`). `tableSize` is in system-functions.ts.
import { SCHEMAS_TABLE, schemaStateOf, type TabletId, type Tx, type TxQueryChained, tabletOf } from "@bunvex/core";
import { decodeId, fromJsonValue, type JSONValue, type Value, v } from "@bunvex/values";
import { paginationOptsValidator } from "./pagination.ts";
import type { SystemQuery } from "./system-functions.ts";

/** Convex's paginationLimits.ts. */
const maximumRowsRead = 10000;
const maximumBytesRead = 5000000;

const componentId = v.optional(v.union(v.string(), v.null()));

/**
 * What the dashboard sends for `undefined` in a filter's value, which a function's arguments cannot carry
 * (Convex's `lib/values.ts` `UNDEFINED_PLACEHOLDER`, renamed by rule 5: DV-478). A field compared with it is a
 * field the document does not have.
 */
export const UNDEFINED_PLACEHOLDER =
  "__BUNVEX_PLACEHOLDER_undefined_I23atX0jcndVbFgXoQZffsih7eAqktCyFjgUuAeNBtfr3ySOljPSPSEOPFgprkdBO3zXNiGEJxmJ5ZFPc5C5qKesG80QRPvlJe8vgSxAt9feLTwxTg4PHfVwUaTEJU67FDwldWmTxp1guMPwxQ2jOuhEryTBf3mQ";

// ------------------------------------------------------------------ the filter expression (lib/filters.ts)

type BuiltinOp = "eq" | "neq" | "gte" | "lte" | "gt" | "lt";
type TypeFilterValue =
  | "string"
  | "boolean"
  | "number"
  | "bigint"
  | "null"
  | "id"
  | "array"
  | "object"
  | "bytes"
  | "unset";
type Clause = { id?: string; field?: string; enabled?: boolean } & (
  | { op: BuiltinOp; value?: unknown }
  | { op: "anyOf" | "noneOf"; value?: unknown[] }
  | { op: "type" | "notype"; value?: TypeFilterValue }
);
type IndexClause =
  | { type: "indexEq"; enabled: boolean; value?: unknown }
  | {
      type: "indexRange";
      enabled: boolean;
      lowerOp?: "gte" | "gt";
      lowerValue?: unknown;
      upperOp?: "lte" | "lt";
      upperValue?: unknown;
    };
type DatabaseIndexFilter = { name: string; clauses: IndexClause[] };
type SearchIndexFilter = {
  name: string;
  search: string;
  clauses: { field: string; enabled: boolean; value: unknown }[];
};
/** Convex's `FilterExpression`: what the dashboard sends, as base64 of its JSON. */
export type FilterExpression = {
  clauses: Clause[];
  order?: "asc" | "desc";
  index?: DatabaseIndexFilter | SearchIndexFilter;
};
/** A clause the function refuses, returned in place of the page's documents (Convex's `FilterValidationError`). */
export type FilterValidationError = { error: string; filter: number };

const BUILTIN_OPS = ["eq", "neq", "gte", "lte", "gt", "lt"];
const TYPE_VALUES: TypeFilterValue[] = [
  "string",
  "boolean",
  "number",
  "bigint",
  "null",
  "id",
  "array",
  "object",
  "bytes",
  "unset",
];
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Convex's `FilterExpressionSchema.parse` (a zod schema): the expression's shape, `index` left to the code.
 * Its message is bunvex's own (zod's is a JSON dump of its issues); the dashboard never sends a bad one.
 */
function checkExpression(x: unknown): asserts x is FilterExpression {
  const bad = (path: string, what: string) => {
    throw new Error(`Invalid filters: ${path} ${what}.`);
  };
  if (!isObject(x)) bad("the expression", "must be an object");
  const e = x as Record<string, unknown>;
  if (e.op !== undefined && e.op !== "and") bad("op", 'must be "and"');
  if (!Array.isArray(e.clauses)) bad("clauses", "must be an array");
  if (e.order !== undefined && e.order !== "asc" && e.order !== "desc") bad("order", 'must be "asc" or "desc"');
  for (const [i, c] of (e.clauses as unknown[]).entries()) {
    const at = `clauses[${i}]`;
    if (!isObject(c)) bad(at, "must be an object");
    const clause = c as Record<string, unknown>;
    if (clause.field !== undefined && typeof clause.field !== "string") bad(`${at}.field`, "must be a string");
    if (clause.id !== undefined && typeof clause.id !== "string") bad(`${at}.id`, "must be a string");
    if (clause.enabled !== undefined && typeof clause.enabled !== "boolean") bad(`${at}.enabled`, "must be a boolean");
    const op = clause.op;
    if (BUILTIN_OPS.includes(op as string)) continue;
    if (op === "type" || op === "notype") {
      if (clause.value !== undefined && !TYPE_VALUES.includes(clause.value as TypeFilterValue))
        bad(`${at}.value`, "must be a type name");
    } else if (op === "anyOf" || op === "noneOf") {
      if (clause.value !== undefined && !Array.isArray(clause.value)) bad(`${at}.value`, "must be an array");
    } else bad(`${at}.op`, "is not an operator");
  }
}

/** Convex's `jsonToConvex`, which refuses `undefined` (a clause with no value). */
function jsonToValue(x: unknown): Value {
  if (x === undefined) throw new Error("Unexpected type of undefined");
  return fromJsonValue(x as JSONValue);
}

/** A value the dashboard sent, as a `Value`; one that is not a JSON value is passed as it is (Convex's). */
function jsonToValueOr(x: unknown): Value | undefined {
  if (x === undefined || x === UNDEFINED_PLACEHOLDER) return undefined;
  try {
    return fromJsonValue(x as JSONValue);
  } catch {
    return x as Value;
  }
}

const isId = (x: string) => {
  try {
    decodeId(x);
    return true;
  } catch {
    return false;
  }
};

/** Convex's `isType`; an object is none of null, an array, an id or bytes. */
function isType(x: Value | undefined, type: TypeFilterValue): boolean {
  switch (type) {
    case "null":
      return x === null;
    case "array":
      return Array.isArray(x);
    case "id":
      return typeof x === "string" && isId(x);
    case "bytes":
      return x instanceof ArrayBuffer;
    case "object":
      return typeof x === "object" && !(["null", "array", "id", "bytes"] as const).some((t) => isType(x, t));
    case "unset":
      return x === undefined;
    default:
      return typeof x === type;
  }
}

/** The search and database index definitions a table's active schema declares, then the two system ones. */
type IndexDef = { indexDescriptor: string; fields: string[] };
type SearchIndexDef = { indexDescriptor: string; searchField: string; filterFields: string[] };

/** Convex's `getAvailableIndexes`: the active schema's indexes of `table`, then `by_creation_time` and `by_id`. */
async function availableIndexes(db: Tx, table: string): Promise<(IndexDef | SearchIndexDef)[]> {
  const rows = (await db.asSystem(() => db.query(SCHEMAS_TABLE).collect())) as Record<string, unknown>[];
  const active = rows.find((r) => schemaStateOf(r) === "active") as { schema?: string } | undefined;
  const system: IndexDef[] = [
    { indexDescriptor: "by_creation_time", fields: ["_creationTime"] },
    { indexDescriptor: "by_id", fields: ["_id"] },
  ];
  if (!active?.schema) return system;
  const parsed = (
    JSON.parse(active.schema) as {
      tables: { tableName: string; indexes?: IndexDef[]; searchIndexes?: SearchIndexDef[] }[];
    }
  ).tables.find((t) => t.tableName === table);
  return [...(parsed?.indexes ?? []), ...(parsed?.searchIndexes ?? []), ...system];
}

/** Convex's `validateIndexFilter`: an error naming no clause (`filter: -1`), or nothing. */
function validateIndexFilter(
  name: string,
  clauses: IndexClause[],
  ix: IndexDef | SearchIndexDef | undefined,
): FilterValidationError | undefined {
  if (!ix) return { filter: -1, error: `Index ${name} does not exist.` };
  if ("searchField" in ix)
    return {
      filter: -1,
      error: `Index ${name} is a search index, but the query is trying to use it as a database index.`,
    };
  if (clauses.length > ix.fields.length)
    return {
      filter: -1,
      error: `Index ${name} has ${ix.fields.length} fields, but the query has ${clauses.length} clauses.`,
    };
  let firstDisabled = -1;
  for (let i = 0; i < clauses.length; i++) {
    if (clauses[i]!.enabled) {
      if (firstDisabled !== -1)
        return {
          filter: -1,
          error: "Invalid index filter selection: found an enabled clause after an disabled clause.",
        };
    } else if (firstDisabled === -1) firstDisabled = i;
  }
  // As Convex's: only the clauses before the first disabled one are looked at here.
  for (let i = 0; i < firstDisabled; i++)
    if (clauses[i]!.type === "indexRange" && i !== firstDisabled - 1)
      return { filter: -1, error: "Invalid index filter selection: found a range filter after a non-range filter." };
  return undefined;
}

/** Convex's `validateSearchIndexFilter`. */
function validateSearchIndexFilter(
  name: string,
  clauses: SearchIndexFilter["clauses"],
  ix: IndexDef | SearchIndexDef | undefined,
  order: "asc" | "desc",
): FilterValidationError | undefined {
  if (!ix) return { filter: -1, error: `Index ${name} does not exist.` };
  if (!("searchField" in ix))
    return {
      filter: -1,
      error: `Index ${name} is not a search index, but the query is trying to use it as search index.`,
    };
  if (order !== "asc") return { filter: -1, error: `Trying to query search index \`${name}\` in descending order.` };
  for (const [i, c] of clauses.entries()) {
    if (!c.enabled) continue;
    if (!ix.filterFields.includes(c.field))
      return {
        filter: i,
        error: `Invalid index filter selection: found a filter for field \`${c.field}\` which is not part of the filter fields of the search index \`${name}\`.`,
      };
    if (clauses.some((o, j) => i !== j && o.enabled && o.field === c.field))
      return { filter: i, error: `Invalid filter: there are multiple filters for field \`${c.field}\`.` };
  }
  return undefined;
}

type RangeBuilder = {
  eq(f: string, x: Value | undefined): RangeBuilder;
  gt(f: string, x: Value | undefined): RangeBuilder;
  gte(f: string, x: Value | undefined): RangeBuilder;
  lt(f: string, x: Value | undefined): RangeBuilder;
  lte(f: string, x: Value | undefined): RangeBuilder;
};

/** Convex's `applyIndexFilters`: the enabled clauses (a prefix) on the index's fields in order. */
function applyIndexFilters(q: RangeBuilder, clauses: IndexClause[], ix: IndexDef): RangeBuilder {
  let b = q;
  const enabled = clauses.filter((c) => c.enabled).length;
  for (let i = 0; i < enabled; i++) {
    const c = clauses[i]!;
    const field = ix.fields[i]!;
    if (c.type === "indexEq") b = b.eq(field, jsonToValueOr(c.value));
    else {
      if (i !== enabled - 1) throw new Error("Index range not supported");
      if (c.lowerOp) b = b[c.lowerOp](field, jsonToValueOr(c.lowerValue));
      if (c.upperOp) b = b[c.upperOp](field, jsonToValueOr(c.upperValue));
    }
  }
  return b;
}

type ValidBuiltin = Extract<Clause, { op: BuiltinOp | "anyOf" | "noneOf" }> & { field: string };
type ValidType = Extract<Clause, { op: "type" | "notype" }> & { field: string; value: TypeFilterValue };
type FilterQ = Parameters<Parameters<TxQueryChained["filter"]>[0]>[0];

/** Convex's `applyBuiltinFilters`: every clause with a field, joined by `and`. */
function applyBuiltinFilters(q: FilterQ, clauses: ValidBuiltin[]) {
  const valid = clauses.filter((c) => c.field !== undefined);
  if (valid.length === 0) return true;
  return q.and(
    ...valid.map((c) => {
      const value = jsonToValue(c.value);
      if (c.op === "anyOf" || c.op === "noneOf") {
        const values = c.value as unknown[];
        if (values.length === 0) return true;
        // As Convex's: the list's elements are compared as sent (not decoded), the placeholder as `undefined`;
        // an encoded value (`{$integer}`, `{$bytes}`) is an object with a `$` field, which a filter refuses.
        const each = values.map((x) => (x === UNDEFINED_PLACEHOLDER ? undefined : literal(x)));
        return c.op === "anyOf"
          ? q.or(...each.map((x) => q.eq(q.field(c.field), x)))
          : q.and(...each.map((x) => q.neq(q.field(c.field), x)));
      }
      return q[c.op](q.field(c.field), value === UNDEFINED_PLACEHOLDER ? undefined : value);
    }),
  );
}

/** A value as a filter's literal: Convex's `convexToJson` refuses a field name starting with `$`. */
function literal(x: unknown): Value {
  const check = (y: unknown) => {
    if (Array.isArray(y)) for (const e of y) check(e);
    else if (isObject(y))
      for (const [k, e] of Object.entries(y)) {
        if (k.startsWith("$")) throw new Error(`Field name ${k} starts with a '$', which is reserved.`);
        check(e);
      }
  };
  check(x);
  return x as Value;
}

/** Convex's `applyTypeFilters`: on the page read, by each top-level field's type. */
function applyTypeFilters(page: Record<string, Value>[], clauses: ValidType[]) {
  const valid = clauses.filter((c) => c.field !== undefined && c.enabled !== false);
  return page.filter((doc) =>
    valid.every((c) => {
      const matches = isType(doc[c.field], c.value);
      return c.op === "type" ? matches : !matches;
    }),
  );
}

/** Convex's `findErrorsInFilters`: a clause whose value is not a JSON value. */
function findErrorsInFilters(expr: FilterExpression): FilterValidationError[] {
  const errors: FilterValidationError[] = [];
  for (const [i, c] of expr.clauses.entries()) {
    if (!c.value) continue;
    try {
      jsonToValue(c.value);
    } catch {
      errors.push({ filter: i, error: `Invalid value: ${JSON.stringify(c.value)}.` });
    }
  }
  return errors;
}

/** js-base64's `decode`: base64 (standard or URL-safe, padded or not) of UTF-8. */
function decodeBase64(s: string): string {
  const std = s.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/")).replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A page with no documents, as Convex's shortcuts and refusals answer. */
const donePage = <T>(page: T[]) => ({ page, isDone: true, continueCursor: "" });

// ------------------------------------------------------------------ the functions

type Row = Record<string, unknown> & { _id: string };

/** The system tables a `queryGeneric` system function reads (Convex's `secretSystemTables.ts` `VIRTUAL_TABLES`). */
const VIRTUAL_TABLES = ["_storage", "_scheduled_functions"];
/** Convex's `maskPublicSystem(db).get`: a document of a public system table, null for any other id. */
async function publicSystemGet(db: Tx, id: string) {
  for (const t of VIRTUAL_TABLES) if (db.system.normalizeId(t, id)) return db.system.get(id);
  return null;
}

/**
 * Whether a `_tables` row is of the namespace `db` runs in: the root's has no `namespace`, a component's names its
 * id (a system function given a `componentId` runs in that component, `inSystemComponent`).
 */
export const ofCurrentNamespace = (db: Tx, row: Record<string, unknown>) =>
  ((row.namespace as { id?: string } | undefined)?.id ?? null) === db.componentId;

export const DATA_SYSTEM_QUERIES: Record<string, SystemQuery> = {
  // Convex's `getTableMapping`: each active table's number and name, the user tables and the two system tables
  // the dashboard links ids to; the first 1000 by number. Reading `_tables` makes it live, as Convex's table
  // mapping dependency.
  "_system/frontend/getTableMapping": {
    args: { componentId },
    handler: async (db) => {
      const rows = (await db.asSystem(() => db.query("_tables").collect())) as Row[];
      const tables = rows
        .filter((r) => (r.state ?? "active") === "active" && ofCurrentNamespace(db, r))
        .map((r) => [Number(r.number as bigint), r.name as string] as const)
        .filter(([, name]) => !name.startsWith("_") || name === "_scheduled_jobs" || name === "_file_storage")
        .sort((a, b) => a[0] - b[0])
        .slice(0, 1000);
      return Object.fromEntries(tables.map(([n, name]) => [String(n), name]));
    },
  },
  // Convex's `paginatedTableDocuments`: a page of `table` under the dashboard's filters (base64 of a
  // `FilterExpression`), newest first by default. A refused expression answers its errors as the page.
  "_system/frontend/paginatedTableDocuments": {
    args: {
      paginationOpts: paginationOptsValidator,
      table: v.string(),
      filters: v.union(v.string(), v.null()),
      componentId,
    },
    handler: async (
      db,
      {
        paginationOpts,
        table,
        filters,
      }: {
        paginationOpts: Record<string, unknown> & { numItems: number; cursor: string | null };
        table: string;
        filters: string | null;
      },
    ) => {
      const parsed = filters ? (JSON.parse(decodeBase64(filters)) as unknown) : null;
      if (parsed) checkExpression(parsed);
      const expr = parsed as FilterExpression | null;
      if (expr?.clauses?.length) {
        const errors = findErrorsInFilters(expr);
        if (errors.length) return donePage(errors);
      }
      const enabled = expr?.clauses?.filter((c) => c.enabled !== false);
      const init = db.query(table);
      let query: TxQueryChained | undefined;
      const order = expr?.order || "desc";
      const indexFilter = expr?.index;
      const hasIndexFilter =
        indexFilter && ("search" in indexFilter || indexFilter.clauses.filter((c) => c.enabled).length > 0);
      if (indexFilter) {
        const selected = (await availableIndexes(db, table)).find((i) => i.indexDescriptor === indexFilter.name);
        const isSearch = "search" in indexFilter;
        const error = isSearch
          ? validateSearchIndexFilter(indexFilter.name, indexFilter.clauses, selected, order)
          : validateIndexFilter(indexFilter.name, indexFilter.clauses, selected);
        if (error) return donePage([error]);
        query = isSearch
          ? init.withSearchIndex(indexFilter.name, (q) => {
              let b = q.search((selected as SearchIndexDef).searchField, indexFilter.search);
              for (const c of indexFilter.clauses) if (c.enabled) b = b.eq(c.field, jsonToValueOr(c.value));
              return b;
            })
          : init
              .withIndex(
                indexFilter.name,
                (q) =>
                  applyIndexFilters(q as unknown as RangeBuilder, indexFilter.clauses, selected as IndexDef) as never,
              )
              .order(order);
      }
      const builtin = (enabled ?? []).filter((c) => c.op !== "type" && c.op !== "notype") as ValidBuiltin[];
      const types = (enabled ?? []).filter((c) => c.op === "type" || c.op === "notype") as ValidType[];
      if (builtin.length > 0) {
        // One document by its id: a `db.get` (Convex's shortcut), nothing when the id is not this table's.
        const only = builtin[0]!;
        if (!hasIndexFilter && builtin.length === 1 && only.field === "_id" && only.op === "eq") {
          if (typeof only.value !== "string") return donePage([]);
          const id = db.normalizeId(table, only.value);
          if (id === null) return donePage([]);
          const doc = await db.get(id);
          return donePage(doc === null ? [] : [doc]);
        }
        query = (query ?? init.order(order)).filter((q) => applyBuiltinFilters(q, builtin));
      }
      const { page, ...rest } = await (query ?? init.order(order)).paginate({
        ...paginationOpts,
        maximumRowsRead,
        maximumBytesRead,
      });
      return { page: types.length ? applyTypeFilters(page as Record<string, Value>[], types) : page, ...rest };
    },
  },
  // Convex's `indexes`: the declared indexes of a table (not `by_id` nor `by_creation_time`), each with its
  // fields, whether it is staged, and its backfill (with its counts while it runs); undefined for no table.
  "_system/frontend/indexes": {
    args: { tableName: v.optional(v.union(v.string(), v.null())), tableNamespace: v.union(v.string(), v.null()) },
    handler: async (db, { tableName, tableNamespace }: { tableName?: string | null; tableNamespace: string | null }) =>
      db.asSystem(async () => {
        if (!tableName) return undefined;
        const named = (await db
          .query("_tables")
          .withIndex("by_name", (q) => q.eq("name", tableName))
          .filter((q) => q.eq(q.field("state"), "active"))
          .collect()) as Row[];
        const matching = named.filter((t) =>
          tableNamespace === null
            ? t.namespace === undefined
            : (t.namespace as { id?: string } | undefined)?.id === tableNamespace,
        );
        if (matching.length !== 1) return undefined;
        const tablet = tabletOf(matching[0]!._id);
        const rows = (await db
          .query("_index")
          .withIndex("by_id")
          .filter((q) => q.eq(q.field("table_id"), tablet))
          .collect()) as Row[];
        const out = [];
        for (const ix of rows) {
          if (ix.descriptor === "by_id" || ix.descriptor === "by_creation_time") continue;
          const { fields, state, staged } = indexFieldsAndState(db, ix);
          if (state === "backfilling") {
            const backfill = (await db
              .query("_index_backfills")
              .withIndex("by_index_id", (q) => q.eq("indexId", ix._id))
              .unique()) as Row | null;
            const stats = backfill
              ? {
                  numDocsIndexed: Number(backfill.numDocsIndexed as bigint),
                  totalDocs: backfill.totalDocs ? Number(backfill.totalDocs as bigint) : null,
                }
              : undefined;
            out.push({ name: ix.descriptor, staged, fields, backfill: { state, stats } });
          } else out.push({ name: ix.descriptor, staged, fields, backfill: { state } });
        }
        return out;
      }),
  },
  // Convex's `listById`: each `{id, tableName}` read, or null when the id is not one of that table's. A system
  // table is named as the dashboard shows it (`_file_storage`, `_scheduled_jobs`) and read through its public
  // virtual table; any other is none.
  "_system/frontend/listById": {
    args: { componentId, ids: v.array(v.object({ id: v.string(), tableName: v.string() })) },
    handler: async (db, { ids }: { ids: { id: string; tableName: string }[] }) =>
      Promise.all(
        ids.map(async ({ id, tableName }) => {
          if (tableName.startsWith("_")) {
            const name =
              tableName === "_file_storage"
                ? "_storage"
                : tableName === "_scheduled_jobs"
                  ? "_scheduled_functions"
                  : tableName;
            const normalized = VIRTUAL_TABLES.includes(name) ? db.system.normalizeId(name, id) : null;
            return normalized === null ? null : publicSystemGet(db, normalized);
          }
          const normalized = db.normalizeId(tableName, id);
          return normalized === null ? null : db.get(normalized);
        }),
      ),
  },
  // Convex's `getById`: a document by its id alone; otherwise a public system table's, or null.
  "_system/frontend/getById": {
    args: { id: v.string(), componentId },
    handler: async (db, { id }: { id: string }) => {
      try {
        return await db.get(id);
      } catch {
        return await publicSystemGet(db, id);
      }
    },
  },
};

/**
 * `fieldsAndState` of an `_index` row, a search or vector index's state taken from the engine: bunvex writes their
 * rows backfilling for good (DV-415), so the state Convex's row would hold is the engine's build — built and enabled
 * `done`, built and staged `backfilled` (DV-368: no `Backfilled` while a push waits).
 */
function indexFieldsAndState(db: Tx, ix: Row): ReturnType<typeof fieldsAndState> {
  const config = ix.config as Record<string, unknown>;
  const read = fieldsAndState(config);
  if (config.type !== "search" && config.type !== "vector") return read;
  const build = db.searchIndexBuild(config.type, ix.table_id as TabletId, ix.descriptor as string);
  if (!build) return read;
  const state = !build.built ? "backfilling" : build.staged ? "backfilled" : "done";
  return { fields: read.fields, state, staged: state !== "done" && build.staged };
}

/** An `_index` row's fields, state and staging, as Convex's `indexes` reads them (`getIndexFieldsAndState`). */
function fieldsAndState(config: Record<string, unknown>): {
  fields: unknown;
  state: "backfilling" | "backfilled" | "done";
  staged: boolean;
} {
  const o = config.onDiskState as Record<string, unknown>;
  switch (config.type) {
    case "database": {
      if (o.type === "Backfilling")
        return {
          fields: config.fields,
          state: "backfilling",
          staged: ((o.backfillState as { staged?: boolean }).staged ?? false) as boolean,
        };
      if (o.type === "Backfilled2")
        return { fields: config.fields, state: "backfilled", staged: (o.staged as boolean | undefined) ?? false };
      return { fields: config.fields, state: "done", staged: false };
    }
    case "search": {
      const s = o.state;
      const state =
        s === "backfilling" || s === "backfilling2"
          ? "backfilling"
          : s === "backfilled" || s === "backfilled2"
            ? "backfilled"
            : "done";
      const staged =
        s === "backfilling" || s === "backfilling2" || s === "backfilled2"
          ? ((o.staged as boolean | undefined) ?? false)
          : false;
      return { fields: { searchField: config.searchField, filterFields: config.filterFields }, state, staged };
    }
    case "vector": {
      const s = o.state;
      const state =
        s === "backfilling" ? "backfilling" : s === "backfilled" || s === "backfilled2" ? "backfilled" : "done";
      const staged =
        s === "backfilling" || s === "backfilled" || s === "backfilled2"
          ? ((o.staged as boolean | undefined) ?? false)
          : false;
      return {
        fields: {
          vectorField: config.vectorField,
          filterFields: config.filterFields,
          dimensions: Number(config.dimensions as bigint),
        },
        state,
        staged,
      };
    }
    default:
      throw new Error("Unknown index type");
  }
}

/**
 * Convex's `GET /api/get_indexes` (`local_backend/src/dashboard.rs`, ViewData): every declared index of the user
 * tables (`IndexModel::get_application_indexes`), as `IndexMetadataResponse` (`schema.rs`): its table, name,
 * fields, backfill (`in_progress` or `done`) and whether it is staged. The CLI waits on it; the dashboard reads
 * `indexes` instead.
 */
export async function applicationIndexes(db: Tx) {
  return db.asSystem(async () => {
    const tables = new Map<string, string>();
    for (const t of (await db.query("_tables").collect()) as Row[])
      if ((t.state ?? "active") === "active" && t.namespace === undefined && !(t.name as string).startsWith("_"))
        tables.set(tabletOf(t._id), t.name as string);
    const out = [];
    for (const ix of (await db.query("_index").collect()) as Row[]) {
      const table = tables.get(ix.table_id as string);
      if (table === undefined || ix.descriptor === "by_id" || ix.descriptor === "by_creation_time") continue;
      const { fields, state, staged } = indexFieldsAndState(db, ix);
      out.push({
        table,
        name: ix.descriptor as string,
        fields,
        backfill: { state: state === "backfilling" ? "in_progress" : "done" },
        staged,
      });
    }
    return out.sort((a, b) => (a.table === b.table ? cmp(a.name, b.name) : cmp(a.table, b.table)));
  });
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
