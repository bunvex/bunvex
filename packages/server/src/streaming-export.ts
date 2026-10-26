// Streaming export (STUDY-60), Convex's legacy connector API (crates/local_backend/src/streaming_export.rs,
// crates/database/src/database.rs `list_snapshot` / `document_deltas`, crates/common/src/json_schemas):
// `GET|POST /api/list_snapshot`, `GET|POST /api/document_deltas`, `GET /api/json_schemas`,
// `GET /api/get_table_column_names`, `GET /api/test_streaming_export_connection`; `ViewData`. Timestamps are
// nanoseconds on the wire (bunvex's are microseconds); documents in one of three JSON encodings.

import type { DashboardShape } from "@bunvex/core";
import {
  compareInternalIds,
  type Engine,
  hasRetention,
  internalIdBytes,
  internalIdOf,
  knob,
  OutOfRetentionError,
  reduceShape,
  SCHEMAS_TABLE,
  type SchemaJson,
  schemaStateOf,
  shapeOf,
  type TableDef,
  type TabletId,
  UnionBuilder,
} from "@bunvex/core";
import {
  compareUtf8,
  encodeId,
  formatExportFloat,
  fromJsonValue,
  isBytes,
  type JSONValue,
  type ValidatorJSON,
  type Value,
} from "@bunvex/values";
import { type BodyShape, checkJsonBody } from "./json-body.ts";
import { intError, QueryArgsError, queryArgs } from "./query-args.ts";
import { displayValidatorJson } from "./validator-json.ts";

/** Convex's knobs. */
export const SNAPSHOT_LIST_LIMIT = knob("SNAPSHOT_LIST_LIMIT", 1024);
export const DOCUMENT_DELTAS_LIMIT = knob("DOCUMENT_DELTAS_LIMIT", 128);
const LIST_SNAPSHOT_MAX_AGE_NS = BigInt(knob("LIST_SNAPSHOT_MAX_AGE_SECS", 5 * 24 * 3600)) * 1_000_000_000n;

export const STREAMING_EXPORT_ROUTE =
  /^\/api\/(list_snapshot|document_deltas|json_schemas|get_table_column_names|test_streaming_export_connection)$/;

export class StreamingExportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (code: string, message: string) => new StreamingExportError(400, code, message);

// ---------------------------------------------------------------- encodings

/** Convex's `ValueFormat` (`json` clean, `convex_encoded_json`, `export_json`), with bunvex's names (DV-307). */
export type Format = "clean" | "encoded" | "export";

/**
 * The `format` argument: `json` or `clean_json`, `encoded_json`, `export_json` (DV-307: Convex's
 * `convex_encoded_json` / `convex_clean_json` renamed, its legacy `convex_json` alias dropped).
 */
export function parseFormat(s: string | null | undefined): Format {
  if (s === undefined || s === null || s === "json" || s === "clean_json") return "clean";
  if (s === "encoded_json") return "encoded";
  if (s === "export_json") return "export";
  throw bad("BadFormat", `format param must be one of [\`json\`]. Got ${s}`);
}

/**
 * The `format` argument as Convex's streaming export routes check it: last, after the read
 * (local_backend/src/streaming_export.rs), so a request also wrong otherwise gets that error. `f` is what the
 * values are written in meanwhile; `check()` throws the format's error, if any.
 */
function lateFormat(s: string | null | undefined): { f: Format; check: () => void } {
  try {
    return { f: parseFormat(s), check: () => {} };
  } catch (e) {
    return {
      f: "clean",
      check: () => {
        throw e;
      },
    };
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const floatBytes = (n: number) => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, n, true);
  return b64(buf);
};
const intBytes = (n: bigint) => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, n, true);
  return b64(buf);
};
const byteOrder = compareUtf8;

