// The app metrics (STUDY-58), as Convex's udf_metrics and function_log: the store's buckets and retention,
// HdrHistogram's percentiles (u8 counts included), the resampling into a window, the top-k rankings, and
// `/api/app_metrics/*` fed by real function calls, table reads and writes, and subscriptions.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import {
  AppMetrics,
  HISTOGRAM_BOUNDS,
  Histogram,
  histogramLayout,
  MetricStore,
  MetricsWindow,
} from "../src/app-metrics.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const MIN = 60_000;
const BASE = 1_700_000_000_000;
const ns = (ms: number) => BigInt(ms) * 1_000_000n;
const win = (startMs: number, endMs: number, n: number) => new MetricsWindow(ns(startMs), ns(endMs), n);
const values = (ts: [bigint, number | null][]) => ts.map(([, x]) => x);

describe("HdrHistogram (1 ms – 15 min, 2 significant figures)", () => {
  test("exact below 256 ms; above, the highest equivalent value", () => {
    const h = new Histogram();
    for (let ms = 1; ms <= 100; ms++) h.record(ms);
    expect([50, 99, 100].map((p) => h.valueAtPercentile(p))).toEqual([50, 99, 100]);
    const big = new Histogram();
    big.record(1000);
    // 1000 is in the bucket of width 4 starting at 1000.
    expect(big.valueAtPercentile(50)).toBe(1003);
    // Clamped to 1 ms – 15 min.
    const edge = new Histogram();
    edge.record(0.2);
    expect(edge.valueAtPercentile(100)).toBe(1);
  });

  test("u8 counts saturate at 255, and a merge copies the total: high percentiles fall through to 0", () => {
    const h = new Histogram();
    for (let i = 0; i < 300; i++) h.record(5);
    expect([h.counts.reduce((a, b) => a + b, 0), h.total]).toEqual([255, 300]);
    const merged = new Histogram();
    merged.add(h);
    expect(merged.valueAtPercentile(50)).toBe(5);
    // ceil(0.99 × 300) = 297 > 255: never reached.
    expect(merged.valueAtPercentile(99)).toBe(0);
  });
});

describe("the store and the window", () => {
  test("counters: rates per second, 0 where the store has data, null outside; late samples dropped", () => {
    const s = new MetricStore(BASE);
    expect(s.addCounter("c", BASE + 10, 3)).toBe(true);
    expect(s.addCounter("c", BASE + 2 * MIN + 5, 6)).toBe(true);
    // Before the newest bucket (across every metric): dropped.
    expect(s.addCounter("other", BASE + MIN, 1)).toBe(false);
    const w = win(BASE - MIN, BASE + 4 * MIN, 5);
    const ts = w.resampleCounters(s, s.query("c", "counter", w.start, w.end), true);
    expect(values(ts)).toEqual([null, 3 / 60, 0, 6 / 60, null]);
    expect(ts[0]![0]).toBe(ns(BASE - MIN));
  });

  test("the last 60 buckets are kept; older ones, and metrics left empty, go", () => {
    const s = new MetricStore(BASE);
    s.addCounter("old", BASE, 1);
    s.addCounter("new", BASE + 60 * MIN, 1);
    expect(s.names("counter")).toEqual(["new"]);
    expect(s.indexRange()).toEqual([1, 60]);
  });

  test("gauges carry forward between samples; after the last, the lag grows; never below 0", () => {
    const m = new AppMetrics(new MetricStore(BASE));
    m.recordScheduledJobs(BASE - 30_000, BASE); // 30 s late
    m.recordScheduledJobs(null, BASE + 3 * MIN); // none left: −∞
    expect(values(m.scheduledJobLag(win(BASE, BASE + 4 * MIN, 4)))).toEqual([30, 30, 30, 0]);
    const late = new AppMetrics(new MetricStore(BASE));
    late.recordScheduledJobs(BASE - 30_000, BASE);
    late.store.addCounter("other", BASE + 2 * MIN, 1);
    expect(values(late.scheduledJobLag(win(BASE, BASE + 3 * MIN, 3)))).toEqual([30, 90, 150]);
  });

  test("the window's errors: Convex's checks", () => {
    const t = (secs: number) => ({ secs_since_epoch: secs, nanos_since_epoch: 0 });
    expect(() => MetricsWindow.parse(JSON.stringify({ start: t(10), end: t(5), num_buckets: 1 }))).toThrow(
      "Invalid query window",
    );
    expect(() => MetricsWindow.parse(JSON.stringify({ start: t(1), end: t(5), num_buckets: 0 }))).toThrow(
      "Invalid query num_buckets: 0",
    );
    expect(() => MetricsWindow.parse(JSON.stringify({ start: t(1), end: t(5), num_buckets: 10001 }))).toThrow(
      "Invalid query num_buckets: 10001",
    );
  });

  test("top k: by total then name, the rest summed; failure rates only for functions with errors", () => {
    const m = new AppMetrics(new MetricStore(BASE));
    const call = (name: string, n: number, failed = false) => {
      for (let i = 0; i < n; i++)
        m.recordExecution({ udfType: "Mutation", name, at: BASE, failed, cached: false, executionTime: 0.001 });
    };
    call("a.js:x", 3);
    call("b.js:y", 5);
    call("c.js:z", 3);
    call("c.js:z", 1, true);
    const w = win(BASE, BASE + MIN, 1);
    expect(m.functionCallCountTopK(w, 2).map(([n, ts]) => [n, values(ts)])).toEqual([
      ["b.js:y", [5]],
      ["c.js:z", [4]],
      ["_rest", [3]],
    ]);
    expect(m.failurePercentageTopK(w, 5).map(([n, ts]) => [n, values(ts)])).toEqual([
      ["c.js:z", [25]],
      ["_rest", [0]],
    ]);
  });
});

