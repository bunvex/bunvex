// The contract suite's part for metrics (UI-01 §18, data-source-metrics.ts). Read-only, so it always runs
// when the source offers metrics and the credential may view them. The window ends at the newest log line,
// so a source with history in the past (a fixture) is measured where it has data.
import { expect } from "bun:test";
import {
  bucketStarts,
  type DashboardDataSource,
  DataSourceError,
  type MetricsWindow,
  REST,
  type Timeseries,
} from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
};

async function setup(src: DashboardDataSource) {
  const caps = await src.getCapabilities();
  if (!caps.operations.includes("viewMetrics")) return null;
  const newest = (await src.listLogs({ numItems: 1, cursor: null })).page[0];
  const end = (newest?.time ?? Date.now()) + 1;
  const window: MetricsWindow = { start: end - 6 * 3_600_000, end, numBuckets: 24 };
  const functions = await src.listFunctions();
  return { window, functions, query: functions.find((f) => f.kind === "query")?.path };
}

/** One bucket per window bucket, at the bucket's start, each a number (≥ 0) or null. */
function expectSeries(s: Timeseries, w: MetricsWindow, max = Number.POSITIVE_INFINITY) {
  expect(s.map((b) => b.time)).toEqual(bucketStarts(w));
  for (const b of s) if (b.value !== null) expect(b.value >= 0 && b.value <= max).toBe(true);
}

export function describeMetricsContract({ make, test }: Ctx) {
  test("function metrics (when offered): a bucket per window bucket; errors and cache hits within the calls", async () => {
    const src = await make();
    const s = src.functionRate ? await setup(src) : null;
    if (!s?.query || !src.functionRate) return;
    const [calls, errors, hits, misses] = await Promise.all(
      (["invocations", "errors", "cacheHits", "cacheMisses"] as const).map((m) =>
        src.functionRate!(s.query!, m, s.window),
      ),
    );
    for (const series of [calls!, errors!, hits!, misses!]) expectSeries(series, s.window);
    calls!.forEach((b, i) => {
      expect(errors![i]!.value ?? 0).toBeLessThanOrEqual(b.value ?? 0);
      expect((hits![i]!.value ?? 0) + (misses![i]!.value ?? 0)).toBeLessThanOrEqual(b.value ?? 0);
    });
    if (src.cacheHitPercentage) expectSeries(await src.cacheHitPercentage(s.query, s.window), s.window, 100);
  });

  test("latency percentiles (when offered): one series per percentile, in order, never decreasing", async () => {
    const src = await make();
    const s = src.latencyPercentiles ? await setup(src) : null;
    if (!s?.functions[0] || !src.latencyPercentiles) return;
    const fn = s.functions[0].path;
    const got = await src.latencyPercentiles(fn, [50, 90, 99], s.window);
    expect(got.map((p) => p.percentile)).toEqual([50, 90, 99]);
    for (const p of got) expectSeries(p.series, s.window);
    got[0]!.series.forEach((b, i) => {
      const values = got.map((p) => p.series[i]!.value);
      if (b.value !== null && values.every((v) => v !== null))
        expect([...(values as number[])].sort((x, y) => x - y)).toEqual(values as number[]);
    });
  });

  test("top functions (when offered): at most k and the rest; percentages 0–100; calls ranked", async () => {
    const src = await make();
    const s = src.topFunctions ? await setup(src) : null;
    if (!s || !src.topFunctions) return;
    for (const measure of ["invocations", "failurePercentage", "cacheHitPercentage"] as const) {
      const top = await src.topFunctions(measure, s.window, 3);
      expect(top.filter((t) => t.function !== REST).length).toBeLessThanOrEqual(3);
      expect(top.filter((t) => t.function === REST).length).toBeLessThanOrEqual(1);
      for (const t of top) expectSeries(t.series, s.window, measure === "invocations" ? undefined : 100);
      if (measure === "invocations") {
        const totals = top
          .filter((t) => t.function !== REST)
          .map((t) => t.series.reduce((n, b) => n + (b.value ?? 0), 0));
        expect([...totals].sort((a, b) => b - a)).toEqual(totals);
      }
    }
  });

  test("table metrics (when offered): rows read and written per bucket; an unknown table is not found", async () => {
    const src = await make();
    const s = src.tableRate ? await setup(src) : null;
    if (!s || !src.tableRate) return;
    const table = (await src.listTables())[0]?.name;
    if (table)
      for (const m of ["rowsRead", "rowsWritten"] as const)
        expectSeries(await src.tableRate(table, m, s.window), s.window);
    const missing = await src.tableRate("no_such_table_here", "rowsRead", s.window).catch((e: unknown) => e);
    expect(missing instanceof DataSourceError && missing.code === "not_found").toBe(true);
  });

  test("metrics windows (when offered): a window without buckets is refused as invalid_request", async () => {
    const src = await make();
    const s = src.functionRate ? await setup(src) : null;
    if (!s?.functions[0] || !src.functionRate) return;
    const bad = await src
      .functionRate(s.functions[0].path, "invocations", { ...s.window, numBuckets: 0 })
      .catch((e: unknown) => e);
    expect(bad instanceof DataSourceError && bad.code === "invalid_request").toBe(true);
  });
}
