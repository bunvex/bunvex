// convex-helpers' `server/stream.ts` (get-convex/convex-helpers @ e48f9df, 0.1.128) for bunvex (STUDY-181 PR 3): a
// query engine over `ctx.db`. A stream is an async iterable of items, each with its index key, ordered by an index;
// streams compose (merge, filter, map, flatMap, distinct) and paginate with the same cursors as convex-helpers'.
//
// - A cursor is the JSON of an index key in the value JSON encoding (`toJsonValue`: `$integer`, `$float`, `$bytes`),
//   with `undefined` written as the string "undefined" and a string ending in "undefined" given a leading "_"; the
//   end of a range is "[]" (STUDY-181 H-2: byte for byte, since components store these cursors).
// - Index fields are read from `schema.tables[t].indexes`, the `{ indexDescriptor, fields }` array (H-5).
// - A range between two index keys is split into ranges `withIndex` can express (equalities, then at most one bound
//   on each side of one field), queried one after the other.
//
// Written for bunvex from the study and convex-helpers' tests; the API, the behaviour and the messages are
// convex-helpers'. Rule 5: the value JSON helpers are `toJsonValue` / `fromJsonValue`.
// biome-ignore-all lint/suspicious/noExplicitAny: the public signatures are convex-helpers', `any` included
import type {
  DataModelFromSchemaDefinition,
  DocumentByInfo,
  DocumentByName,
  GenericDatabaseReader,
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  NamedIndex,
  NamedTableInfo,
  OrderedQuery,
  PaginationOptions,
  PaginationResult,
  Query,
  QueryInitializer,
  SchemaDefinition,
  SystemDataModel,
  TableNamesInDataModel,
} from "@bunvex/server";
import { compareValues, fromJsonValue, getDocumentSize, toJsonValue, type Value } from "@bunvex/values";

/** An index key: the values of a document's index fields, in order (a missing field is `undefined`). */
export type IndexKey = (Value | undefined)[];

/** The most documents a transaction may scan (Convex's limit). */
const MAX_DOCUMENTS_SCANNED = 32_000;
/** A page that scanned this many keys recommends a split, well before the limit stops a later re-read of it. */
const SPLIT_RECOMMENDED_KEYS = MAX_DOCUMENTS_SCANNED / 2;

type Order = "asc" | "desc";
type RangeOp = "gt" | "gte" | "lt" | "lte";
/** One call of an index range: `[op, field, value]`. */
type RangeCall = [RangeOp | "eq", string, Value];

type DM<Schema extends SchemaDefinition<any, boolean>> = DataModelFromSchemaDefinition<Schema>;

//
// Index keys: comparison and cursors.
//

/**
 * A position among index keys: `exact` is the key itself (a whole key); `before` is just below every key that
 * starts with it, and `after` just above every one (a prefix, as range bounds are).
 */
type KeyPoint = { key: IndexKey; at: "exact" | "before" | "after" };

const exact = (key: IndexKey): KeyPoint => ({ key, at: "exact" });
const RANK = { before: 0, exact: 1, after: 2 } as const;

/** Where `a` is relative to `b`: negative below, 0 the same position, positive above. */
function compareKeys(a: KeyPoint, b: KeyPoint): number {
  const shared = Math.min(a.key.length, b.key.length);
  for (let i = 0; i < shared; i++) {
    const c = compareValues(a.key[i], b.key[i]);
    if (c !== 0) return c;
  }
  if (a.key.length < b.key.length) return prefixAgainstLonger(a, b);
  if (b.key.length < a.key.length) return -prefixAgainstLonger(b, a);
  return Math.sign(RANK[a.at] - RANK[b.at]);
}

/** `short`'s key is a strict prefix of `long`'s: `before` it sorts below the longer key, `after` it above. */
function prefixAgainstLonger(short: KeyPoint, long: KeyPoint): number {
  if (short.at === "exact")
    throw new Error(
      long.at === "exact"
        ? `Exact keys are not the same length:  ${JSON.stringify(short.key)}, ${JSON.stringify(long.key)}`
        : `Exact key is shorter than prefix: ${JSON.stringify(short.key)}, ${JSON.stringify(long.key)}`,
    );
  return short.at === "before" ? -1 : 1;
}

/** Where a range's lower bound sits: below the key's prefix when inclusive, above it when not. */
const lowerPoint = (key: IndexKey, inclusive: boolean): KeyPoint => ({ key, at: inclusive ? "before" : "after" });
/** Where a range's upper bound sits: above the key's prefix when inclusive, below it when not. */
const upperPoint = (key: IndexKey, inclusive: boolean): KeyPoint => ({ key, at: inclusive ? "after" : "before" });

/** A string the cursor would read back as `undefined`, or as another string, gets one more leading "_". */
const ESCAPED_SUFFIX = "undefined";

function serializeCursor(key: IndexKey): string {
  const values = key.map((value): Value => {
    if (value === undefined) return ESCAPED_SUFFIX;
    if (typeof value === "string" && value.endsWith(ESCAPED_SUFFIX)) return `_${value}`;
    return value;
  });
  return JSON.stringify(toJsonValue(values));
}

function deserializeCursor(cursor: string): IndexKey {
  const values = fromJsonValue(JSON.parse(cursor)) as Value[];
  return values.map((value) => {
    if (typeof value !== "string" || !value.endsWith(ESCAPED_SUFFIX)) return value;
    return value === ESCAPED_SUFFIX ? undefined : value.slice(1);
  });
}

//
// Index ranges.
//

/** A bound made exclusive, on its side: the next range starts (or ends) past it. */
const exclusive = (op: RangeOp): RangeOp => (op === "gt" || op === "gte" ? "gt" : "lt");

/**
 * The interval between two index keys as ranges `withIndex` can express, in the stream's order. A range is
 * equalities then a bound on one field, or two bounds on the same field; an interval between keys of several
 * fields needs several. From `>[1, 2, 3]` to `<=[1, 3, 2]` over `[a, b, c]`:
 * `a == 1, b == 2, c > 3`, then `a == 1, 2 < b < 3`, then `a == 1, b == 3, c <= 2`.
 */
