// The soak's rules (STUDY-174 §2.4) on made-up runs: a flat run passes; each degradation the soak is for fails its
// rule, and only that one; noise (a GC dip, one slow window) does not.
import { describe, expect, test } from "bun:test";
import {
  exitCode,
  growthRule,
  judge,
  median,
  parseReportOnly,
  percentile,
  R8_MIN_P99_CALLS,
  RULE_IDS,
  type RunData,
  ruleId,
  type Sample,
  theilSen,
  withReportOnly,
} from "./rules.ts";

const MB = 2 ** 20;

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    rssBytes: 200 * MB,
    heapBytes: 60 * MB,
    indexCacheBytes: 20 * MB,
    fds: 40,
    cacheHits: 900,
    cacheMisses: 100,
    sessions: 20,
    subscriptions: 40,
    roomMembers: 20,
    clients: 20,
    subscriptionsOpen: 40,
    recentReconnects: 0,
    latency: { q: { p50: 2, p99: 10, n: 100 } },
    eventLoopLagSeconds: 0.001,
    backlogSeconds: 0,
    ...over,
  };
}

/** A 30-minute run sampled every 15 s, warm-up 5 min, every sample shaped by `at`. */
function runOf(at: (t: number, i: number) => Partial<Sample> = () => ({}), over: Partial<RunData> = {}): RunData {
  const samples = Array.from({ length: 120 }, (_, i) => sample(15 * (i + 1), at(15 * (i + 1), i)));
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    dueAt: i * 18_000,
    ranAt: i * 18_000 + 50,
    runs: 1,
  }));
  return {
    durationSeconds: 1800,
    warmupSeconds: 300,
    indexCacheBudgetBytes: 20 * MB,
    samples,
    final: { sessions: 0, subscriptions: 0, roomMembers: 0, fds: 41 },
    baselineFds: 38,
    idleCpu: 0.004,
    canary: { misses: 3, writes: 5, calls: 10_000 },
    jobs,
    jobsScheduled: 100,
    unexpectedErrors: 0,
    ...over,
  };
}

const failing = (r: RunData) =>
  judge(r)
    .filter((x) => !x.pass)
    .map((x) => x.rule.split(" ")[0]);

describe("the statistics", () => {
  test("Theil–Sen ignores outliers that least squares would follow", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ys = xs.map((x) => 2 * x);
    ys[9] = 1000;
    expect(theilSen(xs, ys)).toBe(2);
  });
  test("median and percentile", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });
});

