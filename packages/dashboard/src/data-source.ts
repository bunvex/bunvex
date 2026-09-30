// The contract between the dashboard and whatever serves its data (UI-01 §5, v2 in §12.4). Plain types and
// one error class — no React and no bunvex import — so an implementation can live anywhere: an HTTP client
// in the browser, a cloud API client, the mock. The semantics every implementation must keep are checked
// by `describeDataSourceContract` (@bunvex/dashboard/contract).

// ------------------------------------------------------------------ values

/** Plain JSON. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A 64-bit integer: its 8 bytes, little-endian two's complement, in base64. */
export type EncodedInt64 = { $integer: string };
/** Bytes, in base64. */
export type EncodedBytes = { $bytes: string };

/**
 * A document value. JSON, plus the two encodings for what JSON cannot carry. Field names never start with
 * `$`, so an object with a single `$integer` or `$bytes` key is always an encoding. A field a document
 * does not have is absent — "unset" — which is not the same as `null`.
 */
export type Value = null | boolean | number | string | EncodedInt64 | EncodedBytes | Value[] | { [key: string]: Value };

/** The type names a `type` / `notype` filter tests for. `unset` is a field the document does not have. */
export type ValueType = "null" | "boolean" | "number" | "int64" | "string" | "bytes" | "array" | "object" | "unset";
export const VALUE_TYPES: readonly ValueType[] = [
  "null",
  "boolean",
  "number",
  "int64",
  "string",
  "bytes",
  "array",
  "object",
  "unset",
];

/** A document. System fields as in Convex: `_id` (unique in its table) and `_creationTime` (ms). */
export type Document = { _id: string; _creationTime: number; [field: string]: Value };

export type CallOptions = { signal?: AbortSignal };
export type Unsubscribe = () => void;

// ------------------------------------------------------------------ deployment and capabilities

export type DeploymentInfo = {
  /** Shown in the header; "local" for a self-hosted development server. */
  name: string;
  /** The server's version. */
  version: string;
  /** Where the engine keeps its data: "memory", "sqlite", "postgres", … (free text). */
  persistence: string;
  /** The deployment's client URL, if the host wants it shown. */
  url?: string;
};

/** What the caller may do. The dashboard gates screens and buttons on it; the source enforces it. */
export type Operation =
  | "viewData"
  | "writeData"
  | "viewLogs"
  | "viewMetrics"
  | "runFunctions"
  // UI-01 §14: Convex's ViewEnvironmentVariables, WriteEnvironmentVariables, ViewAuditLog
  | "viewEnvironmentVariables"
  | "writeEnvironmentVariables"
  | "viewAuditLog";
export const OPERATIONS: readonly Operation[] = [
  "viewData",
  "writeData",
  "viewLogs",
  "viewMetrics",
  "runFunctions",
  "viewEnvironmentVariables",
  "writeEnvironmentVariables",
  "viewAuditLog",
];

export type Capabilities = {
  operations: Operation[];
  /** A read-only credential: no write succeeds, whatever `operations` says. */
  readOnly: boolean;
};

/** A point-in-time sample of the counters the server keeps. Counters are totals since the server started. */
export type DeploymentStats = {
  /** Wall-clock ms when sampled. */
  at: number;
  /** The latest visible commit timestamp. */
  commitTs: number;
  commitGroups: number;
  conflicts: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  /** Live subscriptions now. */
  subscriptions: number;
  subscriptionReruns: number;
  /** Updates published to subscribers. */
  subscriptionUpdates: number;
};

// ------------------------------------------------------------------ tables, schema, indexes

export type IndexInfo = {
  name: string;
  fields: string[];
  /** `by_id` and `by_creation_time`, which every table has. */
  system: boolean;
  /** A new index is `backfilling` until every existing document is in it; only `ready` ones can be queried. */
  state: "ready" | "backfilling";
  progress?: { indexed: number; total?: number };
};

export type TableInfo = {
  name: string;
  /** System indexes (`by_id`, `by_creation_time`) first, then the declared ones. */
  indexes: IndexInfo[];
  /** Omitted when the source cannot count cheaply. */
  documentCount?: number;
  /** In the deployment's schema. A table can also exist only because documents were written to it. */
  declared: boolean;
};

export type SchemaInfo = {
  /** Whether documents are validated against the declared types. */
  enforced: boolean;
  /**
   * One entry per declared table. `validator` is the declared document type (STUDY-12 V2), in Convex's JSON
   * form, without the system fields; absent when the table is declared without one.
   */
  tables: { name: string; validator?: ValidatorJson }[];
};

// ------------------------------------------------------------------ filters and pages

export type FieldOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "anyOf" | "noneOf" | "type" | "notype";
export const FIELD_OPS: readonly FieldOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "anyOf",
  "noneOf",
  "type",
  "notype",
];

