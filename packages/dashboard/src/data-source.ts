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

/**
 * The connection to the deployment, as Convex's dashboard tells it (`deploymentContext.tsx`, polled every 2.5 s):
 * `disconnected` once the socket was down at two checks in a row, `unknown` while that is not settled.
 */
export type ConnectionStatus = "connected" | "disconnected" | "unknown";

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
  /** Where its HTTP actions are served (Convex's "site" URL, `CONVEX_SITE_URL`), if the host wants it shown. */
  httpActionsUrl?: string;
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
  | "viewAuditLog"
  // UI-01 §17.2: Convex's PauseDeployment, UnpauseDeployment
  | "pauseDeployment"
  | "resumeDeployment"
  // STUDY-12 §10.3: Convex's ActAsUser — run functions as a user (the runner's "Act as a user")
  | "actAsUser"
  // UI-01 §19.2 (snapshots): Convex's ViewBackups, CreateBackups, DownloadBackups, ImportBackups
  | "viewBackups"
  | "createBackups"
  | "downloadBackups"
  | "importBackups";
export const OPERATIONS: readonly Operation[] = [
  "viewData",
  "writeData",
  "viewLogs",
  "viewMetrics",
  "runFunctions",
  "viewEnvironmentVariables",
  "writeEnvironmentVariables",
  "viewAuditLog",
  "actAsUser",
  "pauseDeployment",
  "resumeDeployment",
  "viewBackups",
  "createBackups",
  "downloadBackups",
  "importBackups",
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
  /** The rooms' gauges and counters; absent from a deployment without rooms (whose room methods reject `not_found`). */
  rooms?: RoomStats;
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

/**
 * An index as the Data screen's index list shows it: Convex's `_system/frontend/indexes` entry (dashboard-common's
 * `Index`, STUDY-149 "Index list"). `fields` is a database index's fields as stored (`_creationTime` last), a
 * search index's search and filter fields, or a vector index's vector field, filter fields and dimensions. `staged`:
 * declared `{ staged: true }`, built but not queryable. `backfill`: `backfilling` while the documents are added
 * (with the counts once known), `backfilled` built and staged, `done` built and enabled. `by_id` and
 * `by_creation_time` are not listed.
 */
export type IndexListEntry = {
  name: string;
  staged: boolean;
  fields:
    | string[]
    | { searchField: string; filterFields: string[] }
    | { vectorField: string; filterFields: string[]; dimensions: number };
  backfill: {
    state: "backfilling" | "backfilled" | "done";
    stats?: { numDocsIndexed: number; totalDocs: number | null };
  };
};

export type TableInfo = {
  name: string;
  /** System indexes (`by_id`, `by_creation_time`) first, then the declared ones. */
  indexes: IndexInfo[];
  /** Omitted when the source cannot count cheaply. */
  documentCount?: number;
  /** In the deployment's schema. A table can also exist only because documents were written to it. */
  declared: boolean;
  /**
   * The search indexes a filter can read (STUDY-163 §5), as Convex's filter offers them: the declared ones that
   * are not staged. Absent: the source has none to offer.
   */
  searchIndexes?: SearchIndexInfo[];
};

/**
 * A table's indexes as its schema declares them (Convex's schema JSON: `indexes`, `searchIndexes`, `vectorIndexes`
 * and their staged lists), for the schema's code (STUDY-162 §8). Database index fields as stored (`_creationTime`
 * last, as the schema JSON has them).
 */
export type DeclaredIndexes = {
  database: { name: string; fields: string[]; staged: boolean }[];
  search: { name: string; searchField: string; filterFields: string[]; staged: boolean }[];
  vector: { name: string; vectorField: string; dimensions: number; filterFields: string[]; staged: boolean }[];
};

/** A search index, as the filter reads it: the field it searches, and the fields it can filter on by equality. */
export type SearchIndexInfo = { name: string; searchField: string; filterFields: string[] };
export type SchemaInfo = {
  /** Whether documents are validated against the declared types. */
  enforced: boolean;
  /**
   * One entry per declared table. `validator` is the declared document type (STUDY-12 V2), in Convex's JSON
   * form, without the system fields; absent when the table is declared without one.
   */
  tables: { name: string; validator?: ValidatorJson; indexes?: DeclaredIndexes }[];
  /**
   * A schema being checked against the documents already stored (STUDY-12 §14.7), as Convex's
   * `getSchemas.schemaValidationProgress` (`numDocsValidated` / `totalDocs`, `totalDocs` unknown at first);
   * absent when none is. `failed`: the documents that do not match, how many and a few of them — Convex reports
   * the first one in the push's error; the count and the sample are a bunvex addition.
   */
  validation?: SchemaValidation;
};

export type SchemaValidation =
  | { state: "validating"; numDocsValidated: number; totalDocs: number | null }
  | { state: "failed"; failedDocs: number; sample: { table: string; id: string; error: string }[] };

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
 * follow Convex's value order (unset < null < int64 < number < boolean < string < bytes < array < object),
 * so an unset field passes `neq`, `lt`, `lte`, `noneOf` and `type: "unset"`; `anyOf` with no value filters
 * nothing; `type` / `notype` read the document's top-level field by that name (Convex's
 * `paginatedTableDocuments`, DV-479).
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