function splitRange(
  indexFields: string[],
  order: Order,
  lowerKey: IndexKey,
  upperKey: IndexKey,
  lowerOp: RangeOp,
  upperOp: RangeOp,
): RangeCall[][] {
  // The values both keys share become equalities of every range.
  const shared: RangeCall[] = [];
  let fields = indexFields;
  let lower = lowerKey;
  let upper = upperKey;
  while (lower.length > 0 && upper.length > 0 && compareValues(lower[0], upper[0]) === 0) {
    shared.push(["eq", fields[0]!, lower[0] as Value]);
    fields = fields.slice(1);
    lower = lower.slice(1);
    upper = upper.slice(1);
  }
  // A key's range: equalities on all its values but the last, and `op` on the last.
  const rangeOf = (op: RangeOp, key: IndexKey): RangeCall[] => [
    ...shared,
    ...key.map((value, i): RangeCall => [i === key.length - 1 ? op : "eq", fields[i]!, value as Value]),
  ];
  // From the lower key up to its first value, one field at a time; then from the upper key's first value down.
  const fromLower: RangeCall[][] = [];
  for (; lower.length > 1; lower = lower.slice(0, -1), lowerOp = exclusive(lowerOp))
    fromLower.push(rangeOf(lowerOp, lower));
  const toUpper: RangeCall[][] = [];
  for (; upper.length > 1; upper = upper.slice(0, -1), upperOp = exclusive(upperOp))
    toUpper.unshift(rangeOf(upperOp, upper));
  let between: RangeCall[];
  if (upper.length === 0) between = rangeOf(lowerOp, lower);
  else if (lower.length === 0) between = rangeOf(upperOp, upper);
  else between = [...shared, [lowerOp, fields[0]!, lower[0] as Value], [upperOp, fields[0]!, upper[0] as Value]];
  const ranges = [...fromLower, between, ...toUpper];
  return order === "desc" ? ranges.reverse() : ranges;
}

/** A range as `withIndex`'s callback. */
const rangeQuery = (calls: RangeCall[]) => (q: any) => {
  let built = q;
  for (const [op, field, value] of calls) built = built[op](field, value);
  return built;
};

/**
 * A table's index as its ordered fields, from the schema: `by_creation_time` is `["_creationTime", "_id"]`,
 * `by_id` is `["_id"]`, and an index declared `.index("abc", ["a", "b"])` is `["a", "b", "_creationTime", "_id"]`.
 */
export function getIndexFields<
  Schema extends SchemaDefinition<any, boolean>,
  T extends TableNamesInDataModel<DM<Schema>>,
>(table: T, index?: IndexNames<NamedTableInfo<DM<Schema>, T>>, schema?: Schema): string[] {
  const name = String(index ?? "by_creation_time");
  if (name === "by_creation_time") return ["_creationTime", "_id"];
  if (name === "by_id") return ["_id"];
  if (!schema) throw new Error("schema is required to infer index fields");
  const declared = (schema.tables[table] as any).indexes.find((i: any) => i.indexDescriptor === name);
  if (!declared) throw new Error(`Index ${name} not found in table ${table}`);
  return [...declared.fields, "_creationTime", "_id"];
}

/** A document's index key: the value at each field's path (`a.b` reads `doc.a.b`). */
function indexKeyOf(doc: any, indexFields: string[]): IndexKey {
  return indexFields.map((field) => field.split(".").reduce((value, part) => value[part], doc));
}

//
// Streams.
//

type GenericStreamItem = NonNullable<unknown>;
/** An item of a stream: the item (`null` for one read and left out), its index key, and the bytes read for it. */
type StreamItem<T> = [T | null, IndexKey, number];
type StreamIterable<T> = AsyncIterable<StreamItem<T>, undefined>;
type StreamIterator<T> = AsyncIterator<StreamItem<T>, undefined>;
type StreamResult<T> = IteratorResult<StreamItem<T>, undefined>;

const DONE = { done: true, value: undefined } as const;

/** An iterable whose every iteration runs `start` for its iterator. */
const iterable = <T>(start: () => StreamIterator<T>): StreamIterable<T> => ({ [Symbol.asyncIterator]: start });

/**
 * A stream of documents of `db`, typed by `schema`: use it as `ctx.db` (`query`, `withIndex`, `order`), then compose
 * and paginate. In a reactive query, paginate with `endCursor` (as `paginator` explains) so pages stay adjacent.
 */
export function stream<Schema extends SchemaDefinition<any, boolean>>(
  db: GenericDatabaseReader<DM<Schema>>,
  schema: Schema,
): StreamDatabaseReader<Schema> {
  return new StreamDatabaseReader(db, schema);
}

/**
 * An async iterable of items ordered by index fields, which paginates as a query does. Items left out (by
 * `filterWith`, or a `map` to `null`) still count as read.
 */
export abstract class QueryStream<T extends GenericStreamItem> implements GenericOrderedQuery<T> {
  /**
   * Each item with its index key and the bytes read for it (`getDocumentSize` of the documents read, 0 when
   * `trackBandwidth` is false). An item left out is `null`.
   */
  abstract iterWithKeys(trackBandwidth?: boolean): StreamIterable<T>;
  /** The same stream within `indexBounds` (intersected with its own). */
  abstract narrow(indexBounds: IndexBounds): QueryStream<T>;
  abstract getOrder(): "asc" | "desc";
  abstract getIndexFields(): string[];
  /** The values an equality fixes, a prefix of every index key. */
  abstract getEqualityIndexFilter(): Value[];

  /**
   * The items `predicate` accepts. It may run any code, other queries included. It is applied before pagination:
   * the items it rejects are read and count towards `maximumRowsRead`.
   */
  filterWith(predicate: (doc: T) => Promise<boolean>): QueryStream<T> {
    const order = this.getOrder();
    return new FlatMapStream(
      this,
      async (doc: T) => new SingletonStream((await predicate(doc)) ? doc : null, order, [], [], []),
      [],
    );
  }

  /** Each item through `mapper`; an item mapped to `null` is left out (and counts as read). */
  map<U extends GenericStreamItem>(mapper: (doc: T) => Promise<U | null>): QueryStream<U> {
    const order = this.getOrder();
    return new FlatMapStream(this, async (doc: T) => new SingletonStream(await mapper(doc), order, [], [], []), []);
  }

  /**
   * For each item, the items of the stream `mapper` returns for it, in order: the items of the first, then of the
   * second. `mappedIndexFields` are the index fields of those streams (`_creationTime` and `_id` added when
   * missing). The index key of an item is the outer item's key followed by the inner one's.
   */
  flatMap<U extends GenericStreamItem>(
    mapper: (doc: T) => Promise<QueryStream<U>>,
    mappedIndexFields: string[],
  ): QueryStream<U> {
    normalizeIndexFields(mappedIndexFields);
    return new FlatMapStream(this, mapper, mappedIndexFields);
  }

  /**
   * The first item for each distinct value of `distinctIndexFields`, a prefix of the fields the stream is ordered
   * by (after its equalities). It skips past the rest of each group with a new range: a loose index scan.
   */
  distinct(distinctIndexFields: string[]): QueryStream<T> {
    return new DistinctStream(this, distinctIndexFields);
  }

  /** Not supported on a stream: use `filterWith`. */
  filter(_predicate: any): never {
    throw new Error(
      "Cannot call .filter() directly on a query stream. Use .filterWith() for filtering or .collect() if you want to convert the stream to an array first.",
    );
  }

