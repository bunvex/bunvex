// The deployment's other features in the dashboard contract (UI-01 §14, STUDY-12 §9): scheduled functions
// and cron jobs, file storage, environment variables, the audit log. Every method is optional — a source
// offers a feature by having its methods (detected with `typeof`), so older sources stay valid — and the
// shapes follow Convex's system tables. Re-exported by `data-source.ts`, the contract's module.
import type { CallOptions, DataSourceError, Json, Page, PageRequest, Unsubscribe, Value } from "./data-source.ts";

// ------------------------------------------------------------------ scheduled functions and crons

/** A run waiting in the scheduler (Convex's `_scheduled_jobs` with a next time): pending, or running now. */
export type ScheduledFunction = {
  id: string;
  /** When it was scheduled (wall-clock ms). */
  creationTime: number;
  /** "module:name". */
  function: string;
  args: Record<string, Value>;
  /** When it is due (wall-clock ms). */
  scheduledTime: number;
  state: "pending" | "inProgress";
};

/** Nearest first; optionally one function's. */
export type ScheduledFunctionQuery = PageRequest & { function?: string };

/** Convex's cron schedules; hours and minutes are UTC. */
export type CronSchedule =
  | { type: "interval"; seconds: number }
  | { type: "hourly"; minuteUTC: number }
  | { type: "daily"; hourUTC: number; minuteUTC: number }
  | { type: "weekly"; dayOfWeek: number; hourUTC: number; minuteUTC: number }
  | { type: "monthly"; day: number; hourUTC: number; minuteUTC: number }
  | { type: "cron"; cronExpr: string };

/** One run of a cron job (Convex's `_cron_job_logs`). */
export type CronRun = {
  /** The cron job's name. */
  name: string;
  /** When it started (wall-clock ms). */
  time: number;
  function: string;
  /** `skipped`: the previous run was still going (Convex's `canceled`). */
  status: "success" | "failure" | "skipped";
  error?: string;
  durationMs: number;
  logLines: string[];
};

export type CronJob = {
  name: string;
  function: string;
  args: Record<string, Value>;
  schedule: CronSchedule;
  /** When it runs next (wall-clock ms). */
  nextRun: number;
  lastRun: CronRun | null;
  /** A run is going on now. */
  running: boolean;
};

// ------------------------------------------------------------------ file storage

/** A stored file (Convex's `_storage`), with a URL the browser can fetch it from. */
export type StoredFile = {
  /** The storage id. */
  id: string;
  /** When it was stored (wall-clock ms). */
  creationTime: number;
  /** Base64 SHA-256 of the contents, as Convex stores it. */
  sha256: string;
  /** Bytes. */
  size: number;
  contentType: string | null;
  /** Where to download or preview it; may expire (fetch the file again for a fresh one). */
  url: string;
};

/** What a file is, by its content type (`fileKind`): the Files screen's views (UI-01 §24). */
export type FileKind = "image" | "document" | "other";

/** Images are `image/*`; documents are text, PDF, JSON, XML, CSV and office files; the rest is other. */
export function fileKind(contentType: string | null): FileKind {
  const t = (contentType ?? "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (
    t.startsWith("text/") ||
    /^application\/(pdf|json|xml|rtf|msword|vnd\.(openxmlformats-officedocument|oasis\.opendocument|ms-excel|ms-powerpoint)[\w.+-]*)$/.test(
      t,
    )
  )
    return "document";
  return "other";
}

/** Which files a query or a count takes: by creation time (ms, inclusive), kind and size (bytes, inclusive). */
export type FileFilter = { from?: number; to?: number; kind?: FileKind; minSize?: number; maxSize?: number };

/**
 * Newest first by default; `from` / `to` bound the creation time. `kind`, `minSize` and `maxSize` are honoured
 * by a source that offers `fileStats` (the two come together).
 */
export type FileQuery = PageRequest & { order?: "asc" | "desc" } & FileFilter;

/** How many files, and how many bytes, match a filter — in all, and per kind. */
export type FileStats = {
  count: number;
  totalBytes: number;
  byKind: Record<FileKind, { count: number; bytes: number }>;
};

// ------------------------------------------------------------------ environment variables

