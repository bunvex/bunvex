// The dashboard's system functions for schedules and crons (STUDY-30 §3.5), as Convex's
// npm-packages/system-udfs/convex/_system/frontend: same names, arguments and result shapes. Their results
// are Convex's private documents (`_scheduled_jobs`, `_scheduled_job_args`, `_cron_jobs`, `_cron_next_run`,
// `_cron_job_logs`): times in ns as int64, args as bytes, `state.type`. bunvex stores these differently
// (S2), so the documents are built on the way out.
//
// Only an admin may call them (Convex's `queryPrivateSystem("ViewData")`); clients cannot, as no `_system`
// name is in the public registry. Admin keys (Phase 3 item 6) will expose them over HTTP and WebSocket.
import {
  CRON_JOB_LOGS_TABLE,
  CRON_JOBS_TABLE,
  CRON_NEXT_RUN_TABLE,
  cancelJob,
  ENVIRONMENT_VARIABLES_TABLE,
  type Engine,
  EXPORTS_TABLE,
  type JobDoc,
  type PaginationOptions,
  type PaginationResult,
  SCHEDULED_FUNCTIONS_TABLE,
  SNAPSHOT_IMPORTS_TABLE,
  STORAGE_TABLE,
  stringifyValue,
  type Tx,
} from "@bunvex/core";
import { type GenericValidator, type Value, v } from "@bunvex/values";
import type { DeploymentOp } from "./admin-keys.ts";
import type { Functions } from "./functions.ts";
import { paginationOptsValidator } from "./pagination.ts";
import type { FileStorage } from "./storage.ts";

/** Convex's paginationLimits.ts. */
const maximumRowsRead = 10000;
const maximumBytesRead = 5000000;

const ns = (ms: number) => BigInt(Math.round(ms * 1_000_000));
/** Convex keeps arguments as the bytes of their JSON array. */
const argsBytes = (args: Value[]) => new TextEncoder().encode(stringifyValue(args as Value)).buffer as ArrayBuffer;
const canonical = (udfPath: string) => {
  const i = udfPath.lastIndexOf(":");
  const [m, f] = i === -1 ? [udfPath, "default"] : [udfPath.slice(0, i), udfPath.slice(i + 1)];
  return `${m.endsWith(".js") ? m : `${m}.js`}:${f}`;
};

/** A job as Convex's `_scheduled_jobs` document. The args live with the job here, so `argsId` is its id. */
function scheduledJobDoc(d: JobDoc) {
  const state =
    d.state.kind === "inProgress"
      ? { type: "inProgress", requestId: d.state.requestId, executionId: d.state.executionId }
      : d.state.kind === "failed"
        ? { type: "failed", error: d.state.error }
        : { type: d.state.kind };
  return {
    _id: d._id,
    _creationTime: d._creationTime,
    udfPath: d.name,
    argsId: d._id,
    state,
    ...(d.nextTs === undefined ? {} : { nextTs: ns(d.nextTs) }),
    ...(d.completedTime === undefined ? {} : { completedTs: ns(d.completedTime) }),
    originalScheduledTs: ns(d.scheduledTime),
    ...(d.systemErrors === undefined ? {} : { attempts: { systemErrors: BigInt(d.systemErrors), occErrors: 0n } }),
  };
}

type Doc = Record<string, unknown> & { _id: string; _creationTime: number };
const cronJobDoc = (d: Doc) => {
  const spec = d.cronSpec as { udfPath: string; udfArgs: Value[]; cronSchedule: unknown };
  return {
    _id: d._id,
    _creationTime: d._creationTime,
    name: d.name,
    cronSpec: { udfPath: spec.udfPath, udfArgs: argsBytes(spec.udfArgs), cronSchedule: spec.cronSchedule },
  };
};
const cronLogDoc = (d: Doc) => ({
  _id: d._id,
  _creationTime: d._creationTime,
  name: d.name,
  ts: ns(d.ts as number),
  udfPath: d.udfPath,
  udfArgs: argsBytes(d.udfArgs as Value[]),
  status:
    (d.status as { type: string }).type === "canceled"
      ? { type: "canceled", num_canceled: BigInt((d.status as { num_canceled: number }).num_canceled) }
      : d.status,
  logLines: d.logLines,
  executionTime: d.executionTime,
});
const cronNextRunDoc = (d: Doc) => ({
  _id: d._id,
  _creationTime: d._creationTime,
  cronJobId: d.cronJobId,
  state: d.state,
  prevTs: d.prevTs === null ? null : ns(d.prevTs as number),
  nextTs: ns(d.nextTs as number),
});