  /**
   * A page of the stream. Beyond a query's options: `endCursor` reads up to that cursor whatever `numItems` says;
   * `maximumRowsRead` and `maximumBytesRead` stop the page early (`pageStatus: "SplitRequired"`). A page that
   * read many keys, or more than `numItems + 1` items, recommends a split (`"SplitRecommended"`); both give a
   * `splitCursor` in the middle of what was read.
   */
  async paginate(
    opts: PaginationOptions & {
      endCursor?: string | null;
      maximumRowsRead?: number;
      maximumBytesRead?: number;
    },
  ): Promise<PaginationResult<T>> {
    if (opts.numItems === 0) {
      if (opts.cursor === null)
        throw new Error(
          ".paginate called with cursor of null and 0 for numItems. " +
            "This is not supported, as null is not a valid continueCursor. " +
            "Advice: avoid calling paginate entirely in these cases.",
        );
      return { page: [], isDone: false, continueCursor: opts.cursor };
    }
    const order = this.getOrder();
    const start =
      opts.cursor === null ? { key: [], inclusive: true } : { key: deserializeCursor(opts.cursor), inclusive: false };
    let end: { key: IndexKey; inclusive: boolean } = { key: [], inclusive: true };
    // With an end cursor the page runs up to it, however many items that is.
    let wanted: number | undefined = opts.numItems;
    if (opts.endCursor) {
      end = { key: deserializeCursor(opts.endCursor), inclusive: true };
      wanted = undefined;
    }
    const [lower, upper] = order === "asc" ? [start, end] : [end, start];
    const narrowed = this.narrow({
      lowerBound: lower.key,
      lowerBoundInclusive: lower.inclusive,
      upperBound: upper.key,
      upperBoundInclusive: upper.inclusive,
    });
    const page: T[] = [];
    const keysRead: IndexKey[] = [];
    let hasMore = Boolean(opts.endCursor && opts.endCursor !== "[]");
    let continueCursor = opts.endCursor ?? "[]";
    const { maximumRowsRead, maximumBytesRead } = opts;
    let bytesRead = 0;
    let limitHit = false;
    for await (const [doc, key, bytes] of narrowed.iterWithKeys(maximumBytesRead !== undefined)) {
      if (doc !== null) page.push(doc);
      keysRead.push(key);
      bytesRead += bytes;
      limitHit =
        (maximumBytesRead !== undefined && bytesRead >= maximumBytesRead) ||
        (maximumRowsRead !== undefined && keysRead.length >= maximumRowsRead);
      if (limitHit || (wanted !== undefined && page.length >= wanted)) {
        hasMore = true;
        continueCursor = serializeCursor(key);
        break;
      }
    }
    let pageStatus: "SplitRecommended" | "SplitRequired" | undefined;
    let split: IndexKey | undefined;
    const middle = () => keysRead[Math.floor((keysRead.length - 1) / 2)];
    if (limitHit) {
      pageStatus = "SplitRequired";
      split = middle();
    } else if (keysRead.length >= SPLIT_RECOMMENDED_KEYS || page.length > opts.numItems + 1) {
      pageStatus = "SplitRecommended";
      split = middle();
    }
    return {
      page,
      isDone: !hasMore,
      continueCursor,
      pageStatus,
      splitCursor: split ? serializeCursor(split) : undefined,
    };
  }

  async collect(): Promise<T[]> {
    return await this.take(Infinity);
  }

  /** The first `n` items (left-out items skipped). */
  async take(n: number): Promise<T[]> {
    const items: T[] = [];
    for await (const [doc] of this.iterWithKeys()) {
      if (doc === null) continue;
      items.push(doc);
      if (items.length === n) break;
    }
    return items;
  }

  async unique(): Promise<T | null> {
    const items = await this.take(2);
    if (items.length === 2) throw new Error("Query is not unique");
    return items[0] ?? null;
  }

  async first(): Promise<T | null> {
    const items = await this.take(1);
    return items[0] ?? null;
  }

  /** The stream's items, as convex-helpers iterates them: a left-out item comes as `null`. */
  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    const items = this.iterWithKeys()[Symbol.asyncIterator]();
    return {
      async next() {
        const result = await items.next();
        return result.done ? DONE : { done: false, value: result.value[0]! };
      },
    };
  }
}

/** What a stream offers of a query: `OrderedQuery<TableInfo>` is `GenericOrderedQuery<DocumentByInfo<TableInfo>>`. */
export interface GenericOrderedQuery<T> extends AsyncIterable<T> {
  /**
   * A page of `paginationOpts.numItems` items from `paginationOpts.cursor`, and a cursor to continue from. In a
   * reactive query, give later runs the page's end cursor so pages stay adjacent and do not overlap.
   */
  paginate(paginationOpts: PaginationOptions): Promise<PaginationResult<T>>;
  /** Every result. For many results, iterating the query is often better. */
  collect(): Promise<Array<T>>;
  /** The first `n` results (fewer when there are fewer). */
  take(n: number): Promise<Array<T>>;
  /** The first result, or `null`. */
  first(): Promise<T | null>;
  /** The only result, or `null`; throws when there is more than one. */
  unique(): Promise<T | null>;
  /** Not supported: use `filterWith`. */
  filter(predicate: any): this;
}

/** `ctx.db` as streams: `query(table)` starts a stream as `ctx.db.query(table)` starts a query. */
export class StreamDatabaseReader<Schema extends SchemaDefinition<any, boolean>>
  implements GenericDatabaseReader<DM<Schema>>
{
  // The system tables are the reader's own, not streams.
  public system: GenericDatabaseReader<SystemDataModel>["system"];

  constructor(
    public db: GenericDatabaseReader<DM<Schema>>,
    public schema: Schema,
  ) {
    this.system = db.system;
  }

  query<TableName extends TableNamesInDataModel<DM<Schema>>>(
    tableName: TableName,
  ): StreamQueryInitializer<Schema, TableName> {
    return new StreamQueryInitializer(this, tableName);
  }

  get(_id: any): any {
    throw new Error("get() not supported for `paginator`");
  }

  normalizeId(_tableName: any, _id: any): any {
    throw new Error("normalizeId() not supported for `paginator`.");
  }
}

/** A key interval: from `lowerBound` to `upperBound`, each a key prefix, each inclusive or not. `[]` is unbounded. */
export type IndexBounds = {
  lowerBound: IndexKey;
  lowerBoundInclusive: boolean;
  upperBound: IndexKey;
  upperBoundInclusive: boolean;
};

/** What a stream of one index range is: its database, table, index and fields, order and bounds. */
export type QueryReflection<
  Schema extends SchemaDefinition<any, boolean>,
  T extends TableNamesInDataModel<DM<Schema>>,
  IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>,
> = {
  db: GenericDatabaseReader<DataModelFromSchemaDefinition<Schema>>;
  schema: Schema;
  table: T;
  index: IndexName;
  indexFields: string[];
  order: "asc" | "desc";
  bounds: IndexBounds;
  indexRange?: (
    q: IndexRangeBuilder<
      DocumentByInfo<NamedTableInfo<DM<Schema>, T>>,
      NamedIndex<NamedTableInfo<DM<Schema>, T>, IndexName>
    >,
  ) => IndexRange;
};