// ---------------------------------------------------------------- the routes, fed by real calls

const SECRET = "6b".repeat(32);
const NAME = "metrics-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 1 });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    list: query(async ({ db }) => (await db.query("items").collect()).length),
    // One row scanned, then one `get`: two rows read.
    byId: query(async ({ db }) => db.get(((await db.query("items").first()) as { _id: string })._id as never)),
    add: mutation(({ db }) => db.insert("items", {})),
    fail: mutation(() => {
      throw new Error("no");
    }),
    run: action(async ({ runQuery }) => runQuery("m:list" as never, {})),
    later: mutation(({ scheduler }) => scheduler.runAfter(3_600_000, "m:add" as never, {})),
  });
  const http = httpRouter();
  http.route({ pathPrefix: "/hook/", method: "GET", handler: httpAction(async () => new Response("ok")) });
  const s = createServer({ engine, functions, port: 0, http });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = (kind: string, path: string) =>
    fetch(`${api}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {} }),
    });
  const now = Date.now();
  const window = JSON.stringify({
    start: { secs_since_epoch: Math.floor(now / 1000) - 600, nanos_since_epoch: 0 },
    end: { secs_since_epoch: Math.floor(now / 1000) + 60, nanos_since_epoch: 0 },
    num_buckets: 1,
  });
  const get = async (route: string, params: Record<string, string>, key: string | null = KEY) => {
    const r = await fetch(`${api}/api/app_metrics/${route}?${new URLSearchParams({ window, ...params })}`, {
      headers: key ? { authorization: `Bunvex ${key}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  // The one bucket's value.
  const one = (series: [unknown, number | null][]) => series[0]![1];
  return { s, api, call, get, one, site: s.siteUrl! };
}