/** An import's row as Convex's: without bunvex's own `object_size` and `hidden_tables`. */
const importDoc = (d: Record<string, unknown> | null) => {
  if (!d) return null;
  const { object_size: _, hidden_tables: __, ...rest } = d;
  return rest;
};

/** What a system function may use besides its transaction. */
export type SystemEnv = { files: FileStorage | null; functions?: Functions };
/** A system query or mutation: its argument validators (checked as Convex's) and its handler. */
export type SystemQuery = {
  args: Record<string, GenericValidator>;
  /** The operation a key needs (Convex's `queryPrivateSystem(op)` / `mutationGeneric(op)`); default
   *  `ViewData` for a query, `WriteData` for a mutation. */
  op?: DeploymentOp;
  handler: (db: Tx, args: never, env: SystemEnv) => Promise<unknown>;
};
export type SystemMutation = SystemQuery;

const noFiles = (): never => {
  throw new Error("File storage is not configured on this server.");
};
/** A `_storage` document with its URL first, as Convex's `FileMetadata`. */
const withUrl = (files: FileStorage, d: Record<string, unknown>, row: { storageId: string }) => ({
  url: `${files.origin}/api/storage/${row.storageId}`,
  ...d,
});
const componentId = v.optional(v.union(v.string(), v.null()));