/** A stream of one index range of a table, which can say what it reads (`reflect`). */
export abstract class StreamableQuery<
    Schema extends SchemaDefinition<any, boolean>,
    T extends TableNamesInDataModel<DM<Schema>>,
    IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>,
  >
  extends QueryStream<DocumentByInfo<NamedTableInfo<DM<Schema>, T>>>
  implements OrderedQuery<NamedTableInfo<DM<Schema>, T>>
{
  abstract reflect(): QueryReflection<Schema, T, IndexName>;
}

/** `stream(db, schema).query(table)`: the whole table by creation time until `withIndex` picks a range. */
export class StreamQueryInitializer<
    Schema extends SchemaDefinition<any, boolean>,
    T extends TableNamesInDataModel<DM<Schema>>,
  >
  extends StreamableQuery<Schema, T, "by_creation_time">
  implements QueryInitializer<NamedTableInfo<DM<Schema>, T>>
{
  constructor(
    public parent: StreamDatabaseReader<Schema>,
    public table: T,
  ) {
    super();
  }

  fullTableScan(): StreamQuery<Schema, T, "by_creation_time"> {
    return this.withIndex("by_creation_time");
  }

  withIndex<IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>>(
    indexName: IndexName,
    indexRange?: (
      q: IndexRangeBuilder<
        DocumentByInfo<NamedTableInfo<DM<Schema>, T>>,
        NamedIndex<NamedTableInfo<DM<Schema>, T>, IndexName>
      >,
    ) => IndexRange,
  ): StreamQuery<Schema, T, IndexName> {
    const recorder = new RangeRecorder(getIndexFields<Schema, T>(this.table, indexName, this.parent.schema));
    if (indexRange) indexRange(recorder as any);
    return new StreamQuery(this, indexName, recorder, indexRange);
  }

  withSearchIndex(_indexName: any, _searchFilter: any): any {
    throw new Error("Cannot paginate withSearchIndex");
  }

  inner() {
    return this.fullTableScan();
  }
  order(order: "asc" | "desc"): OrderedStreamQuery<Schema, T, "by_creation_time"> {
    return this.inner().order(order);
  }
  reflect() {
    return this.inner().reflect();
  }
  override iterWithKeys(trackBandwidth = false) {
    return this.inner().iterWithKeys(trackBandwidth);
  }
  override getOrder(): "asc" | "desc" {
    return this.inner().getOrder();
  }
  override getEqualityIndexFilter(): Value[] {
    return this.inner().getEqualityIndexFilter();
  }
  override getIndexFields(): string[] {
    return this.inner().getIndexFields();
  }
  override narrow(indexBounds: IndexBounds) {
    return this.inner().narrow(indexBounds);
  }
}

/** An index range of a table, ascending until `order` says otherwise. */
export class StreamQuery<
    Schema extends SchemaDefinition<any, boolean>,
    T extends TableNamesInDataModel<DM<Schema>>,
    IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>,
  >
  extends StreamableQuery<Schema, T, IndexName>
  implements Query<NamedTableInfo<DM<Schema>, T>>
{
  constructor(
    public parent: StreamQueryInitializer<Schema, T>,
    public index: IndexName,
    public q: RangeRecorder,
    public indexRange:
      | ((
          q: IndexRangeBuilder<
            DocumentByInfo<NamedTableInfo<DM<Schema>, T>>,
            NamedIndex<NamedTableInfo<DM<Schema>, T>, IndexName>
          >,
        ) => IndexRange)
      | undefined,
  ) {
    super();
  }

  order(order: "asc" | "desc") {
    return new OrderedStreamQuery(this, order);
  }
  inner() {
    return this.order("asc");
  }
  reflect() {
    return this.inner().reflect();
  }
  override iterWithKeys(trackBandwidth = false) {
    return this.inner().iterWithKeys(trackBandwidth);
  }
  override getOrder(): "asc" | "desc" {
    return this.inner().getOrder();
  }
  override getEqualityIndexFilter(): Value[] {
    return this.inner().getEqualityIndexFilter();
  }
  override getIndexFields(): string[] {
    return this.inner().getIndexFields();
  }
  override narrow(indexBounds: IndexBounds) {
    return this.inner().narrow(indexBounds);
  }
}

