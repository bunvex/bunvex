/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from "bunvex/server";
import type { GenericId } from "bunvex/values";
import schema from "../schema.js";

/**
 * The names of all of your tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in bunvex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

/**
 * An identifier for a document in bunvex: its `_id`.
 *
 * Ids are strings at run time; the type tells one table's ids from another's, and from other strings.
 * Load a document with `db.get(tableName, id)` in queries and mutations.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

/**
 * The app's data model: its tables, the type of their documents, and their indexes.
 *
 * It parameterizes `queryGeneric`, `mutationGeneric` and the database types.
 */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
