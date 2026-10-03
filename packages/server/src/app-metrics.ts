// The app metrics (STUDY-58), as Convex's crates/udf_metrics and application/src/function_log.rs: an
// in-memory store of counters, gauges and latency histograms in buckets of one minute since the process
// started, the last hour kept; and the queries the dashboard's `/api/app_metrics/*` routes answer, each
// resampled into the asked window.
//
// Convex's arithmetic is kept: counters and gauges add up in f32; a window is in nanoseconds, its buckets
// `floor(width / n)` wide; a sample is placed by the start of its store bucket; histograms are
// HdrHistogram's (1 ms – 15 min, 2 significant figures, 8-bit counts that saturate), merged as its `add`.

/** Convex's knobs (`UDF_METRICS_*`): bucket width, number of buckets kept, the histograms' range. */
export const BUCKET_WIDTH_MS = Number(process.env.UDF_METRICS_BUCKET_WIDTH_SECS ?? 60) * 1000;
export const MAX_BUCKETS = Number(process.env.UDF_METRICS_MAX_BUCKETS ?? 60);
const MAX_DURATION_MS = 15 * 60 * 1000;

const f32 = Math.fround;

// ---------------------------------------------------------------- HdrHistogram (low 1, high 900 000, 2 figures)

// 2 significant figures: single-unit resolution up to 200, so 256 sub-buckets (half 128), unit magnitude 0;
// 13 buckets reach 900 000; (13 + 1) × 128 counts.
const HALF_MAG = 7;
const HALF = 1 << HALF_MAG;
const COUNTS = 14 * HALF;

const bucketFor = (v: number) => (v < 2 * HALF ? 0 : Math.floor(Math.log2(v)) - HALF_MAG);
const indexFor = (v: number) => {
  const b = bucketFor(v);
  return ((b + 1) << HALF_MAG) + (Math.floor(v / 2 ** b) - HALF);
};
const valueFor = (index: number) => {
  let b = (index >> HALF_MAG) - 1;
  let sub = (index & (HALF - 1)) + HALF;
  if (b < 0) {
    sub -= HALF;
    b = 0;
  }
  return sub * 2 ** b;
};
const highestEquivalent = (v: number) => {
  const b = bucketFor(v);
  return Math.floor(v / 2 ** b) * 2 ** b + 2 ** b - 1;
};

export class Histogram {
  /** u8 counts: a count saturates at 255 (Convex's `Histogram<u8>`). */
  readonly counts = new Uint8Array(COUNTS);
  /** Every sample recorded (not saturating), as HdrHistogram's `total_count`. */
  total = 0;

  /** A duration in ms: whole ms, clamped to 1 ms – 15 min (Convex's `HistogramBucket::record`). */
  record(ms: number) {
    const v = Math.min(Math.max(Math.floor(ms), 1), MAX_DURATION_MS);
    const i = indexFor(v);
    if (this.counts[i]! < 255) this.counts[i]!++;
    this.total++;
  }

  /** HdrHistogram's `add`: into an empty one, a copy (total included); else counts saturate, and the total grows by the source's counts. */
  add(src: Histogram) {
    if (src.total === 0) return;
    if (this.total === 0) {
      this.counts.set(src.counts);
      this.total = src.total;
      return;
    }
    let observed = 0;
    for (let i = 0; i < COUNTS; i++) {
      const c = src.counts[i]!;
      if (c === 0) continue;
      this.counts[i] = Math.min(255, this.counts[i]! + c);
      observed += c;
    }
    this.total += observed;
  }

  /** HdrHistogram's `value_at_percentile`: the highest equivalent value; 0 when the target is never reached. */
  valueAtPercentile(p: number): number {
    const q = Math.min(p / 100, 1);
    let target = Math.ceil(q * this.total);
    if (target === 0) target = 1;
    let sum = 0;
    for (let i = 0; i < COUNTS; i++) {
      sum += this.counts[i]!;
      if (sum >= target) {
        const v = valueFor(i);
        return q === 0 ? v : highestEquivalent(v);
      }
    }
    return 0;
  }
}