/** An index range of a table in an order: the stream that reads the database. */
export class OrderedStreamQuery<
    Schema extends SchemaDefinition<any, boolean>,
    T extends TableNamesInDataModel<DM<Schema>>,
    IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>,
  >
  extends StreamableQuery<Schema, T, IndexName>
  implements OrderedQuery<NamedTableInfo<DM<Schema>, T>>
{
  constructor(
    public parent: StreamQuery<Schema, T, IndexName>,
    public order: "asc" | "desc",
  ) {
    super();
  }

  reflect() {
    const range = this.parent.q;
    return {
      db: this.parent.parent.parent.db,
      schema: this.parent.parent.parent.schema,
      table: this.parent.parent.table,
      index: this.parent.index,
      indexFields: range.indexFields,
      order: this.order,
      bounds: {
        lowerBound: range.lowerBoundIndexKey ?? [],
        lowerBoundInclusive: range.lowerBoundInclusive,
        upperBound: range.upperBoundIndexKey ?? [],
        upperBoundInclusive: range.upperBoundInclusive,
      },
      indexRange: this.parent.indexRange,
    };
  }

  /** The query as `ctx.db` would build it. */
  inner(): OrderedQuery<NamedTableInfo<DM<Schema>, T>> {
    const { db, table, index, order, indexRange } = this.reflect();
    return (db.query(table) as any).withIndex(index, indexRange).order(order);
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<DocumentByName<DM<Schema>, T>> {
    const { indexFields } = this.reflect();
    const query = this.inner();
    return iterable(() => {
      const docs = query[Symbol.asyncIterator]();
      return {
        async next(): Promise<StreamResult<DocumentByName<DM<Schema>, T>>> {
          const result = await docs.next();
          if (result.done) return DONE;
          const doc = result.value;
          return { done: false, value: [doc, indexKeyOf(doc, indexFields), trackBandwidth ? getDocumentSize(doc) : 0] };
        },
      };
    });
  }

  override getOrder(): "asc" | "desc" {
    return this.order;
  }
  override getEqualityIndexFilter(): Value[] {
    return this.parent.q.equalityIndexFilter;
  }
  override getIndexFields(): string[] {
    return this.parent.q.indexFields;
  }

  override narrow(indexBounds: IndexBounds) {
    const { db, table, index, order, bounds, schema } = this.reflect();
    // The tighter of each pair of bounds: the higher lower bound, the lower upper bound.
    const lower =
      compareKeys(
        lowerPoint(indexBounds.lowerBound, indexBounds.lowerBoundInclusive),
        lowerPoint(bounds.lowerBound, bounds.lowerBoundInclusive),
      ) > 0
        ? { key: indexBounds.lowerBound, inclusive: indexBounds.lowerBoundInclusive }
        : { key: bounds.lowerBound, inclusive: bounds.lowerBoundInclusive };
    const upper =
      compareKeys(
        upperPoint(indexBounds.upperBound, indexBounds.upperBoundInclusive),
        upperPoint(bounds.upperBound, bounds.upperBoundInclusive),
      ) < 0
        ? { key: indexBounds.upperBound, inclusive: indexBounds.upperBoundInclusive }
        : { key: bounds.upperBound, inclusive: bounds.upperBoundInclusive };
    const narrowed = streamIndexRange(
      db,
      schema,
      table,
      index,
      {
        lowerBound: lower.key,
        lowerBoundInclusive: lower.inclusive,
        upperBound: upper.key,
        upperBoundInclusive: upper.inclusive,
      },
      order,
    );
    // An empty intersection keeps this range's equalities, so merges and flatMaps still line up.
    if (narrowed instanceof EmptyStream)
      return new EmptyStream<DocumentByName<DM<Schema>, T>>(
        order,
        this.getIndexFields(),
        this.getEqualityIndexFilter(),
      );
    return narrowed;
  }
}

/** A stream of the documents of `table` within `bounds` of `index`, in `order`. */
export function streamIndexRange<
  Schema extends SchemaDefinition<any, boolean>,
  T extends TableNamesInDataModel<DM<Schema>>,
  IndexName extends IndexNames<NamedTableInfo<DM<Schema>, T>>,
>(
  db: GenericDatabaseReader<DM<Schema>>,
  schema: Schema,
  table: T,
  index: IndexName,
  bounds: IndexBounds,
  order: "asc" | "desc",
): QueryStream<DocumentByName<DM<Schema>, T>> {
  const indexFields = getIndexFields(table, index, schema);
  const lower = lowerPoint(bounds.lowerBound, bounds.lowerBoundInclusive);
  const upper = upperPoint(bounds.upperBound, bounds.upperBoundInclusive);
  if (compareKeys(lower, upper) >= 0) return new EmptyStream(order, indexFields);
  const ranges = splitRange(
    indexFields,
    order,
    bounds.lowerBound,
    bounds.upperBound,
    bounds.lowerBoundInclusive ? "gte" : "gt",
    bounds.upperBoundInclusive ? "lte" : "lt",
  );
  const reader = stream(db, schema);
  return new ConcatStreams(
    ...ranges.map((calls) =>
      reader
        .query(table)
        .withIndex(index, rangeQuery(calls) as any)
        .order(order),
    ),
  );
}

/**
 * Records an index range as `withIndex`'s callback builds it: its bounds as key prefixes and the values its
 * equalities fix. Refuses what an index range cannot express, as `Cannot use <op> on field '<field>'`.
 */
class RangeRecorder {
  #bounded = false;
  public lowerBoundIndexKey: IndexKey | undefined = undefined;
  public lowerBoundInclusive = true;
  public upperBoundIndexKey: IndexKey | undefined = undefined;
  public upperBoundInclusive = true;
  public equalityIndexFilter: Value[] = [];

  constructor(public indexFields: string[]) {}

  eq(field: string, value: Value) {
    if (!this.#canBound("lower", field) || !this.#canBound("upper", field)) this.#refuse("eq", field);
    this.#push("lower", value);
    this.#push("upper", value);
    this.equalityIndexFilter.push(value);
    return this;
  }
  lt(field: string, value: Value) {
    return this.#bound("lt", "upper", false, field, value);
  }
  lte(field: string, value: Value) {
    return this.#bound("lte", "upper", true, field, value);
  }
  gt(field: string, value: Value) {
    return this.#bound("gt", "lower", false, field, value);
  }
  gte(field: string, value: Value) {
    return this.#bound("gte", "lower", true, field, value);
  }

  #bound(op: RangeOp, side: "lower" | "upper", inclusive: boolean, field: string, value: Value) {
    if (!this.#canBound(side, field)) this.#refuse(op, field);
    this.#push(side, value);
    if (!inclusive) {
      if (side === "lower") this.lowerBoundInclusive = false;
      else this.upperBoundInclusive = false;
    }
    this.#bounded = true;
    return this;
  }

  #push(side: "lower" | "upper", value: Value) {
    if (side === "lower") this.lowerBoundIndexKey = [...(this.lowerBoundIndexKey ?? []), value];
    else this.upperBoundIndexKey = [...(this.upperBoundIndexKey ?? []), value];
  }

  /** Whether `side` may take a value for `field`: the next index field, and that side not bounded yet. */
  #canBound(side: "lower" | "upper", field: string): boolean {
    const lower = this.lowerBoundIndexKey?.length ?? 0;
    const upper = this.upperBoundIndexKey?.length ?? 0;
    const [mine, other] = side === "lower" ? [lower, upper] : [upper, lower];
    if (mine > other) return false;
    if (mine === other && this.#bounded) return false;
    return mine < this.indexFields.length && this.indexFields[mine] === field;
  }

  #refuse(op: RangeOp | "eq", field: string): never {
    throw new Error(`Cannot use ${op} on field '${field}'`);
  }
}

/**
 * The streams merged into one, ordered by their index keys: each stream is ordered by `orderByIndexFields` (with
 * `_creationTime` and `_id` added when missing), which must be fields it is ordered by after some of its
 * equalities. Merging `withIndex("by_author", q => q.eq("author", u))` streams by `["author"]` gives one author
 * after the other; by `["_creationTime"]`, every author's messages by creation time.
 */
export function mergedStream<T extends GenericStreamItem>(
  streams: QueryStream<T>[],
  orderByIndexFields: string[],
): QueryStream<T> {
  return new MergedStream(streams, orderByIndexFields);
}

/** Streams merged by their index keys (`mergedStream`). */
export class MergedStream<T extends GenericStreamItem> extends QueryStream<T> {
  #order: "asc" | "desc";
  #streams: QueryStream<T>[];
  #equalityIndexFilter: Value[];
  #indexFields: string[];

