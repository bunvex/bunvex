// The contract suite's part for the subscriptions inspector (STUDY-131 AD-25, data-source-subscriptions.ts).
// Read-only, so it runs whenever the source offers it: history no longer than its size and newest first,
// read ranges with both bounds, a path filter that keeps only matching queries, a cache whose biggest entries
// come biggest first, and `unauthorized` without `viewMetrics`.
import { expect } from "bun:test";
import type { DashboardDataSource, DataSourceError, SubscriptionsSnapshot } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DataSourceError).code;
  }
  return "resolved";
};

export function expectSubscriptions(s: SubscriptionsSnapshot) {
  let n = 0;
  for (const session of s.sessions)
    for (const q of session.queries) {
      n++;
      expect(q.history.length <= s.historySize).toBe(true);
      expect(q.history.every((h, i) => i === 0 || h.at <= q.history[i - 1]!.at)).toBe(true);
      for (const r of q.readSet) {
        expect(typeof r.index).toBe("string");
        expect(typeof r.lo.text === "string" && typeof r.hi.text === "string").toBe(true);
      }
      expect(q.documentsRead >= 0 && q.bytesRead >= 0).toBe(true);
    }
  expect(n).toBe(s.totals.queries);
}

export function describeSubscriptionsContract({ make, test, watchTimeoutMs }: Ctx) {
  test("subscriptions (when offered): bounded history, newest first; a path filter", async () => {
    const src = await make();
    if (!src.getSubscriptions) return;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) {
      expect(await refusal(src.getSubscriptions())).toBe("unauthorized");
      return;
    }
    const all = await src.getSubscriptions();
    expectSubscriptions(all);
    const first = all.sessions.flatMap((s) => s.queries)[0];
    if (!first) return;
    const only = await src.getSubscriptions({ path: first.path });
    expectSubscriptions(only);
    expect(only.sessions.flatMap((s) => s.queries).every((q) => q.path.includes(first.path))).toBe(true);
    expect(only.totals.queries).toBeGreaterThan(0);
  });

  test("query cache (when offered): counters, biggest entries first", async () => {
    const src = await make();
    if (!src.getQueryCache) return;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) {
      expect(await refusal(src.getQueryCache())).toBe("unauthorized");
      return;
    }
    const c = await src.getQueryCache();
    expect(c.entries >= 0 && c.bytes <= c.maxBytes).toBe(true);
    const reasons = Object.values(c.missReasons).reduce((a, b) => a + b, 0);
    expect(reasons <= c.misses).toBe(true);
    expect(c.biggest.every((e, i) => i === 0 || e.size <= c.biggest[i - 1]!.size)).toBe(true);
  });

  test("invalidations (when offered): watchInvalidations never delivers synchronously", async () => {
    const src = await make();
    if (!src.watchInvalidations) return;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) return;
    let subscribing = true;
    let early = false;
    const off = src.watchInvalidations(
      {},
      () => {
        if (subscribing) early = true;
      },
      () => {},
    );
    subscribing = false;
    await new Promise((r) => setTimeout(r, Math.min(50, watchTimeoutMs)));
    off();
    expect(early).toBe(false);
  });
}