/** A value as JSON text in `format` (Convex's export.rs; floats as serde_json with `float_roundtrip`). */
export function writeValue(v: Value, f: Format): string {
  if (v === null) return "null";
  if (typeof v === "bigint")
    return f === "clean" ? `"${v}"` : f === "encoded" ? `{"$integer":"${intBytes(v)}"}` : v.toString();
  if (typeof v === "number") {
    if (Number.isNaN(v) || !Number.isFinite(v)) {
      if (f === "clean") return Number.isNaN(v) ? '"NaN"' : v > 0 ? '"Infinity"' : '"-Infinity"';
      return `{"$float":"${floatBytes(v)}"}`;
    }
    if (Object.is(v, -0) && f === "encoded") return `{"$float":"${floatBytes(v)}"}`;
    return formatExportFloat(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (isBytes(v)) {
    const s = b64(new Uint8Array(v));
    return f === "clean" ? `"${s}"` : `{"$bytes":"${s}"}`;
  }
  if (Array.isArray(v)) return `[${v.map((x) => writeValue(x, f)).join(",")}]`;
  return `{${fieldsOf(v as Record<string, Value>, f)}}`;
}

function fieldsOf(o: Record<string, Value>, f: Format): string {
  return Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort(byteOrder)
    .map((k) => `${JSON.stringify(k)}:${writeValue(o[k]!, f)}`)
    .join(",");
}

/** A streamed document: `_component`, `_table`, `_ts` (and `_deleted`) first, then its fields in key order. */
function docJson(table: string, tsNs: bigint, deleted: boolean | null, doc: Record<string, Value>, f: Format) {
  const head = `"_component":"","_table":${JSON.stringify(table)},"_ts":${tsNs}${deleted === null ? "" : `,"_deleted":${deleted}`}`;
  const body = fieldsOf(doc, f);
  return `{${head}${body ? `,${body}` : ""}}`;
}

// ---------------------------------------------------------------- selection

type Inclusion = "included" | "excluded";
export type Columns = Record<string, Inclusion> & { _other: Inclusion };
type Tables = Record<string, Columns | "excluded"> & { _other: Inclusion | Columns };
/** Convex's `Selection`: per component path (`""` the root), per table, per column. */
export type Selection = Record<string, Tables | Inclusion> & { _other: Inclusion };

const normInclusion = (v: unknown): Inclusion | null =>
  v === "included" || v === "incl" ? "included" : v === "excluded" || v === "excl" ? "excluded" : null;

/**
 * Convex's `SelectionArg`, an untagged enum: the first of an exact `selection`, a `tableName` (in a
 * `component`), a `component`, or everything that the arguments make; arguments that make none of the first
 * three select everything (`Everything {}` takes any object). A table name that is not one is an untyped error
 * where the table is looked up (a 500).
 */
export function selectionOf(args: Record<string, unknown>): Selection {
  if (args.selection !== undefined)
    try {
      return checkSelection(args.selection);
    } catch (e) {
      if (!(e instanceof StreamingExportError)) throw e;
    }
  const table = args.tableName ?? args.table_name;
  const component = args.component;
  if (typeof table === "string" && (component === undefined || component === null || typeof component === "string")) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table) || /^_+$/.test(table))
      throw new Error(`Invalid table name ${table}`);
    const c = (component as string | null | undefined) ?? "";
    return { _other: "excluded", [c]: { _other: "excluded", [table]: { _other: "included" } } } as Selection;
  }
  if (typeof component === "string") return { _other: "excluded", [component]: { _other: "included" } } as Selection;
  return { _other: "included" };
}

export function checkSelection(raw: unknown): Selection {
  const fail = (m: string) => {
    throw bad("BadJsonBody", `selection: ${m}`);
  };
  const level = (o: unknown, depth: number): unknown => {
    const inc = normInclusion(o);
    if (inc !== null) return inc;
    if (depth === 3 || typeof o !== "object" || o === null || Array.isArray(o)) return fail("invalid inclusion");
    const rec = o as Record<string, unknown>;
    if (!("_other" in rec)) return fail("missing field `_other`");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec))
      out[k] = k === "_other" && depth === 2 ? normInclusion(v) : level(v, depth + 1);
    if (depth === 2 && out._other === null) return fail("invalid inclusion");
    return out;
  };
  const s = level(raw, 0) as Selection;
  if (typeof s !== "object") fail("expected an object");
  return s;
}