  constructor(streams: QueryStream<T>[], orderByIndexFields: string[]) {
    super();
    if (streams.length === 0) throw new Error("Cannot union empty array of streams");
    this.#order = allSame(
      streams.map((s) => s.getOrder()),
      "Cannot merge streams with different orders",
    );
    this.#streams = streams.map((s) => new OrderByStream(s, orderByIndexFields));
    this.#indexFields = allSame(
      this.#streams.map((s) => s.getIndexFields()),
      "Cannot merge streams with different index fields. Consider using .orderBy()",
    );
    this.#equalityIndexFilter = commonPrefix(this.#streams.map((s) => s.getEqualityIndexFilter()));
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<T> {
    const sources = this.#streams.map((s) => s.iterWithKeys(trackBandwidth));
    const direction = this.#order === "asc" ? 1 : -1;
    return iterable(() => {
      const iterators = sources.map((s) => s[Symbol.asyncIterator]());
      // Each stream's next item, read ahead; `undefined` once taken.
      const heads: (StreamResult<T> | undefined)[] = Array(iterators.length);
      return {
        async next() {
          // The bytes of the items read ahead this time are charged to the item this call returns.
          let bytes = 0;
          await Promise.all(
            iterators.map(async (iterator, i) => {
              if (heads[i]) return;
              const head = await iterator.next();
              heads[i] = head;
              if (trackBandwidth && !head.done && head.value) bytes += head.value[2];
            }),
          );
          let lowest: number | undefined;
          for (let i = 0; i < heads.length; i++) {
            const head = heads[i]!;
            if (head.done || !head.value) continue;
            if (
              lowest === undefined ||
              compareKeys(exact(head.value[1]), exact(heads[lowest]!.value![1])) * direction < 0
            )
              lowest = i;
          }
          if (lowest === undefined) return DONE;
          const [doc, key] = heads[lowest]!.value!;
          heads[lowest] = undefined;
          return { done: false, value: [doc, key, bytes] };
        },
      };
    });
  }

  override getOrder(): "asc" | "desc" {
    return this.#order;
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#equalityIndexFilter;
  }
  override getIndexFields(): string[] {
    return this.#indexFields;
  }
  override narrow(indexBounds: IndexBounds) {
    return new MergedStream(
      this.#streams.map((s) => s.narrow(indexBounds)),
      this.#indexFields,
    );
  }
}

/** The first of `values`, which must all be equal (as values), or `message`. */
function allSame<T extends Value>(values: T[], message: string): T {
  const first = values[0]!;
  for (const value of values) if (compareValues(value, first) !== 0) throw new Error(message);
  return first;
}

/** The longest prefix the lists share. */
function commonPrefix(lists: Value[][]): Value[] {
  let prefix = lists[0]!;
  for (const list of lists) {
    const differs = prefix.findIndex((value, i) => i >= list.length || compareValues(value, list[i]) !== 0);
    if (differs !== -1) prefix = prefix.slice(0, differs);
  }
  return prefix;
}

/**
 * Streams read one after the other: they must cover disjoint ranges, given in the stream's order (an item out of
 * order throws). `mergedStream` does the same with its checks; this is for `streamIndexRange`'s pieces.
 */
class ConcatStreams<T extends GenericStreamItem> extends QueryStream<T> {
  #order: "asc" | "desc";
  #streams: QueryStream<T>[];
  #equalityIndexFilter: Value[];
  #indexFields: string[];

  constructor(...streams: QueryStream<T>[]) {
    super();
    this.#streams = streams;
    if (streams.length === 0) throw new Error("Cannot concat empty array of streams");
    this.#order = allSame(
      streams.map((s) => s.getOrder()),
      "Cannot concat streams with different orders. Consider using .orderBy()",
    );
    this.#indexFields = allSame(
      streams.map((s) => s.getIndexFields()),
      "Cannot concat streams with different index fields. Consider using .orderBy()",
    );
    this.#equalityIndexFilter = commonPrefix(streams.map((s) => s.getEqualityIndexFilter()));
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<T> {
    const sources = this.#streams.map((s) => s.iterWithKeys(trackBandwidth));
    const direction = this.#order === "asc" ? 1 : -1;
    let previous: IndexKey | undefined;
    return iterable(() => {
      const iterators = sources.map((s) => s[Symbol.asyncIterator]());
      return {
        async next() {
          while (iterators.length > 0) {
            const result = await iterators[0]!.next();
            if (result.done) {
              iterators.shift();
              continue;
            }
            const key = result.value[1];
            if (previous !== undefined && compareKeys(exact(previous), exact(key)) * direction > 0)
              throw new Error(`ConcatStreams in wrong order: ${JSON.stringify(previous)}, ${JSON.stringify(key)}`);
            previous = key;
            return result;
          }
          return DONE;
        },
      };
    });
  }

  override getOrder(): "asc" | "desc" {
    return this.#order;
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#equalityIndexFilter;
  }
  override getIndexFields(): string[] {
    return this.#indexFields;
  }
  override narrow(indexBounds: IndexBounds) {
    return new ConcatStreams(...this.#streams.map((s) => s.narrow(indexBounds)));
  }
}

type Mapper<T, U extends GenericStreamItem> = (doc: T, indexKey: IndexKey) => Promise<QueryStream<U>>;

/**
 * Walks a flatMap: each outer item, then the items of its inner stream. An outer item left out, or whose inner
 * stream is empty, still yields one left-out item (its inner key all nulls), so it counts as read and a page can
 * stop on it; except at `resumeAt`, the outer key a cursor already stopped inside, whose placeholder would repeat
 * that cursor (its bytes go to the next item instead).
 */
class FlatMapIterator<T extends GenericStreamItem, U extends GenericStreamItem> implements StreamIterator<U> {
  #outerOrder: Order;
  #outer: StreamIterator<T>;
  #current: { key: IndexKey; inner: StreamIterator<U>; yielded: number; bytes: number } | null = null;
  #carriedBytes = 0;

  constructor(
    outer: QueryStream<T>,
    private readonly mapper: Mapper<T, U>,
    private readonly innerFields: string[],
    private readonly trackBandwidth: boolean,
    private readonly resumeAt: IndexKey | undefined,
  ) {
    this.#outerOrder = outer.getOrder();
    this.#outer = outer.iterWithKeys(trackBandwidth)[Symbol.asyncIterator]();
  }

  #isResumePoint(key: IndexKey): boolean {
    return this.resumeAt !== undefined && compareKeys(exact(key), exact(this.resumeAt)) === 0;
  }

  /** One left-out item for an outer item, its inner key all nulls. */
  #placeholder(): QueryStream<U> {
    const nulls = this.innerFields.map(() => null);
    return new SingletonStream<U>(null, this.#outerOrder, this.innerFields, nulls, nulls);
  }

  async #enter([item, key, bytes]: StreamItem<T>) {
    let inner: QueryStream<U>;
    if (item === null) {
      inner = this.#isResumePoint(key) ? new EmptyStream(this.#outerOrder, this.innerFields) : this.#placeholder();
    } else {
      inner = await this.mapper(item, key);
      if (!equalIndexFields(inner.getIndexFields(), this.innerFields))
        throw new Error(
          `FlatMapStream: inner stream has different index fields than expected: ${JSON.stringify(inner.getIndexFields())} vs ${JSON.stringify(this.innerFields)}`,
        );
      if (inner.getOrder() !== this.#outerOrder)
        throw new Error(
          `FlatMapStream: inner stream has different order than outer stream: ${inner.getOrder()} vs ${this.#outerOrder}`,
        );
    }
    this.#current = { key, inner: inner.iterWithKeys(this.trackBandwidth)[Symbol.asyncIterator](), yielded: 0, bytes };
  }

  async next(): Promise<StreamResult<U>> {
    for (;;) {
      const current = this.#current;
      if (current === null) {
        const outer = await this.#outer.next();
        if (outer.done) return DONE;
        await this.#enter(outer.value);
        continue;
      }
      const result = await current.inner.next();
      if (result.done) {
        if (current.yielded > 0) {
          this.#current = null;
        } else if (this.#isResumePoint(current.key)) {
          this.#carriedBytes += current.bytes;
          this.#current = null;
        } else {
          current.inner = this.#placeholder().iterWithKeys(this.trackBandwidth)[Symbol.asyncIterator]();
        }
        continue;
      }
      const [item, innerKey, innerBytes] = result.value;
      current.yielded++;
      // The outer item's bytes go with its first inner item.
      const bytes = (current.yielded === 1 ? current.bytes : 0) + innerBytes + this.#carriedBytes;
      this.#carriedBytes = 0;
      return { done: false, value: [item, [...current.key, ...innerKey], bytes] };
    }
  }
}

