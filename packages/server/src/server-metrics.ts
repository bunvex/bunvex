// The server's Prometheus metrics and its `/metrics` route (STUDY-114), as Convex's meta route
// (crates/common/src/http/mod.rs `metrics`): open, on the API port and the site port, turned off by
// `DISABLE_METRICS_ENDPOINT=true`.
//
// The series are bunvex's own (DV-377): Convex's ~800 describe its services, bunvex's describe its one
// process. Names follow Convex's (a unit suffix; `sync_*_args_bytes` and the like keep Convex's names) under
// the `bunvex_` prefix, where Convex prefixes its binary's name.
import type { Engine } from "@bunvex/core";
import packageJson from "../package.json" with { type: "json" };
import { type HistogramFamily, Registry, type Sample } from "./prometheus.ts";

/** Convex's `DISABLE_METRICS_ENDPOINT` knob: a bool knob, so only `true` turns it on; another value is ignored. */
export function metricsEndpointDisabled(v: string | undefined): boolean {
  if (v === undefined || v === "false") return false;
  if (v === "true") return true;
  console.warn(`bunvex: invalid value ${v} for DISABLE_METRICS_ENDPOINT, falling back to false`);
  return false;
}

/** Seconds, from 1 ms to 15 min (a function's duration; an action may run 30 min, past the last bound). */
const SECONDS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];
/** Sizes, from 64 B to 16 MiB by powers of 4. */
const BYTES = [64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216];
/** Commits per write batch. */
const COMMITS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

export type UdfType = "Query" | "Mutation" | "Action" | "HttpAction";
const UDF_TYPES: readonly [UdfType, string][] = [
  ["Query", "query"],
  ["Mutation", "mutation"],
  ["Action", "action"],
  ["HttpAction", "http_action"],
];

/** What the metrics read when scraped; set once the server has built them. */
export type MetricSources = {
  engine: Engine;
  syncSessions: () => number;
  syncSubscriptions: () => number;
  syncStats: { executions: number; reused: number; transitions: number };
  schedulerRunning: () => number;
  /** Seconds the oldest runnable scheduled job has waited (0 with none). */
  schedulerBacklog: () => number;
  schedulerStats: { succeeded: number; failed: number; systemErrors: number };
};

export class ServerMetrics {
  readonly registry = new Registry();
  private readonly calls;
  private readonly errors;
  private readonly durations;
  private readonly byType = new Map<UdfType, { calls: { inc(n?: number): void }; errors: { inc(n?: number): void } }>();
  private readonly durationByType = new Map<UdfType, { observe(v: number): void }>();
  private readonly invalidationsTotal;
  readonly queryModificationArgs;
  readonly mutationArgs;
  readonly actionArgs;
  readonly transitionMessageSize;
  private readonly batchCommits: HistogramFamily;
  private readonly flushSeconds: HistogramFamily;
  private sources: MetricSources | null = null;
  private loopLag = 0;
  private lagTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const r = this.registry;
    // A version info gauge, as Convex's `*_info` gauges.
    r.gauge("bunvex_version_info", "The running bunvex version", () => [[[packageJson.version], 1]], ["version"]);

    // Functions, by kind; no per-function label (the app metrics have those).
    this.calls = r.counter("bunvex_udf_executions_total", "Function executions finished, by kind", ["udf_type"]);
    this.errors = r.counter("bunvex_udf_errors_total", "Function executions that failed, by kind", ["udf_type"]);
    this.durations = r.histogram("bunvex_udf_execution_seconds", "Time a function execution took, by kind", SECONDS, [
      "udf_type",
    ]);
    for (const [type, label] of UDF_TYPES) {
      this.byType.set(type, { calls: this.calls.labels(label), errors: this.errors.labels(label) });
      this.durationByType.set(type, this.durations.labels(label));
    }

    // The committer.
    const committer = () => this.sources?.engine.committer;
    r.collectedCounter("bunvex_database_commits_total", "Commits made durable", () => committer()?.commits ?? 0);
    r.collectedCounter(
      "bunvex_database_commit_conflicts_total",
      "Commits refused by an optimistic concurrency conflict",
      () => committer()?.conflicts ?? 0,
    );
    r.collectedCounter(
      "bunvex_database_commit_groups_total",
      "Commit groups written (the commits queued while the previous group was written)",
      () => committer()?.groups ?? 0,
    );
    this.batchCommits = r.histogram(
      "bunvex_database_write_batch_commits",
      "Number of commits combined into one batched persistence write",
      COMMITS,
    );
    this.flushSeconds = r.histogram(
      "bunvex_database_commit_persistence_write_seconds",
      "Time to write one batch of commits to persistence, retries included",
      SECONDS,
    );
    r.gauge(
      "bunvex_database_visible_ts_seconds",
      "The timestamp new transactions read at, in seconds since the epoch",
      () => (committer()?.visibleTs ?? 0) / 1e6,
    );
    r.collectedCounter(
      "bunvex_query_cache_hits_total",
      "Queries answered from the query cache",
      () => this.sources?.engine.stats.cacheHits ?? 0,
    );
    r.collectedCounter(
      "bunvex_query_cache_misses_total",
      "Queries the query cache did not have",
      () => this.sources?.engine.stats.cacheMisses ?? 0,
    );