// ---------------------------------------------------------------- the store

type Kind = "counter" | "gauge" | "histogram";
type Metric = { kind: Kind; buckets: Map<number, number | Histogram> };

export class MetricStore {
  private metrics = new Map<string, Metric>();
  /** The newest bucket with any sample, across every metric. */
  private maxIndex = -1;

  constructor(
    /** Wall-clock ms at the store's creation: bucket i is `[base + i·width, base + (i+1)·width)`. */
    readonly base = Date.now(),
    readonly width = BUCKET_WIDTH_MS,
    readonly maxBuckets = MAX_BUCKETS,
  ) {}

  /** The bucket of `ts`, or null for a sample Convex refuses: before the base, or before the newest bucket. */
  private indexOf(ts: number): number | null {
    if (ts < this.base) return null;
    const i = Math.floor((ts - this.base) / this.width);
    return i < this.maxIndex ? null : i;
  }

  private metric(name: string, kind: Kind): Metric | null {
    let m = this.metrics.get(name);
    if (!m) {
      m = { kind, buckets: new Map() };
      this.metrics.set(name, m);
    }
    return m.kind === kind ? m : null;
  }

  /** Each `add*` is false for a sample dropped (late, or of another kind than the metric's), as Convex's errors. */
  addCounter(name: string, ts: number, value: number): boolean {
    return this.add(name, "counter", ts, (old) => f32((old as number | undefined) ?? 0) + f32(value));
  }

  addGauge(name: string, ts: number, value: number): boolean {
    return this.add(name, "gauge", ts, () => f32(value));
  }

  /** Keep the bucket's highest value (Convex's `add_gauge_max`). */
  addGaugeMax(name: string, ts: number, value: number): boolean {
    return this.add(name, "gauge", ts, (old) => (old === undefined ? f32(value) : Math.max(old as number, f32(value))));
  }

  addHistogram(name: string, ts: number, ms: number): boolean {
    return this.add(name, "histogram", ts, (old) => {
      const h = (old as Histogram | undefined) ?? new Histogram();
      h.record(ms);
      return h;
    });
  }

  private add(
    name: string,
    kind: Kind,
    ts: number,
    update: (old: number | Histogram | undefined) => number | Histogram,
  ) {
    const i = this.indexOf(ts);
    if (i === null) return false;
    const m = this.metric(name, kind);
    if (!m) return false;
    const old = m.buckets.get(i);
    m.buckets.set(i, f32Safe(update(old)));
    if (old === undefined) {
      if (i > this.maxIndex) this.maxIndex = i;
      this.prune();
    }
    return true;
  }

  /** Drop the buckets older than the newest `maxBuckets`, and the metrics left empty. */
  private prune() {
    const cutoff = this.maxIndex - this.maxBuckets;
    if (cutoff < 0) return;
    for (const [name, m] of this.metrics) {
      for (const i of m.buckets.keys()) if (i <= cutoff) m.buckets.delete(i);
      if (m.buckets.size === 0) this.metrics.delete(name);
    }
  }

  names(kind: Kind): string[] {
    return [...this.metrics].filter(([, m]) => m.kind === kind).map(([n]) => n);
  }

  /** The kept buckets: `[newest − maxBuckets + 1, newest]`, or null when empty (Convex's `bucket_index_range`). */
  indexRange(): [number, number] | null {
    if (this.maxIndex < 0 || this.metrics.size === 0) return null;
    return [Math.max(0, this.maxIndex - this.maxBuckets + 1), this.maxIndex];
  }

  bucketStartNs(i: number): bigint {
    return BigInt(this.base + i * this.width) * 1_000_000n;
  }