/** Whether the selection takes `table` of the root component, and which of its columns. */
export function tableSelection(s: Selection, table: string): Columns | null {
  const comp = s[""] ?? s._other;
  if (comp === "excluded") return null;
  if (comp === "included") return { _other: "included" } as Columns;
  const t = ((comp as Tables)[table] ?? (comp as Tables)._other) as Columns | Inclusion;
  if (t === "excluded") return null;
  if (t === "included") return { _other: "included" } as Columns;
  const cols = t as Columns;
  // Convex: `_id` must be included (an untyped error, so a 500).
  if ((cols._id ?? cols._other) === "excluded") throw new Error("`_id` must be included in the column selection");
  return cols;
}

export function pickColumns(doc: Record<string, Value>, cols: Columns): Record<string, Value> {
  if (cols._other === "included" && Object.keys(cols).length === 1) return doc;
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(doc)) if (k === "_id" || (cols[k] ?? cols._other) === "included") out[k] = v;
  return out;
}

// ---------------------------------------------------------------- the routes

type Deps = { engine: Engine };

/** The user tables a stream reads: active and hidden (an import's), not system ones, by tablet. */
export function streamedTables(engine: Engine): TableDef[] {
  const c = engine.catalog;
  return [...c.tables.values(), ...c.hidden.values()]
    .filter((t) => !t.name.startsWith("_"))
    .sort((a, b) => compareInternalIds(a.id, b.id));
}

/** `list_snapshot`: one table's documents at `snapshot`, by id, a page at a time. */
export async function listSnapshot(deps: Deps, args: Record<string, unknown>): Promise<string> {
  const { engine } = deps;
  const { f, check: checkFormat } = lateFormat(args.format as string | undefined);
  const selection = selectionOf(args);
  const now = engine.committer.visibleTs;
  let snapshotNs: bigint;
  if (args.snapshot === undefined || args.snapshot === null) snapshotNs = now;
  else {
    snapshotNs = BigInt(args.snapshot as string);
    // Convex turns a negative `i64` into its timestamp type with an untyped error (a 500).
    if (snapshotNs < 0n) throw new Error(`Invalid timestamp ${snapshotNs}`);
    if (snapshotNs > now) throw bad("SnapshotTooNew", `Snapshot value ${snapshotNs} is in the future.`);
    if (now - snapshotNs > LIST_SNAPSHOT_MAX_AGE_NS) throw tooOld(snapshotNs);
  }
  let cursor: { tablet: TabletId; id: string | null } | null = null;
  if (args.cursor !== undefined && args.cursor !== null) {
    try {
      const c = JSON.parse(args.cursor as string) as { tablet: unknown; id: unknown };
      if (typeof c.tablet !== "string" || (c.id !== null && typeof c.id !== "string")) throw new Error();
      cursor = { tablet: c.tablet, id: c.id };
    } catch {
      throw bad(
        "InvalidListSnapshotCursor",
        "Invalid value for the `cursor` argument of list_snapshot. Use a `cursor` returned by a previous list_snapshot call, and treat it as an opaque value.",
      );
    }
  }
  const tables = streamedTables(engine)
    .map((t) => ({ t, cols: tableSelection(selection, t.name) }))
    .filter((x) => x.cols !== null && (cursor === null || compareInternalIds(x.t.id, cursor.tablet) >= 0));
  const out = (values: string[], next: string | null) => {
    checkFormat();
    return `{"values":[${values.join(",")}],"snapshot":${snapshotNs},"cursor":${next === null ? "null" : JSON.stringify(next)},"hasMore":${next !== null}}`;
  };
  if (tables.length === 0) return out([], null);
  const { t, cols } = tables[0]!;
  const after = cursor !== null && cursor.tablet === t.id ? cursor.id : null;
  let page: Record<string, Value>[];
  try {
    page = (await engine.query(
      (db) =>
        db.asSystem(() =>
          db
            .queryDef(t)
            .withIndex("by_id", (q) => (after === null ? q : q.gt("_id", after)))
            .take(SNAPSHOT_LIST_LIMIT),
        ),
      undefined,
      undefined,
      undefined,
      snapshotNs,
    )) as Record<string, Value>[];
  } catch (e) {
    if (e instanceof OutOfRetentionError) throw tooOld(snapshotNs);
    throw e;
  }
  // Each document as of the snapshot, `_ts` its revision's ts (PERSIST-01 C16); a third-party store without
  // `getVersions` gives the snapshot instead.
  const versions = engine.persistence.getVersions
    ? await engine.persistence.getVersions(
        t.id,
        page.map((d) => internalIdOf(d._id as string)),
        snapshotNs,
      )
    : null;
  const values = page.map((d, i) => {
    const v = versions?.[i];
    return docJson(t.name, v ? v.ts : snapshotNs, null, pickColumns(d, cols!), f);
  });
  if (page.length >= SNAPSHOT_LIST_LIMIT)
    return out(values, JSON.stringify({ tablet: t.id, id: page[page.length - 1]!._id }));
  const next = tables[1];
  return out(values, next ? JSON.stringify({ tablet: next.t.id, id: null }) : null);
}