    // Sync.
    r.gauge("bunvex_sync_sessions", "WebSocket sync sessions open", () => this.sources?.syncSessions() ?? 0);
    r.gauge(
      "bunvex_sync_subscriptions",
      "Queries subscribed to, across every sync session",
      () => this.sources?.syncSubscriptions() ?? 0,
    );
    this.invalidationsTotal = r
      .counter("bunvex_sync_subscription_invalidations_total", "Subscriptions a commit invalidated")
      .labels();
    r.collectedCounter(
      "bunvex_sync_transitions_total",
      "Transitions sent to sync clients",
      () => this.sources?.syncStats.transitions ?? 0,
    );
    r.collectedCounter(
      "bunvex_sync_query_executions_total",
      "Subscribed query runs (one run serves every session subscribed to the same query)",
      () => this.sources?.syncStats.executions ?? 0,
    );
    r.collectedCounter(
      "bunvex_sync_query_reused_total",
      "Subscribed query results reused from another session's run",
      () => this.sources?.syncStats.reused ?? 0,
    );
    const bytes = (name: string, help: string) => {
      const h = r.histogram(name, help, BYTES);
      return h.labels();
    };
    this.queryModificationArgs = bytes(
      "bunvex_sync_query_modification_args_bytes",
      "Size of the arguments of the queries a ModifyQuerySet message adds",
    );
    this.mutationArgs = bytes("bunvex_sync_mutation_args_bytes", "Size of mutation args in client messages");
    this.actionArgs = bytes("bunvex_sync_action_args_bytes", "Size of action args in client messages");
    this.transitionMessageSize = bytes(
      "bunvex_sync_transition_message_size_bytes",
      "Size of the messages sent to sync clients (a transition before it is chunked)",
    );

    // Scheduled functions.
    r.gauge(
      "bunvex_scheduled_job_running_jobs",
      "Scheduled functions running now",
      () => this.sources?.schedulerRunning() ?? 0,
    );
    r.gauge(
      "bunvex_scheduled_job_backlog_seconds",
      "Age of the oldest runnable scheduled job (0 with none)",
      () => this.sources?.schedulerBacklog() ?? 0,
    );
    r.collectedCounter(
      "bunvex_scheduled_job_result_total",
      "Scheduled function runs finished, by result",
      () => {
        const s = this.sources?.schedulerStats;
        return [
          [["success"], s?.succeeded ?? 0],
          [["failure"], s?.failed ?? 0],
          [["system_error"], s?.systemErrors ?? 0],
        ] satisfies Sample[];
      },
      ["result"],
    );

    // Search and vector indexes.
    r.gauge(
      "bunvex_search_indexes",
      "Text and vector indexes, by kind and state",
      () => {
        const e = this.sources?.engine;
        const n = new Map<string, number>();
        for (const kind of ["text", "vector"])
          for (const state of ["ready", "backfilling", "bootstrapping"]) n.set(`${kind}\u0000${state}`, 0);
        const count = (kind: string, all: readonly { ready: boolean; bootstrapping: boolean }[]) => {
          for (const i of all) {
            const key = `${kind}\u0000${i.bootstrapping ? "bootstrapping" : i.ready ? "ready" : "backfilling"}`;
            n.set(key, n.get(key)! + 1);
          }
        };
        if (e) {
          count("text", e.searchIndexes.all());
          count("vector", e.vectorIndexes.all());
        }
        return [...n].map(([k, v]) => [k.split("\u0000"), v] as Sample);
      },
      ["kind", "state"],
    );
    r.collectedCounter(
      "bunvex_search_indexes_restored_total",
      "Text and vector indexes restored from a snapshot at start",
      () => this.sources?.engine.searchStats.restored ?? 0,
    );

    // The process.
    r.gauge("bunvex_process_resident_memory_bytes", "Resident memory", () => process.memoryUsage.rss());
    r.gauge("bunvex_process_heap_bytes", "JavaScript heap in use", () => process.memoryUsage().heapUsed);
    r.gauge(
      "bunvex_process_event_loop_lag_seconds",
      "How late the last event loop probe ran (sampled every 500 ms)",
      () => this.loopLag,
    );
    r.gauge("bunvex_process_start_time_seconds", "When the process started, in seconds since the epoch", () =>
      Math.floor(performance.timeOrigin / 1000),
    );
  }

  /** Read the server's state when scraped, and record each write batch; samples the event loop from now on. */
  start(sources: MetricSources) {
    this.sources = sources;
    const batch = this.batchCommits.labels();
    const flush = this.flushSeconds.labels();
    sources.engine.committer.onBatch = (commits, seconds) => {
      batch.observe(commits);
      flush.observe(seconds);
    };
    const PERIOD = 500;
    let expected = performance.now() + PERIOD;
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      this.loopLag = Math.max(0, now - expected) / 1000;
      expected = now + PERIOD;
    }, PERIOD);
    this.lagTimer.unref?.();
  }

  stop() {
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.lagTimer = null;
    if (this.sources) this.sources.engine.committer.onBatch = null;
  }

  /** A finished function execution (where the app metrics record it). */
  execution(udfType: UdfType, failed: boolean, seconds: number) {
    const t = this.byType.get(udfType);
    if (!t) return;
    t.calls.inc();
    if (failed) t.errors.inc();
    this.durationByType.get(udfType)!.observe(seconds);
  }

  /** Subscriptions a commit invalidated. */
  invalidations(n: number) {
    this.invalidationsTotal.inc(n);
  }
}