  /** A metric's buckets covering `[start, end)` (ns), oldest first. */
  query(name: string, kind: Kind, start: bigint, end: bigint): { index: number; value: number | Histogram }[] {
    const m = this.metrics.get(name);
    if (!m) return [];
    if (m.kind !== kind) throw new Error(`Metric type mismatch: ${kind} != ${m.kind}`);
    const at = (ns: bigint) => {
      const ms = Number(ns / 1_000_000n);
      return ms < this.base ? 0 : Math.floor((ms - this.base) / this.width);
    };
    const [lo, hi] = [at(start), at(end - 1n)];
    return [...m.buckets]
      .filter(([i]) => i >= lo && i <= hi)
      .sort(([a], [b]) => a - b)
      .map(([index, value]) => ({ index, value }));
  }
}

const f32Safe = (v: number | Histogram) => (typeof v === "number" ? f32(v) : v);

// ---------------------------------------------------------------- windows and resampling

/** A value of a series: Convex's `(SystemTime, Option<f64>)`. */
export type Point = [time: bigint, value: number | null];
export type Timeseries = Point[];

/** Convex's `MetricsWindow`: `[start, end)` in ns, split into `numBuckets`. */
export class MetricsWindow {
  readonly width: bigint;
  constructor(
    readonly start: bigint,
    readonly end: bigint,
    readonly numBuckets: number,
  ) {
    this.width = (end - start) / BigInt(numBuckets);
  }

  /** The `window` query parameter: `{start, end}` as `{secs_since_epoch, nanos_since_epoch}`, `num_buckets`. */
  static parse(raw: string): MetricsWindow {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const time = (v: unknown, field: string): bigint => {
      const t = v as { secs_since_epoch?: unknown; nanos_since_epoch?: unknown } | null;
      if (typeof t !== "object" || t === null) throw new Error(`invalid type for \`${field}\``);
      const { secs_since_epoch: s, nanos_since_epoch: n } = t;
      if (!Number.isInteger(s) || (s as number) < 0) throw new Error("missing field `secs_since_epoch`");
      if (!Number.isInteger(n) || (n as number) < 0) throw new Error("missing field `nanos_since_epoch`");
      return BigInt(s as number) * 1_000_000_000n + BigInt(n as number);
    };
    if (json === null || typeof json !== "object") throw new Error("invalid type: expected struct MetricsWindowInner");
    for (const f of ["start", "end", "num_buckets"]) if (!(f in json)) throw new Error(`missing field \`${f}\``);
    const start = time(json.start, "start");
    const end = time(json.end, "end");
    const n = json.num_buckets;
    if (!Number.isInteger(n) || (n as number) < 0) throw new Error("invalid value for `num_buckets`");
    if (end < start) throw new Error(`Invalid query window: ${debugTime(end)} < ${debugTime(start)}`);
    if (n === 0 || (n as number) > 10000) throw new Error(`Invalid query num_buckets: ${n}`);
    return new MetricsWindow(start, end, n as number);
  }

  bucketStart(i: number): bigint {
    return this.start + this.width * BigInt(i);
  }

  contains(ns: bigint) {
    return ns >= this.start && ns < this.end;
  }

  /** Convex's `bucket_index`: in f64 seconds. */
  bucketIndex(ns: bigint): number {
    const secs = (d: bigint) => Number(d / 1_000_000_000n) + Number(d % 1_000_000_000n) / 1e9;
    return Math.min(this.numBuckets - 1, Math.floor(secs(ns - this.start) / secs(this.width)));
  }

  private empty(): Timeseries {
    return Array.from({ length: this.numBuckets }, (_, i) => [this.bucketStart(i), null] as Point);
  }

