// convex-helpers' `server/pagination.ts` (get-convex/convex-helpers @ e48f9df, 0.1.128) for bunvex (STUDY-181 PR 4):
// pages of a table between two index keys, for apps that stitch pages together themselves, and `paginator`, a
// `ctx.db` whose `paginate` can run anywhere (several times in a function, in a component).
//
// - `getPage` reads one row past its limit to learn `hasMore`, and returns each document's raw index key (not a
//   cursor), to pass back as a later page's `startIndexKey` or `endIndexKey`.
// - An empty key is an unbounded end, whatever its inclusivity.
// - `PageRequest.indexFields` is declared and never read, as upstream (STUDY-181 H-7): the fields come from `schema`.
//
// Written for bunvex from the study and convex-helpers' tests, on `server/stream`; the API, the behaviour and the
// messages are convex-helpers'.
// biome-ignore-all lint/suspicious/noExplicitAny: the public signatures are convex-helpers', `any` included
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  GenericDatabaseReader,
  GenericDataModel,
  IndexNames,
  NamedTableInfo,
  SchemaDefinition,
  TableNamesInDataModel,
} from "@bunvex/server";
import {
  getIndexFields,
  type IndexBounds,
  type IndexKey,
  type StreamDatabaseReader,
  stream,
  streamIndexRange,
} from "./stream.ts";

/** An index key: the values of a document's index fields, in order (a missing field is `undefined`). */
export type { IndexKey };

/** A page `getPage` reads when the request does not say how many rows. */
const DEFAULT_TARGET_MAX_ROWS = 100;

/** Which page of a table to read: its index, order, ends and size. */
export type PageRequest<DataModel extends GenericDataModel, T extends TableNamesInDataModel<DataModel>> = {
  /** The table the page is read from. */
  table: T;
  /** The key the page starts at. Missing or `[]`: the start of the index (in `order`). */
  startIndexKey?: IndexKey;
  /** Whether a document at `startIndexKey` is in the page. Default `false`; no effect on an empty key. */
  startInclusive?: boolean;
  /**
   * The key the page ends at. When given, the page runs to it whatever `targetMaxRows` says (only
   * `absoluteMaxRows` still caps it), so a page stays next to the one after it as it grows. `[]`: the end of the
   * index.
   */
  endIndexKey?: IndexKey;
  /** Whether a document at `endIndexKey` is in the page. Default `true`; no effect on an empty key. */
  endInclusive?: boolean;
  /** How many rows a page without `endIndexKey` holds at most. Default 100. */
  targetMaxRows?: number;
  /**
   * How many rows any page holds at most, `endIndexKey` or not. A page cut by it no longer reaches the next one, so
   * gaps can open between pages. Default: no cap but the transaction's read limits.
   */
  absoluteMaxRows?: number;
  /** The order the index is walked in. Default `"asc"`. */
  order?: "asc" | "desc";
  /** The index walked. Default `by_creation_time`. */
  index?: IndexNames<NamedTableInfo<DataModel, T>>;
  /**
   * The app's schema (`import schema from "./schema"`), which gives a named index its fields. Not needed for
   * `by_creation_time` or `by_id`.
   */
  schema?: SchemaDefinition<any, boolean>;
  /** The index's fields. Accepted and not read, as upstream: name the `schema` instead. */
  indexFields?: string[];
};

/** A page of a table, with each document's index key. */
export type PageResponse<DataModel extends GenericDataModel, T extends TableNamesInDataModel<DataModel>> = {
  /** The documents, in index order (reversed for `"desc"`). */
  page: DocumentByName<DataModel, T>[];
  /** Whether the requested range has documents past this page. */
  hasMore: boolean;
  /** `indexKeys[i]` is `page[i]`'s index key, for `startIndexKey` or `endIndexKey` of a page next to this one. */
  indexKeys: IndexKey[];
};

/**
 * Reads one page of a table, in a query or a mutation.
 * @param ctx A context with `db`.
 * @param request Which page.
 * @returns The page, whether there is more, and the index keys of its documents.
 */