/** `flatMap` (and `filterWith` and `map`, whose inner streams are single items with no index fields). */
class FlatMapStream<T extends GenericStreamItem, U extends GenericStreamItem> extends QueryStream<U> {
  #outer: QueryStream<T>;
  #mapper: Mapper<T, U>;
  #innerFields: string[];
  #resumeAt: IndexKey | undefined;

  constructor(outer: QueryStream<T>, mapper: Mapper<T, U>, innerFields: string[], resumeAt?: IndexKey) {
    super();
    this.#outer = outer;
    this.#mapper = mapper;
    this.#innerFields = innerFields;
    this.#resumeAt = resumeAt;
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<U> {
    const outer = this.#outer;
    const mapper = this.#mapper;
    const innerFields = this.#innerFields;
    const resumeAt = this.#resumeAt;
    return iterable(() => new FlatMapIterator(outer, mapper, innerFields, trackBandwidth, resumeAt));
  }

  override getOrder(): "asc" | "desc" {
    return this.#outer.getOrder();
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#outer.getEqualityIndexFilter();
  }
  override getIndexFields(): string[] {
    return [...this.#outer.getIndexFields(), ...this.#innerFields];
  }

  override narrow(indexBounds: IndexBounds) {
    const asc = this.getOrder() === "asc";
    const outerLength = this.#outer.getIndexFields().length;
    const outerLower = indexBounds.lowerBound.slice(0, outerLength);
    const innerLower = indexBounds.lowerBound.slice(outerLength);
    const outerUpper = indexBounds.upperBound.slice(0, outerLength);
    const innerUpper = indexBounds.upperBound.slice(outerLength);
    // A start strictly after a position inside an outer item: that item's remaining inner items are still read,
    // but it must not yield its placeholder again. Keep the furthest such start across narrowings.
    const start = asc
      ? { outer: outerLower, inner: innerLower, inclusive: indexBounds.lowerBoundInclusive }
      : { outer: outerUpper, inner: innerUpper, inclusive: indexBounds.upperBoundInclusive };
    let resumeAt = this.#resumeAt;
    if (
      start.inner.length > 0 &&
      !start.inclusive &&
      (resumeAt === undefined || compareKeys(exact(start.outer), exact(resumeAt)) * (asc ? 1 : -1) > 0)
    )
      resumeAt = start.outer;
    const outer = this.#outer.narrow({
      lowerBound: outerLower,
      lowerBoundInclusive: innerLower.length === 0 ? indexBounds.lowerBoundInclusive : true,
      upperBound: outerUpper,
      upperBoundInclusive: innerUpper.length === 0 ? indexBounds.upperBoundInclusive : true,
    });
    const mapper = this.#mapper;
    return new FlatMapStream(
      outer,
      async (item: T, key: IndexKey) => {
        const inner = await mapper(item, key);
        // Only the outer items at an edge of the bounds have their inner stream narrowed; the edge is found by the
        // outer key the walk gives, since `map` may have changed the item's own fields.
        const atLower = innerLower.length > 0 && compareKeys(exact(key), exact(outerLower)) === 0;
        const atUpper = innerUpper.length > 0 && compareKeys(exact(key), exact(outerUpper)) === 0;
        if (!atLower && !atUpper) return inner;
        return inner.narrow({
          lowerBound: atLower ? innerLower : [],
          lowerBoundInclusive: atLower ? indexBounds.lowerBoundInclusive : true,
          upperBound: atUpper ? innerUpper : [],
          upperBoundInclusive: atUpper ? indexBounds.upperBoundInclusive : true,
        });
      },
      this.#innerFields,
      resumeAt,
    );
  }
}

/**
 * A stream of one item at a given index key. A `null` item is one read and left out: it yields nothing but counts
 * towards `maximumRowsRead`, unlike an `EmptyStream`.
 */
export class SingletonStream<T extends GenericStreamItem> extends QueryStream<T> {
  #value: T | null;
  #order: "asc" | "desc";
  #indexFields: string[];
  #indexKey: IndexKey;
  #equalityIndexFilter: Value[];
  #bandwidth: number;

  constructor(
    value: T | null,
    order: "asc" | "desc" = "asc",
    indexFields: string[],
    indexKey: IndexKey,
    equalityIndexFilter: Value[],
    bandwidth = 0,
  ) {
    super();
    this.#value = value;
    this.#order = order;
    this.#indexFields = indexFields;
    this.#indexKey = indexKey;
    this.#equalityIndexFilter = equalityIndexFilter;
    this.#bandwidth = bandwidth;
    if (indexKey.length !== indexFields.length)
      throw new Error(
        `indexKey must have the same length as indexFields: ${JSON.stringify(indexKey)} vs ${JSON.stringify(indexFields)}`,
      );
  }