/**
 * A condition on one field, applied to the documents the index range yields. `value` is a Value for the
 * comparisons, an array of Values for `anyOf` / `noneOf`, a ValueType for `type` / `notype`. Comparisons
 * follow the value order (null < int64 < number < boolean < string < bytes < array < object); an unset
 * field only matches `neq`, `noneOf` and `type: "unset"`.
 */
export type FieldFilter = {
  /** Stable within the expression; errors name the clause by it. */
  id: string;
  field: string;
  op: FieldOp;
  value?: Value | Value[] | ValueType;
  /** A disabled clause is kept (the UI shows it) but not applied. */
  enabled: boolean;
};

/**
 * Which part of an index to read. `eq` fixes the index's leading fields in order (a prefix); `range`
 * bounds the field right after them. Disabled `eq` clauses may only trail the enabled ones.
 */
export type IndexFilter = {
  name: string;
  eq: { value: Value; enabled: boolean }[];
  range?: { lower?: { op: "gt" | "gte"; value: Value }; upper?: { op: "lt" | "lte"; value: Value } };
};

/** Everything that selects and orders a table's documents. Serializable: it lives in the URL. */
export type FilterExpression = {
  /** Default: `by_creation_time`, unbounded. */
  index?: IndexFilter;
  clauses: FieldFilter[];
  /** The index order, ascending or descending. */
  order: "asc" | "desc";
};

export type PageRequest = {
  /** A hint: a page may hold fewer items without being the last one (`isDone` decides). */
  numItems: number;
  /** `null` starts; then the previous page's `continueCursor`. */
  cursor: string | null;
};

/** Convex's pagination result, so a server can pass its paginate() through. */
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

export type DocumentQuery = PageRequest & {
  table: string;
  /** Default: every document, newest first. */
  filter?: FilterExpression;
};

// ------------------------------------------------------------------ validators (STUDY-12 V1–V2)

/**
 * A validator in Convex's JSON form (what `v.*` validators serialize to, `Validator.json`): how functions'
 * arguments and return values, and the schema's document types, reach the dashboard. A `literal`'s value is
 * JSON, with an int64 as `{ $integer }` as elsewhere; `record` keys are `string`, `id` or a union of them.
 */
export type ValidatorJson =
  | { type: "null" }
  | { type: "number" }
  | { type: "bigint" }
  | { type: "boolean" }
  | { type: "string" }
  | { type: "bytes" }
  | { type: "any" }
  | { type: "literal"; value: Json | EncodedInt64 }
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJson }
  | { type: "record"; keys: ValidatorJson; values: { fieldType: ValidatorJson; optional: false } }
  | { type: "object"; value: Record<string, ObjectFieldJson> }
  | { type: "union"; value: ValidatorJson[] };

export type ObjectFieldJson = { fieldType: ValidatorJson; optional: boolean };

// ------------------------------------------------------------------ functions and logs

export type FunctionKind = "query" | "mutation" | "action";

export type FunctionInfo = {
  /** "module:name". */
  path: string;
  kind: FunctionKind;
  visibility: "public" | "internal";
  /** The declared arguments validator (STUDY-12 V1). Absent: none declared — any arguments are accepted. */
  args?: ValidatorJson;
  /** The declared return value validator. Absent: none declared. */
  returns?: ValidatorJson;
};

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogEntry = {
  /** Unique and ordered: a later entry has a greater id (compared as strings). */
  id: string;
  /** Wall-clock ms. */
  time: number;
  level: LogLevel;
  message: string;
  function?: { path: string; kind: FunctionKind };
  /** Groups the lines of one request: a call from a client, and every function it runs. */
  requestId?: string;
  /**
   * The execution (one function running once) the line belongs to; a request runs one, or more when an action
   * calls other functions (STUDY-12 L6, the call tree).
   */
  executionId?: string;
  /** The execution that called this one, in the same request; absent for the request's first. */
  parentExecutionId?: string;
  /** On the line that ends an execution. */
  execution?: { status: "success" | "failure"; durationMs: number };
};

/**
 * What running a function from the dashboard gave (STUDY-12 §7): its value, or the error it threw, with the
 * lines it logged. A function that throws is a result, not a rejected call; `runFunction` rejects only when
 * the call could not be made (no such function, not allowed, unavailable).
 */
export type FunctionRun = {
  /** Its return value (`undefined` comes back as `null`). Absent when it threw. */
  value?: Value;
  /** When it threw: the message, and a ConvexError's data. */
  error?: { message: string; data?: Value };
  /** Oldest first. */
  logLines: { level: LogLevel; message: string }[];
  durationMs: number;
};

export type LogFilter = { function?: string; levels?: LogLevel[] };

/** Newest first; the cursor walks back in time. */
export type LogQuery = PageRequest & LogFilter;

// ------------------------------------------------------------------ errors

export type DataSourceErrorCode = "unauthorized" | "not_found" | "invalid_request" | "unavailable";

/**
 * What a source throws. Anything else is treated as `unavailable`; an abort rejects with the signal's
 * reason. An invalid filter names the offending clause (`details.clause`, a FieldFilter id, or "index").
 */
