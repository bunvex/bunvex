// Streaming export (STUDY-60), Convex's legacy connector API (crates/local_backend/src/streaming_export.rs,
// crates/database/src/database.rs `list_snapshot` / `document_deltas`, crates/common/src/json_schemas):
// `GET|POST /api/list_snapshot`, `GET|POST /api/document_deltas`, `GET /api/json_schemas`,
// `GET /api/get_table_column_names`, `GET /api/test_streaming_export_connection`; `ViewData`. Timestamps are
// nanoseconds on the wire (bunvex's are microseconds); documents in one of three JSON encodings.

import type { DashboardShape } from "@bunvex/core";
import {
  type Engine,
  hasRetention,
  OutOfRetentionError,
  reduceShape,
  shapeOf,
  type TableDef,
  UnionBuilder,
} from "@bunvex/core";
import { formatExportFloat, fromJsonValue, type JSONValue, type Value } from "@bunvex/values";

/** Convex's knobs. */
export const SNAPSHOT_LIST_LIMIT = 1024;
export const DOCUMENT_DELTAS_LIMIT = 128;
const LIST_SNAPSHOT_MAX_AGE_NS = 5n * 24n * 3600n * 1_000_000_000n;

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

/** Convex's `ValueFormat`: `json` (clean), `convex_encoded_json`, `export_json`. */
export type Format = "clean" | "encoded" | "export";

/**
 * The `format` argument: `json`, `encoded_json` or `export_json`. Convex's names for the encoded form (and its
 * legacy aliases) carry its name, so bunvex answers them as unknown formats (rule 5, DV-307).
 */
