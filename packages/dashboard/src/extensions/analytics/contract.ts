// The contract suite's part for the Analytics extension (UI-01 §26). Read-only, so it runs whenever the source
// offers Analytics and the credential may see metrics: a consistent realtime picture (30 per-minute values,
// device counts adding up, breakdowns sorted), newest-first lists that page, and the watch never synchronous.
import { expect } from "bun:test";
import type { ContractContext, ContractExtensionPart } from "../contract-types.ts";
import { type AnalyticsRealtime, DEVICES } from "./data-source.ts";
import { analyticsExtension } from "./index.ts";

export function expectRealtime(r: AnalyticsRealtime) {
  expect(r.perMinute).toHaveLength(30);
  expect(r.perMinute.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  expect(DEVICES.reduce((n, d) => n + r.devices[d], 0)).toBe(r.visitorsLast30Min);
  for (const rows of [r.pages, r.referrers, r.countries, r.browsers]) {
    expect(rows.every((x, i) => x.visitors <= x.events && (i === 0 || x.visitors <= rows[i - 1]!.visitors))).toBe(true);
  }
  for (const v of r.live) {
    expect(v.lat >= -90 && v.lat <= 90 && v.lon >= -180 && v.lon <= 180).toBe(true);
    expect(v.lastSeen <= r.time && v.since <= v.lastSeen).toBe(true);
  }
  expect(r.recent.length <= 50 && r.recent.every((e, i) => i === 0 || e.time <= r.recent[i - 1]!.time)).toBe(true);
}

function describeAnalyticsContract({ make, test, watchTimeoutMs }: ContractContext) {
  const offered = async () => {
    const src = await make();
    if (!src.getAnalyticsRealtime) return null;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) return null;
    return src;
  };

  test("analytics (when offered): a consistent realtime picture", async () => {
    const src = await offered();
    if (src) expectRealtime(await src.getAnalyticsRealtime!());
  });

  test("analytics (when offered): events, sessions and profiles page newest first", async () => {
    const src = await offered();
    if (!src) return;
    const events = await src.listAnalyticsEvents!({ cursor: null, numItems: 20 });
    expect(events.page.every((e, i) => i === 0 || e.time <= events.page[i - 1]!.time)).toBe(true);
    if (!events.isDone) {
      const next = await src.listAnalyticsEvents!({ cursor: events.continueCursor, numItems: 20 });
      expect(next.page[0]!.time <= events.page.at(-1)!.time).toBe(true);
    }
    const name = events.page[0]?.name;
    if (name) {
      const named = await src.listAnalyticsEvents!({ cursor: null, numItems: 20, name });
      expect(named.page.every((e) => e.name === name)).toBe(true);
    }
    const sessions = await src.listAnalyticsSessions!({ cursor: null, numItems: 20 });
    expect(sessions.page.every((s, i) => i === 0 || s.lastSeen <= sessions.page[i - 1]!.lastSeen)).toBe(true);
    const profiles = await src.listAnalyticsProfiles!({ cursor: null, numItems: 20 });
    expect(profiles.page.every((p, i) => i === 0 || p.lastSeen <= profiles.page[i - 1]!.lastSeen)).toBe(true);
  });

  test("analytics (when offered): watchAnalyticsRealtime delivers, never synchronously", async () => {
    const src = await offered();
    if (!src?.watchAnalyticsRealtime) return;
    let subscribing = true;
    let early = false;
    const first = await new Promise<AnalyticsRealtime>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no realtime picture delivered")), watchTimeoutMs);
      const off = src.watchAnalyticsRealtime!((r) => {
        if (subscribing) early = true;
        clearTimeout(timer);
        queueMicrotask(off);
        resolve(r);
      }, reject);
      subscribing = false;
    });
    expect(early).toBe(false);
    expectRealtime(first);
  });
}

export const analyticsContract: ContractExtensionPart = {
  id: "analytics",
  requires: analyticsExtension.requires,
  describe: describeAnalyticsContract,
};