  /** Convex's `resample_counters`: 0 where the store has data, each bucket added by its start; a rate per second. */
  resampleCounters(store: MetricStore, buckets: { index: number; value: number | Histogram }[], rate: boolean) {
    const out = this.empty();
    const range = store.indexRange();
    if (!range) return out;
    for (let i = range[0]; i <= range[1]; i++) {
      const s = store.bucketStartNs(i);
      if (this.contains(s)) out[this.bucketIndex(s)]![1] = 0;
    }
    for (const b of buckets) {
      const s = store.bucketStartNs(b.index);
      if (this.contains(s)) {
        const p = out[this.bucketIndex(s)]!;
        p[1] = (p[1] ?? 0) + (b.value as number);
      }
    }
    if (rate) {
      const w = Number(this.width) / 1e9;
      for (const p of out) if (p[1] !== null) p[1] /= w;
    }
    return out;
  }

  /** Convex's `resample_gauges`: the last value per bucket, carried forward between the first and last set. */
  resampleGauges(store: MetricStore, buckets: { index: number; value: number | Histogram }[]) {
    const out = this.empty();
    if (!store.indexRange()) return out;
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (const b of buckets) {
      const s = store.bucketStartNs(b.index);
      if (!this.contains(s)) continue;
      const i = this.bucketIndex(s);
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
      out[i]![1] = b.value as number;
    }
    let last: number | null = null;
    for (let i = lo; i <= hi; i++) {
      const p = out[i]!;
      if (p[1] !== null) last = p[1];
      else p[1] = last;
    }
    return out;
  }

  /** Convex's `resample_histograms`: per percentile, the merged histogram's value in seconds. */
  resampleHistograms(
    store: MetricStore,
    buckets: { index: number; value: number | Histogram }[],
    percentiles: number[],
  ) {
    if (percentiles.length > 5) throw new Error(`Invalid query percentiles: ${percentiles.length}`);
    const hists: (Histogram | null)[] = Array.from({ length: this.numBuckets }, () => null);
    const range = store.indexRange();
    if (range) {
      for (let i = range[0]; i <= range[1]; i++) {
        const s = store.bucketStartNs(i);
        if (this.contains(s)) hists[this.bucketIndex(s)] = new Histogram();
      }
      for (const b of buckets) {
        const s = store.bucketStartNs(b.index);
        if (this.contains(s)) hists[this.bucketIndex(s)]!.add(b.value as Histogram);
      }
    }
    // As Convex's `BTreeMap<Percentile, _>`: by percentile, each once.
    return [...new Set(percentiles)]
      .sort((a, b) => a - b)
      .map((p): [number, Timeseries] => [
        p,
        hists.map((h, i): Point => {
          if (!h) return [this.bucketStart(i), null];
          let ms = h.valueAtPercentile(p);
          if (h.total !== 0) ms = Math.max(1, ms);
          return [this.bucketStart(i), ms / 1000];
        }),
      ]);
  }
}

/** Rust's `SystemTime` debug form, for the window errors. */
function debugTime(ns: bigint) {
  return `SystemTime { tv_sec: ${ns / 1_000_000_000n}, tv_nsec: ${ns % 1_000_000_000n} }`;
}

/** A series as Convex serializes it: times as `{secs_since_epoch, nanos_since_epoch}`, NaN and ±∞ as null. */
export function seriesJson(ts: Timeseries) {
  return ts.map(([t, v]) => [
    { secs_since_epoch: Number(t / 1_000_000_000n), nanos_since_epoch: Number(t % 1_000_000_000n) },
    v === null || !Number.isFinite(v) ? null : v,
  ]);
}

export function sumSeries(w: MetricsWindow, series: Iterable<Timeseries>): Timeseries {
  const out: Timeseries = Array.from({ length: w.numBuckets }, (_, i) => [w.bucketStart(i), null]);
  for (const s of series)
    s.forEach(([, v], i) => {
      if (v !== null) out[i]![1] = (out[i]![1] ?? 0) + v;
    });
  return out;
}

export const mergeSeries = (
  a: Timeseries,
  b: Timeseries,
  merge: (x: number | null, y: number | null) => number | null,
): Timeseries => a.map(([t, x], i) => [t, merge(x, b[i]![1])]);