  override iterWithKeys(_trackBandwidth = false): StreamIterable<T> {
    const item: StreamItem<T> = [this.#value, this.#indexKey, this.#bandwidth];
    return iterable(() => {
      let sent = false;
      return {
        async next() {
          if (sent) return DONE;
          sent = true;
          return { done: false, value: item };
        },
      };
    });
  }

  override getOrder(): "asc" | "desc" {
    return this.#order;
  }
  override getIndexFields(): string[] {
    return this.#indexFields;
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#equalityIndexFilter;
  }

  override narrow(indexBounds: IndexBounds): QueryStream<T> {
    const key = exact(this.#indexKey);
    const aboveLower =
      compareKeys({ key: indexBounds.lowerBound, at: indexBounds.lowerBoundInclusive ? "exact" : "after" }, key) <= 0;
    const belowUpper =
      compareKeys(key, { key: indexBounds.upperBound, at: indexBounds.upperBoundInclusive ? "exact" : "before" }) <= 0;
    if (aboveLower && belowUpper)
      return new SingletonStream(
        this.#value,
        this.#order,
        this.#indexFields,
        this.#indexKey,
        this.#equalityIndexFilter,
      );
    return new EmptyStream(this.#order, this.#indexFields);
  }
}

/** A stream with no items at all; unlike `SingletonStream(null, …)`, nothing counts towards `maximumRowsRead`. */
export class EmptyStream<T extends GenericStreamItem> extends QueryStream<T> {
  #order: "asc" | "desc";
  #indexFields: string[];
  #equalityIndexFilter: Value[];

  constructor(order: "asc" | "desc", indexFields: string[], equalityIndexFilter: Value[] = []) {
    super();
    this.#order = order;
    this.#indexFields = indexFields;
    this.#equalityIndexFilter = equalityIndexFilter;
  }

  override iterWithKeys(_trackBandwidth = false): StreamIterable<T> {
    return iterable(() => ({
      async next() {
        return DONE;
      },
    }));
  }

  override getOrder(): "asc" | "desc" {
    return this.#order;
  }
  override getIndexFields(): string[] {
    return this.#indexFields;
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#equalityIndexFilter;
  }
  override narrow(_indexBounds: IndexBounds) {
    return this;
  }
}

/**
 * `_creationTime` and `_id` appended, in place, when missing: every index ends with them (`["_id"]` alone, `by_id`,
 * needs no `_creationTime`).
 */
function normalizeIndexFields(indexFields: string[]) {
  const idOnly = indexFields.length === 1 && indexFields[0] === "_id";
  if (!indexFields.includes("_creationTime") && !idOnly) indexFields.push("_creationTime");
  if (!indexFields.includes("_id")) indexFields.push("_id");
}

/**
 * The field lists a stream is ordered by: its index fields, and each suffix of them that drops only fields its
 * equalities fix.
 */
function* orderingIndexFields<T extends GenericStreamItem>(s: QueryStream<T>): Generator<string[]> {
  const fields = s.getIndexFields();
  const fixed = s.getEqualityIndexFilter().length;
  for (let dropped = 0; dropped <= fixed; dropped++) yield fields.slice(dropped);
}

/** A stream seen as ordered by fewer index fields: the leading ones its equalities fix are dropped from its keys. */
class OrderByStream<T extends GenericStreamItem> extends QueryStream<T> {
  #fixedPrefix: Value[];
  #stream: QueryStream<T>;
  #indexFields: string[];

  constructor(s: QueryStream<T>, indexFields: string[]) {
    super();
    this.#stream = s;
    this.#indexFields = indexFields;
    normalizeIndexFields(this.#indexFields);
    const streamFields = s.getIndexFields();
    if (![...orderingIndexFields(s)].some((fields) => equalIndexFields(fields, indexFields)))
      throw new Error(
        `indexFields must be some sequence of fields the stream is ordered by: ${JSON.stringify(indexFields)}, ${JSON.stringify(streamFields)} (${s.getEqualityIndexFilter().length} equality fields)`,
      );
    this.#fixedPrefix = s.getEqualityIndexFilter().slice(0, streamFields.length - indexFields.length);
  }

  override getOrder(): "asc" | "desc" {
    return this.#stream.getOrder();
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#stream.getEqualityIndexFilter().slice(this.#fixedPrefix.length);
  }
  override getIndexFields(): string[] {
    return this.#indexFields;
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<T> {
    const source = this.#stream.iterWithKeys(trackBandwidth);
    const dropped = this.#fixedPrefix.length;
    return iterable(() => {
      const items = source[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await items.next();
          if (result.done) return result;
          const [doc, key, bytes] = result.value;
          return { done: false, value: [doc, key.slice(dropped), bytes] };
        },
      };
    });
  }

  override narrow(indexBounds: IndexBounds) {
    return new OrderByStream(
      this.#stream.narrow({
        lowerBound: [...this.#fixedPrefix, ...indexBounds.lowerBound],
        lowerBoundInclusive: indexBounds.lowerBoundInclusive,
        upperBound: [...this.#fixedPrefix, ...indexBounds.upperBound],
        upperBoundInclusive: indexBounds.upperBoundInclusive,
      }),
      this.#indexFields,
    );
  }
}

/** `distinct`: after each item, the stream narrowed past every key that shares its distinct prefix. */
class DistinctStream<T extends GenericStreamItem> extends QueryStream<T> {
  #prefixLength: number;
  #stream: QueryStream<T>;
  #distinctIndexFields: string[];

  constructor(s: QueryStream<T>, distinctIndexFields: string[]) {
    super();
    this.#stream = s;
    this.#distinctIndexFields = distinctIndexFields;
    let prefixLength: number | undefined;
    for (const fields of orderingIndexFields(s)) {
      if (equalIndexFields(fields.slice(0, distinctIndexFields.length), distinctIndexFields)) {
        // The fields the equalities fix, then the distinct ones.
        prefixLength = s.getIndexFields().length - fields.length + distinctIndexFields.length;
        break;
      }
    }
    if (prefixLength === undefined)
      throw new Error(
        `distinctIndexFields must be a prefix of the stream's ordering index fields: ${JSON.stringify(distinctIndexFields)}, ${JSON.stringify(s.getIndexFields())} (${s.getEqualityIndexFilter().length} equality fields)`,
      );
    this.#prefixLength = prefixLength;
  }

  override iterWithKeys(trackBandwidth = false): StreamIterable<T> {
    const original = this.#stream;
    const prefixLength = this.#prefixLength;
    return iterable(() => {
      let rest = original;
      let items = rest.iterWithKeys(trackBandwidth)[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await items.next();
          if (result.done) return DONE;
          const [doc, key, bytes] = result.value;
          // A left-out item does not settle its group: the walk goes on through it (so `filterWith` is cheaper
          // after `distinct` than before).
          if (doc === null) return { done: false, value: [null, key, bytes] };
          const group = key.slice(0, prefixLength);
          rest = rest.narrow(
            original.getOrder() === "asc"
              ? { lowerBound: group, lowerBoundInclusive: false, upperBound: [], upperBoundInclusive: true }
              : { lowerBound: [], lowerBoundInclusive: true, upperBound: group, upperBoundInclusive: false },
          );
          items = rest.iterWithKeys(trackBandwidth)[Symbol.asyncIterator]();
          return result;
        },
      };
    });
  }

  override narrow(indexBounds: IndexBounds): QueryStream<T> {
    return new DistinctStream(
      this.#stream.narrow({
        ...indexBounds,
        lowerBound: indexBounds.lowerBound.slice(0, this.#prefixLength),
        upperBound: indexBounds.upperBound.slice(0, this.#prefixLength),
      }),
      this.#distinctIndexFields,
    );
  }

  override getOrder(): "asc" | "desc" {
    return this.#stream.getOrder();
  }
  override getIndexFields(): string[] {
    return this.#stream.getIndexFields();
  }
  override getEqualityIndexFilter(): Value[] {
    return this.#stream.getEqualityIndexFilter();
  }
}

function equalIndexFields(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((field, i) => field === b[i]);
}
