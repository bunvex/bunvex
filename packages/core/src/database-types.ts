// The database as types (STUDY-36), as Convex's (npm-packages/convex/src/server/database.ts, query.ts,
// index_range_builder.ts, filter_builder.ts): what `ctx.db` is to an app whose data model is known — tables,
// ids, documents, index names and fields, field paths. Types only: at run time `ctx.db` is the engine's `Tx`,
// which accepts every one of these calls.
import type { CommitTsPlaceholder, GenericId, Value } from "@bunvex/values";
import type {
  DocumentByInfo,
  DocumentByName,
  FieldPaths,
  GenericDataModel,
  GenericTableInfo,
  IndexNames,
  NamedIndex,
  NamedTableInfo,
  SystemTableNames,
  TableNamesInDataModel,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "./data-model.ts";
import type { Expression } from "./filter.ts";
import type { Expand } from "./schema.ts";
import type { PaginationOptions } from "./tx.ts";

/** The type of the value at a dotted field path of a document (`undefined` when a part may be missing). */
export type FieldTypeFromFieldPath<
  Document,
  FieldPath extends string,
> = FieldPath extends `${infer First}.${infer Rest}`
  ? First extends keyof Document
    ? NonNullable<Document[First]> extends Record<string, unknown>
      ?
          | FieldTypeFromFieldPath<NonNullable<Document[First]>, Rest>
          | (undefined extends Document[First] ? undefined : never)
      : undefined
    : undefined
  : FieldPath extends keyof Document
    ? Document[FieldPath]
    : undefined;

/** A filter's value or expression of a type. */
export type ExpressionOrValueOf<T> = Expression<T> | T;
type NumericValue = bigint | number;

/** Convex's `FilterBuilder`: field references and operators, typed by the table. */
export interface FilterBuilder<TableInfo extends GenericTableInfo> {
  field<FieldPath extends FieldPaths<TableInfo>>(
    fieldPath: FieldPath,
  ): Expression<FieldTypeFromFieldPath<DocumentByInfo<TableInfo>, FieldPath>>;
  eq<T extends Value | undefined>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  neq<T extends Value | undefined>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  lt<T extends Value>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  lte<T extends Value>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  gt<T extends Value>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  gte<T extends Value>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<boolean>;
  add<T extends NumericValue>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<T>;
  sub<T extends NumericValue>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<T>;
  mul<T extends NumericValue>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<T>;
  div<T extends NumericValue>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<T>;
  mod<T extends NumericValue>(l: ExpressionOrValueOf<T>, r: ExpressionOrValueOf<T>): Expression<T>;
  neg<T extends NumericValue>(x: ExpressionOrValueOf<T>): Expression<T>;
  and(...exprs: ExpressionOrValueOf<boolean>[]): Expression<boolean>;
  or(...exprs: ExpressionOrValueOf<boolean>[]): Expression<boolean>;
  not(x: ExpressionOrValueOf<boolean>): Expression<boolean>;
}

/** A range of an index (what `withIndex`'s callback returns). */
export interface IndexRange {
  readonly __isIndexRange: true;
}
type PlusOne<N extends number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17][N];
type FieldAt<Fields extends string[], N extends number> = Fields[N] & string;

/** After an upper bound: nothing more. */
export interface UpperBoundIndexRangeBuilder extends IndexRange {}
/** After a lower bound on a field: an upper bound on the same field, or nothing. */
export interface LowerBoundIndexRangeBuilder<Document, Field extends string> extends IndexRange {
  lt(field: Field, value: FieldTypeFromFieldPath<Document, Field>): UpperBoundIndexRangeBuilder;
  lte(field: Field, value: FieldTypeFromFieldPath<Document, Field>): UpperBoundIndexRangeBuilder;
}
/**
 * Convex's `IndexRangeBuilder`: equalities on the index's fields in order, then a range on the next one.
 * `FieldNum` is how many equalities came before.
 */
export interface IndexRangeBuilder<Document, IndexFields extends string[], FieldNum extends number = 0>
  extends IndexRange {
  eq(
    field: FieldAt<IndexFields, FieldNum>,
    value: FieldTypeFromFieldPath<Document, FieldAt<IndexFields, FieldNum>>,
  ): IndexRangeBuilder<Document, IndexFields, PlusOne<FieldNum>>;
  gt(
    field: FieldAt<IndexFields, FieldNum>,
    value: FieldTypeFromFieldPath<Document, FieldAt<IndexFields, FieldNum>>,
  ): LowerBoundIndexRangeBuilder<Document, FieldAt<IndexFields, FieldNum>>;
  gte(
    field: FieldAt<IndexFields, FieldNum>,
    value: FieldTypeFromFieldPath<Document, FieldAt<IndexFields, FieldNum>>,
  ): LowerBoundIndexRangeBuilder<Document, FieldAt<IndexFields, FieldNum>>;
  lt(
    field: FieldAt<IndexFields, FieldNum>,
    value: FieldTypeFromFieldPath<Document, FieldAt<IndexFields, FieldNum>>,
  ): UpperBoundIndexRangeBuilder;
  lte(
    field: FieldAt<IndexFields, FieldNum>,
    value: FieldTypeFromFieldPath<Document, FieldAt<IndexFields, FieldNum>>,
  ): UpperBoundIndexRangeBuilder;
}