/** numerator / denominator × 100, as Convex's `percentage`. */
export function percentage(n: number | null, d: number | null): number | null {
  if (n !== null && d !== null) return (n / d) * 100;
  if (n === null && d !== null) return 0;
  if (n !== null && d === null) return 100;
  return null;
}

/** hits / (hits + misses) × 100, as Convex's `cache_hit_percentage`. */
export function cacheHitPercentage(h: number | null, m: number | null): number | null {
  if (h !== null && m !== null) return (h / (h + m)) * 100;
  if (h !== null) return 100;
  if (m !== null) return 0;
  return null;
}

// ---------------------------------------------------------------- what is recorded, and the queries

/** A finished execution, as the function log has it (function-log.ts `Completion`). */
export type Execution = {
  udfType: "Query" | "Mutation" | "Action" | "HttpAction";
  /** The metric name: `module.js:function`, or an HTTP action's route path. */
  name: string;
  /** When it was logged, wall-clock ms. */
  at: number;
  failed: boolean;
  cached: boolean;
  /** Seconds. */
  executionTime: number;
  tables?: ReadonlyMap<string, { rowsRead: number; rowsWritten: number }>;
};

export type UdfRateMetric = "invocations" | "errors" | "cacheHits" | "cacheMisses" | "subscriptionInvalidations";
export type TableRateMetric = "rowsRead" | "rowsWritten";

const udf = (name: string, metric: string) => `udf:${name}:${metric}`;
/** Convex's `outstanding_functions:{env}:{UdfType}:{state}`. */
export const outstandingMetric = (env: "isolate" | "node", udfType: string, state: "running" | "queued") =>
  `outstanding_functions:${env}:${udfType}:${state}`;
const NEXT_JOB_TS = "scheduled_jobs:next_ts";