/**
 * A search index read (Convex's `SearchIndexFilter`, STUDY-163 §5): the text searched in its search field, and
 * equalities on its filter fields. Results come by relevance, so the expression's order is `asc`; an empty search
 * finds nothing, as a search query does.
 */
export type SearchFilter = {
  name: string;
  search: string;
  clauses: { field: string; value: Value; enabled: boolean }[];
};

/** Everything that selects and orders a table's documents. Serializable: it lives in the URL. */
export type FilterExpression = {
  /** Default: `by_creation_time`, unbounded. */
  index?: IndexFilter;
  /** A search index instead of `index` (never both); `clauses` then apply to its results. */
  search?: SearchFilter;
  clauses: FieldFilter[];
  /** The index order, ascending or descending. */
  order: "asc" | "desc";
};

export type PageRequest = {
  /**
   * A hint: a page may hold fewer items without being the last one (`isDone` decides). At most 32 000, as a
   * deployment's `paginate` reads (more is `invalid_request`, "Requested too many items").
   */
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
  /** Convex's `v.commitTs()`: an int64, the commit's timestamp. */
  | { type: "commitTs" }
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

/**
 * An HTTP action is a route of the app's router (Convex's `HttpAction`): listed and logged, never run by the
 * runner.
 */
export type FunctionKind = "query" | "mutation" | "action" | "httpAction";

export type FunctionInfo = {
  /** "module:name"; an HTTP action's is its route, "METHOD /path", as Convex names it in the logs. */
  path: string;
  kind: FunctionKind;
  /** The module it is defined in, when `path` does not say: an HTTP action's ("http", Convex's `http.js`). */
  module?: string;
  visibility: "public" | "internal";
  /** The declared arguments validator (STUDY-12 V1). Absent: none declared — any arguments are accepted. */
  args?: ValidatorJson;
  /** The declared return value validator. Absent: none declared. */
  returns?: ValidatorJson;
  /**
   * The line it is declared on in its module's source, when the push reported it (Convex's `lineno`): a module's
   * functions are listed in this order, as in Convex's Functions screen.
   */
  line?: number;
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
  /** The client that made the request (UI-01 §33), when it said who it is; absent for the system's runs. */
  client?: ClientInfo;
  /** On the line that ends an execution. */
  execution?: {
    status: "success" | "failure";
    durationMs: number;
    /** A query whose result came from the cache (Convex's `cachedResult`): the list says "(cached)", not its duration. */
    cached?: boolean;
    /** What it used (STUDY-12 §10.5), as far as the source measures it. */
    usage?: ExecutionUsage;
    /** Who started the request it belongs to. */
    identity?: ExecutionIdentity;
    /** Why it ran and where its trace is (STUDY-131 AD-27, a bunvex addition), when the source knows. */
    links?: ExecutionLinks;
  };
};

/**
 * Why an execution ran, as the subscriptions inspector names it (AD-25): an invalidation (a commit wrote into
 * what it read), or a run no invalidation caused.
 */
export type ExecutionRunReason = "invalidation" | "newSubscriber" | "identityChange" | "codeChange" | "retry";

/**
 * Where to look for why an execution ran (STUDY-131 AD-27, a bunvex addition). A server source maps these from
 * a Completion's `links` in `/api/stream_function_logs`, which the server sends only to the dashboard.
 */
export type ExecutionLinks = {
  /**
   * A live query's run: its entry in the subscriptions inspector (the line's function, these arguments), why
   * it ran, and the invalidation it answers, by its `seq` (the follow stream's) and commit ts. `invalidation`
   * is null for a run no invalidation caused, or when the inspector records none.
   */
  subscription?: {
    argsDigest: string;
    reason: ExecutionRunReason;
    invalidation: { seq: number; commitTs: number } | null;
  };
  /** The run's span, when it was traced (AD-26): ids as W3C Trace Context writes them, lowercase hex. */
  trace?: { traceId: string; spanId: string };
};

/** An execution's resources, as Convex's usage stats (each absent when not measured). */
export type ExecutionUsage = {
  /** Memory the execution used, in MB (with the duration: the compute). */
  memoryMb?: number;
  databaseReadBytes?: number;
  databaseWriteBytes?: number;
  fileReadBytes?: number;
  fileWriteBytes?: number;
  /** The size of the value it returned. */
  returnBytes?: number;
};

/**
 * Who started a request, as Convex's `identityType`: a developer with the admin key, a signed-in user, an
 * admin acting as a user (the runner's "Act as a user"), the system (the scheduler, crons), or unknown.
 */
export type ExecutionIdentity = "admin" | "user" | "acting_as_user" | "system" | "unknown";

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

/**
 * A user's identity to run a function as (STUDY-12 §10.3), as Convex's runner takes it: `subject` and
 * `issuer`, the OpenID claims (`name`, `email`, …), and any custom claims, flattened.
 */
export type UserIdentity = { subject: string; issuer: string } & Record<string, Value>;

/** `identity`: run as that user (`actAsUser`); without it, the function sees no user, as an admin's run. */
export type RunOptions = CallOptions & { identity?: UserIdentity };

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

import type { AuthFeatures } from "./data-source-auth.ts";
import type { AuthAdminFeatures } from "./data-source-auth-admin.ts";
import type { ClientInfo, ClientsFeatures } from "./data-source-clients.ts";
import type { MetricsFeatures } from "./data-source-metrics.ts";
import type { RoomStats, RoomsFeatures } from "./data-source-rooms.ts";
import type { SnapshotFeatures } from "./data-source-snapshot.ts";
import type { DeploymentStateFeatures } from "./data-source-state.ts";
import type { SubscriptionsFeatures } from "./data-source-subscriptions.ts";
import type { SystemTablesFeatures } from "./data-source-system-tables.ts";
import type { TopologyFeatures } from "./data-source-topology.ts";

export * from "./data-source-auth.ts";
export * from "./data-source-auth-admin.ts";
export * from "./data-source-clients.ts";
export * from "./data-source-deployment.ts";
export * from "./data-source-metrics.ts";
export * from "./data-source-rooms.ts";
export * from "./data-source-snapshot.ts";
export * from "./data-source-state.ts";
export * from "./data-source-subscriptions.ts";
export * from "./data-source-system-tables.ts";
export * from "./data-source-topology.ts";

import type { ExtensionFeatures } from "./extensions/index.ts";

export interface DashboardDataSource
  extends DeploymentFeatures,
    DeploymentStateFeatures,
    MetricsFeatures,
    AuthFeatures,
    AuthAdminFeatures,
    SnapshotFeatures,
    TopologyFeatures,
    RoomsFeatures,
    SubscriptionsFeatures,
    SystemTablesFeatures,
    ClientsFeatures,
    ExtensionFeatures {
  getDeployment(opts?: CallOptions): Promise<DeploymentInfo>;
  getCapabilities(opts?: CallOptions): Promise<Capabilities>;
  getStats(opts?: CallOptions): Promise<DeploymentStats>;
  /** Pushes a fresh sample whenever the source has one (an implementation may poll). Never synchronously. */
  watchStats(onStats: (stats: DeploymentStats) => void, onError: (error: DataSourceError) => void): Unsubscribe;
  /**
   * Tells the caller how the connection to the deployment stands, at each change (the first one included). The
   * dashboard covers the screens while `disconnected`, and stops its polled reads until the connection is back,
   * as Convex's. Never synchronously. Optional; a source without it is always connected (the mock).
   */
  watchConnection?(onStatus: (status: ConnectionStatus) => void): Unsubscribe;

  listTables(opts?: CallOptions): Promise<TableInfo[]>;
  getSchema(opts?: CallOptions): Promise<SchemaInfo>;
  listDocuments(query: DocumentQuery, opts?: CallOptions): Promise<Page<Document>>;
  /** `null` when the table exists but the document does not; `not_found` when the table does not exist. */
  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null>;
  /**
   * Tells the caller the table list may have changed (a table created or deleted, by a push, a write or the
   * dashboard), as Convex's Data screen keeps the table mapping subscribed (`getTableMapping`). The dashboard
   * then lists the tables again. Never synchronously. Optional; without it, the list is read again when a watched
   * table changes.
   */
  watchTables?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;
  /**
   * A table's index list, live, as Convex's dashboard keeps `_system/frontend/indexes` subscribed: `onIndexes` with
   * the list, then again whenever it changes (an index a push adds, stages or enables; a backfill's progress); null
   * for a table that does not exist. Never synchronously. Without it, the index list shows `TableInfo.indexes`.
   */
  watchIndexes?(
    table: string,
    onIndexes: (indexes: IndexListEntry[] | null) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
  /**
   * Tells the caller a table changed — a write committed — with its new count when the source knows it.
   * The dashboard then refreshes what it shows. Never synchronously; coalescing several writes is allowed.
   */
  watchTable(
    table: string,
    onChange: (change: { count?: number }) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;

  // Writes: present when the source can write; allowed when `writeData` is granted and not `readOnly`. Their
  // rules are Convex's Data screen mutations (`_system/frontend/addDocument`, …; STUDY-149 PR 3, DV-479: where
  // this contract and Convex differ, the contract follows Convex). A refusal the deployment explains (a field
  // name, the schema, a read-only system table) is `invalid_request` with its words.
  /**
   * All or nothing, at most 4 096 documents (more is `invalid_request`). A table that does not exist yet is
   * created, as Convex's `db.insert` creates it. Convex's mutation answers no ids, so neither does this.
   */
  insertDocuments?(table: string, documents: Record<string, Value>[], opts?: CallOptions): Promise<void>;
  /**
   * Every id must exist (an id of a document that is gone: `not_found`; one that is not an id:
   * `invalid_request`; nothing written either way). `_id` and `_creationTime` may only be given their own values.
   */
  patchDocuments?(table: string, ids: string[], fields: Record<string, FieldPatch>, opts?: CallOptions): Promise<void>;
  /**
   * Sets or removes `fields` in every document of the table (the screen's "Edit all"), in one transaction, as
   * Convex's bulk edit (`patchDocumentsFields` without ids): all or nothing, with no filter and no pages. A table
   * past what one transaction may read is refused (`invalid_request`, the deployment's words; 4 093 documents
   * with the default limits), nothing written. A table that does not exist has nothing to edit: no error.
   */
  patchAllDocuments?(table: string, fields: Record<string, FieldPatch>, opts?: CallOptions): Promise<void>;
  /** Keeps `_id` and `_creationTime`; replaces every other field. A document that is gone: `not_found`. */
  replaceDocument?(table: string, id: string, document: Record<string, Value>, opts?: CallOptions): Promise<void>;
  /**
   * At most 4 096 ids (more is `invalid_request`). All or nothing: an id of a document that is gone fails the call
   * (`not_found`), as Convex's `db.delete`.
   */
  deleteDocuments?(table: string, ids: string[], opts?: CallOptions): Promise<void>;
  /**
   * Deletes every document of the table, oldest first, in pages of 4 000 (one transaction each, as Convex's
   * `clearTablePage`); an abort stops between pages, the table partly cleared. Documents written meanwhile may
   * stay. An unknown table: `not_found`.
   */
  clearTable?(table: string, opts?: CallOptions): Promise<{ deleted: number }>;

  /**
   * Creates an empty table (STUDY-12 D11), not in the schema until declared there, as Convex's dashboard does: a
   * mutation that inserts a document and deletes it. A name that is not an identifier (letters, digits, `_`; not
   * starting with a digit; at most 64), or a system table's (`_`), is `invalid_request`. A taken name is not
   * refused (the screen refuses it, as Convex's form does), unless the table's declared document type refuses
   * an empty document.
   */
  createTable?(name: string, opts?: CallOptions): Promise<void>;
  /**
   * Deletes whole tables, their documents and indexes, in one transaction (Convex's `/api/delete_tables`). A
   * table the schema declares (or points to with `v.id`) is `invalid_request`; a name with no table is skipped.
   */
  deleteTables?(names: string[], opts?: CallOptions): Promise<void>;

  /**
   * A document type every document in the table fits (STUDY-12 D11, the "Generated" schema), in Convex's
   * JSON form without system fields — what Convex computes as the table's shape. Null when the table is
   * empty; an unknown table is `not_found`.
   */
  inferDocumentType?(table: string, opts?: CallOptions): Promise<ValidatorJson | null>;

  /**
   * The table a document id belongs to (STUDY-12 D11: "Go to reference"), or null when no table has it — what
   * Convex's dashboard reads off the id with its table mapping (`getReferencedTableName`). Besides the user tables,
   * a file's id is in `_file_storage` and a scheduled run's in `_scheduled_jobs`, the names Convex's mapping gives
   * them (STUDY-163 §2); "Go to reference" opens Files and the scheduled functions for them. Optional; without it,
   * ids are plain text.
   */
  tableOfId?(id: string, opts?: CallOptions): Promise<string | null>;

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]>;
  /**
   * Runs a function once, as the dashboard's function runner does: present when the source can; allowed
   * when `runFunctions` is granted (a read-only credential runs queries only). Unknown path: `not_found`;
   * not allowed: `unauthorized`. The run is logged like any other execution.
   */
  runFunction?(path: string, args: Record<string, Value>, opts?: RunOptions): Promise<FunctionRun>;

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
    opts?: Pick<RunOptions, "identity">,
  ): Unsubscribe;

  /**
   * Tells the caller the deployed functions may have changed (a push), as Convex's dashboard keeps its module list
   * subscribed (`modules:listForAllComponents`). The dashboard then lists them again. Never synchronously.
   * Optional; without it, the list is read when a screen opens.
   */
  watchFunctions?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;

  /**
   * Runs a query written in the dashboard once, as Convex's runner runs its "Custom test query"
   * (`/api/run_test_function`): `code` is a JavaScript module (the screen compiles the TypeScript typed, as Convex's
   * does) whose default export is a query; `query` and `internalQuery` are in scope, the source imports them. It
   * runs with no arguments, against the deployment's data, and changes nothing. What it returns or throws comes
   * back as a run, with the lines it logged; so does a module that does not load (its error), as in Convex's
   * runner. Rejects only when the call cannot be made (`unauthorized`, `unavailable`). Allowed with
   * `runFunctions` (Convex's `RunTestQuery`), read-only credentials included. Optional.
   */
  runTestQuery?(code: string, opts?: CallOptions): Promise<FunctionRun>;

  listLogs(query: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>>;
  /** Live tail: entries created after the call, in id order, matching the filter. Never synchronously. */
  watchLogs(
    filter: LogFilter,
    onEntries: (entries: LogEntry[]) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
}