describe("the rules", () => {
  test("a flat run passes every rule", () => {
    expect(failing(runOf())).toEqual([]);
  });

  test("noise does not fail: a GC sawtooth, one slow window, a reconnect burst", () => {
    const r = runOf((_t, i) => ({
      heapBytes: (50 + (i % 8) * 3) * MB,
      rssBytes: (200 + (i % 5) * 4) * MB,
      latency: { q: i === 100 ? { p50: 40, p99: 900, n: 100 } : { p50: 2, p99: 10, n: 100 } },
      ...(i === 50 ? { sessions: 24, recentReconnects: 3 } : {}),
    }));
    expect(failing(r)).toEqual([]);
  });

  test("a leak: RSS growing 1 MB a minute fails R1; a single step up early (a cache filling) does not", () => {
    expect(failing(runOf((t) => ({ rssBytes: 200 * MB + (t / 60) * MB })))).toEqual(["R1"]);
    expect(failing(runOf((t) => ({ rssBytes: (t < 420 ? 200 : 260) * MB })))).toEqual([]);
  });

  test("memory is judged once the index cache is full: its filling is not a leak", () => {
    // The cache fills by 1 MB a minute until t = 20 min, RSS with it; flat after.
    const filling = (t: number) => ({
      indexCacheBytes: Math.min(20, t / 60) * MB,
      rssBytes: (200 + Math.min(20, t / 60)) * MB,
    });
    expect(failing(runOf(filling))).toEqual([]);
    // One that never fills is not judged.
    const r = judge(runOf(() => ({ indexCacheBytes: 5 * MB, rssBytes: 200 * MB })));
    expect(r.find((x) => x.rule.startsWith("R1"))?.detail).toStartWith("not judged");
  });

  test("memory is judged once the page cache is full: the ballast read's filling is not a leak (Q6)", () => {
    // SQLite's 256 MiB page cache fills until t = 20 min, RSS with it; flat after.
    const filling = (t: number) => ({ rssBytes: (200 + Math.min(300, (t / 1200) * 300)) * MB });
    expect(failing(runOf(filling))).toEqual(["R1"]);
    expect(failing(runOf(filling, { pageCacheFilledSeconds: 1200 }))).toEqual([]);
    const at = judge(runOf(filling, { pageCacheFilledSeconds: 1200 })).find((x) => x.rule.startsWith("R1"))!;
    expect(at.detail).toEndWith("judged from t=1200 s");
    // A leak past the fill still fails: 2 MB a minute.
    const leak = (t: number) => ({ rssBytes: (500 + Math.max(0, t - 1200) / 30) * MB });
    expect(failing(runOf(leak, { pageCacheFilledSeconds: 1200 }))).toEqual(["R1"]);
    // A fill that did not finish: memory is not judged, and says why.
    const r = judge(runOf(filling, { pageCacheFilledSeconds: null }));
    for (const id of ["R1", "R2"])
      expect(r.find((x) => x.rule.startsWith(id))?.detail).toBe(
        "not judged: the page cache's fill (the ballast read) did not finish",
      );
    // Filled early: a third of the run still bounds it (the JS heap's own warm-up).
    expect(
      judge(runOf(() => ({}), { pageCacheFilledSeconds: 60 })).find((x) => x.rule.startsWith("R1"))!.detail,
    ).toEndWith("judged from t=600 s");
  });

  test("memory is judged no earlier than a third of the run, whatever filled the caches", () => {
    // The heap warming up for 15 minutes (+1.6 MB a minute), the index cache full from the start: not a leak.
    const warming = (t: number) => ({ heapBytes: (60 + Math.min(24, (t / 60) * 1.6)) * MB });
    expect(failing(runOf(warming))).toEqual([]);
    expect(judge(runOf(warming)).find((x) => x.rule.startsWith("R2"))!.detail).toEndWith("judged from t=600 s");
    // Without the bound (a run's warm-up past its retention only) the same heap would fail R2.
    expect(failing(runOf(warming, { durationSeconds: 0 }))).toEqual(["R2"]);
  });

  test("a heap leak fails R2", () => {
    expect(failing(runOf((t) => ({ heapBytes: 60 * MB + (t / 60) * 1.5 * MB })))).toEqual(["R2"]);
  });

  test("the canary missing on a timer (#751) fails R3", () => {
    // One miss every 17 s for 25 minutes.
    expect(failing(runOf(() => ({}), { canary: { misses: 88, writes: 5, calls: 15_000 } }))).toEqual(["R3"]);
  });

  test("a hit rate that falls from 90 % to 60 % fails R4", () => {
    expect(
      failing(
        runOf((t) => {
          const rate = 0.9 - 0.3 * (t / 1800);
          return { cacheHits: Math.round(1000 * rate), cacheMisses: Math.round(1000 * (1 - rate)) };
        }),
      ),
    ).toEqual(["R4"]);
  });

  test("sessions the server keeps after their clients left fail R5 and R6", () => {
    const r = runOf((_t, i) => ({ sessions: 20 + Math.floor(i / 10) }), {
      final: { sessions: 12, subscriptions: 0, roomMembers: 0, fds: 41 },
    });
    expect(failing(r)).toEqual(["R5", "R6"]);
  });

  test("a descriptor leak fails R7a and R7b", () => {
    const r = runOf((_t, i) => ({ fds: 40 + Math.floor(i / 2) }), {
      final: { sessions: 0, subscriptions: 0, roomMembers: 0, fds: 100 },
    });
    expect(failing(r)).toEqual(["R7a", "R7b"]);
  });

  test("latency that doubles fails R8", () => {
    expect(failing(runOf((t) => ({ latency: { q: { p50: 2 + t / 300, p99: 10 + t / 30, n: 100 } } })))).toEqual(["R8"]);
  });

  test("R8 judges the p99 only on windows of at least R8_MIN_P99_CALLS calls (Q7)", () => {
    expect(R8_MIN_P99_CALLS).toBe(100);
    // A p99 that doubles while the p50 stays flat: a failure with full windows...
    const p99Up = (n: number) => runOf((t) => ({ latency: { q: { p50: 2, p99: 10 + t / 30, n } } }));
    expect(failing(p99Up(R8_MIN_P99_CALLS))).toEqual(["R8"]);
    // ...and not judged with windows of 30 calls (the soak's `schedule`), where a "p99" is the slowest call.
    expect(failing(p99Up(30))).toEqual([]);
    expect(judge(p99Up(30)).find((x) => x.rule.startsWith("R8"))?.detail).toContain("p99 not judged");
    // Below the threshold the p50 is still judged.
    expect(failing(runOf((t) => ({ latency: { q: { p50: 2 + t / 60, p99: 10, n: 30 } } })))).toEqual(["R8"]);
    // Mixed windows: the p99 is judged on the full ones alone.
    const mixed = runOf((t, i) => ({
      latency: { q: i % 2 ? { p50: 2, p99: 10 + t / 30, n: 30 } : { p50: 2, p99: 10, n: R8_MIN_P99_CALLS } },
    }));
    expect(failing(mixed)).toEqual([]);
  });

  test("a lost job and a job run twice fail R9a; a growing lag fails R9b", () => {
    const base = runOf();
    const lost = runOf(() => ({}), { jobs: base.jobs.slice(1) });
    expect(failing(lost)).toEqual(["R9a"]);
    const twice = runOf(() => ({}), { jobs: base.jobs.map((j, i) => (i === 7 ? { ...j, runs: 2 } : j)) });
    expect(failing(twice)).toEqual(["R9a"]);
    const lagging = runOf(() => ({}), {
      jobs: base.jobs.map((j) => ({ ...j, ranAt: j.dueAt + j.seq * 40 })),
    });
    expect(failing(lagging)).toEqual(["R9b"]);
  });

  test("a busy event loop fails R10; a backend that polls while idle fails R11; errors fail R12", () => {
    expect(failing(runOf(() => ({ eventLoopLagSeconds: 0.5 })))).toEqual(["R10"]);
    expect(failing(runOf(() => ({}), { idleCpu: 0.26 }))).toEqual(["R11"]);
    expect(failing(runOf(() => ({}), { unexpectedErrors: 1 }))).toEqual(["R12"]);
  });

  test("growthRule needs both a slope and a level shift", () => {
    const flat = Array.from({ length: 30 }, (_, i) => sample(i * 60));
    expect(growthRule("x", flat, (s) => s.rssBytes, MB, 0, String).pass).toBe(true);
    const rising = Array.from({ length: 30 }, (_, i) => sample(i * 60, { rssBytes: 200 * MB + i * 2 * MB }));
    expect(growthRule("x", rising, (s) => s.rssBytes, MB, 0, String).pass).toBe(false);
    expect(growthRule("x", rising, (s) => s.rssBytes, MB, 100 * MB, String).pass).toBe(true);
  });
});