const tooOld = (ns: bigint) => bad("SnapshotTooOld", `Snapshot value ${ns} is too far in the past.`);

/** `document_deltas`: every document change after `cursor`, whole commits, about 128 rows a page. */
export async function documentDeltas(deps: Deps, args: Record<string, unknown>): Promise<string> {
  const { engine } = deps;
  if (args.cursor === undefined || args.cursor === null)
    throw bad("DocumentDeltasCursorRequired", "/api/document_deltas requires a cursor");
  const { f, check: checkFormat } = lateFormat(args.format as string | undefined);
  const selection = selectionOf(args);
  const cursorNs = BigInt(args.cursor as string);
  if (cursorNs < 0n) throw new Error("negative cursor");
  const store = engine.persistence;
  if (!hasRetention(store)) throw new Error("this persistence has no document log");
  const upper = engine.committer.visibleTs;
  const values: string[] = [];
  let rowsRead = 0;
  let after = cursorNs;
  let newCursor: bigint | null = null;
  let hasMore = false;
  outer: for (;;) {
    const rows = await store.readDocumentLog(after, upper, 16);
    if (rows.length === 0) break;
    const commits = new Map<bigint, typeof rows>();
    for (const r of rows) (commits.get(r.ts) ?? commits.set(r.ts, []).get(r.ts)!).push(r);
    for (const [ts, commit] of [...commits].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (newCursor !== null) {
        hasMore = true;
        break outer;
      }
      // As Convex's log: by (table, id), bytewise.
      commit.sort((a, b) => compareInternalIds(a.table, b.table) || compareInternalIds(a.id, b.id));
      for (const r of commit) {
        rowsRead++;
        const t = engine.catalog.byTablet(r.table);
        if (!t || t.name.startsWith("_") || engine.catalog.deleting.has(r.table)) continue;
        const cols = tableSelection(selection, t.name);
        if (!cols) continue;
        // The log keys a document by its internal id; apps know it by its id.
        if (r.deleted) values.push(docJson(t.name, ts, true, { _id: encodeId(t.number, internalIdBytes(r.id)) }, f));
        else {
          const version = await store.get(r.table, r.id, ts);
          if (version === null) continue;
          const doc = fromJsonValue(JSON.parse(version.json) as JSONValue) as Record<string, Value>;
          values.push(docJson(t.name, ts, false, pickColumns(doc, cols), f));
        }
      }
      if (rowsRead >= DOCUMENT_DELTAS_LIMIT || values.length >= DOCUMENT_DELTAS_LIMIT) newCursor = ts;
      after = ts;
    }
  }
  // Convex's `validate_document_snapshot`, after the read: the range must still be in the document window.
  const minDoc = engine.retention?.minDocumentTs ?? 0n;
  if (cursorNs + 1n < minDoc)
    throw bad(
      "InvalidWindowToReadDocuments",
      `Trying to synchronize from timestamp ${cursorNs + 1n}, which is older than the database’s retention window. This may happen if you paused your Fivetran or Airbyte connector for a long period of time. Please perform a full sync of the connector. See https://fivetran.com/docs/connectors/troubleshooting/trigger-historical-re-syncs or https://docs.airbyte.com/platform/operator-guides/refreshes`,
    );
  checkFormat();
  const cursorOut = hasMore ? newCursor! : upper;
  return `{"values":[${values.join(",")}],"cursor":${cursorOut},"hasMore":${hasMore}}`;
}