export class DataSourceError extends Error {
  override readonly name = "DataSourceError";
  constructor(
    readonly code: DataSourceErrorCode,
    message: string,
    readonly details: { clause?: string } = {},
  ) {
    super(message);
  }
}

/** Normalises anything a source threw into a DataSourceError. */
export const toDataSourceError = (e: unknown): DataSourceError =>
  e instanceof DataSourceError ? e : new DataSourceError("unavailable", e instanceof Error ? e.message : String(e));

export const isAbortError = (e: unknown) => e instanceof Error && e.name === "AbortError";

// ------------------------------------------------------------------ the interface

import type { DeploymentFeatures } from "./data-source-deployment.ts";

/** A field update in `patchDocuments`: a new value, or removing the field. */
export type FieldPatch = Value | { $unset: true };

export * from "./data-source-deployment.ts";

export interface DashboardDataSource extends DeploymentFeatures {
  getDeployment(opts?: CallOptions): Promise<DeploymentInfo>;
  getCapabilities(opts?: CallOptions): Promise<Capabilities>;
  getStats(opts?: CallOptions): Promise<DeploymentStats>;
  /** Pushes a fresh sample whenever the source has one (an implementation may poll). Never synchronously. */
  watchStats(onStats: (stats: DeploymentStats) => void, onError: (error: DataSourceError) => void): Unsubscribe;

  listTables(opts?: CallOptions): Promise<TableInfo[]>;
  getSchema(opts?: CallOptions): Promise<SchemaInfo>;
  listDocuments(query: DocumentQuery, opts?: CallOptions): Promise<Page<Document>>;
  /** `null` when the table exists but the document does not; `not_found` when the table does not exist. */
  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null>;
  /**
   * Tells the caller a table changed — a write committed — with its new count when the source knows it.
   * The dashboard then refreshes what it shows. Never synchronously; coalescing several writes is allowed.
   */
  watchTable(
    table: string,
    onChange: (change: { count?: number }) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;

  // Writes: present when the source can write; allowed when `writeData` is granted and not `readOnly`.
  /** All or nothing. Returns the new ids, in order. */
  insertDocuments?(table: string, documents: Record<string, Value>[], opts?: CallOptions): Promise<string[]>;
  /** Every id must exist (else `not_found`, nothing written). System fields cannot be patched. */
  patchDocuments?(table: string, ids: string[], fields: Record<string, FieldPatch>, opts?: CallOptions): Promise<void>;
  /** Keeps `_id` and `_creationTime`; replaces every other field. */
  replaceDocument?(table: string, id: string, document: Record<string, Value>, opts?: CallOptions): Promise<void>;
  /** Ids that do not exist are ignored. */
  deleteDocuments?(table: string, ids: string[], opts?: CallOptions): Promise<void>;
  /** Deletes every document of the table (the source may do it in several transactions). */
  clearTable?(table: string, opts?: CallOptions): Promise<{ deleted: number }>;

  /**
   * Creates an empty table (STUDY-12 D11), not in the schema until declared there. A name that is taken, or
   * not an identifier (letters, digits, `_`; not starting with a digit or `_`; at most 64): `invalid_request`.
   * Convex's dashboard does it with a mutation that inserts a document and deletes it.
   */
  createTable?(name: string, opts?: CallOptions): Promise<void>;

  /**
   * A document type every document in the table fits (STUDY-12 D11, the "Generated" schema), in Convex's
   * JSON form without system fields — what Convex computes as the table's shape. Null when the table is
   * empty; an unknown table is `not_found`.
   */
  inferDocumentType?(table: string, opts?: CallOptions): Promise<ValidatorJson | null>;

  /**
   * The table a document id belongs to (STUDY-12 D11: "Go to reference"), or null when no table has it — what
   * Convex's dashboard reads off the id with its table mapping. Optional; without it, ids are plain text.
   */
  tableOfId?(id: string, opts?: CallOptions): Promise<string | null>;

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]>;
  /**
   * Runs a function once, as the dashboard's function runner does: present when the source can; allowed
   * when `runFunctions` is granted (a read-only credential runs queries only). Unknown path: `not_found`;
   * not allowed: `unauthorized`. The run is logged like any other execution.
   */
  runFunction?(path: string, args: Record<string, Value>, opts?: CallOptions): Promise<FunctionRun>;

  /**
   * Keeps a query subscribed, as Convex's runner does (STUDY-12 §10, R1): `onResult` gets its run
   * (asynchronously, never inside the call), then a new one each time the result may have changed. Same
   * permissions and errors as `runFunction`, delivered to `onError`; a mutation or an action is
   * `invalid_request`. Optional; without it, the runner runs a query once.
   */
  watchFunction?(
    path: string,
    args: Record<string, Value>,
    onResult: (run: FunctionRun) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;

  listLogs(query: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>>;
  /** Live tail: entries created after the call, in id order, matching the filter. Never synchronously. */
  watchLogs(
    filter: LogFilter,
    onEntries: (entries: LogEntry[]) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
}
