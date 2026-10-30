// The deployment's topology for the dashboard (STUDY-131 §11, AD-04 — a bunvex addition: Convex's topology is
// internal, and its dashboard has no such view). bunvex runs as one process: the leader, alone, holding the
// store's lease, running the scheduler and serving every client (STUDY-24 has no follower mode yet). What this
// reports is what the server already counts — sync sessions and subscriptions, the query cache's counters, the
// committer's commits, the limiters' running actions, the process's CPU and memory, the engine's lease — read
// when asked, plus a minute of samples taken every 5 s from those same counters (no store read, ever). What the
// server does not know is null or absent, never made up: CPU and memory limits, the lease's expiry on the
// store's clock, the store's size and its connections, who the clients are (AD-08's handshake is a later study).
import { availableParallelism, hostname } from "node:os";
import type { Engine } from "@bunvex/core";
import { clearLongTimer, type LongTimer, longInterval } from "@bunvex/core";

/** How often a sample is taken, and how many are kept: a minute of history. */
export const TOPOLOGY_SAMPLE_MS = 5_000;
export const TOPOLOGY_HISTORY = 12;

/** The drivers the dashboard names; another package's driver is `other`. */
const DRIVERS = new Set(["memory", "sqlite", "postgres", "mysql"]);

export type TopologySources = {
  engine: Engine;
  /** WebSocket sync sessions open: the clients this node holds. */
  connections: () => number;
  /** Queries subscribed across those sessions. */
  subscriptions: () => number;
  /** Actions (HTTP and Node actions included) running now. */
  actionsRunning: () => number;
  /** Whether the scheduler loop runs here. */
  scheduler: () => boolean;
  version: string;
  /** Default TOPOLOGY_SAMPLE_MS (tests shorten it). */
  sampleMs?: number;
};

/** The counters a sample is the difference of. */
type Counters = {
  at: number;
  cpuMicros: number;
  commits: number;
  hits: number;
  misses: number;
  invalidated: number;
};

export type TopologySample = {
  time: number;
  cpu: number | null;
  lagMs: null;
  connections: number;
  cacheHitRate: number | null;
  invalidationsPerSecond: number;
  /** Not in the contract's sample: the node's current rate, kept with the window it was measured over. */
  commitsPerSecond: number;
};

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export class TopologyReporter {
  private readonly samples: TopologySample[] = [];
  private last: Counters;
  private timer: LongTimer | null = null;
  private readonly cores = availableParallelism();
  /** When the process started (wall-clock ms), as `bunvex_process_start_time_seconds`. */
  private readonly startedAt = Math.round(performance.timeOrigin);

  constructor(private readonly s: TopologySources) {
    this.last = this.counters();
  }

  start() {
    if (this.timer) return;
    this.timer = longInterval(() => this.sample(), this.s.sampleMs ?? TOPOLOGY_SAMPLE_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearLongTimer(this.timer);
    this.timer = null;
  }

  private counters(): Counters {
    const cpu = process.cpuUsage();
    const { engine } = this.s;
    return {
      at: Date.now(),
      cpuMicros: cpu.user + cpu.system,
      commits: engine.committer.commits,
      hits: engine.stats.cacheHits,
      misses: engine.stats.cacheMisses,
      invalidated: engine.cache.misses.invalidated,
    };
  }

  /** The rates between `from` and now, as one sample (not kept). */
  private measure(from: Counters, now: Counters): TopologySample {
    const seconds = (now.at - from.at) / 1000;
    const lookups = now.hits - from.hits + (now.misses - from.misses);
    return {
      time: now.at,
      // the share of the machine's cores this process used over the window
      cpu: seconds > 0 ? round(Math.min(1, (now.cpuMicros - from.cpuMicros) / (seconds * 1e6 * this.cores)), 4) : null,
      lagMs: null,
      connections: this.s.connections(),
      cacheHitRate: lookups > 0 ? round((now.hits - from.hits) / lookups, 4) : null,
      invalidationsPerSecond: seconds > 0 ? round((now.invalidated - from.invalidated) / seconds, 2) : 0,
      commitsPerSecond: seconds > 0 ? round((now.commits - from.commits) / seconds, 2) : 0,
    };
  }

  /** One sample of the window since the last; the oldest dropped past a minute. */
  sample() {
    const now = this.counters();
    this.samples.push(this.measure(this.last, now));
    this.last = now;
    if (this.samples.length > TOPOLOGY_HISTORY) this.samples.shift();
  }

  /** The picture `/api/debug/topology` answers: the contract's `Topology`, one leader. */
  snapshot() {
    const { engine } = this.s;
    const lease = engine.leaseState;
    const stopped = engine.committer.stopped !== null;
    // before the first sample, the rates since the reporter started
    const current = this.samples.at(-1) ?? this.measure(this.last, this.counters());
    const id = lease?.holder ?? `${hostname()}:${process.pid}`;
    const driver = engine.persistence.driver;
    // memory and SQLite keep one process behind a file lock (STUDY-24 H7): no other node can ever join
    const singleNode = lease?.scope === "process";
    const cache = engine.cache;
    const time = Date.now();
    return {
      time,
      nodes: [
        {
          id,
          role: "leader" as const,
          // a stopped committer is fail-stop: the process is on its way out
          state: stopped ? ("down" as const) : ("ok" as const),
          version: this.s.version,
          startedAt: this.startedAt,
          cpu: current.cpu,
          memoryBytes: process.memoryUsage.rss(),
          memoryLimitBytes: null,
          connections: this.s.connections(),
          subscriptions: this.s.subscriptions(),
          cache: {
            entries: cache.size,
            bytes: cache.bytes,
            maxBytes: cache.maxBytes,
            hitRate: current.cacheHitRate,
            invalidationsPerSecond: current.invalidationsPerSecond,
            evictions: cache.evictions,
          },
          commitsPerSecond: current.commitsPerSecond,
          scheduler: this.s.scheduler(),
          actionsRunning: this.s.actionsRunning(),
          history: this.samples.map(({ commitsPerSecond: _, ...h }) => h),
        },
      ],
      store: {
        driver: driver !== undefined && DRIVERS.has(driver) ? driver : "other",
        singleNode,
        leaseHolder: lease && !stopped ? lease.holder : null,
        // Convex's lease (DV-413) and the file lock have no expiry; a "ttl" lease's is on the store's clock
        leaseExpiresAt: null,
        leaseTtlMs: lease?.scope === "ttl" ? lease.ttlMs : null,
        latencyMs: lease?.renewalMs == null ? null : round(lease.renewalMs, 1),
        sizeBytes: null,
        connections: null,
      },
      // the lease taken on a store other nodes could share; a file lock is no event (the mock's rule)
      events:
        lease && !singleNode
          ? [{ id: "lease-1", time: lease.acquiredAt, kind: "lease_acquired" as const, node: lease.holder }]
          : [],
    };
  }
}