/** A page of a typed query. */
export type PaginationResultOf<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

/** Convex's `OrderedQuery`: filters and results. */
export interface OrderedQuery<TableInfo extends GenericTableInfo> extends AsyncIterable<DocumentByInfo<TableInfo>> {
  filter(predicate: (q: FilterBuilder<TableInfo>) => ExpressionOrValueOf<boolean>): this;
  paginate(paginationOpts: PaginationOptions): Promise<PaginationResultOf<DocumentByInfo<TableInfo>>>;
  collect(): Promise<DocumentByInfo<TableInfo>[]>;
  take(n: number): Promise<DocumentByInfo<TableInfo>[]>;
  first(): Promise<DocumentByInfo<TableInfo> | null>;
  unique(): Promise<DocumentByInfo<TableInfo> | null>;
}
/** Convex's `Query`: an order, then an ordered query. */
export interface Query<TableInfo extends GenericTableInfo> extends OrderedQuery<TableInfo> {
  order(order: "asc" | "desc"): OrderedQuery<TableInfo>;
}
/** What a search filter callback returns (Convex's `SearchFilter`). */
export interface SearchFilter {
  readonly __isSearchFilter?: undefined;
}
/** Convex's `SearchFilterBuilder`: the search first. */
export interface SearchFilterBuilder<Document, Config extends { searchField: string; filterFields: string }> {
  search(fieldName: Config["searchField"], query: string): SearchFilterFinalizer<Document, Config>;
}
/** Convex's `SearchFilterFinalizer`: equality filters on the index's filter fields. */
export interface SearchFilterFinalizer<Document, Config extends { searchField: string; filterFields: string }>
  extends SearchFilter {
  eq<FieldName extends Config["filterFields"]>(
    fieldName: FieldName,
    value: FieldTypeFromFieldPath<Document, FieldName>,
  ): SearchFilterFinalizer<Document, Config>;
}

/** Convex's `QueryInitializer`: the whole table, or an index range. */
export interface QueryInitializer<TableInfo extends GenericTableInfo> extends Query<TableInfo> {
  fullTableScan(): Query<TableInfo>;
  withIndex<IndexName extends IndexNames<TableInfo>>(
    indexName: IndexName,
    indexRange?: (q: IndexRangeBuilder<DocumentByInfo<TableInfo>, NamedIndex<TableInfo, IndexName>>) => IndexRange,
  ): Query<TableInfo>;
  /** A full-text search (STUDY-45): always in relevance order. */
  withSearchIndex<IndexName extends keyof TableInfo["searchIndexes"] & string>(
    indexName: IndexName,
    searchFilter: (
      q: SearchFilterBuilder<DocumentByInfo<TableInfo>, TableInfo["searchIndexes"][IndexName]>,
    ) => SearchFilter,
  ): OrderedQuery<TableInfo>;
}

/** A table's name from one of its ids. */
type TableOf<Id> = Id extends GenericId<infer TableName> ? TableName : never;

/** The system tables an app reads through `db.system`. */
export type SystemDataModel = {
  _scheduled_functions: {
    document: {
      _id: GenericId<"_scheduled_functions">;
      _creationTime: number;
      name: string;
      args: Value[];
      scheduledTime: number;
      completedTime?: number;
      state:
        | { kind: "pending" }
        | { kind: "inProgress" }
        | { kind: "success" }
        | { kind: "failed"; error: string }
        | { kind: "canceled" };
    };
    fieldPaths: "_id" | "_creationTime" | "name" | "args" | "scheduledTime" | "completedTime" | "state" | "state.kind";
    indexes: { by_id: ["_id"]; by_creation_time: ["_creationTime"] };
    searchIndexes: {};
    vectorIndexes: {};
  };
  _storage: {
    document: {
      _id: GenericId<"_storage">;
      _creationTime: number;
      sha256: string;
      size: number;
      contentType?: string;
    };
    fieldPaths: "_id" | "_creationTime" | "sha256" | "size" | "contentType";
    indexes: { by_id: ["_id"]; by_creation_time: ["_creationTime"] };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/** Reading one data model (the app's, or the system tables'). */
export interface BaseDatabaseReader<DataModel extends GenericDataModel> {
  get<TableName extends TableNamesInDataModel<DataModel>>(
    id: GenericId<TableName>,
  ): Promise<DocumentByName<DataModel, TableName> | null>;
  get<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<TableName>,
  ): Promise<DocumentByName<DataModel, TableName> | null>;
  query<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
  ): QueryInitializer<NamedTableInfo<DataModel, TableName>>;
  normalizeId<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
    id: string,
  ): GenericId<TableName> | null;
}