/** Convex's `FunctionExecutionLog` metrics, over one `MetricStore`. */
export class AppMetrics {
  constructor(
    readonly store = new MetricStore(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Metric names, built once per function and table (bounded: names come from code and the schema). */
  private udfNames = new Map<string, Record<"inv" | "err" | "hit" | "miss" | "time", string>>();
  private tableNames = new Map<string, [read: string, written: string]>();

  /** Convex's `log_execution_app_metrics`: stops at the first sample refused (a late one). */
  recordExecution(e: Execution) {
    const s = this.store;
    let n = this.udfNames.get(e.name);
    if (!n) {
      if (this.udfNames.size >= 10_000) this.udfNames.clear();
      n = {
        inv: udf(e.name, "invocations"),
        err: udf(e.name, "errors"),
        hit: udf(e.name, "cache_hits"),
        miss: udf(e.name, "cache_misses"),
        time: udf(e.name, "execution_time"),
      };
      this.udfNames.set(e.name, n);
    }
    if (!s.addCounter(n.inv, e.at, 1)) return;
    if (e.failed && !s.addCounter(n.err, e.at, 1)) return;
    if (e.udfType === "Query" && !s.addCounter(e.cached ? n.hit : n.miss, e.at, 1)) return;
    // Convex records the time as f32 seconds, then whole milliseconds.
    if (!s.addHistogram(n.time, e.at, Math.fround(e.executionTime) * 1000)) return;
    for (const [table, st] of e.tables ?? []) {
      let t = this.tableNames.get(table);
      if (!t) {
        if (this.tableNames.size >= 10_000) this.tableNames.clear();
        t = [`table:${table}:rows_read`, `table:${table}:rows_written`];
        this.tableNames.set(table, t);
      }
      if (!s.addCounter(t[0], e.at, st.rowsRead)) return;
      if (!s.addCounter(t[1], e.at, st.rowsWritten)) return;
    }
  }

  /**
   * Convex's `record_subscription_invalidations`: per committed mutation (its write source), the number of
   * subscriptions it invalidated per table.
   */
  recordInvalidations(source: string, perTable: ReadonlyMap<string, number>) {
    const at = this.now();
    for (const [table, n] of perTable) this.store.addCounter(`subscription_invalidations:${source}:${table}`, at, n);
  }

  /** Convex's `log_scheduled_job_stats`: now − the next job's time in seconds (−∞ with none); a late sample moves to the cutoff. */
  recordScheduledJobs(nextJobMs: number | null, at = this.now()) {
    const value = (t: number) => (nextJobMs === null ? Number.NEGATIVE_INFINITY : (t - nextJobMs) / 1000);
    if (this.store.addGauge(NEXT_JOB_TS, at, value(at))) return;
    const range = this.store.indexRange();
    if (!range) return;
    const cutoff = this.store.base + range[1] * this.store.width;
    this.store.addGauge(NEXT_JOB_TS, cutoff, value(cutoff));
  }

  /** Convex's `log_outstanding_functions`: the bucket's highest count. */
  recordOutstanding(env: "isolate" | "node", udfType: string, running: number, queued: number) {
    const at = this.now();
    this.store.addGaugeMax(outstandingMetric(env, udfType, "running"), at, running);
    this.store.addGaugeMax(outstandingMetric(env, udfType, "queued"), at, queued);
  }

  // ---- queries

  private counter(name: string, w: MetricsWindow, rate: boolean) {
    return w.resampleCounters(this.store, this.store.query(name, "counter", w.start, w.end), rate);
  }

  udfRate(name: string, metric: UdfRateMetric, w: MetricsWindow): Timeseries {
    if (metric === "subscriptionInvalidations") {
      const byTable = this.invalidations(w, name);
      return byTable.size === 0 ? w.resampleCounters(this.store, [], true) : sumSeries(w, byTable.values());
    }
    const suffix = {
      invocations: "invocations",
      errors: "errors",
      cacheHits: "cache_hits",
      cacheMisses: "cache_misses",
    }[metric];
    return this.counter(udf(name, suffix), w, true);
  }

  cacheHitPercentage(name: string, w: MetricsWindow): Timeseries {
    const hits = this.counter(udf(name, "cache_hits"), w, false);
    const misses = this.counter(udf(name, "cache_misses"), w, false);
    return mergeSeries(hits, misses, cacheHitPercentage);
  }

  /** Every function's counts of `metric` (Convex's `get_udf_metric_counter`: names `udf…<metric>`). */
  private perFunction(w: MetricsWindow, metric: string): Map<string, Timeseries> {
    const out = new Map<string, Timeseries>();
    for (const n of this.store.names("counter"))
      if (n.startsWith("udf") && n.endsWith(metric)) {
        const parts = n.split(":");
        out.set(parts.slice(1, -1).join(":"), this.counter(n, w, false));
      }
    return out;
  }

  /** Convex's `subscription_invalidations:` counters, keyed `mutation:table` (or `table` for one mutation). */
  private invalidations(w: MetricsWindow, mutation?: string): Map<string, Timeseries> {
    const all = "subscription_invalidations:";
    const prefix = mutation === undefined ? all : `${all}${mutation}:`;
    const out = new Map<string, Timeseries>();
    for (const n of this.store.names("counter"))
      if (n.startsWith(prefix)) out.set(n.slice(prefix.length), this.counter(n, w, false));
    return out;
  }

  failurePercentageTopK(w: MetricsWindow, k: number) {
    return topKForRate(w, this.perFunction(w, "errors"), this.perFunction(w, "invocations"), k, percentage, false);
  }

  cacheHitPercentageTopK(w: MetricsWindow, k: number) {
    return topKForRate(
      w,
      this.perFunction(w, "cache_hits"),
      this.perFunction(w, "cache_misses"),
      k,
      cacheHitPercentage,
      true,
    );
  }

  functionCallCountTopK(w: MetricsWindow, k: number) {
    return topKOfCounts(w, this.perFunction(w, "invocations"), k);
  }

  subscriptionInvalidationsTopK(w: MetricsWindow, k: number, mutation?: string) {
    return topKOfCounts(w, this.invalidations(w, mutation), k);
  }

  latencyPercentiles(name: string, percentiles: number[], w: MetricsWindow) {
    const buckets = this.store.query(udf(name, "execution_time"), "histogram", w.start, w.end);
    return w.resampleHistograms(this.store, buckets, percentiles);
  }

  tableRate(table: string, metric: TableRateMetric, w: MetricsWindow): Timeseries {
    return this.counter(`table:${table}:${metric === "rowsRead" ? "rows_read" : "rows_written"}`, w, true);
  }

  /** Convex's `scheduled_job_lag`: gauges carried forward, a gap grows by the time passed, never below 0. */
  scheduledJobLag(w: MetricsWindow): Timeseries {
    const ts = w.resampleGauges(this.store, this.store.query(NEXT_JOB_TS, "gauge", w.start, w.end));
    for (let i = 1; i < ts.length; i++) {
      const prev = ts[i - 1]![1];
      if (ts[i]![1] === null && prev !== null) ts[i]![1] = prev + Number(ts[i]![0] - ts[i - 1]![0]) / 1e9;
    }
    for (const p of ts) if (p[1] !== null) p[1] = Math.max(p[1], 0);
    return ts;
  }

  functionConcurrency(w: MetricsWindow): [string, Timeseries][] {
    return this.store
      .names("gauge")
      .filter((n) => n.startsWith("outstanding_functions:"))
      .sort()
      .map((n) => [n, w.resampleGauges(this.store, this.store.query(n, "gauge", w.start, w.end))]);
  }
}

/** Convex's `top_k`: by total, then by name; `ascending` for the lowest first. */
function topK(totals: Map<string, number>, k: number, ascending: boolean): string[] {
  return [...totals]
    .sort(([n1, a], [n2, b]) => (ascending ? a - b : b - a) || (n1 < n2 ? -1 : n1 > n2 ? 1 : 0))
    .slice(0, k)
    .map(([n]) => n);
}

const total = (s: Timeseries): number | null => {
  let sum: number | null = null;
  for (const [, v] of s) if (v !== null) sum = (sum ?? 0) + v;
  return sum;
};

function topKOfCounts(w: MetricsWindow, series: Map<string, Timeseries>, k: number): [string, Timeseries][] {
  const totals = new Map<string, number>();
  for (const [n, s] of series) {
    const t = total(s);
    if (t !== null) totals.set(n, t);
  }
  const out: [string, Timeseries][] = [];
  for (const n of topK(totals, k, false)) {
    out.push([n, series.get(n)!]);
    series.delete(n);
  }
  if (series.size > 0) out.push(["_rest", sumSeries(w, series.values())]);
  return out;
}

/** Convex's `top_k_for_rate`: ranked by the rate over the whole window, the others merged into `_rest`. */
function topKForRate(
  w: MetricsWindow,
  ts1: Map<string, Timeseries>,
  ts2: Map<string, Timeseries>,
  k: number,
  merge: (a: number | null, b: number | null) => number | null,
  ascending: boolean,
): [string, Timeseries][] {
  const totals = new Map<string, number>();
  for (const [n, s] of ts1) {
    const other = ts2.get(n);
    const r = merge(total(s), other ? total(other) : null);
    if (r !== null) totals.set(n, r);
  }
  const out: [string, Timeseries][] = [];
  for (const n of topK(totals, k, ascending)) {
    const a = ts1.get(n)!;
    ts1.delete(n);
    const b = ts2.get(n) ?? a.map(([t]): Point => [t, null]);
    ts2.delete(n);
    out.push([n, mergeSeries(a, b, merge)]);
  }
  if (ts1.size > 0 || ts2.size > 0)
    out.push(["_rest", mergeSeries(sumSeries(w, ts1.values()), sumSeries(w, ts2.values()), merge)]);
  return out;
}