// ---------------------------------------------------------------- shapes: json_schemas, column names

/** Each streamed user table's reduced shape now (computed from its documents, as `/api/shapes2`). */
async function shapes(
  engine: Engine,
  at = engine.committer.visibleTs,
): Promise<{ name: string; shape: DashboardShape }[]> {
  const out: { name: string; shape: DashboardShape }[] = [];
  const active = [...engine.catalog.tables.values()].filter((t) => !t.name.startsWith("_"));
  for (const t of active.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const b = new UnionBuilder();
    let last: string | null = null;
    for (;;) {
      const page = (await engine.query(
        (db) =>
          db.asSystem(() =>
            db
              .queryDef(t)
              .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
              .take(1000),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as Record<string, Value>[];
      for (const d of page) b.push(shapeOf(d));
      if (page.length < 1000) break;
      last = page[page.length - 1]!._id as string;
    }
    out.push({ name: t.name, shape: reduceShape(b.build(), (n) => engine.catalog.publicNameOf(n)) });
  }
  return out;
}

/** Convex's leaf schemas per format (crates/common/src/json_schemas). */
function leafSchema(kind: "Int64" | "Float64" | "Bytes", f: Format, special = false): unknown {
  if (kind === "Int64")
    return f === "clean"
      ? { $description: "int64 represented as base10 string", type: "string" }
      : f === "encoded"
        ? {
            $description: "int64",
            type: "object",
            properties: { $integer: { $description: "int64 -> little-endian -> base64", type: "string" } },
          }
        : { $description: "int64", type: "number" };
  if (kind === "Bytes")
    return f === "clean"
      ? { $description: "base64 bytes", type: "string" }
      : { type: "object", $description: "base64 bytes", properties: { $bytes: { type: "string" } } };
  if (!special) return { type: "number" };
  const alt =
    f === "clean"
      ? { type: "string", $description: "-inf, inf, or NaN" }
      : {
          type: "object",
          $description: f === "encoded" ? "-0, -inf, inf, or NaN" : "-inf, inf, or NaN",
          properties: { $float: { $description: "float64 -> little-endian -> base64", type: "string" } },
        };
  return { $description: "float64", anyOf: [{ type: "number" }, alt] };
}

function shapeSchema(s: DashboardShape, f: Format): unknown {
  switch (s.type) {
    case "Unknown":
    case "Record":
      return {};
    case "Never":
      return false;
    case "Id":
      return { $description: `Id(${s.tableName})`, type: "string" };
    case "Null":
      return { type: "null" };
    case "Int64":
    case "Bytes":
      return leafSchema(s.type, f);
    case "Float64":
      return leafSchema("Float64", f, s.float64Range.hasSpecialValues);
    case "Boolean":
      return { type: "boolean" };
    case "String":
      return { type: "string" };
    case "Array":
      return { type: "array", items: shapeSchema(s.shape, f) };
    case "Union":
      return { anyOf: s.shapes.map((x) => shapeSchema(x, f)) };
    case "Object": {
      const fields = [...s.fields].sort((a, b) => byteOrder(a.fieldName, b.fieldName));
      return {
        type: "object",
        properties: Object.fromEntries(fields.map((x) => [x.fieldName, shapeSchema(x.shape, f)])),
        additionalProperties: false,
        required: fields.filter((x) => !x.optional).map((x) => x.fieldName),
      };
    }
  }
}

/** Convex's `JsonSchemaArgs`, as its query extractor reads it. Throws `QueryArgsError`. */
export function jsonSchemasArgs(q: URLSearchParams) {
  const a = queryArgs(q, [
    ["deltaSchema", "bool", true],
    ["format", "string", true],
    ["byComponent", "bool", true],
  ]);
  return { delta: a.deltaSchema === true, byComponent: a.byComponent === true };
}

type FieldSchema = { schema: unknown; optional: boolean };

/** Convex's `json_schemas::object`: fields and `required` in byte order, nothing else allowed. */
function objectSchema(fields: [string, FieldSchema][]): Record<string, unknown> {
  const sorted = [...fields].sort(([a], [b]) => byteOrder(a, b));
  return {
    type: "object",
    properties: Object.fromEntries(sorted.map(([k, x]) => [k, x.schema])),
    additionalProperties: false,
    required: sorted.filter(([, x]) => !x.optional).map(([k]) => k),
  };
}

/** `_id` and `_creationTime`, as Convex adds them to a table's schema (`AddTopLevelFields::True`). */
const systemFields = (table: string): [string, FieldSchema][] => [
  ["_id", { schema: { $description: `Id(${table})`, type: "string" }, optional: false }],
  ["_creationTime", { schema: { type: "number" }, optional: false }],
];

/** Convex's `Validator::to_json_schema` (crates/common/src/schemas/validator.rs), on the validator's JSON. */
function validatorSchema(j: ValidatorJSON, f: Format): unknown {
  switch (j.type) {
    case "id":
      return { $description: `Id(${j.tableName})`, type: "string" };
    case "null":
      return { type: "null" };
    case "number":
      return leafSchema("Float64", f, true);
    case "bigint":
    case "commitTs":
      return leafSchema("Int64", f);
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "bytes":
      return leafSchema("Bytes", f);
    case "literal": {
      const x = j.value;
      if (typeof x === "number") return leafSchema("Float64", f, true);
      if (typeof x === "boolean") return { type: "boolean" };
      if (typeof x === "string") return { type: "string" };
      return leafSchema("Int64", f);
    }
    case "array":
      return { type: "array", items: validatorSchema(j.value, f) };
    case "record":
      // As Convex's `json_schemas::record`, the value's schema under `type`.
      return {
        type: "object",
        $description: `Record with keys of type ${displayValidatorJson(j.keys as Record<string, JSONValue>)}`,
        additionalProperties: { type: validatorSchema(j.values.fieldType, f) },
      };
    case "object":
      return objectSchema(
        Object.entries(j.value).map(([k, x]) => [k, { schema: validatorSchema(x.fieldType, f), optional: x.optional }]),
      );
    case "union":
      return { anyOf: j.value.map((x) => validatorSchema(x, f)) };
    default:
      return {};
  }
}

/**
 * Convex's `ensure_supported_for_streaming_export`: a union of more than one object, at any depth, has no JSON
 * Schema an export can use.
 */
function checkExportable(j: ValidatorJSON): void {
  if (j.type === "array") checkExportable(j.value);
  else if (j.type === "object") for (const x of Object.values(j.value)) checkExportable(x.fieldType);
  else if (j.type === "union") {
    for (const x of j.value) checkExportable(x);
    if (j.value.filter((x) => x.type === "object").length > 1)
      throw bad("UnsupportedSchemaForExport", "Schema contains a union of objects, which is not supported for export");
  }
}

/**
 * Convex's `json_schema_from_active_schema` (local_backend/src/streaming_export.rs): a table whose shape is
 * neither an object nor empty (a document with more fields than `MAX_OBJECT_FIELDS` is a `Record`) is
 * described by its definition in the active schema.
 */
function schemaFromActive(active: SchemaJson | null, table: string, f: Format): Record<string, unknown> {
  if (active === null)
    throw bad("NoSchemaForExport", "There is no active schema, which is needed for streaming export.");
  const doc = active.tables.find((t) => t.tableName === table)?.documentType ?? null;
  if (doc === null)
    throw bad(
      "NoTableDefinitionForExport",
      `The table "${table}" does not have a schema, which is needed for streaming export.`,
    );
  if (doc.type === "any") return objectSchema(systemFields(table));
  // The stored document type is one object or a union of objects (Convex's `DocumentSchema`).
  const objects = doc.type === "union" ? doc.value : [doc];
  if (objects.length !== 1)
    throw bad(
      "UnsupportedSchemaForExport",
      `Schema for table "${table}" contains a union of object types, which is unsupported for streaming export`,
    );
  const o = objects[0]!;
  if (o.type !== "object") return objectSchema(systemFields(table));
  const fields = Object.entries(o.value)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, x]): [string, FieldSchema] => [k, { schema: validatorSchema(x.fieldType, f), optional: x.optional }]);
  const out = objectSchema([...fields, ...systemFields(table)]);
  checkExportable(o);
  return out;
}

