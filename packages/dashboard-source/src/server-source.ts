// `createServerDataSource`: the `DashboardDataSource` contract over a bunvex deployment, as Convex's dashboard
// reads one (STUDY-149 §3.3): the admin key on one sync connection (system queries subscribed, writes as
// WebSocket requests) and on the admin HTTP routes (metrics, the log stream). Built in steps (STUDY-149's PR
// plan): the deployment, its capabilities and counters, the schema, the deployment state, the logs and the
// function metrics (PR 1); the tables, their documents, live tables and the table metrics (PR 2, tables.ts); the
// schedules, the files, the audit log and Health's concurrency and invalidations (PR 5, `deployment.ts`); the
// functions, the runner and the Settings screens (PR 4, `functions.ts` and `settings.ts`).
import {
  type CallOptions,
  type Capabilities,
  type DashboardDataSource,
  DataSourceError,
  type DeploymentInfo,
  type DeploymentState,
  type DeploymentStats,
  type FunctionMetric,
  type LogEntry,
  type LogFilter,
  type LogQuery,
  type MetricsWindow,
  OPERATIONS,
  type SchemaInfo,
  type SchemaValidation,
  type TableMetric,
  type TopKMeasure,
  type Unsubscribe,
  type ValidatorJson,
} from "@bunvex/dashboard/data-source";
import { AdminHttp, type FetchFn } from "./admin-http.ts";
import { capabilitiesOf } from "./credentials.ts";
import { deploymentReads } from "./deployment.ts";
import { Functions } from "./functions.ts";
import { LogStream, type LogStreamOptions } from "./logs.ts";
import { Metrics } from "./metrics.ts";
import { Settings } from "./settings.ts";
import { AdminSync, type ConnectionStatus, watchConnection } from "./sync.ts";
import { Tables } from "./tables.ts";
import { dataWrites } from "./writes.ts";

export type ServerDataSourceOptions = {
  /** The deployment's URL, e.g. `http://127.0.0.1:3210`. */
  url: string;
  adminKey: string;
  /** Default: the global `fetch`. */
  fetch?: FetchFn;
  /** Default: the global `WebSocket`. */
  webSocketConstructor?: typeof WebSocket;
  /** How often `watchStats` samples `/stats`. Default 2 000 ms. */
  statsIntervalMs?: number;
  /** The log stream's timings (tests shorten them). */
  logs?: LogStreamOptions;
};

/** The server source: the contract, plus what a host needs around it (the connection, closing it). */
export type ServerDataSource = DashboardDataSource &
  Disposable & {
    /** Reports the connection's state as Convex's dashboard does (polled every 2.5 s). Returns the stop. */
    watchConnection(onStatus: (s: ConnectionStatus) => void): Unsubscribe;
    /** Closes the socket and stops every loop. */
    close(): Promise<void>;
  };

/** `/stats` (bunvex's counters, DV-162), as the server sends it. */
type StatsJson = {
  storage: string;
  ts: number;
  groups: number;
  conflicts: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  subscriptions?: number;
  sync: { executions: number; transitions: number };
};

/** Convex's schema JSON (`DatabaseSchema`), as `getSchemas` returns it. */
type SchemaJson = {
  tables: { tableName: string; documentType?: ValidatorJson | null }[];
  schemaValidation: boolean;
};

/**
 * The schema the contract shows: each declared table and its document type (Convex's schema JSON carries no
 * system fields in it); a table declared with `v.any()` has none, as one declared without a validator.
 */
export function schemaInfoOf(json: string | undefined, progress: SchemaValidation | undefined): SchemaInfo {
  const schema: SchemaJson | null = json === undefined ? null : (JSON.parse(json) as SchemaJson);
  return {
    enforced: schema?.schemaValidation ?? false,
    tables: (schema?.tables ?? []).map((t) => ({
      name: t.tableName,
      ...(t.documentType && t.documentType.type !== "any" && { validator: t.documentType }),
    })),
    ...(progress && { validation: progress }),
  };
}

