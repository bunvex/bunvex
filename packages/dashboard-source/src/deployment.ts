// The Schedules, Files and History screens over a deployment (STUDY-149 PR 5), as Convex's dashboard reads them
// (STUDY-149 §1.2): the scheduled runs as `paginatedScheduledJobs` pages and each run's arguments with
// `scheduler:getArgs`; the cron jobs with `listCronJobs` and `listCronJobRuns`; the files with
// `fileStorageV2:*`; the audit log with `paginatedDeploymentEvents`. Every read is a subscription while the
// screen watches (`LiveGroup`), the scheduled runs and the file list paused past Convex's rate. Cancelling goes
// over `/api/cancel_job` and `/api/cancel_all_jobs`, an upload to the URL `generateUploadUrl` gives.
import {
  type AuditEvent,
  type AuditEventQuery,
  type CallOptions,
  type CronJob,
  type CronRun,
  type CronSchedule,
  DataSourceError,
  type DeploymentFeatures,
  type FileQuery,
  type Page,
  type ScheduledFunction,
  type ScheduledFunctionQuery,
  type StoredFile,
} from "@bunvex/dashboard/data-source";
import type { AdminHttp } from "./admin-http.ts";
import { LiveGroup } from "./live.ts";
import { displayPath } from "./logs.ts";
import type { AdminSync, Args } from "./sync.ts";
import { argsOfBytes, canonicalPath, encodeJson, msOfNs, numberOf } from "./wire.ts";

/** Convex's `SCHEDULED_JOBS_PAGE_SIZE`, for counting the runs `cancel_all_jobs` cancels. */
const SCAN_PAGE = 50;

type PageJson<T> = { page: T[]; isDone: boolean; continueCursor: string };

type JobDoc = {
  _id: string;
  _creationTime: number;
  udfPath: string;
  udfArgs?: ArrayBuffer | null;
  argsId?: string | null;
  nextTs: bigint | null;
  state: { type: string };
};

type CronLogDoc = {
  name: string;
  ts: bigint;
  udfPath: string;
  status: { type: "success" } | { type: "err"; error: unknown } | { type: "canceled"; num_canceled: bigint };
  logLines: { logLines: string[] };
  executionTime: number;
};

type CronJobDoc = {
  name: string;
  cronSpec: { udfPath: string; udfArgs: ArrayBuffer; cronSchedule: Record<string, unknown> & { type: string } };
  lastRun: CronLogDoc | null;
  nextRun: { nextTs: bigint; state: { type: string } };
};

type FileDoc = {
  _id: string;
  _creationTime: number;
  sha256: string;
  size: bigint | number;
  contentType?: string | null;
  url: string;
};

type EventDoc = {
  _id: string;
  _creationTime: number;
  action: string;
  member_id: bigint | null;
  metadata?: unknown;
};

/** A cron log's run: `err` is a failure and `canceled` the runs skipped (Convex's `num_canceled`). */
export function cronRunOf(log: CronLogDoc): CronRun {
  const s = log.status;
  return {
    name: log.name,
    time: msOfNs(log.ts),
    function: displayPath(log.udfPath),
    status: s.type === "success" ? "success" : s.type === "err" ? "failure" : "skipped",
    ...(s.type === "canceled" && { skippedRuns: numberOf(s.num_canceled) }),
    ...(s.type === "err" && { error: typeof s.error === "string" ? s.error : JSON.stringify(s.error) }),
    durationMs: log.executionTime * 1000,
    logLines: log.logLines.logLines,
  };
}

/** A cron schedule with its int64 fields as numbers. */
export function cronScheduleOf(s: CronJobDoc["cronSpec"]["cronSchedule"]): CronSchedule {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out as CronSchedule;
}

export function cronJobOf(job: CronJobDoc): CronJob {
  return {
    name: job.name,
    function: displayPath(job.cronSpec.udfPath),
    args: argsOfBytes(job.cronSpec.udfArgs),
    schedule: cronScheduleOf(job.cronSpec.cronSchedule),
    nextRun: msOfNs(job.nextRun.nextTs),
    lastRun: job.lastRun ? cronRunOf(job.lastRun) : null,
    running: job.nextRun.state.type === "inProgress",
  };
}

