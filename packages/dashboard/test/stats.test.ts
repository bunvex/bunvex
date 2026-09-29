import { describe, expect, test } from "bun:test";
import type { DeploymentStats } from "@bunvex/dashboard";
import {
  appendSample,
  cacheHitRate,
  commitRates,
  formatPercent,
  formatRate,
  ratePerSecond,
} from "../src/screens/stats.ts";

const sample = (at: number, commitTs: number, extra: Partial<DeploymentStats> = {}): DeploymentStats => ({
  at,
  commitTs,
  commitGroups: 0,
  conflicts: 0,
  retries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  subscriptions: 0,
  subscriptionReruns: 0,
  subscriptionUpdates: 0,
  ...extra,
});

describe("stats", () => {
  test("rate per second between two samples", () => {
    expect(ratePerSecond(sample(0, 100), sample(2000, 160), "commitTs")).toBe(30);
  });

  test("no rate when time did not move or the counter went back", () => {
    expect(ratePerSecond(sample(1000, 100), sample(1000, 200), "commitTs")).toBe(0);
    expect(ratePerSecond(sample(0, 100), sample(1000, 50), "commitTs")).toBe(0);
  });

  test("cache hit rate, and none before any cached query", () => {
    expect(cacheHitRate(sample(0, 0, { cacheHits: 3, cacheMisses: 1 }))).toBe(0.75);
    expect(cacheHitRate(sample(0, 0))).toBeNull();
  });

  test("history keeps the last N samples and restarts when the server did", () => {
    let h: DeploymentStats[] = [];
    for (let i = 0; i < 5; i++) h = appendSample(h, sample(i * 1000, i * 10), 3);
    expect(h.map((s) => s.commitTs)).toEqual([20, 30, 40]);
    h = appendSample(h, sample(6000, 5), 3); // commit clock went back: a restart
    expect(h.map((s) => s.commitTs)).toEqual([5]);
  });

  test("a sample no newer than the last one (a re-subscription's first delivery) is dropped", () => {
    const h = [sample(0, 0), sample(1000, 10)];
    expect(appendSample(h, sample(1000, 10), 5)).toBe(h);
    expect(appendSample(h, sample(500, 12), 5)).toBe(h);
  });

  test("commit rates for each consecutive pair", () => {
    expect(commitRates([sample(0, 0), sample(1000, 10), sample(3000, 30)])).toEqual([10, 10]);
    expect(commitRates([sample(0, 0)])).toEqual([]);
  });

  test("formatting", () => {
    expect(formatRate(3)).toBe("3.0");
    expect(formatRate(49.64)).toBe("49.6");
    expect(formatRate(1234.5)).toBe("1,235");
    expect(formatPercent(0.8871)).toBe("88.7%");
  });
});
