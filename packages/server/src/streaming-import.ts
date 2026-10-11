// Streaming import (STUDY-141), Convex's `/api/streaming_import/*` (crates/local_backend/src/streaming_import.rs):
// the routes Airbyte's destination connector and Convex's Fivetran destination call, with ImportBackups. Built
// so far (STUDY-141 PR 1): `clear_tables`, `get_schema` and `replace_tables`; the record, operation and
// primary-key-index routes are future work (PRs 2–4) and answer 404 as any unknown route.
import {
  type Caller,
  type Engine,
  ImportBackfillingError,
  insertAuditLogEvents,
  SCHEMAS_TABLE,
  schemaStateOf,
  schemaToJson,
  TooManyTablesError,
} from "@bunvex/core";
import { auditActor, auditEvents } from "./audit-log.ts";
import type { Functions } from "./functions.ts";
import { type BodyShape, readJsonBody } from "./json-body.ts";
import { UNIDECODE_SLUG_TABLE } from "./unidecode-table.ts";

export const STREAMING_IMPORT_ROUTE = /^\/api\/streaming_import\/([^/]+)$/;

/** Each built route's method (Convex's `streaming_import_routes`, router.rs). */
const METHODS: Record<string, string> = { clear_tables: "PUT", get_schema: "GET", replace_tables: "POST" };

/** A request error: its status, code and message. */
export class StreamingImportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** axum's default body limit, which these routes keep (Convex sets one only on `import_airbyte_records`). */
export const STREAMING_IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

/** The body's text, as Convex's `buffer_body` takes it: past the limit, its `BadJsonBody`. */
async function bodyText(req: Request): Promise<string> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > STREAMING_IMPORT_BODY_LIMIT)
    throw new StreamingImportError(400, "BadJsonBody", "Failed to buffer the request body: length limit exceeded");
  return new TextDecoder().decode(bytes);
}

/** Convex's `ClearTableArgs` (`tableNames: Vec<String>`). */
const CLEAR_TABLE_ARGS: BodyShape = { name: "ClearTableArgs", fields: [["tableNames", "strings"]] };
/** Convex's `ReplaceTableArgs` (`_table_names: BTreeMap<String, String>`, camelCase: `tableNames`). */
const REPLACE_TABLE_ARGS: BodyShape = { name: "ReplaceTableArgs", fields: [["tableNames", "stringMap"]] };

// ---------------------------------------------------------------- names (Convex's `ValidIdentifier`)

/** Convex's `IDENTIFIER_PREFIX` (crates/application/src/valid_identifier.rs). */
const IDENTIFIER_PREFIX = "source_";

/** Convex's `check_valid_identifier`: `[A-Za-z_][A-Za-z0-9_]*`, at most 64 bytes, not all underscores. */
const isIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s) && /[A-Za-z0-9]/.test(s);

let table: string[] | null = null;
/** The slug part of U+0080 and above (`unidecode` 0.3.0, reduced; past U+FFFE nothing). */
function transliterate(cp: number): string {
  table ??= UNIDECODE_SLUG_TABLE.split(",");
  return cp < 0xffff ? (table[cp - 0x80] ?? "") : "";
}

/**
 * Convex's `slugify!(s, separator = "_")` (the `slugify` 0.1.0 crate): transliterate (`unidecode`), lower-case,
 * keep `a–z0–9`, and turn every run of anything else into one `_`, none at either end. (The crate's trims and
 * its space replacement change nothing past that last step.)
 */
export function slugify(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x80 ? ch.toLowerCase() : transliterate(cp);
  }
  return out
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
}

/**
 * Convex's `ValidIdentifier<TableName>`: a valid table name that is not a system name (`_…`) is kept; anything
 * else becomes `source_<slug>`. A slug that is still not a valid name (too long) is Convex's untyped error, an
 * internal error to the caller.
 */
export function validTableName(name: string): string {
  if (isIdentifier(name) && !name.startsWith("_")) return name;
  const candidate = IDENTIFIER_PREFIX + slugify(name);
  if (!isIdentifier(candidate)) throw new Error("Failed to create a valid identifier.");
  return candidate;
}

