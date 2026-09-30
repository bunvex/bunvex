// The deployment's other features in the dashboard contract (UI-01 §14, STUDY-12 §9): scheduled functions
// and cron jobs, file storage, environment variables, the audit log. Every method is optional — a source
// offers a feature by having its methods (detected with `typeof`), so older sources stay valid — and the
// shapes follow Convex's system tables. Re-exported by `data-source.ts`, the contract's module.
import type { CallOptions, DataSourceError, Page, PageRequest, Unsubscribe, Value } from "./data-source.ts";

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
}