export function createServerDataSource(opts: ServerDataSourceOptions): ServerDataSource {
  const http = new AdminHttp(opts);
  const sync = new AdminSync(opts);
  const logs = new LogStream(http, opts.logs);
  const metrics = new Metrics(http);
  const tables = new Tables(sync, http);
  const deployment = deploymentReads(sync, http);
  const writes = dataWrites(sync, http, tables);
  const statsIntervalMs = opts.statsIntervalMs ?? 2000;
  // a key's operations do not change: asked once (again after a failure)
  let caps: Promise<Capabilities> | null = null;
  const capabilities = () => {
    caps ??= source.getCapabilities().catch((e: unknown) => {
      caps = null;
      throw e;
    });
    return caps;
  };
  const functions = new Functions(sync, http, opts, capabilities);
  const settings = new Settings(sync, http);

  const getStats = async (o?: CallOptions): Promise<DeploymentStats> => {
    const s = await http.json<StatsJson>("/stats", { signal: o?.signal });
    return {
      at: Date.now(),
      commitTs: s.ts,
      commitGroups: s.groups,
      conflicts: s.conflicts,
      retries: s.retries,
      cacheHits: s.cacheHits,
      cacheMisses: s.cacheMisses,
      subscriptions: s.subscriptions ?? 0,
      subscriptionReruns: s.sync.executions,
      subscriptionUpdates: s.sync.transitions,
    };
  };

  const close = async () => {
    logs.close();
    tables.close();
    deployment.close();
    settings.close();
    await functions.close();
    await sync.close();
  };

  const source: ServerDataSource = {
    // ---------------------------------------------------------------- the deployment
    async getDeployment(o) {
      const [name, version, storage, urls] = await Promise.all([
        http.text("/instance_name", { signal: o?.signal }),
        http.text("/version", { signal: o?.signal }),
        // `/stats` needs ViewMetrics; without it the persistence is not shown
        http.json<StatsJson>("/stats", { signal: o?.signal }).then(
          (s) => s.storage,
          (e: unknown) => {
            if (e instanceof DataSourceError && e.code === "unauthorized") return "";
            throw e;
          },
        ),
        // Convex's summaries read `convexCloudUrl` and `convexSiteUrl` (DV-474: `cloudUrl`, `siteUrl`)
        settings.urls(o),
      ]);
      const info: DeploymentInfo = {
        name,
        version,
        persistence: storage,
        url: urls.cloud ?? opts.url,
        ...(urls.site !== null && { httpActionsUrl: urls.site }),
      };
      return info;
    },
    async getCapabilities(o): Promise<Capabilities> {
      const check = await http.json<{ allowedOps?: string[]; isReadOnly?: boolean }>("/api/check_admin_key", {
        signal: o?.signal,
      });
      return capabilitiesOf({ allowedOps: check.allowedOps ?? [], isReadOnly: check.isReadOnly ?? false }, OPERATIONS);
    },
    getStats,
    watchStats(onStats, onError) {
      let stopped = false;
      const sample = () =>
        getStats().then(
          (s) => !stopped && onStats(s),
          (e: unknown) =>
            !stopped && onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e))),
        );
      const first = setTimeout(sample, 0);
      const timer = setInterval(sample, statsIntervalMs);
      return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(timer);
      };
    },

    // ---------------------------------------------------------------- the schema
    async getSchema(o) {
      const [schemas, progress] = await Promise.all([
        sync.query<{ active?: string }>("_system/frontend/getSchemas", {}, o?.signal),
        sync.query<{ numDocsValidated: number; totalDocs: number | null } | null>(
          "_system/frontend/getSchemas:schemaValidationProgress",
          {},
          o?.signal,
        ),
      ]);
      return schemaInfoOf(schemas.active, progress ? { state: "validating", ...progress } : undefined);
    },

    // ---------------------------------------------------------------- the deployment state (UI-01 §17.2)
    async getDeploymentState(o): Promise<DeploymentState> {
      const s = await sync.query<{ state: string }>("_system/frontend/deploymentState", {}, o?.signal);
      return { state: s.state === "paused" ? "paused" : "running" };
    },
    async pauseDeployment(o) {
      await http.request("/api/v1/pause_deployment", { method: "POST", signal: o?.signal });
    },
    async resumeDeployment(o) {
      // Convex's route refuses a deployment that is not paused; the contract's resume is idempotent.
      if ((await source.getDeploymentState?.(o))?.state !== "paused") return;
      await http.request("/api/v1/unpause_deployment", { method: "POST", signal: o?.signal });
    },

    // ---------------------------------------------------------------- logs
    listLogs: (q: LogQuery, o?: CallOptions) => logs.list(q, o?.signal),
    watchLogs: (filter: LogFilter, onEntries: (e: LogEntry[]) => void, onError) =>
      logs.watch(filter, onEntries, onError),

    // ---------------------------------------------------------------- metrics (UI-01 §18)
    functionRate: (fn: string, metric: FunctionMetric, w: MetricsWindow, o?: CallOptions) =>
      metrics.functionRate(fn, metric, w, o?.signal),
    cacheHitPercentage: (fn: string, w: MetricsWindow, o?: CallOptions) => metrics.cacheHitPercentage(fn, w, o?.signal),
    latencyPercentiles: (fn: string, percentiles: number[], w: MetricsWindow, o?: CallOptions) =>
      metrics.latencyPercentiles(fn, percentiles, w, o?.signal),
    topFunctions: (measure: TopKMeasure, w: MetricsWindow, k: number, o?: CallOptions) =>
      metrics.topFunctions(measure, w, k, o?.signal),
    scheduledJobLag: (w: MetricsWindow, o?: CallOptions) => metrics.scheduledJobLag(w, o?.signal),
    // the server answers zeros for any name; the mapping tells an unknown table
    async tableRate(table: string, metric: TableMetric, w: MetricsWindow, o?: CallOptions) {
      if (!(await tables.tableNames(o?.signal)).includes(table))
        throw new DataSourceError("not_found", `Table "${table}" does not exist.`);
      return metrics.tableRate(table, metric, w, o?.signal);
    },
    functionConcurrency: (w: MetricsWindow, o?: CallOptions) => metrics.functionConcurrency(w, o?.signal),
    subscriptionInvalidations: (w: MetricsWindow, k: number, o?: CallOptions & { function?: string }) =>
      metrics.subscriptionInvalidations(w, k, o?.function, o?.signal),

    // ---------------------------------------------------------------- schedules, files, the audit log (PR 5)
    listScheduledFunctions: deployment.listScheduledFunctions,
    watchScheduledFunctions: deployment.watchScheduledFunctions,
    cancelScheduledFunction: deployment.cancelScheduledFunction,
    cancelAllScheduledFunctions: deployment.cancelAllScheduledFunctions,
    listCronJobs: deployment.listCronJobs,
    listCronRuns: deployment.listCronRuns,
    listFiles: deployment.listFiles,
    countFiles: deployment.countFiles,
    getFile: deployment.getFile,
    uploadFile: deployment.uploadFile,
    deleteFiles: deployment.deleteFiles,
    watchFiles: deployment.watchFiles,
    listAuditEvents: deployment.listAuditEvents,
    watchAuditEvents: deployment.watchAuditEvents,

    // ---------------------------------------------------------------- tables and documents (PR 2)
    listTables: (o) => tables.listTables(o),
    listDocuments: (q, o) => tables.listDocuments(q, o),
    getDocument: (t, id, o) => tables.getDocument(t, id, o),
    watchTable: (t, onChange, onError) => tables.watchTable(t, onChange, onError),
    inferDocumentType: (t, o) => tables.inferDocumentType(t, o),
    tableOfId: (id, o) => tables.tableOfId(id, o),

    // ---------------------------------------------------------------- functions and the runner (PR 4)
    listFunctions: (o) => functions.listFunctions(o),
    watchFunctions: (onChange, onError) => functions.watchFunctions(onChange, onError),
    runFunction: (path, args, o) => functions.runFunction(path, args, o),
    watchFunction: (path, args, onResult, onError, o) => functions.watchFunction(path, args, onResult, onError, o),
    runTestQuery: (code, o) => functions.runTestQuery(code, o),

    // ---------------------------------------------------------------- settings (PR 4)
    listEnvironmentVariables: (o) => settings.listEnvironmentVariables(o),
    updateEnvironmentVariables: (changes, o) => settings.updateEnvironmentVariables(changes, o),
    watchEnvironmentVariables: (onChange, onError) => settings.watchEnvironmentVariables(onChange, onError),
    listAuthProviders: (o) => settings.listAuthProviders(o),
    getLatestSnapshotExport: (o) => settings.getLatestSnapshotExport(o),
    requestSnapshotExport: (options, o) => settings.requestSnapshotExport(options, o),
    downloadSnapshotExport: (id, o) => settings.downloadSnapshotExport(id, o),
    startSnapshotImport: (request, o) => settings.startSnapshotImport(request, o),
    confirmSnapshotImport: (id, o) => settings.confirmSnapshotImport(id, o),
    cancelSnapshotImport: (id, o) => settings.cancelSnapshotImport(id, o),
    getSnapshotImport: (id, o) => settings.getSnapshotImport(id, o),

    // ---------------------------------------------------------------- the Data screen's writes (PR 3, writes.ts)
    ...writes,

    // ---------------------------------------------------------------- the host's
    watchConnection: (onStatus) => watchConnection(() => sync.connectionState(), onStatus),
    close,
    [Symbol.dispose]() {
      void close();
    },
  };
  return source;
}
