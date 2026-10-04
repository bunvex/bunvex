/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `bunvex dev`.
 * @module
 */

import type { AnyDataModel } from "bunvex/server";
import type { GenericId } from "bunvex/values";

/**
 * No `schema.ts` file found!
 *
 * Without a schema the types are permissive (`Doc = any`). Add a `schema.ts` for type-safe documents,
 * then rerun codegen with `bunvex dev`.
 */

/**
 * The names of all of your tables.
 */
export type TableNames = string;

/**
 * The type of a document stored in bunvex.
 */
export type Doc = any;

/**
 * An identifier for a document in bunvex: its `_id`.
 *
 * Ids are strings at run time; the type tells one table's ids from another's, and from other strings.
 * Load a document with `db.get(tableName, id)` in queries and mutations.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames = TableNames> = GenericId<TableName>;

/**
 * The app's data model: its tables, the type of their documents, and their indexes.
 *
 * It parameterizes `queryGeneric`, `mutationGeneric` and the database types.
 */
export type DataModel = AnyDataModel;