/** The active schema at `at`, as stored (STUDY-134), or null. */
async function activeSchemaAt(engine: Engine, at: bigint): Promise<SchemaJson | null> {
  const text = await engine.query(
    async (db) => {
      const rows = (await db.asSystem(() => db.query(SCHEMAS_TABLE).collect())) as Record<string, unknown>[];
      return (rows.find((r) => schemaStateOf(r) === "active")?.schema as string | undefined) ?? null;
    },
    undefined,
    undefined,
    undefined,
    at,
  );
  return text === null ? null : (JSON.parse(text) as SchemaJson);
}

/**
 * `json_schemas`: each active user table's JSON Schema, from its inferred shape, or from the active schema when
 * the shape is not an object.
 */
export async function jsonSchemas(deps: Deps, q: URLSearchParams): Promise<unknown> {
  const { delta, byComponent } = jsonSchemasArgs(q);
  const f = parseFormat(q.get("format"));
  const at = deps.engine.committer.visibleTs;
  let active: SchemaJson | null | undefined;
  const out: Record<string, unknown> = {};
  for (const { name, shape } of await shapes(deps.engine, at)) {
    let schema: Record<string, unknown>;
    if (shape.type === "Never") schema = objectSchema(systemFields(name));
    else if (shape.type === "Object") schema = shapeSchema(shape, f) as Record<string, unknown>;
    else {
      if (active === undefined) active = await activeSchemaAt(deps.engine, at);
      schema = schemaFromActive(active, name, f);
    }
    if (delta)
      Object.assign(schema.properties as object, {
        _table: { type: "string" },
        _component: { type: "string" },
        _ts: { type: "integer" },
        _deleted: { type: "boolean" },
      });
    schema.$schema = "http://json-schema.org/draft-07/schema#";
    out[name] = schema;
  }
  return byComponent ? { "": out } : out;
}