export async function getPage<DataModel extends GenericDataModel, T extends TableNamesInDataModel<DataModel>>(
  ctx: { db: GenericDatabaseReader<DataModel> },
  request: PageRequest<DataModel, T>,
): Promise<PageResponse<DataModel, T>> {
  const absoluteMaxRows = request.absoluteMaxRows ?? Number.POSITIVE_INFINITY;
  // An end key, even `[]`, lets the page run to it: only the absolute cap holds.
  const limit = request.endIndexKey
    ? absoluteMaxRows
    : Math.min(absoluteMaxRows, request.targetMaxRows ?? DEFAULT_TARGET_MAX_ROWS);
  const page: DocumentByName<DataModel, T>[] = [];
  const indexKeys: IndexKey[] = [];
  for await (const [doc, indexKey] of streamQuery(ctx, request)) {
    // One row past the limit is read, and only says that there is more.
    if (page.length >= limit) return { page, hasMore: true, indexKeys };
    page.push(doc);
    indexKeys.push(indexKey);
  }
  return { page, hasMore: false, indexKeys };
}

/**
 * The documents of a page request's range with their index keys, one at a time, with no row limit.
 * @param ctx A context with `db`.
 * @param request The range: as `getPage`'s request, without its limits.
 */
export async function* streamQuery<DataModel extends GenericDataModel, T extends TableNamesInDataModel<DataModel>>(
  ctx: { db: GenericDatabaseReader<DataModel> },
  request: Omit<PageRequest<DataModel, T>, "targetMaxRows" | "absoluteMaxRows">,
): AsyncGenerator<[DocumentByName<DataModel, T>, IndexKey]> {
  const index = request.index ?? "by_creation_time";
  const fieldCount = getIndexFields(request.table, request.index as any, request.schema).length;
  const start = request.startIndexKey ?? [];
  const end = request.endIndexKey ?? [];
  if (start.length > fieldCount || end.length > fieldCount) {
    throw new Error("Index key length exceeds index fields length");
  }
  // `[]` is unbounded here; to the stream, an exclusive `[]` would be an empty range, so it is made inclusive.
  const startInclusive = start.length === 0 || (request.startInclusive ?? false);
  const endInclusive = end.length === 0 || (request.endInclusive ?? true);
  const order = request.order === "desc" ? "desc" : "asc";
  // The page starts at the lower bound ascending and at the upper one descending.
  const bounds: IndexBounds =
    order === "asc"
      ? { lowerBound: start, lowerBoundInclusive: startInclusive, upperBound: end, upperBoundInclusive: endInclusive }
      : { lowerBound: end, lowerBoundInclusive: endInclusive, upperBound: start, upperBoundInclusive: startInclusive };
  const range = streamIndexRange(ctx.db as any, request.schema as any, request.table, index as any, bounds, order);
  for await (const [doc, indexKey] of range.iterWithKeys()) {
    yield [doc as DocumentByName<DataModel, T>, indexKey];
  }
}

// Stitching pages: https://stack.convex.dev/pagination#stitching-the-pages-together.
/**
 * `ctx.db` for one-off pages that need not be reactive: `paginator(db, schema).query(t).withIndex(…).paginate(opts)`
 * reads as `db.query(t).withIndex(…).paginate(opts)` does, except that:
 *
 * - the end of a page is not recorded for a rerun: pass the current page's `continueCursor` as `endCursor` to keep it;
 * - it can run several times in a function, and in a component;
 * - its cursors are index keys, not encrypted;
 * - `.filter()` is not supported: filter the `page`, or use `filterWith`;
 * - system tables (`_storage`, `_scheduled_functions`) are not supported;
 * - the schema is required.
 *
 * `opts.cursor` is the previous page's `continueCursor`; `opts.endCursor`, if given, the current page's, and the page
 * ends there instead of at `opts.numItems`.
 */
export function paginator<Schema extends SchemaDefinition<any, boolean>>(
  db: GenericDatabaseReader<DataModelFromSchemaDefinition<Schema>>,
  schema: Schema,
): StreamDatabaseReader<Schema> {
  return stream(db, schema);
}