export type EnvironmentVariable = { name: string; value: string };

/** One change in a batch: a value sets (adds or replaces) the variable, `null` deletes it. */
export type EnvironmentVariableChange = { name: string; value: string | null };

// ------------------------------------------------------------------ the audit log

/** Something done to the deployment (Convex's `_deployment_audit_log`). */
export type AuditEvent = {
  id: string;
  /** Wall-clock ms. */
  time: number;
  /** Convex's action names: `add_documents`, `delete_files`, `update_environment_variable`, `push_config`, … */
  action: string;
  /** Who did it, as the source names them ("admin key", a team member); null when unknown. */
  author: string | null;
  /** The action's details, e.g. `{ table: "tasks", count: 3 }`. */
  metadata: { [key: string]: Json };
};

/** Newest first; `from` / `to` bound the time (ms, inclusive); `actions` keeps only those. */
export type AuditEventQuery = PageRequest & { from?: number; to?: number; actions?: string[] };

// ------------------------------------------------------------------ the optional methods

export interface DeploymentFeatures {
  // Scheduled functions: read with `viewData`; cancelling needs `writeData` (and not `readOnly`).
  listScheduledFunctions?(query: ScheduledFunctionQuery, opts?: CallOptions): Promise<Page<ScheduledFunction>>;
  /** Tells the caller the scheduled functions or the cron jobs changed. Never synchronously. */
  watchScheduledFunctions?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;
  /** A run that is not pending (running, or gone) is `invalid_request` / `not_found`. */
  cancelScheduledFunction?(id: string, opts?: CallOptions): Promise<void>;
  /** Every pending run, or one function's. */
  cancelAllScheduledFunctions?(fn?: string, opts?: CallOptions): Promise<{ canceled: number }>;
  /** Every cron job, by name, with its last run. */
  listCronJobs?(opts?: CallOptions): Promise<CronJob[]>;
  /** A cron job's runs, newest first (the source keeps a few per job, as Convex keeps 5). */
  listCronRuns?(name: string, opts?: CallOptions): Promise<CronRun[]>;

  // File storage: read with `viewData`; uploading and deleting need `writeData` (and not `readOnly`).
  listFiles?(query: FileQuery, opts?: CallOptions): Promise<Page<StoredFile>>;
  /** Every stored file. */
  countFiles?(opts?: CallOptions): Promise<number>;
  /** The files matching `filter` (every file without one), counted in all and per kind; see `FileQuery`. */
  fileStats?(filter?: FileFilter, opts?: CallOptions): Promise<FileStats>;
  /** `null` when there is no such file. */
  getFile?(id: string, opts?: CallOptions): Promise<StoredFile | null>;
  /** Stores the contents (the content type is the blob's); returns the new storage id. */
  uploadFile?(file: Blob, opts?: CallOptions): Promise<string>;
  /** Ids that do not exist are ignored. */
  deleteFiles?(ids: string[], opts?: CallOptions): Promise<void>;
  /** Tells the caller the stored files changed. Never synchronously. */
  watchFiles?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;

  // Environment variables: read with `viewEnvironmentVariables`, changed with `writeEnvironmentVariables`
  // (and not `readOnly`), as Convex's operations.
  /** Every variable, by name. */
  listEnvironmentVariables?(opts?: CallOptions): Promise<EnvironmentVariable[]>;
  /**
   * Applies the changes together or not at all, as Convex's `update_environment_variables`: a bad name, a
   * value over 8 KiB, more than 512 variables or 512 KiB in all is `invalid_request` naming the variable.
   * Deleting an unknown name is allowed. A rename is a delete and a set in one batch.
   */
  updateEnvironmentVariables?(changes: EnvironmentVariableChange[], opts?: CallOptions): Promise<void>;

  // The audit log: read with `viewAuditLog`. The source records the events; the dashboard only reads them.
  listAuditEvents?(query: AuditEventQuery, opts?: CallOptions): Promise<Page<AuditEvent>>;
  /** Tells the caller new events were recorded. Never synchronously. */
  watchAuditEvents?(onChange: () => void, onError: (error: DataSourceError) => void): Unsubscribe;
}
