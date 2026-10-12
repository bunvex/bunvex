// `createServerDataSource`: the `DashboardDataSource` contract over a bunvex deployment, as Convex's dashboard
// reads one (STUDY-149 §3.3): the admin key on one sync connection (system queries subscribed, writes as
// WebSocket requests) and on the admin HTTP routes (metrics, the log stream). Built in steps (STUDY-149's PR
// plan); this is the first: the deployment, its capabilities and counters, the schema, the deployment state,
// the logs and the function metrics. The rest of the contract's required methods answer `unavailable` until
// the server functions under them exist (PRs 2–5).
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
  type TopKMeasure,
  type Unsubscribe,
  type ValidatorJson,
} from "@bunvex/dashboard/data-source";
import { AdminHttp, type FetchFn } from "./admin-http.ts";
import { capabilitiesOf } from "./credentials.ts";
import { LogStream, type LogStreamOptions } from "./logs.ts";
import { Metrics } from "./metrics.ts";
import { AdminSync, type ConnectionStatus, watchConnection } from "./sync.ts";

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

const notYet = (what: string) =>
  new DataSourceError("unavailable", `${what} is not available from a bunvex deployment yet.`);

/** A rejection that waits for the caller's abort first (the contract's AbortError wins). */
const rejectNotYet = (what: string, opts?: CallOptions) =>
  opts?.signal?.aborted ? Promise.reject(opts.signal.reason) : Promise.reject(notYet(what));

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
  const statsIntervalMs = opts.statsIntervalMs ?? 2000;

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
    await sync.close();
  };

  const source: ServerDataSource = {
    // ---------------------------------------------------------------- the deployment
    async getDeployment(o) {
      const [name, version, storage] = await Promise.all([
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
      ]);
      const info: DeploymentInfo = { name, version, persistence: storage, url: opts.url };
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

    // ---------------------------------------------------------------- not yet (STUDY-149 PRs 2 and 4)
    listTables: (o) => rejectNotYet("The table list", o),
    listDocuments: (_q, o) => rejectNotYet("The documents", o),
    getDocument: (_t, _id, o) => rejectNotYet("A document", o),
    watchTable(_table, _onChange, onError) {
      const timer = setTimeout(() => onError(notYet("Watching a table")), 0);
      return () => clearTimeout(timer);
    },
    listFunctions: (o) => rejectNotYet("The function list", o),

    // ---------------------------------------------------------------- the host's
    watchConnection: (onStatus) => watchConnection(() => sync.connectionState(), onStatus),
    close,
    [Symbol.dispose]() {
      void close();
    },
  };
  return source;
}
