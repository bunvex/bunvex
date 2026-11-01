// The custom test query's own type files (STUDY-162), as Convex's `FunctionEditor.tsx` creates them beside the
// library's declarations: the globals the query is written against (`query`, `internalQuery`, `process.env`), the
// generated `server` and `dataModel` (codegen's two forms: with the deployment's schema, or without one), and the
// schema itself as `schema.ts` (`schemaCode`, the Schema panel's). Paths are the editor's file system's.
import type { SchemaInfo, TableInfo } from "../data-source.ts";
import { schemaCode } from "../database/schema-code.ts";

// the specifiers an app's files import, written into the files below (as text, not imported here)
const SERVER = JSON.stringify("@bunvex/server");
const VALUES = JSON.stringify("@bunvex/values");

/** The test query's own model: a module at the project's root, beside `schema.ts`. */
export const QUERY_FILE = "file:///testQuery.ts";

const GLOBALS = `import type { QueryBuilder } from ${SERVER};
import type { DataModel } from "./_generated/dataModel";

declare global {
  /**
   * Define a query in this bunvex app's public API.
   *
   * It may read the database, and clients may call it.
   */
  const query: QueryBuilder<DataModel, "public">;

  /**
   * Define a query only other bunvex functions can call.
   */
  const internalQuery: QueryBuilder<DataModel, "public">;

  const process: {
    env: {
      [key: string]: string | undefined;
      BUNVEX_CLOUD_URL: string;
      BUNVEX_SITE_URL: string;
    };
  };
}
`;

const GENERATED_SERVER = `import type { GenericQueryCtx } from ${SERVER};
import type { DataModel } from "./dataModel";

export type QueryCtx = GenericQueryCtx<DataModel>;
`;

const DATA_MODEL_WITH_SCHEMA = `import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  SystemTableNames,
  TableNamesInDataModel,
} from ${SERVER};
import type { GenericId } from ${VALUES};
import schema from "../schema";

/** The names of all of your tables. */
export type TableNames = TableNamesInDataModel<DataModel>;

/** The type of a document stored in bunvex. */
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

/** An identifier for a document in bunvex: its \`_id\`. */
export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

/** The app's data model: its tables, the type of their documents, and their indexes. */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
`;

const DATA_MODEL_WITHOUT_SCHEMA = `import type { AnyDataModel } from ${SERVER};
import type { GenericId } from ${VALUES};

/** The names of all of your tables. */
export type TableNames = string;

/** The type of a document stored in bunvex. */
export type Doc = any;

/** An identifier for a document in bunvex: its \`_id\`. */
export type Id<TableName extends TableNames = TableNames> = GenericId<TableName>;

/** The app's data model: without a schema, any table and any document. */
export type DataModel = AnyDataModel;
`;

/**
 * The files the test query's types come from, for this deployment's schema: `file:///…` → text. Without a declared
 * table, the data model is codegen's without a schema, and there is no `schema.ts`.
 */
export function queryTypeFiles(schema: SchemaInfo | undefined, tables: TableInfo[]): Record<string, string> {
  const code = schema ? schemaCode(schema, tables) : null;
  return {
    "file:///globals.d.ts": GLOBALS,
    "file:///_generated/server.d.ts": GENERATED_SERVER,
    "file:///_generated/dataModel.d.ts": code ? DATA_MODEL_WITH_SCHEMA : DATA_MODEL_WITHOUT_SCHEMA,
    ...(code && { "file:///schema.ts": code.code }),
  };
}