/** `get_table_column_names`: each user table's top-level fields. */
export async function tableColumnNames(deps: Deps): Promise<unknown> {
  const tables = (await shapes(deps.engine)).map(({ name, shape }) => ({
    name,
    columns: shape.type === "Object" ? shape.fields.map((x) => x.fieldName).sort(byteOrder) : ["_creationTime", "_id"],
  }));
  return { byComponent: { "": tables } };
}

/**
 * Convex's `ListSnapshotArgs` and `DocumentDeltasArgs` (`SelectionArg` flattened into them, so read as a map
 * only): what their JSON body is checked against.
 */
const STREAMING_BODIES: Record<string, BodyShape> = {
  list_snapshot: {
    name: "ListSnapshotArgs",
    flatten: true,
    fields: [
      ["snapshot", { option: { int: "i64" } }],
      ["cursor", "optString"],
      ["format", "optString"],
    ],
  },
  document_deltas: {
    name: "DocumentDeltasArgs",
    flatten: true,
    fields: [
      ["cursor", { option: { int: "i64" } }],
      ["format", "optString"],
    ],
  },
};

/**
 * A request's arguments, as Convex's extractors read them: the query string (GET) or the JSON body (POST),
 * `snapshot` and `cursor` kept exact. Throws `QueryArgsError` or `BadJsonBody`.
 */
export async function streamingArgs(req: Request, url: URL): Promise<Record<string, unknown>> {
  const route = url.pathname.endsWith("document_deltas") ? "document_deltas" : "list_snapshot";
  if (req.method === "GET") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) {
      if (k === "snapshot" || (k === "cursor" && route === "document_deltas")) {
        const e = intError(v, "i64");
        if (e !== null) throw new QueryArgsError(`${k}: ${e}`);
      }
      out[k] = v;
    }
    return out;
  }
  const text = await req.text();
  checkJsonBody(req, text, STREAMING_BODIES[route]!);
  // Nanosecond timestamps exceed 2^53: read them as written.
  const exact = text.replace(/"(snapshot|cursor)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
  let body: unknown;
  try {
    body = JSON.parse(exact);
  } catch (e) {
    throw bad("BadJsonBody", (e as Error).message);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("BadJsonBody", "expected an object");
  return body as Record<string, unknown>;
}
