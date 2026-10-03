// The data model as types (STUDY-36), as Convex's (npm-packages/convex/src/server/data_model.ts,
// schema.ts, system_fields.ts): what `_generated/dataModel` derives from an app's schema, and what the typed
// database, contexts and builders are generic over. Types only; nothing here exists at run time.
import type { GenericId, GenericValidator, Value } from "@bunvex/values";
import type {
  Expand,
  GenericSchema,
  GenericTableIndexes,
  GenericTableSearchIndexes,
  SchemaDefinition,
  TableDefinition,
} from "./schema.ts";

/** A document's fields (Convex's `GenericDocument`). */
export type GenericDocument = Record<string, Value>;
/** The dotted paths of a document's fields an index or filter may name. */
export type GenericFieldPaths = string;

/** One table, as types (Convex's `GenericTableInfo`). */
export type GenericTableInfo = {
  document: GenericDocument;
  fieldPaths: GenericFieldPaths;
  indexes: GenericTableIndexes;
  searchIndexes: GenericTableSearchIndexes;
  vectorIndexes: Record<string, unknown>;
};

/** Every table of an app, as types (Convex's `GenericDataModel`). */
export type GenericDataModel = Record<string, GenericTableInfo>;

/** A data model without a schema: any table, any document (Convex's `AnyDataModel`). */
export type AnyDataModel = {
  [tableName: string]: {
    // biome-ignore lint/suspicious/noExplicitAny: Convex's AnyDataModel is any by definition
    document: any;
    fieldPaths: GenericFieldPaths;
    indexes: {};
    searchIndexes: {};
    vectorIndexes: {};
  };
};

export type TableNamesInDataModel<DataModel extends GenericDataModel> = keyof DataModel & string;
export type NamedTableInfo<
  DataModel extends GenericDataModel,
  TableName extends keyof DataModel,
> = DataModel[TableName];
export type DocumentByName<
  DataModel extends GenericDataModel,
  TableName extends TableNamesInDataModel<DataModel>,
> = DataModel[TableName]["document"];
export type DocumentByInfo<TableInfo extends GenericTableInfo> = TableInfo["document"];
export type FieldPaths<TableInfo extends GenericTableInfo> = TableInfo["fieldPaths"];
export type Indexes<TableInfo extends GenericTableInfo> = TableInfo["indexes"];
export type IndexNames<TableInfo extends GenericTableInfo> = keyof Indexes<TableInfo> & string;
export type NamedIndex<
  TableInfo extends GenericTableInfo,
  IndexName extends IndexNames<TableInfo>,
> = Indexes<TableInfo>[IndexName];

/** The system tables an app may read (`db.system`, ids in `v.id`). */
export type SystemTableNames = "_scheduled_functions" | "_storage";

/** The fields every document has besides `_id`. */
export type SystemFields = { _creationTime: number };
export type IdField<TableName extends string> = { _id: GenericId<TableName> };
/** Convex's `SystemIndexes`: the two indexes every table has. */
export type SystemIndexes = { by_id: ["_id"]; by_creation_time: ["_creationTime"] };

/** `Omit` that keeps a union's branches apart (Convex's `BetterOmit`). */
export type BetterOmit<T, K extends keyof T> = {
  [Property in keyof T as Property extends K ? never : Property]: T[Property];
};
/** A document as written: without `_id` and `_creationTime`. */
export type WithoutSystemFields<Document extends GenericDocument> = Expand<
  BetterOmit<Document, keyof SystemFields | "_id">
>;
/** A document as written, its system fields optional. */
export type WithOptionalSystemFields<Document extends GenericDocument> = Expand<
  WithoutSystemFields<Document> & Partial<Pick<Document, keyof SystemFields | "_id">>
>;

/** The dotted paths of a value's object fields, down nested objects (not into arrays or records). */
type PathsOf<T, Depth extends unknown[] = []> = Depth["length"] extends 8
  ? never
  : T extends readonly unknown[]
    ? never
    : T extends Record<string, unknown>
      ? {
          [K in keyof T & string]:
            | K
            | (NonNullable<T[K]> extends Record<string, unknown>
                ? `${K}.${PathsOf<NonNullable<T[K]>, [...Depth, 0]>}`
                : never);
        }[keyof T & string]
      : never;

/** A document type with `_id` and `_creationTime`, over each branch of a union. */
type WithSystemFields<TableName extends string, D> = D extends unknown
  ? Expand<IdField<TableName> & SystemFields & D>
  : never;

/** One table's info from its definition. */
type TableInfoOf<TableName extends string, T> =
  T extends TableDefinition<infer DocumentType, infer TableIndexes, infer SearchIndexes>
    ? DocumentType extends GenericValidator
      ? {
          document: unknown extends DocumentType["type"]
            ? // biome-ignore lint/suspicious/noExplicitAny: v.any() tables hold any document
              any
            : WithSystemFields<TableName, DocumentType["type"]>;
          fieldPaths: unknown extends DocumentType["type"]
            ? GenericFieldPaths
            : "_id" | "_creationTime" | PathsOf<DocumentType["type"]>;
          indexes: Expand<TableIndexes & SystemIndexes>;
          searchIndexes: SearchIndexes;
          vectorIndexes: {};
        }
      : never
    : never;

/**
 * The data model of a schema (Convex's `DataModelFromSchemaDefinition`): each table's document (with its
 * system fields), field paths and indexes. With `strictTableNameTypes: false`, any other table name is
 * allowed too, as `AnyDataModel`.
 */
export type DataModelFromSchemaDefinition<SchemaDef extends SchemaDefinition<GenericSchema, boolean>> =
  SchemaDef extends SchemaDefinition<infer Schema, infer Strict>
    ? Strict extends false
      ? { [TableName in keyof Schema & string]: TableInfoOf<TableName, Schema[TableName]> } & AnyDataModel
      : { [TableName in keyof Schema & string]: TableInfoOf<TableName, Schema[TableName]> }
    : never;