describe("report-only rules (--report-only; the nightly's R1 until Q6)", () => {
  const leak = runOf((t) => ({ rssBytes: 200 * MB + (t / 60) * MB }));

  test("a report-only rule that fails is still reported, but does not fail the run", () => {
    const v = withReportOnly(judge(leak), parseReportOnly("R1"));
    const r1 = v.find((x) => ruleId(x) === "R1")!;
    expect(r1.pass).toBe(false);
    expect(r1.reportOnly).toBe(true);
    expect(exitCode(v)).toBe(0);
    expect(exitCode(withReportOnly(judge(leak), parseReportOnly("")))).toBe(1);
  });

  test("every other rule still fails the run, R10, R11 and R12 included", () => {
    const only = parseReportOnly("R1");
    expect(exitCode(withReportOnly(judge(runOf(() => ({}), { idleCpu: 0.26 })), only))).toBe(1);
    expect(exitCode(withReportOnly(judge(runOf(() => ({ eventLoopLagSeconds: 0.5 }))), only))).toBe(1);
    expect(exitCode(withReportOnly(judge(runOf(() => ({}), { unexpectedErrors: 1 })), only))).toBe(1);
    expect(
      exitCode(withReportOnly(judge(runOf(() => ({}), { canary: { misses: 88, writes: 5, calls: 1 } })), only)),
    ).toBe(1);
    expect(exitCode(withReportOnly(judge(runOf()), only))).toBe(0);
  });

  test("an unknown id throws; the ids are every rule's", () => {
    expect(() => parseReportOnly("R1,R13")).toThrow(/unknown rule "R13"/);
    expect(() => parseReportOnly("r1")).toThrow();
    const ids = new Set(judge(runOf()).map(ruleId));
    expect([...ids].sort()).toEqual([...RULE_IDS].sort());
  });
});