// ---------------------------------------------------------------- the routes

export type StreamingImportDeps = { engine: Engine; functions: Functions };

/**
 * One request to `/api/streaming_import/<route>`, its caller already identified (Convex's `ExtractIdentity`).
 * As Convex's extractors: the body is read before the operation is checked. Null for a route not built.
 */
export async function streamingImportRoute(
  deps: StreamingImportDeps,
  route: string,
  req: Request,
  caller: Caller,
): Promise<Response | null> {
  const method = METHODS[route];
  if (method === undefined) return null;
  // axum's method router: a GET route answers HEAD too, and a wrong method is 405 with the allowed ones.
  const allowed = method === "GET" ? ["GET", "HEAD"] : [method];
  if (!allowed.includes(req.method)) return new Response(null, { status: 405, headers: { allow: allowed.join(",") } });
  const { engine, functions } = deps;
  switch (route) {
    case "clear_tables": {
      const { tableNames } = await readJsonBody<{ tableNames: string[] }>(req, () => bodyText(req), CLEAR_TABLE_ARGS);
      functions.requireOperation(caller, "ImportBackups");
      await clearTables(engine, tableNames.map(validTableName), caller);
      return new Response(null, { status: 200 });
    }
    case "get_schema": {
      functions.requireOperation(caller, "ImportBackups");
      // The active schema's `DatabaseSchemaJson`, as stored (STUDY-134), or null.
      const schema = await engine.query(async (db) => {
        const rows = (await db.asSystem(() => db.query(SCHEMAS_TABLE).collect())) as Record<string, unknown>[];
        const active = rows.find((r) => schemaStateOf(r) === "active") as { schema: string } | undefined;
        return active?.schema ?? null;
      });
      return new Response(schema ?? "null", { status: 200, headers: { "content-type": "application/json" } });
    }
    case "replace_tables": {
      // Convex disabled it ("until we figure out how to make schema validation and indexes work with
      // overwrites"): the body is read, nothing is checked, and it always fails.
      await readJsonBody(req, () => bodyText(req), REPLACE_TABLE_ARGS);
      throw new StreamingImportError(
        400,
        "OverwriteNotSupported",
        "Overwrite sync mode is not supported. Please use a different sync mode.",
      );
    }
  }
  return null;
}

/**
 * Convex's `clear_tables` (snapshot_import/mod.rs): an import of empty tables in Replace mode. Each table is
 * replaced by an empty hidden one (its number and enabled indexes kept; a missing table is created), and all
 * are activated in one commit, which checks that the schema did not change meanwhile and records one
 * `clear_tables` event as the caller.
 */
export async function clearTables(engine: Engine, names: string[], caller: Caller) {
  // A name given twice: Convex's second empty table wants the number its first one took, a `TableConflict`
  // for a table that exists; for one that does not, both are new and one table results.
  const once: string[] = [];
  for (const name of names) {
    if (!once.includes(name)) once.push(name);
    else if (engine.catalog.tables.has(name))
      throw new StreamingImportError(
        400,
        "TableConflict",
        `New table \`${name}\` has IDs that conflict with existing table \`${name}\`. To delete all existing tables, import with \`bunvex import --replace-all\`.`,
      );
  }
  const schemaBefore = JSON.stringify(schemaToJson(engine.schema));
  try {
    await engine.replaceWithEmptyTables(
      once,
      async (db) => {
        if (JSON.stringify(schemaToJson(engine.schema)) !== schemaBefore)
          throw new StreamingImportError(
            400,
            "ImportSchemaChanged",
            "Could not complete import because schema changed. Avoid modifying schema.ts while importing tables",
          );
        await insertAuditLogEvents(db, [auditEvents.clearTables()], auditActor(caller));
      },
      { createMissing: true },
    );
  } catch (e) {
    if (e instanceof ImportBackfillingError) throw new StreamingImportError(400, e.code, e.message);
    if (e instanceof TooManyTablesError) throw new StreamingImportError(400, e.code, e.message);
    throw e;
  }
}