export const storedFileOf = (f: FileDoc): StoredFile => ({
  id: f._id,
  creationTime: f._creationTime,
  sha256: f.sha256,
  size: numberOf(f.size),
  contentType: f.contentType ?? null,
  url: f.url,
});

/**
 * An audit event. Convex's dashboard names a `member_id` it cannot find "Unknown member" (a self-hosted one has
 * no team) and a null one after itself, the system; here that is `system`, and an unknown member is `null`.
 */
export const auditEventOf = (e: EventDoc): AuditEvent => ({
  id: e._id,
  time: e._creationTime,
  action: e.action,
  author: e.member_id === null ? "system" : null,
  metadata: e.metadata === undefined || e.metadata === null ? {} : encodeJson(e.metadata),
});

/** A file read's error as the contract's code: an id that is not a storage id is invalid, one with no file not found. */
function fileError(e: unknown): unknown {
  if (!(e instanceof DataSourceError) || e.code === "unauthorized") return e;
  if (/does not match validator|Unable to decode ID|Invalid ID/i.test(e.message))
    return new DataSourceError("invalid_request", e.message);
  if (/not found|does not exist/i.test(e.message)) return new DataSourceError("not_found", e.message);
  return e;
}

export type DeploymentReads = Required<
  Pick<
    DeploymentFeatures,
    | "listScheduledFunctions"
    | "watchScheduledFunctions"
    | "cancelScheduledFunction"
    | "cancelAllScheduledFunctions"
    | "listCronJobs"
    | "listCronRuns"
    | "listFiles"
    | "countFiles"
    | "getFile"
    | "uploadFile"
    | "deleteFiles"
    | "watchFiles"
    | "listAuditEvents"
    | "watchAuditEvents"
  >
> & { close(): void };