test("udf_rate, cache_hit_percentage, table_rate and latency_percentiles from real calls", async () => {
  const t = await setup();
  for (let i = 0; i < 3; i++) await t.call("mutation", "m:add");
  await t.call("mutation", "m:fail");
  await t.call("query", "m:list");
  await t.call("query", "m:byId");
  await t.call("query", "m:list"); // a cache hit
  await t.call("action", "m:run"); // runs m:list too: a miss, as an action's runQuery has a cache of its own
  await fetch(`${t.site}/hook/a`);
  await fetch(`${t.site}/hook/b`);
  const width = 660; // seconds in the one bucket
  const rate = async (udfPath: string, metric: string, udfType?: string) =>
    t.one((await t.get("udf_rate", { udfPath, metric, ...(udfType ? { udfType } : {}) })).body) ?? 0;
  expect(Math.round((await rate("m:add", "invocations")) * width)).toBe(3);
  expect(Math.round((await rate("m.js:fail", "errors")) * width)).toBe(1);
  expect(Math.round((await rate("m:list", "invocations")) * width)).toBe(3);
  expect(Math.round((await rate("m:list", "cacheHits")) * width)).toBe(1);
  expect(Math.round((await rate("m:run", "invocations")) * width)).toBe(1);
  // An HTTP action is named by its route's path (a prefix route's ends in `*`).
  expect(Math.round((await rate("GET /hook/*", "invocations", "HttpAction")) * width)).toBe(2);
  expect(t.one((await t.get("cache_hit_percentage", { udfPath: "m:list" })).body)).toBeCloseTo(100 / 3);
  const written = t.one((await t.get("table_rate", { name: "items", metric: "rowsWritten" })).body);
  expect(Math.round(written! * width)).toBe(3);
  const read = t.one((await t.get("table_rate", { name: "items", metric: "rowsRead" })).body);
  expect(Math.round(read! * width)).toBe(8); // the two uncached lists read the three rows each, byId two
  const lat = await t.get("latency_percentiles", { udfPath: "m:add", percentiles: "[99,50]" });
  expect(lat.body.map(([p]: [number]) => p)).toEqual([50, 99]);
  expect(lat.body[0][1][0][1]).toBeGreaterThan(0);
  // System functions are not measured.
  const top = await t.get("function_call_count_top_k", { k: "25" });
  expect(top.body.map(([n]: [string]) => n).sort()).toEqual([
    "/hook/*",
    "m.js:add",
    "m.js:byId",
    "m.js:fail",
    "m.js:list",
    "m.js:run",
  ]);
});

test("the routes' errors and access", async () => {
  const t = await setup();
  expect(await t.get("function_call_count_top_k", { k: "26" })).toEqual({
    status: 400,
    body: { code: "InvalidTopKParameter", message: "k must be between 1 and 25, got 26" },
  });
  expect(await t.get("function_call_count_top_k", { k: "x" })).toEqual({
    status: 400,
    body: { code: "BadQueryArgs", message: "Failed to deserialize query string: k: invalid digit found in string" },
  });
  expect((await t.get("udf_rate", { udfPath: "m:add" })).body).toEqual({
    code: "BadQueryArgs",
    message: "Failed to deserialize query string: missing field `metric`",
  });
  expect((await t.get("udf_rate", { udfPath: "m:add", metric: "nope" })).status).toBe(500);
  expect((await t.get("udf_rate", { udfPath: "m:add", metric: "errors", window: "{}" })).status).toBe(500);
  expect((await t.get("scheduled_job_lag", {}, null)).status).toBe(403);
  // The arguments come before ViewMetrics, as in Convex's handlers (`metrics_log` is called after them).
  expect((await t.get("udf_rate", { udfPath: "m:add" }, null)).body.code).toBe("BadQueryArgs");
  expect((await t.get("function_call_count_top_k", { k: "26" }, null)).body.code).toBe("InvalidTopKParameter");
  expect((await t.get("scheduled_job_lag", { window: "{}" }, null)).status).toBe(500);
  // A path that does not parse is Convex's untyped error, before the key too.
  expect((await t.get("cache_hit_percentage", { udfPath: "bad::" }, null)).status).toBe(500);
  // A `udf_rate` metric is parsed after it.
  expect((await t.get("udf_rate", { udfPath: "m:add", metric: "nope" }, null)).status).toBe(403);
  // The log streams too: their query string before ViewLogs (Convex's `function_log`).
  const logs = await fetch(`${t.api}/api/app_metrics/stream_function_logs?cursor=x`);
  expect([logs.status, await logs.json()]).toEqual([
    400,
    { code: "BadQueryArgs", message: "Failed to deserialize query string: cursor: invalid float literal" },
  ]);
  expect((await fetch(`${t.api}/api/app_metrics/stream_udf_execution?cursor=0`)).status).toBe(403);
});

test("subscription invalidations, by mutation and table", async () => {
  const t = await setup();
  const c = await v1Client(syncUrl(t.s.server.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, "m:list")]);
  await c.transition(0);
  c.mutate(1, "m:add");
  await c.transition(1);
  const top = await t.get("subscription_invalidations_top_k", {});
  expect(top.body.map(([n, s]: [string, [unknown, number][]]) => [n, s[0]![1]])).toEqual([["m.js:add:items", 1]]);
  const one = await t.get("subscription_invalidations_top_k", { udfPath: "m:add" });
  expect(one.body.map(([n]: [string]) => n)).toEqual(["items"]);
});

