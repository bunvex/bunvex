// The soak's pass/fail rules (STUDY-174 §2.4): pure functions over the samples a run took, so they are tested on
// their own (rules.test.ts) and a run's report can be re-judged from its JSON. A rule fails on a trend (a robust
// slope projected over the run, and a level shift between the first and last thirds) and not on one noisy sample.

/** One sample of the backend and the driver, every `sampleSeconds`. */
export type Sample = {
  /** Seconds since the workload started. */
  t: number;
  rssBytes: number;
  heapBytes: number;
  /** The index cache's estimate of what it holds (`bunvex_index_cache_bytes`), bounded by its budget. */
  indexCacheBytes: number;
  fds: number;
  /** Diagnostics, not judged: resident memory by kind (Linux only, else null) and the store's files. */
  detail?: { anonBytes: number | null; fileBytes: number | null; dbBytes: number; walBytes: number };
  /** Query cache hits and misses since the previous sample (`/metrics` counter deltas). */
  cacheHits: number;
  cacheMisses: number;
  /** The backend's gauges. */
  sessions: number;
  subscriptions: number;
  roomMembers: number;
  /** What the driver had open when it sampled, and how many clients it replaced in the last 10 s. */
  clients: number;
  subscriptionsOpen: number;
  recentReconnects: number;
  /** Latency over the window since the previous sample, per operation, in ms (null: no call). */
  latency: Record<string, { p50: number; p99: number; n: number } | null>;
  eventLoopLagSeconds: number;
  /** Scheduler backlog (`bunvex_scheduled_job_backlog_seconds`). */
  backlogSeconds: number;
};

export type JobRecord = { seq: number; dueAt: number; ranAt: number | null; runs: number };

export type RunData = {
  durationSeconds: number;
  warmupSeconds: number;
  /**
   * The index cache's budget. Memory (R1, R2) is judged only from the first sample past the warm-up where the
   * index cache is 90 % full and the write log has reached its longest retention (300 s): before that, memory
   * grows by design.
   */
  indexCacheBudgetBytes: number;
  samples: Sample[];
  /** After the workload stopped and every client closed (the drain). */
  final: { sessions: number; subscriptions: number; roomMembers: number; fds: number };
  baselineFds: number;
  /** Backend CPU over the idle tail, as a share of one core (0.03 = 3 %). */
  idleCpu: number;
  /** Runs of the cache canary (cache misses) past the warm-up, and the writes into its read set then. */
  canary: { misses: number; writes: number; calls: number };
  jobs: JobRecord[];
  jobsScheduled: number;
  /** Function failures the workload did not ask for, and calls whose request failed. */
  unexpectedErrors: number;
};

export type RuleResult = { rule: string; pass: boolean; detail: string };

/** The Theil–Sen slope: the median of every pairwise slope, robust to a few outliers (GC, a reconnect burst). */
export function theilSen(xs: number[], ys: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) if (xs[j]! !== xs[i]!) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
  return slopes.length ? median(slopes) : 0;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** The first and last thirds of `xs`. */
function thirds<T>(xs: T[]): [T[], T[]] {
  const n = Math.floor(xs.length / 3);
  return [xs.slice(0, n), xs.slice(xs.length - n)];
}

const mb = (b: number) => `${(b / 2 ** 20).toFixed(1)} MB`;

/**
 * A resource that must not grow: fails when its robust slope is above `maxPerMinute` AND the last third's median is
 * above the first third's by more than `minShift`. Both: a slope alone can be one step (a cache filling), a level
 * shift alone can be noise. A rate, not a share of the run: a leak of 1 MB a minute is one whatever the run's length.
 */
export function growthRule(
  rule: string,
  samples: Sample[],
  value: (s: Sample) => number,
  maxPerMinute: number,
  minShift: number,
  fmt: (n: number) => string,
): RuleResult {
  if (samples.length < 6) return { rule, pass: true, detail: "too few samples to judge" };
  const xs = samples.map((s) => s.t);
  const ys = samples.map(value);
  const perMinute = theilSen(xs, ys) * 60;
  const [a, c] = thirds(ys);
  const shift = median(c) - median(a);
  const pass = !(perMinute > maxPerMinute && shift > minShift);
  return {
    rule,
    pass,
    detail: `slope ${fmt(perMinute)}/min (limit ${fmt(maxPerMinute)}), last-vs-first third ${fmt(shift)} (limit ${fmt(minShift)}); median ${fmt(median(ys))}`,
  };
}

