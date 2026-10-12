// The metrics' units and windows (STUDY-149 §1.2), and the connection watcher's rule (Convex's
// `handleConnectionStateChange`).
import { describe, expect, test } from "bun:test";
import { bucketStarts, type DataSourceError, REST } from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { Metrics, windowParam } from "../src/metrics.ts";
import { nextConnectionStatus, watchConnection } from "../src/sync.ts";

const w = { start: 1_700_000_000_000, end: 1_700_000_600_000, numBuckets: 3 };
const t = (s: number) => ({ secs_since_epoch: s, nanos_since_epoch: 0 });

function metricsAnswering(body: unknown) {
  const asked: URL[] = [];
  const http = new AdminHttp({
    url: "http://x",
    adminKey: "k",
    fetch: ((input: RequestInfo | URL) => {
      asked.push(new URL(String(input)));
      return Promise.resolve(new Response(JSON.stringify(body)));
    }) as typeof fetch,
  });
  return { metrics: new Metrics(http), asked };
}

describe("metrics", () => {
  test("the window as Convex serializes it; one with no bucket, or that ends before it starts, is refused", () => {
    expect(JSON.parse(windowParam({ start: 1500, end: 2250, numBuckets: 2 }))).toEqual({
      start: { secs_since_epoch: 1, nanos_since_epoch: 500_000_000 },
      end: { secs_since_epoch: 2, nanos_since_epoch: 250_000_000 },
      num_buckets: 2,
    });
    for (const bad of [
      { ...w, numBuckets: 0 },
      { ...w, numBuckets: 1.5 },
      { ...w, end: w.start },
    ]) {
      let e: unknown;
      try {
        windowParam(bad);
      } catch (err) {
        e = err;
      }
      expect((e as DataSourceError).code).toBe("invalid_request");
    }
  });

  test("udf_rate (per second) becomes a count per bucket, at the window's bucket starts", async () => {
    const { metrics, asked } = metricsAnswering([
      [t(1), 0.01],
      [t(2), null],
      [t(3), 0],
    ]);
    const s = await metrics.functionRate("messages:send", "cacheHits", w);
    expect(s).toEqual([
      { time: bucketStarts(w)[0]!, value: 2 },
      { time: bucketStarts(w)[1]!, value: null },
      { time: bucketStarts(w)[2]!, value: 0 },
    ]);
    expect(asked[0]!.pathname).toBe("/api/app_metrics/udf_rate");
    expect(asked[0]!.searchParams.get("path")).toBe("messages:send");
    expect(asked[0]!.searchParams.get("metric")).toBe("cacheHits");
  });

  test("latencies: seconds become milliseconds, in the order asked", async () => {
    const { metrics } = metricsAnswering([
      [
        50,
        [
          [t(1), 0.002],
          [t(2), null],
          [t(3), 0.001],
        ],
      ],
      [
        99,
        [
          [t(1), 0.5],
          [t(2), null],
          [t(3), 0.25],
        ],
      ],
    ]);
    const got = await metrics.latencyPercentiles("f:g", [99, 50], w);
    expect(got.map((p) => [p.percentile, p.series.map((b) => b.value)])).toEqual([
      [99, [500, null, 250]],
      [50, [2, null, 1]],
    ]);
  });

  test("top functions: display paths, and the rest kept as REST", async () => {
    const series = [
      [t(1), 1],
      [t(2), 1],
      [t(3), 1],
    ];
    const { metrics, asked } = metricsAnswering([
      ["messages.js:send", series],
      ["dir/jobs.js:run", series],
      ["_rest", series],
    ]);
    const top = await metrics.topFunctions("failurePercentage", w, 2);
    expect(top.map((x) => x.function)).toEqual(["messages:send", "dir/jobs:run", REST]);
    expect(asked[0]!.pathname).toBe("/api/app_metrics/failure_percentage_top_k");
    expect(asked[0]!.searchParams.get("k")).toBe("2");
  });
});

describe("the connection watcher", () => {
  const at = (connected: boolean, ms: number) => ({ connected, at: ms });

  test("unknown without a previous observation or when it is stale; disconnected only twice in a row", () => {
    expect(nextConnectionStatus(at(false, 0), null)).toBe("unknown");
    expect(nextConnectionStatus(at(false, 2500), at(true, 0))).toBe("unknown");
    expect(nextConnectionStatus(at(false, 5000), at(false, 2500))).toBe("disconnected");
    expect(nextConnectionStatus(at(false, 10_000), at(false, 2500))).toBe("unknown");
    expect(nextConnectionStatus(at(true, 5000), at(false, 2500))).toBe("connected");
  });

  test("reports each change once, never synchronously, until stopped", async () => {
    let connected = true;
    const seen: string[] = [];
    const stop = watchConnection(
      () => ({ isWebSocketConnected: connected }) as ReturnType<Parameters<typeof watchConnection>[0]>,
      (s) => seen.push(s),
      5,
    );
    expect(seen).toEqual([]);
    await Bun.sleep(30);
    connected = false;
    await Bun.sleep(30);
    stop();
    const stopped = seen.length;
    await Bun.sleep(20);
    expect(seen.length).toBe(stopped);
    expect(seen).toEqual(["unknown", "connected", "unknown", "disconnected"]);
  });
});
