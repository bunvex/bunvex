// The contract suite's part for the topology (UI-01 §22, data-source-topology.ts). Read-only, so it runs
// whenever the source offers the view and the credential may see it: one leader first, followers after it by
// id, lag only on followers, a lease (when there is one) held by the leader, events newest first.
import { expect } from "bun:test";
import type { DashboardDataSource, Topology } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
};

export function expectTopology(t: Topology) {
  expect(t.nodes.length).toBeGreaterThan(0);
  const [leader, ...followers] = t.nodes;
  expect(leader!.role).toBe("leader");
  expect(leader!.lag).toBeUndefined();
  expect(followers.every((n) => n.role === "follower" && n.lag !== undefined)).toBe(true);
  expect(followers.map((n) => n.id)).toEqual(followers.map((n) => n.id).sort());
  expect(new Set(t.nodes.map((n) => n.id)).size).toBe(t.nodes.length);
  for (const n of t.nodes) {
    expect(["ok", "lagging", "down"]).toContain(n.state);
    if (n.cpu !== null) expect(n.cpu >= 0 && n.cpu <= 1).toBe(true);
    if (n.cacheHitRate !== null) expect(n.cacheHitRate >= 0 && n.cacheHitRate <= 1).toBe(true);
    expect(n.history.every((h, i) => i === 0 || h.time >= n.history[i - 1]!.time)).toBe(true);
  }
  if (t.store.leaseHolder !== null) expect(t.store.leaseHolder).toBe(leader!.id);
  if (t.store.singleNode) expect(t.nodes.length).toBe(1);
  expect(t.events.every((e, i) => i === 0 || e.time <= t.events[i - 1]!.time)).toBe(true);
}

export function describeTopologyContract({ make, test, watchTimeoutMs }: Ctx) {
  test("topology (when offered): one leader first, followers by id, a lease held by the leader", async () => {
    const src = await make();
    if (!src.getTopology) return;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) return;
    expectTopology(await src.getTopology());
  });

  test("topology (when offered): watchTopology delivers a picture, never synchronously", async () => {
    const src = await make();
    if (!src.watchTopology) return;
    if (!(await src.getCapabilities()).operations.includes("viewMetrics")) return;
    let subscribing = true;
    let calledDuringSubscribe = false;
    const first = await new Promise<Topology>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no topology delivered")), watchTimeoutMs);
      const off = src.watchTopology!(
        (t) => {
          if (subscribing) calledDuringSubscribe = true;
          clearTimeout(timer);
          queueMicrotask(off);
          resolve(t);
        },
        (e) => reject(e),
      );
      subscribing = false;
    });
    expect(calledDuringSubscribe).toBe(false);
    expectTopology(first);
  });
}