/** Convex's `GenericDatabaseReader`: `ctx.db` in a query. */
export interface GenericDatabaseReader<DataModel extends GenericDataModel> extends BaseDatabaseReader<DataModel> {
  system: BaseDatabaseReader<SystemDataModel>;
}

/** Convex's `BaseDatabaseReaderWithTable`: the database scoped to a table at a time (STUDY-66 §2). */
export interface BaseDatabaseReaderWithTable<DataModel extends GenericDataModel> {
  /** Scope the database to one table. */
  table<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
  ): BaseTableReader<DataModel, TableName>;
}

/** Convex's `BaseTableReader`: `db.table(name)` in a query. */
export interface BaseTableReader<
  DataModel extends GenericDataModel,
  TableName extends TableNamesInDataModel<DataModel>,
> {
  /** The document of this table with id `id`, or null. */
  get(id: GenericId<TableName>): Promise<DocumentByName<DataModel, TableName> | null>;
  /** Begin a query of this table. */
  query(): QueryInitializer<NamedTableInfo<DataModel, TableName>>;
}

/** Convex's `GenericDatabaseReaderWithTable`: a query's `ctx.db` as the table-scoped API types it. */
export interface GenericDatabaseReaderWithTable<DataModel extends GenericDataModel>
  extends BaseDatabaseReaderWithTable<DataModel> {
  system: BaseDatabaseReaderWithTable<SystemDataModel>;
}

/** A patch: some fields of a document's, `undefined` to remove one (system fields cannot be patched). */
export type PatchValue<Document> = Expand<{
  [K in keyof WithoutSystemFieldsLoose<Document>]?: WithoutSystemFieldsLoose<Document>[K] | undefined;
}>;
type WithoutSystemFieldsLoose<Document> =
  Document extends Record<string, Value | undefined> ? WithoutSystemFields<Document & Record<string, Value>> : Document;

/** Convex's `GenericDatabaseWriter`: `ctx.db` in a mutation. */
export interface GenericDatabaseWriter<DataModel extends GenericDataModel> extends GenericDatabaseReader<DataModel> {
  /**
   * Convex's `db.vars` (STUDY-53): `commitTs`, the placeholder for this transaction's commit timestamp. Write
   * it in a document (or return it); it resolves at the commit to an int64 (`bigint`) of nanoseconds,
   * ordered by commit order. Read back within the mutation it is still the placeholder.
   */
  readonly vars: { readonly commitTs: CommitTsPlaceholder };
  insert<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    value: WithoutSystemFields<DocumentByName<DataModel, TableName>>,
  ): Promise<GenericId<TableName>>;
  patch<Id extends GenericId<TableNamesInDataModel<DataModel>>>(
    id: Id,
    value: PatchValue<DocumentByName<DataModel, TableOf<Id> & TableNamesInDataModel<DataModel>>>,
  ): Promise<void>;
  patch<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<TableName>,
    value: PatchValue<DocumentByName<DataModel, TableName>>,
  ): Promise<void>;
  replace<Id extends GenericId<TableNamesInDataModel<DataModel>>>(
    id: Id,
    value: WithOptionalSystemFields<DocumentByName<DataModel, TableOf<Id> & TableNamesInDataModel<DataModel>>>,
  ): Promise<void>;
  replace<TableName extends TableNamesInDataModel<DataModel>>(
    table: TableName,
    id: GenericId<TableName>,
    value: WithOptionalSystemFields<DocumentByName<DataModel, TableName>>,
  ): Promise<void>;
  delete(id: GenericId<TableNamesInDataModel<DataModel>>): Promise<void>;
  delete<TableName extends TableNamesInDataModel<DataModel>>(table: TableName, id: GenericId<TableName>): Promise<void>;
}

/** Convex's `GenericDatabaseWriterWithTable`: a mutation's `ctx.db` as the table-scoped API types it. */
export interface GenericDatabaseWriterWithTable<DataModel extends GenericDataModel>
  extends GenericDatabaseReaderWithTable<DataModel> {
  /** Scope the database to one table. */
  table<TableName extends TableNamesInDataModel<DataModel>>(
    tableName: TableName,
  ): BaseTableWriter<DataModel, TableName>;
}

/** Convex's `BaseTableWriter`: `db.table(name)` in a mutation. */
export interface BaseTableWriter<DataModel extends GenericDataModel, TableName extends TableNamesInDataModel<DataModel>>
  extends BaseTableReader<DataModel, TableName> {
  insert(value: WithoutSystemFields<DocumentByName<DataModel, TableName>>): Promise<GenericId<TableName>>;
  patch(id: GenericId<TableName>, value: PatchValue<DocumentByName<DataModel, TableName>>): Promise<void>;
  replace(
    id: GenericId<TableName>,
    value: WithOptionalSystemFields<DocumentByName<DataModel, TableName>>,
  ): Promise<void>;
  delete(id: GenericId<TableName>): Promise<void>;
}

/** The system tables' names, for `Id` in `_generated/dataModel`. */
export type { SystemTableNames };
