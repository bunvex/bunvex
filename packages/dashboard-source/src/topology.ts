// The deployment's topology (STUDY-131 §11, AD-04 — a bunvex addition, UI-01 §22): `GET /api/debug/topology`
// with the admin key (ViewMetrics), polled. A deployment is one process today, the leader alone; the server
// samples its counters every 5 s, so `watchTopology` asks as often (Convex's dashboard has no such screen to take
// a cadence from; its polled Health reads are 8 s). The first picture comes at once, never synchronously. While the
// deployment is disconnected the screen stops watching and asks again on the way back (STUDY-149 PR 6's rule).
import {
  type CallOptions,
  DataSourceError,
  type NodeCache,
  type NodeSample,
  type StoreDriver,
  type Topology,
  type TopologyEvent,
  type TopologyNode,
  type Unsubscribe,
} from "@bunvex/dashboard/data-source";
import type { AdminHttp } from "./admin-http.ts";

/** How often `watchTopology` asks: the server's sampling period. */
export const TOPOLOGY_INTERVAL_MS = 5_000;

const DRIVERS: readonly StoreDriver[] = ["memory", "sqlite", "postgres", "mysql", "other"];

/** `/api/debug/topology`, as the server sends it (`packages/server/src/topology.ts`). */
type TopologyJson = {
  time: number;
  nodes: (Omit<TopologyNode, "cache" | "history"> & { cache?: NodeCache; history: NodeSample[] })[];
  store: Omit<Topology["store"], "driver"> & { driver: string };
  events: TopologyEvent[];
};

/** The server's picture as the contract's: the same fields, copied (an unknown driver is `other`). */
export function topologyOf(json: TopologyJson): Topology {
  if (!Array.isArray(json?.nodes) || json.nodes.length === 0 || !json.store)
    throw new DataSourceError("unavailable", "The deployment answered no topology.");
  return {
    time: json.time,
    nodes: json.nodes.map(
      (n): TopologyNode => ({
        id: n.id,
        role: n.role,
        state: n.state,
        version: n.version,
        startedAt: n.startedAt,
        cpu: n.cpu,
        memoryBytes: n.memoryBytes,
        memoryLimitBytes: n.memoryLimitBytes,
        connections: n.connections,
        subscriptions: n.subscriptions,
        ...(n.cache && {
          cache: {
            entries: n.cache.entries,
            ...(n.cache.maxEntries !== undefined && { maxEntries: n.cache.maxEntries }),
            ...(n.cache.bytes !== undefined && { bytes: n.cache.bytes }),
            ...(n.cache.maxBytes !== undefined && { maxBytes: n.cache.maxBytes }),
            hitRate: n.cache.hitRate,
            invalidationsPerSecond: n.cache.invalidationsPerSecond,
            evictions: n.cache.evictions,
          },
        }),
        ...(n.lag && { lag: { commits: n.lag.commits, ms: n.lag.ms } }),
        ...(n.commitsPerSecond !== undefined && { commitsPerSecond: n.commitsPerSecond }),
        scheduler: n.scheduler,
        actionsRunning: n.actionsRunning,
        history: n.history.map((h) => ({
          time: h.time,
          cpu: h.cpu,
          lagMs: h.lagMs,
          connections: h.connections,
          ...(h.cacheHitRate !== undefined && { cacheHitRate: h.cacheHitRate }),
          ...(h.invalidationsPerSecond !== undefined && { invalidationsPerSecond: h.invalidationsPerSecond }),
        })),
      }),
    ),
    store: {
      ...json.store,
      driver: (DRIVERS as readonly string[]).includes(json.store.driver) ? (json.store.driver as StoreDriver) : "other",
    },
    events: json.events.map((e) => ({ ...e })),
  };
}

export function topologyReads(http: AdminHttp, opts: { topologyIntervalMs?: number | undefined } = {}) {
  const intervalMs = opts.topologyIntervalMs ?? TOPOLOGY_INTERVAL_MS;
  const getTopology = async (o?: CallOptions): Promise<Topology> =>
    topologyOf(await http.json<TopologyJson>("/api/debug/topology", { signal: o?.signal }));
  /** The watches polling now, stopped by the source's close. */
  const live = new Set<Unsubscribe>();
  return {
    getTopology,
    close() {
      for (const off of [...live]) off();
    },
    watchTopology(onTopology: (t: Topology) => void, onError: (e: DataSourceError) => void): Unsubscribe {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ask = new AbortController();
      // one request at a time: the next is scheduled once this one answers
      const poll = () =>
        getTopology({ signal: ask.signal })
          .then(
            (t) => !stopped && onTopology(t),
            (e: unknown) =>
              !stopped && onError(e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e))),
          )
          .finally(() => {
            if (!stopped) timer = setTimeout(poll, intervalMs);
          });
      timer = setTimeout(poll, 0);
      const off = () => {
        stopped = true;
        clearTimeout(timer);
        ask.abort();
        live.delete(off);
      };
      live.add(off);
      return off;
    },
  };
}