/** The write log's longest retention (`WRITE_LOG_MAX_RETENTION_SECS`): it grows until then. */
const WRITE_LOG_MAX_RETENTION_S = 300;

/** When memory is at its steady state: past the warm-up and the write log's retention, the index cache 90 % full. */
export function memoryWarmup(run: RunData): number | null {
  const from = Math.max(run.warmupSeconds, WRITE_LOG_MAX_RETENTION_S);
  const s = run.samples.find((s) => s.t >= from && s.indexCacheBytes >= 0.9 * run.indexCacheBudgetBytes);
  return s ? s.t : null;
}

/** Every rule, on the samples past the warm-up. */
export function judge(run: RunData): RuleResult[] {
  const post = run.samples.filter((s) => s.t >= run.warmupSeconds);
  const out: RuleResult[] = [];

  // R1, R2: memory, once the bounded caches are full.
  const full = memoryWarmup(run);
  if (full === null)
    for (const rule of ["R1 RSS does not trend up", "R2 heap does not trend up"])
      out.push({
        rule,
        pass: true,
        detail: "not judged: the index cache never filled (a longer run, or a smaller cache)",
      });
  else {
    const steady = run.samples.filter((s) => s.t >= full);
    const at = `; judged from t=${Math.round(full)} s`;
    for (const r of [
      growthRule("R1 RSS does not trend up", steady, (s) => s.rssBytes, 0.5 * 2 ** 20, 10 * 2 ** 20, mb),
      growthRule("R2 heap does not trend up", steady, (s) => s.heapBytes, 0.3 * 2 ** 20, 8 * 2 ** 20, mb),
    ])
      out.push({ ...r, detail: r.detail + at });
  }

  // R3: the cache canary misses only after a write into what it read (one miss per write, and the first call).
  out.push({
    rule: "R3 the cache canary stays cached between writes",
    pass: run.canary.misses <= run.canary.writes + 1,
    detail: `${run.canary.misses} misses in ${run.canary.calls} calls past the warm-up; ${run.canary.writes} writes into its reads`,
  });

  // R4: the overall hit rate does not fall (per-window rates, robust slope projected over the span).
  const windows = post.filter((s) => s.cacheHits + s.cacheMisses > 0);
  if (windows.length >= 6) {
    const rate = windows.map((s) => s.cacheHits / (s.cacheHits + s.cacheMisses));
    const span = windows[windows.length - 1]!.t - windows[0]!.t;
    const drop =
      -theilSen(
        windows.map((s) => s.t),
        rate,
      ) * span;
    const [a, c] = thirds(rate);
    const shift = median(a) - median(c);
    out.push({
      rule: "R4 the cache hit rate does not fall",
      pass: !(drop > 0.1 && shift > 0.1),
      detail: `hit rate median ${(median(rate) * 100).toFixed(1)} %, projected change ${(-drop * 100).toFixed(1)} points, first-to-last third ${(-shift * 100).toFixed(1)} points`,
    });
  } else out.push({ rule: "R4 the cache hit rate does not fall", pass: true, detail: "too few windows" });

  // R5: the backend's sessions, subscriptions and room members follow what the driver has open.
  let worst = { d: 0, what: "" };
  for (const s of post) {
    const allowance = 3 + s.recentReconnects;
    const checks: [string, number][] = [
      ["sessions", s.sessions - s.clients],
      ["subscriptions", s.subscriptions - s.subscriptionsOpen],
      ["room members", s.roomMembers - s.clients],
    ];
    for (const [what, d] of checks) {
      const over = Math.abs(d) - allowance;
      if (over > worst.d) worst = { d: over, what: `${what} off by ${d} at t=${Math.round(s.t)} s` };
    }
  }
  out.push({
    rule: "R5 sessions, subscriptions and room members match the open clients",
    pass: worst.d <= 0,
    detail: worst.d > 0 ? worst.what : "within the reconnect allowance at every sample",
  });
  out.push({
    rule: "R6 everything is freed after the clients close",
    pass: run.final.sessions === 0 && run.final.subscriptions === 0 && run.final.roomMembers === 0,
    detail: `sessions ${run.final.sessions}, subscriptions ${run.final.subscriptions}, room members ${run.final.roomMembers}`,
  });

  // R7: file descriptors: no trend while running, back near the baseline after the drain.
  const fd = growthRule(
    "R7a file descriptors do not trend up",
    post,
    (s) => s.fds,
    0.2,
    4,
    (n) => n.toFixed(1),
  );
  out.push(fd);
  out.push({
    rule: "R7b file descriptors return to the baseline",
    pass: run.final.fds <= run.baselineFds + 8,
    detail: `baseline ${run.baselineFds}, after the drain ${run.final.fds}`,
  });

  // R8: latency: the last third's p50 and p99 are not much above the first third's.
  const ops = new Set(post.flatMap((s) => Object.keys(s.latency)));
  for (const op of [...ops].sort()) {
    const ws = post.map((s) => s.latency[op]).filter((l): l is NonNullable<typeof l> => l != null && l.n >= 5);
    if (ws.length < 6) continue;
    const [a, c] = thirds(ws);
    const p99a = median(a.map((w) => w.p99));
    const p99c = median(c.map((w) => w.p99));
    const p50a = median(a.map((w) => w.p50));
    const p50c = median(c.map((w) => w.p50));
    const pass = !(p99c > 1.5 * p99a && p99c > p99a + 20) && !(p50c > 1.3 * p50a && p50c > p50a + 10) && p99c < 1000;
    out.push({
      rule: `R8 ${op} latency does not trend up`,
      pass,
      detail: `p50 ${p50a.toFixed(1)} → ${p50c.toFixed(1)} ms, p99 ${p99a.toFixed(1)} → ${p99c.toFixed(1)} ms (first → last third)`,
    });
  }

  // R9: the scheduler: every job ran exactly once; its lag stays small and flat.
  const ran = run.jobs.filter((j) => j.runs >= 1 && j.ranAt !== null);
  const twice = run.jobs.filter((j) => j.runs > 1).length;
  out.push({
    rule: "R9a every scheduled job ran exactly once",
    pass: run.jobs.length === run.jobsScheduled && ran.length === run.jobsScheduled && twice === 0,
    detail: `${run.jobsScheduled} scheduled, ${run.jobs.length} recorded, ${ran.length} ran, ${twice} ran more than once`,
  });
  const post0 = run.jobs.length ? Math.min(...run.jobs.map((j) => j.dueAt)) : 0;
  const lagWindows = new Map<number, number[]>();
  for (const j of ran) {
    const t = (j.dueAt - post0) / 1000;
    if (t < run.warmupSeconds) continue;
    const w = Math.floor(t / 60);
    if (!lagWindows.has(w)) lagWindows.set(w, []);
    lagWindows.get(w)!.push(j.ranAt! - j.dueAt);
  }
  const lagP99 = [...lagWindows.entries()].sort((a, b) => a[0] - b[0]).map(([w, l]) => [w * 60, percentile(l, 99)]);
  const worstLag = Math.max(0, ...lagP99.map(([, l]) => l!));
  const lagGrowth =
    lagP99.length >= 6
      ? theilSen(
          lagP99.map(([t]) => t!),
          lagP99.map(([, l]) => l!),
        ) *
        (lagP99[lagP99.length - 1]![0]! - lagP99[0]![0]!)
      : 0;
  out.push({
    rule: "R9b scheduler lag stays under 2 s and does not trend up",
    pass: worstLag <= 2000 && lagGrowth <= 1000,
    detail: `worst per-minute p99 ${Math.round(worstLag)} ms, projected growth ${Math.round(lagGrowth)} ms`,
  });

  // R10: the event loop stays responsive. Each sample is the last 500 ms probe's lateness, so one GC pause can land
  // on a sample: the rule counts samples over 200 ms, and fails past 5 % of them.
  const lag = post.map((s) => s.eventLoopLagSeconds * 1000);
  const late = lag.filter((l) => l > 200).length;
  out.push({
    rule: "R10 event loop lag over 200 ms in at most 5 % of samples",
    pass: !(late > 0.05 * lag.length),
    detail: `${late} of ${lag.length} samples over 200 ms; median ${median(lag).toFixed(1)} ms, max ${Math.max(0, ...lag).toFixed(1)} ms`,
  });

  // R11: an idle backend costs (almost) nothing: no loop polls while nothing is due.
  out.push({
    rule: "R11 an idle backend uses under 3 % of a core",
    pass: run.idleCpu < 0.03,
    detail: `${(run.idleCpu * 100).toFixed(1)} % of a core over the idle tail`,
  });

  out.push({
    rule: "R12 no unexpected errors",
    pass: run.unexpectedErrors === 0,
    detail: `${run.unexpectedErrors} unexpected errors`,
  });
  return out;
}