export function parseFormat(s: string | null | undefined): Format {
  if (s === undefined || s === null || s === "json") return "clean";
  if (s === "encoded_json") return "encoded";
  if (s === "export_json") return "export";
  throw bad("BadFormat", `format param must be one of [\`json\`]. Got ${s}`);
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
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

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
  if (v instanceof ArrayBuffer) {
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
type Columns = Record<string, Inclusion> & { _other: Inclusion };
type Tables = Record<string, Columns | "excluded"> & { _other: Inclusion | Columns };
/** Convex's `Selection`: per component path (`""` the root), per table, per column. */
export type Selection = Record<string, Tables | Inclusion> & { _other: Inclusion };

const normInclusion = (v: unknown): Inclusion | null =>
  v === "included" || v === "incl" ? "included" : v === "excluded" || v === "excl" ? "excluded" : null;

/** Convex's `SelectionArg`: an exact `selection`, a `tableName` (in a `component`), a `component`, or everything. */
export function selectionOf(args: Record<string, unknown>): Selection {
  if (args.selection !== undefined) return checkSelection(args.selection);
  const table = (args.tableName ?? args.table_name) as string | undefined;
  const component = (args.component as string | undefined) ?? "";
  if (table !== undefined)
    return { _other: "excluded", [component]: { _other: "excluded", [table]: { _other: "included" } } } as Selection;
  if (args.component !== undefined) return { _other: "excluded", [component]: { _other: "included" } } as Selection;
  return { _other: "included" };
}

function checkSelection(raw: unknown): Selection {
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
function tableSelection(s: Selection, table: string): Columns | null {
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

function pickColumns(doc: Record<string, Value>, cols: Columns): Record<string, Value> {
  if (cols._other === "included" && Object.keys(cols).length === 1) return doc;
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(doc)) if (k === "_id" || (cols[k] ?? cols._other) === "included") out[k] = v;
  return out;
}

// ---------------------------------------------------------------- the routes

type Deps = { engine: Engine };

/** The user tables a stream reads: active and hidden (an import's), not system ones, by tablet. */
function streamedTables(engine: Engine): TableDef[] {
  const c = engine.catalog;
  return [...c.tables.values(), ...c.hidden.values()]
    .filter((t) => !t.name.startsWith("_"))
    .sort((a, b) => a.id - b.id);
}

/** `list_snapshot`: one table's documents at `snapshot`, by id, a page at a time. */
export async function listSnapshot(deps: Deps, args: Record<string, unknown>): Promise<string> {
  const { engine } = deps;
  const f = parseFormat(args.format as string | undefined);
  const selection = selectionOf(args);
  const nowUs = engine.committer.visibleTs;
  let snapshotNs: bigint;
  if (args.snapshot === undefined || args.snapshot === null) snapshotNs = BigInt(nowUs) * 1000n;
  else {
    snapshotNs = BigInt(args.snapshot as string);
    if (snapshotNs > BigInt(nowUs) * 1000n)
      throw bad("SnapshotTooNew", `Snapshot value ${snapshotNs} is in the future.`);
    if (BigInt(nowUs) * 1000n - snapshotNs > LIST_SNAPSHOT_MAX_AGE_NS) throw tooOld(snapshotNs);
  }
  const snapshotUs = Number(snapshotNs / 1000n);
  let cursor: { tablet: number; id: string | null } | null = null;
  if (args.cursor !== undefined && args.cursor !== null) {
    try {
      const c = JSON.parse(args.cursor as string) as { tablet: unknown; id: unknown };
      if (typeof c.tablet !== "number" || (c.id !== null && typeof c.id !== "string")) throw new Error();
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
    .filter((x) => x.cols !== null && (cursor === null || x.t.id >= cursor.tablet));
  const out = (values: string[], next: string | null) =>
    `{"values":[${values.join(",")}],"snapshot":${snapshotNs},"cursor":${next === null ? "null" : JSON.stringify(next)},"hasMore":${next !== null}}`;
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
      snapshotUs,
    )) as Record<string, Value>[];
  } catch (e) {
    if (e instanceof OutOfRetentionError) throw tooOld(snapshotNs);
    throw e;
  }
  // Each document as of the snapshot; `_ts` is the snapshot (DV-306).
  const values = page.map((d) => docJson(t.name, snapshotNs, null, pickColumns(d, cols!), f));
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
  const f = parseFormat(args.format as string | undefined);
  const selection = selectionOf(args);
  const cursorNs = BigInt(args.cursor as string);
  if (cursorNs < 0n) throw new Error("negative cursor");
  const cursorUs = Number(cursorNs / 1000n);
  const store = engine.persistence;
  if (!hasRetention(store)) throw new Error("this persistence has no document log");
  const upperUs = engine.committer.visibleTs;
  const values: string[] = [];
  let rowsRead = 0;
  let after = cursorUs;
  let newCursor: number | null = null;
  let hasMore = false;
  outer: for (;;) {
    const rows = await store.readDocumentLog(after, upperUs, 16);
    if (rows.length === 0) break;
    const commits = new Map<number, typeof rows>();
    for (const r of rows) (commits.get(r.ts) ?? commits.set(r.ts, []).get(r.ts)!).push(r);
    for (const [ts, commit] of [...commits].sort(([a], [b]) => a - b)) {
      if (newCursor !== null) {
        hasMore = true;
        break outer;
      }
      commit.sort((a, b) => a.table - b.table || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const r of commit) {
        rowsRead++;
        const t = engine.catalog.byTablet(r.table);
        if (!t || t.name.startsWith("_") || engine.catalog.deleting.has(r.table)) continue;
        const cols = tableSelection(selection, t.name);
        if (!cols) continue;
        const tsNs = BigInt(ts) * 1000n;
        if (r.deleted) values.push(docJson(t.name, tsNs, true, { _id: r.id }, f));
        else {
          const json = await store.get(r.table, r.id, ts);
          if (json === null) continue;
          const doc = fromJsonValue(JSON.parse(json) as JSONValue) as Record<string, Value>;
          values.push(docJson(t.name, tsNs, false, pickColumns(doc, cols), f));
        }
      }
      if (rowsRead >= DOCUMENT_DELTAS_LIMIT || values.length >= DOCUMENT_DELTAS_LIMIT) newCursor = ts;
      after = ts;
    }
  }
  // Convex's `validate_document_snapshot`, after the read: the range must still be in the document window.
  const minDoc = engine.retention?.minDocumentTs ?? 0;
  if (cursorNs + 1n < BigInt(minDoc) * 1000n)
    throw bad(
      "InvalidWindowToReadDocuments",
      `Trying to synchronize from timestamp ${cursorNs + 1n}, which is older than the database’s retention window. This may happen if you paused your Fivetran or Airbyte connector for a long period of time. Please perform a full sync of the connector. See https://fivetran.com/docs/connectors/troubleshooting/trigger-historical-re-syncs or https://docs.airbyte.com/platform/operator-guides/refreshes`,
    );
  const cursorOut = hasMore ? BigInt(newCursor!) * 1000n : BigInt(upperUs) * 1000n;
  return `{"values":[${values.join(",")}],"cursor":${cursorOut},"hasMore":${hasMore}}`;
}

// ---------------------------------------------------------------- shapes: json_schemas, column names

/** Each streamed user table's reduced shape now (computed from its documents, as `/api/shapes2`). */
async function shapes(engine: Engine): Promise<{ name: string; shape: DashboardShape }[]> {
  const at = engine.committer.visibleTs;
  const byNumber = new Map([...engine.catalog.tables.values()].map((t) => [t.number, t.name]));
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
    out.push({ name: t.name, shape: reduceShape(b.build(), (n) => byNumber.get(n)) });
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

/** `json_schemas`: each active user table's JSON Schema, from its inferred shape. */
export async function jsonSchemas(deps: Deps, q: URLSearchParams): Promise<unknown> {
  const bool = (k: string) => {
    const v = q.get(k);
    if (v === null) return false;
    if (v !== "true" && v !== "false") throw bad("BadQueryArgs", `${k}: provided string was not \`true\` or \`false\``);
    return v === "true";
  };
  const delta = bool("deltaSchema");
  const byComponent = bool("byComponent");
  const f = parseFormat(q.get("format"));
  const out: Record<string, unknown> = {};
  for (const { name, shape } of await shapes(deps.engine)) {
    let schema: Record<string, unknown>;
    if (shape.type === "Never")
      schema = {
        type: "object",
        properties: { _creationTime: { type: "number" }, _id: { $description: `Id(${name})`, type: "string" } },
        additionalProperties: false,
        required: ["_creationTime", "_id"],
      };
    else if (shape.type === "Object") schema = shapeSchema(shape, f) as Record<string, unknown>;
    // Unreachable with reduced shapes (a table's objects are merged into one); Convex falls back to the schema.
    else throw bad("NoSchemaForExport", "There is no active schema, which is needed for streaming export.");
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

/** A request's arguments: the query string (GET) or the JSON body (POST), `snapshot` and `cursor` kept exact. */
export async function streamingArgs(req: Request, url: URL): Promise<Record<string, unknown>> {
  const intArg = (k: string, v: string) => {
    if (!/^-?\d+$/.test(v)) throw bad("BadQueryArgs", `${k}: invalid digit found in string`);
    return v;
  };
  if (req.method === "GET") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams)
      out[k] = k === "snapshot" || (k === "cursor" && url.pathname.endsWith("document_deltas")) ? intArg(k, v) : v;
    return out;
  }
  const text = await req.text();
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
