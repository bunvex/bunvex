// The contract between the dashboard and whatever serves its data (UI-01 §5). Plain types and one error
// class — no React and no bunvex import — so an implementation can live anywhere: an HTTP client in the
// browser, a cloud API client, the mock. The semantics every implementation must keep are UI-01 §5.1 and
// are checked by `describeDataSourceContract` (@bunvex/dashboard/contract).

/** Document values as the dashboard shows them. v0 is JSON; richer values arrive with @bunvex/values. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A document. System fields as in Convex: `_id` (unique in its table) and `_creationTime` (ms). */
export type Document = { _id: string; _creationTime: number; [field: string]: Json };

export type CallOptions = { signal?: AbortSignal };
export type Unsubscribe = () => void;

// ------------------------------------------------------------------ deployment

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

// ------------------------------------------------------------------ tables and documents

export type IndexInfo = { name: string; fields: string[]; system: boolean };

export type TableInfo = {
  name: string;
  /** System indexes (`by_id`, `by_creation_time`) first, then the declared ones. */
  indexes: IndexInfo[];
  /** Omitted when the source cannot count cheaply. */
  documentCount?: number;
};

export type PageRequest = {
  /** A hint: a page may hold fewer items without being the last one. */
  numItems: number;
  /** `null` starts; then the previous page's `continueCursor`. */
  cursor: string | null;
};

/** Convex's pagination result, so a server can pass its paginate() through. */
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

export type DocumentQuery = PageRequest & {
  table: string;
  /** Default "by_creation_time". */
  index?: string;
  /** Default "desc". */
  order?: "asc" | "desc";
};

// ------------------------------------------------------------------ functions

export type FunctionKind = "query" | "mutation" | "action";

export type FunctionInfo = {
  /** "module:name". */
  path: string;
  kind: FunctionKind;
  visibility: "public" | "internal";
};

// ------------------------------------------------------------------ logs

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
  /** Groups the lines of one execution. */
  requestId?: string;
  /** On the line that ends an execution. */
  execution?: { status: "success" | "failure"; durationMs: number };
};

export type LogFilter = { function?: string; levels?: LogLevel[] };

/** Newest first; the cursor walks back in time. */
export type LogQuery = PageRequest & LogFilter;

// ------------------------------------------------------------------ errors

export type DataSourceErrorCode = "unauthorized" | "not_found" | "invalid_request" | "unavailable";

/** What a source throws. Anything else is treated as `unavailable`; an abort rejects with the signal's reason. */
export class DataSourceError extends Error {
  override readonly name = "DataSourceError";
  constructor(
    readonly code: DataSourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Normalises anything a source threw into a DataSourceError. */
export const toDataSourceError = (e: unknown): DataSourceError =>
  e instanceof DataSourceError ? e : new DataSourceError("unavailable", e instanceof Error ? e.message : String(e));

export const isAbortError = (e: unknown) => e instanceof Error && e.name === "AbortError";

// ------------------------------------------------------------------ the interface

export interface DashboardDataSource {
  getDeployment(opts?: CallOptions): Promise<DeploymentInfo>;
  getStats(opts?: CallOptions): Promise<DeploymentStats>;
  /** Pushes a fresh sample whenever the source has one (an implementation may poll). Never synchronously. */
  watchStats(onStats: (stats: DeploymentStats) => void, onError: (error: DataSourceError) => void): Unsubscribe;

  listTables(opts?: CallOptions): Promise<TableInfo[]>;
  listDocuments(query: DocumentQuery, opts?: CallOptions): Promise<Page<Document>>;
  /** `null` when the table exists but the document does not; `not_found` when the table does not exist. */
  getDocument(table: string, id: string, opts?: CallOptions): Promise<Document | null>;

  listFunctions(opts?: CallOptions): Promise<FunctionInfo[]>;

  listLogs(query: LogQuery, opts?: CallOptions): Promise<Page<LogEntry>>;
  /** Live tail: entries created after the call, in id order, matching the filter. Never synchronously. */
  watchLogs(
    filter: LogFilter,
    onEntries: (entries: LogEntry[]) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
}