export const SYSTEM_QUERIES: Record<string, SystemQuery> = {
  // The CLI's `export` waits on it (Convex's `_system/cli/exports:getLatest`): the newest export, or null.
  "_system/cli/exports:getLatest": {
    args: {},
    op: "ViewBackups",
    handler: async (db) =>
      db.asSystem(() =>
        db
          .query(EXPORTS_TABLE)
          .withIndex("by_requestor", (q) => q.eq("requestor", "snapshotExport"))
          .order("desc")
          .first(),
      ),
  },
  // The CLI's `import` follows an import with it (Convex's `_system/cli/queryImport`), and lists them first.
  "_system/cli/queryImport": {
    args: { importId: v.id(SNAPSHOT_IMPORTS_TABLE) },
    op: "ViewBackups",
    handler: async (db, args: { importId: string }) =>
      db.asSystem(async () => importDoc(await db.get(SNAPSHOT_IMPORTS_TABLE, args.importId))),
  },
  "_system/cli/queryImport:list": {
    args: {},
    op: "ViewBackups",
    handler: async (db) =>
      db.asSystem(async () => (await db.query(SNAPSHOT_IMPORTS_TABLE).order("desc").take(20)).map(importDoc)),
  },
  // The CLI's `run` lists them when a function is missing (Convex's `_system/cli/modules:apiSpec`).
  "_system/cli/modules:apiSpec": {
    args: { componentId },
    handler: async (_db, _args, env) => env.functions?.apiSpec() ?? [],
  },
  // The CLI's (STUDY-37, Convex's `_system/cli/queryEnvironmentVariables`): every variable, by name.
  "_system/cli/queryEnvironmentVariables": {
    args: {},
    op: "ViewEnvironmentVariables",
    handler: async (db) =>
      db.asSystem(() => db.query(ENVIRONMENT_VARIABLES_TABLE).withIndex("by_name").order("asc").collect()),
  },
  "_system/cli/queryEnvironmentVariables:get": {
    args: { name: v.string() },
    op: "ViewEnvironmentVariables",
    handler: async (db, { name }: { name: string }) => {
      const doc = await db.asSystem(() =>
        db
          .query(ENVIRONMENT_VARIABLES_TABLE)
          .withIndex("by_name", (q) => q.eq("name", name))
          .first(),
      );
      return doc ? { name: doc.name, value: doc.value } : null;
    },
  },
  "_system/frontend/paginatedScheduledJobs": {
    args: { componentId, paginationOpts: paginationOptsValidator, udfPath: v.optional(v.string()) },
    handler: async (db, { paginationOpts, udfPath }: { paginationOpts: PaginationOptions; udfPath?: string }) => {
      const opts = { ...paginationOpts, maximumRowsRead, maximumBytesRead };
      const r: PaginationResult = await db.asSystem(() =>
        udfPath === undefined
          ? db
              .query(SCHEDULED_FUNCTIONS_TABLE)
              .withIndex("by_next_ts", (q) => q.gt("nextTs", null))
              .order("asc")
              .paginate(opts)
          : db
              .query(SCHEDULED_FUNCTIONS_TABLE)
              .withIndex("by_udf_path_and_next_event_ts", (q) => q.eq("name", canonical(udfPath)).gt("nextTs", null))
              .order("asc")
              .paginate(opts),
      );
      return { ...r, page: r.page.map((d) => scheduledJobDoc(d as unknown as JobDoc)) };
    },
  },
  "_system/frontend/scheduler:getArgs": {
    args: { componentId, argsId: v.string() },
    handler: async (db, { argsId }: { argsId: string }) => {
      const id = db.asSystemSync(() => db.normalizeId(SCHEDULED_FUNCTIONS_TABLE, argsId));
      const d = id && ((await db.asSystem(() => db.get(SCHEDULED_FUNCTIONS_TABLE, id))) as unknown as JobDoc | null);
      return d ? { _id: d._id, _creationTime: d._creationTime, args: argsBytes(d.args) } : null;
    },
  },
  "_system/frontend/listCronJobs": {
    args: { componentId },
    handler: async (db) =>
      db.asSystem(async () => {
        const jobs = (await db.query(CRON_JOBS_TABLE).collect()) as unknown as Doc[];
        const out = [];
        for (const job of jobs) {
          const lastRun = (await db
            .query(CRON_JOB_LOGS_TABLE)
            .withIndex("by_name_and_ts", (q) => q.eq("name", job.name as string))
            .order("desc")
            .first()) as unknown as Doc | null;
          const nextRun = (await db
            .query(CRON_NEXT_RUN_TABLE)
            .withIndex("by_cron_job_id", (q) => q.eq("cronJobId", job._id))
            .first()) as unknown as Doc | null;
          if (nextRun === null) throw new Error("No next run found for cron job");
          out.push({ ...cronJobDoc(job), lastRun: lastRun && cronLogDoc(lastRun), nextRun: cronNextRunDoc(nextRun) });
        }
        return out;
      }),
  },
  // Files (Convex's fileStorageV2): count, page by creation time with each file's URL, one file.
  "_system/frontend/fileStorageV2:numFiles": {
    args: { componentId },
    handler: async (db) => (await db.system.query(STORAGE_TABLE).collect()).length,
  },
  "_system/frontend/fileStorageV2:fileMetadata": {
    args: {
      paginationOpts: paginationOptsValidator,
      filters: v.optional(
        v.object({
          minCreationTime: v.optional(v.number()),
          maxCreationTime: v.optional(v.number()),
          order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
        }),
      ),
      componentId,
    },
    handler: async (
      db,
      {
        paginationOpts,
        filters,
      }: {
        paginationOpts: PaginationOptions;
        filters?: { minCreationTime?: number; maxCreationTime?: number; order?: "asc" | "desc" };
      },
      { files },
    ) => {
      const fs = files ?? noFiles();
      const q = db.system.query(STORAGE_TABLE);
      const ranged =
        filters && (filters.minCreationTime !== undefined || filters.maxCreationTime !== undefined)
          ? q.withIndex("by_creation_time", (b) => {
              let r = b;
              if (filters.minCreationTime !== undefined) r = r.gte("_creationTime", filters.minCreationTime);
              if (filters.maxCreationTime !== undefined) r = r.lte("_creationTime", filters.maxCreationTime);
              return r;
            })
          : q;
      const page = await ranged.order(filters?.order ?? "desc").paginate(paginationOpts);
      const rows = await Promise.all(page.page.map((d) => fs.resolve(db, d._id, "storage.getUrl")));
      return { ...page, page: page.page.map((d, i) => withUrl(fs, d, rows[i]!)) };
    },
  },
  "_system/frontend/fileStorageV2:getFile": {
    args: { storageId: v.string(), componentId },
    handler: async (db, { storageId }: { storageId: string }, { files }) => {
      const fs = files ?? noFiles();
      const d = await db.system.get(storageId);
      if (!d) return null;
      const row = await fs.resolve(db, d._id, "storage.getUrl");
      return withUrl(fs, d, row!);
    },
  },
  "_system/frontend/listCronJobRuns": {
    args: { componentId },
    handler: async (db) =>
      ((await db.asSystem(() => db.query(CRON_JOB_LOGS_TABLE).collect())) as unknown as Doc[]).map(cronLogDoc),
  },
};