test("function_concurrency's gauges and the scheduler's lag", async () => {
  const t = await setup();
  await t.call("action", "m:run");
  await t.call("mutation", "m:add");
  const c = (await t.get("function_concurrency", {})).body;
  expect(Object.keys(c).sort()).toEqual([
    "outstanding_functions:isolate:Action:queued",
    "outstanding_functions:isolate:Action:running",
    "outstanding_functions:isolate:Mutation:queued",
    "outstanding_functions:isolate:Mutation:running",
    "outstanding_functions:isolate:Query:queued",
    "outstanding_functions:isolate:Query:running",
    // Each limiter reports from start, the Node actions' too (STUDY-68).
    "outstanding_functions:node:Action:queued",
    "outstanding_functions:node:Action:running",
  ]);
  expect(t.one(c["outstanding_functions:isolate:Action:running"])).toBe(1);
  // No job yet: no sample. A job an hour away: a lag of 0.
  expect(t.one((await t.get("scheduled_job_lag", {})).body)).toBeNull();
  await t.call("mutation", "m:later");
  for (let i = 0; i < 100 && t.one((await t.get("scheduled_job_lag", {})).body) === null; i++) await Bun.sleep(10);
  expect(t.one((await t.get("scheduled_job_lag", {})).body)).toBe(0);
});

test("each call's read of the run state counts one `_backend_state` row, from the scan or the cache", async () => {
  const t = await setup();
  // A stored state document (pause, unpause): every user function reads it first, as Convex's.
  const post = (path: string) =>
    fetch(`${t.api}/api/v1/${path}`, { method: "POST", headers: { authorization: `Bunvex ${KEY}` } });
  await post("pause_deployment");
  await post("unpause_deployment");
  await t.call("query", "m:list"); // the scan
  await t.call("mutation", "m:add"); // the cache
  const width = 660;
  const read = t.one((await t.get("table_rate", { name: "_backend_state", metric: "rowsRead" })).body);
  expect(Math.round(read! * width)).toBe(2);
});

describe("the histogram layout from the UDF_METRICS_* bounds (STUDY-147 §3.8), as HdrHistogram's", () => {
  test("Convex's defaults: 1 ms to 15 min, 2 figures, the layout bunvex had (14 × 128 counts)", () => {
    expect(HISTOGRAM_BOUNDS).toEqual({ low: 1, high: 900_000, figures: 2 });
    const l = histogramLayout(1, 900_000, 2);
    expect(l.counts).toBe(14 * 128);
    // Single-unit resolution up to 255, then steps doubling per bucket.
    for (const v of [1, 200, 255]) expect([l.valueFor(l.indexFor(v)), l.highestEquivalent(v)]).toEqual([v, v]);
    expect([l.valueFor(l.indexFor(1000)), l.highestEquivalent(1000)]).toEqual([1000, 1003]);
    expect(l.indexFor(900_000)).toBeLessThan(l.counts);
  });
  test("other bounds: the sizes HdrHistogram computes, every value in its own equivalent range", () => {
    // 3 figures: 2048 sub-buckets (half 1024); 12 buckets reach an hour.
    expect(histogramLayout(1, 3_600_000, 3).counts).toBe(13 * 1024);
    // A lowest value of 1000 scales values down by 2^9 (512): 6 buckets, not 15.
    expect(histogramLayout(1000, 3_600_000, 2).counts).toBe(7 * 128);
    for (const [low, high, figures] of [
      [1, 3_600_000, 3],
      [1000, 3_600_000, 2],
      [1, 900_000, 1],
    ] as const) {
      const l = histogramLayout(low, high, figures);
      for (let v = low; v <= high; v = Math.ceil(v * 1.37) + 1) {
        const i = l.indexFor(v);
        expect(i).toBeLessThan(l.counts);
        expect(l.valueFor(i)).toBeLessThanOrEqual(v);
        expect(l.highestEquivalent(v)).toBeGreaterThanOrEqual(v);
      }
    }
  });
});