export function deploymentReads(sync: AdminSync, http: AdminHttp, clock: () => number = Date.now): DeploymentReads {
  const schedules = new LiveGroup(sync, clock);
  const files = new LiveGroup(sync, clock);
  const history = new LiveGroup(sync, clock);

  /** A page of scheduled runs (nearest first), with their arguments. */
  const jobsPage = async (q: ScheduledFunctionQuery, signal?: AbortSignal, live = true) => {
    const args: Args = {
      paginationOpts: { numItems: q.numItems, cursor: q.cursor },
      ...(q.function !== undefined && { udfPath: canonicalPath(q.function) }),
    };
    const page = live
      ? await schedules.read<PageJson<JobDoc>>("_system/frontend/paginatedScheduledJobs", args, {
          list: `jobs ${q.function ?? ""}`,
          first: q.cursor === null,
          pausable: true,
          signal,
        })
      : await sync.query<PageJson<JobDoc>>("_system/frontend/paginatedScheduledJobs", args, signal);
    return page;
  };

  const jobOf = async (j: JobDoc, signal?: AbortSignal): Promise<ScheduledFunction> => {
    // arguments never change: read once, as the run's details panel does
    const bytes = j.udfArgs
      ? j.udfArgs
      : j.argsId
        ? (
            await sync.query<{ args: ArrayBuffer } | null>(
              "_system/frontend/scheduler:getArgs",
              { argsId: j.argsId },
              signal,
            )
          )?.args
        : undefined;
    return {
      id: j._id,
      creationTime: j._creationTime,
      function: displayPath(j.udfPath),
      args: argsOfBytes(bytes),
      scheduledTime: msOfNs(j.nextTs ?? 0n),
      state: j.state.type === "inProgress" ? "inProgress" : "pending",
    };
  };

  const cronJobs = (signal?: AbortSignal) =>
    schedules.read<CronJobDoc[]>(
      "_system/frontend/listCronJobs",
      {},
      { list: "crons", first: true, pausable: false, signal },
    );

  return {
    // ---------------------------------------------------------------- schedules
    async listScheduledFunctions(q, o): Promise<Page<ScheduledFunction>> {
      const page = await jobsPage(q, o?.signal);
      return {
        page: await Promise.all(page.page.map((j) => jobOf(j, o?.signal))),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    },
    watchScheduledFunctions: (onChange, onError) => schedules.watch(onChange, onError),
    async cancelScheduledFunction(id, o) {
      await http.request("/api/cancel_job", { body: { id }, signal: o?.signal });
    },
    async cancelAllScheduledFunctions(fn, o) {
      // Convex's route answers no count: the runs listed just before are the ones it cancels.
      let canceled = 0;
      let cursor: string | null = null;
      for (;;) {
        const p: PageJson<JobDoc> = await jobsPage(
          { numItems: SCAN_PAGE, cursor, ...(fn !== undefined && { function: fn }) },
          o?.signal,
          false,
        );
        canceled += p.page.length;
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      await http.request("/api/cancel_all_jobs", {
        body: fn === undefined ? {} : { udfPath: canonicalPath(fn) },
        signal: o?.signal,
      });
      return { canceled };
    },
    async listCronJobs(o) {
      return (await cronJobs(o?.signal))
        .map(cronJobOf)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async listCronRuns(name, o) {
      const [jobs, logs] = await Promise.all([
        cronJobs(o?.signal),
        schedules.read<CronLogDoc[]>(
          "_system/frontend/listCronJobRuns",
          {},
          { list: "cron runs", first: true, pausable: false, signal: o?.signal },
        ),
      ]);
      if (!jobs.some((j) => j.name === name)) throw new DataSourceError("not_found", `There is no cron job ${name}.`);
      return logs
        .filter((l) => l.name === name)
        .map(cronRunOf)
        .sort((a, b) => b.time - a.time);
    },

    // ---------------------------------------------------------------- files
    async listFiles(q: FileQuery, o?: CallOptions): Promise<Page<StoredFile>> {
      const filters = {
        ...(q.from !== undefined && { minCreationTime: q.from }),
        ...(q.to !== undefined && { maxCreationTime: q.to }),
        order: q.order ?? "desc",
      };
      const page = await files.read<PageJson<FileDoc>>(
        "_system/frontend/fileStorageV2:fileMetadata",
        { paginationOpts: { numItems: q.numItems, cursor: q.cursor }, filters },
        { list: `files ${JSON.stringify(filters)}`, first: q.cursor === null, pausable: true, signal: o?.signal },
      );
      return { page: page.page.map(storedFileOf), isDone: page.isDone, continueCursor: page.continueCursor };
    },
    countFiles: (o) =>
      files
        .read<bigint | number>(
          "_system/frontend/fileStorageV2:numFiles",
          {},
          { list: "count", first: true, pausable: false, signal: o?.signal },
        )
        .then(numberOf),
    async getFile(id, o) {
      try {
        const f = await files.read<FileDoc | null>(
          "_system/frontend/fileStorageV2:getFile",
          { storageId: id },
          { list: "file", first: true, pausable: false, signal: o?.signal },
        );
        return f ? storedFileOf(f) : null;
      } catch (e) {
        throw fileError(e);
      }
    },
    async uploadFile(file, o) {
      const url = await sync.mutation<string>("_system/frontend/fileStorageV2:generateUploadUrl", {});
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: file.type ? { "Content-Type": file.type } : {},
          body: file,
          ...(o?.signal && { signal: o.signal }),
        });
      } catch (e) {
        if (o?.signal?.aborted) throw o.signal.reason;
        throw new DataSourceError("unavailable", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw new DataSourceError("unavailable", `The upload failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { storageId: string }).storageId;
    },
    async deleteFiles(ids) {
      try {
        await sync.mutation("_system/frontend/fileStorageV2:deleteFiles", { storageIds: ids });
      } catch (e) {
        throw fileError(e);
      }
    },
    watchFiles: (onChange, onError) => files.watch(onChange, onError),

    // ---------------------------------------------------------------- the audit log
    async listAuditEvents(q: AuditEventQuery, o?: CallOptions): Promise<Page<AuditEvent>> {
      const filters = {
        minDate: q.from ?? 0,
        ...(q.to !== undefined && { maxDate: q.to }),
        ...(q.actions !== undefined && { actions: q.actions }),
      };
      const page = await history.read<PageJson<EventDoc>>(
        "_system/frontend/paginatedDeploymentEvents",
        { paginationOpts: { numItems: q.numItems, cursor: q.cursor }, filters },
        { list: `events ${JSON.stringify(filters)}`, first: q.cursor === null, pausable: false, signal: o?.signal },
      );
      return { page: page.page.map(auditEventOf), isDone: page.isDone, continueCursor: page.continueCursor };
    },
    watchAuditEvents: (onChange, onError) => history.watch(() => onChange(), onError),

    close() {
      schedules.close();
      files.close();
      history.close();
    },
  };
}