/** Convex's file mutations for the dashboard (fileStorageV2). Convex also writes audit-log entries; bunvex has no audit log yet. */
export const SYSTEM_MUTATIONS: Record<string, SystemMutation> = {
  "_system/frontend/fileStorageV2:deleteFile": {
    args: { storageId: v.id(STORAGE_TABLE), componentId },
    handler: async (db, { storageId }: { storageId: string }, { files }) => {
      await (files ?? noFiles()).deleteIn(db, storageId);
    },
  },
  "_system/frontend/fileStorageV2:deleteFiles": {
    args: { storageIds: v.array(v.id(STORAGE_TABLE)), componentId },
    handler: async (db, { storageIds }: { storageIds: string[] }, { files }) => {
      const fs = files ?? noFiles();
      for (const id of storageIds) await fs.deleteIn(db, id);
    },
  },
  "_system/frontend/fileStorageV2:generateUploadUrl": {
    args: { componentId },
    handler: async (_db, _args, { files }) => (files ?? noFiles()).uploadUrl(),
  },
};

/** Convex's MAX_JOBS_CANCEL_BATCH: `cancel_all_jobs` cancels this many per transaction, until a batch is short. */
export const MAX_JOBS_CANCEL_BATCH = 1000;

/** Convex's `POST /api/cancel_job` (admin, WriteData): cancel one job; a finished or unknown one is a no-op. */
export async function cancelScheduledJob(engine: Engine, id: string) {
  await engine.mutation(async (db) => {
    const jobId = db.asSystemSync(() => db.normalizeId(SCHEDULED_FUNCTIONS_TABLE, id));
    if (!jobId) throw new Error(`Invalid ID "${id}" for table _scheduled_jobs`);
    await cancelJob(db, jobId, Date.now());
  }, "cancel_job");
}

/**
 * Convex's `POST /api/cancel_all_jobs` (admin, WriteData): cancel every pending or running job, or one
 * function's, optionally only those with `startNextTs ≤ nextTs < endNextTs` (ns), in batches.
 */
export async function cancelAllScheduledJobs(
  engine: Engine,
  opts: { udfPath?: string; startNextTs?: bigint; endNextTs?: bigint } = {},
): Promise<number> {
  const lo = opts.startNextTs === undefined ? null : Number(opts.startNextTs) / 1_000_000;
  const hi = opts.endNextTs === undefined ? null : Number(opts.endNextTs) / 1_000_000;
  let total = 0;
  for (;;) {
    const n = await engine.mutation(async (db) => {
      const jobs = (await db.asSystem(() =>
        (opts.udfPath === undefined
          ? db.query(SCHEDULED_FUNCTIONS_TABLE).withIndex("by_next_ts", (q) => {
              const b = lo === null ? q.gt("nextTs", null) : q.gte("nextTs", lo);
              return hi === null ? b : b.lt("nextTs", hi);
            })
          : db.query(SCHEDULED_FUNCTIONS_TABLE).withIndex("by_udf_path_and_next_event_ts", (q) => {
              const b0 = q.eq("name", canonical(opts.udfPath!));
              const b = lo === null ? b0.gt("nextTs", null) : b0.gte("nextTs", lo);
              return hi === null ? b : b.lt("nextTs", hi);
            })
        ).take(MAX_JOBS_CANCEL_BATCH),
      )) as unknown as JobDoc[];
      const now = Date.now();
      for (const j of jobs) await cancelJob(db, j._id, now);
      return jobs.length;
    }, "cancel_all_jobs");
    total += n;
    if (n < MAX_JOBS_CANCEL_BATCH) return total;
  }
}
