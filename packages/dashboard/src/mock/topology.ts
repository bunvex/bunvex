// The mock's deployment topology (UI-01 §22): a leader alone by default, as bunvex runs today, or a leader and
// followers (`nodes`), one of which drifts behind the commit stream and catches up again, so the view has a
// lagging state and events to show. Vitals wander a little on every tick. Not part of the contract: the
// source wraps it.
import type { ClientBucket } from "../data-source-clients.ts";
import type {
  NodeSample,
  StoreDriver,
  Topology,
  TopologyEvent,
  TopologyEventKind,
  TopologyNode,
} from "../data-source-topology.ts";
import type { Random } from "./random.ts";

const HISTORY = 60;
const LEASE_TTL_MS = 10_000;
/** Past this, a follower counts as lagging (STUDY-24 H9's "waits briefly"). */
const LAGGING_MS = 500;
const GiB = 1024 ** 3;
/** The fixture's queries, as the cache's most-cached functions (shares drift a little per node). */
const QUERIES = ["tasks:list", "messages:list", "tasks:byOwner", "users:get", "tasks:count"];
const MAX_ENTRIES = 5000;
const ENTRY_BYTES = 6 * 1024;

const NAMES = ["node-a", "node-b", "node-c", "node-d", "node-e", "node-f", "node-g", "node-h"];

export type MockTopologyOptions = {
  /** How many nodes, 1–8; 1 is a leader alone. */
  nodes: number;
  now: number;
  version: string;
  /** The deployment's persistence: memory or SQLite keep one node; more nodes use Postgres. */
  persistence: string;
  /** Who a node's connections are (UI-01 §33), from its connection count and a per-node salt. */
  clients?: (connections: number, salt: number) => ClientBucket[];
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class MockTopology {
  private readonly nodes: TopologyNode[];
  private readonly events: TopologyEvent[] = [];
  private readonly driver: StoreDriver;
  private now: number;
  private eventSeq = 0;
  private leaseExpiresAt: number;
  private sizeBytes = 2.1 * GiB;

  private readonly clientsOf?: MockTopologyOptions["clients"];

  constructor(
    private readonly rnd: Random,
    opts: MockTopologyOptions,
  ) {
    this.clientsOf = opts.clients;
    const count = clamp(Math.round(opts.nodes), 1, NAMES.length);
    this.now = opts.now;
    const p = opts.persistence.toLowerCase();
    this.driver =
      count > 1
        ? "postgres"
        : ((["memory", "sqlite", "postgres", "mysql", "mongodb"] as const).find((d) => d === p) ?? "memory");
    this.nodes = NAMES.slice(0, count).map((id, i) => this.makeNode(id, i === 0, opts.version, i));
    this.leaseExpiresAt = this.now + LEASE_TTL_MS;
    // a little past: the followers joined after the leader took the lease
    if (!this.single()) this.event("lease_acquired", this.nodes[0]!.id, undefined, this.now - 3_600_000);
    for (const n of this.nodes.slice(1)) this.event("node_joined", n.id, undefined, n.startedAt);
    const start = this.now;
    for (let i = HISTORY - 1; i >= 0; i--) this.tick(start - i * 1000, false);
  }

  private makeNode(id: string, leader: boolean, version: string, i: number): TopologyNode {
    return {
      id,
      role: leader ? "leader" : "follower",
      state: "ok",
      version,
      startedAt: this.now - (leader ? 26 : 26 - i * 3) * 3_600_000 - (17 + i * 11) * 60_000,
      cpu: leader ? 0.4 : 0.2,
      memoryBytes: (leader ? 1.2 : 0.9) * GiB,
      memoryLimitBytes: 4 * GiB,
      connections: 0,
      subscriptions: 0,
      cache: {
        entries: leader ? 900 : 2600 + i * 300,
        maxEntries: MAX_ENTRIES,
        bytes: 0,
        maxBytes: MAX_ENTRIES * ENTRY_BYTES * 2,
        hitRate: leader ? 0.82 : 0.9,
        invalidationsPerSecond: 0,
        evictions: leader ? 120 : 800 + i * 150,
        topQueries: [],
      },
      ...(leader ? { commitsPerSecond: 120 } : { lag: { commits: 1, ms: 20 } }),
      scheduler: leader,
      actionsRunning: 0,
      history: [],
    };
  }

  private event(kind: TopologyEventKind, node?: string, detail?: string, time = this.now) {
    this.events.unshift({ id: `t${++this.eventSeq}`, time, kind, ...(node && { node }), ...(detail && { detail }) });
    this.events.sort((a, b) => b.time - a.time);
    this.events.length = Math.min(this.events.length, 50);
  }

  /** Moves the simulation `ms` on (its own clock, so a fixed `now` stays consistent). */
  step(ms: number) {
    this.tick(this.now + ms);
  }

  /** One step of the simulation: vitals wander, the lease renews, the drifting follower moves. */
  tick(now: number, live = true) {
    this.now = now;
    const r = this.rnd;
    const single = this.nodes.length === 1;
    const leader = this.nodes[0]!;
    for (const [i, n] of this.nodes.entries()) {
      n.cpu = clamp((n.cpu ?? 0.3) + (r.next() - 0.5) * 0.06, 0.05, 0.95);
      n.memoryBytes = clamp((n.memoryBytes ?? GiB) + (r.next() - 0.5) * 0.02 * GiB, 0.4 * GiB, 3.6 * GiB);
      // each node's own LRU: the commits it applies invalidate entries; queries refill it; past the cap it evicts
      const cps = this.nodes[0]!.commitsPerSecond ?? 100;
      const c = n.cache!;
      c.hitRate = clamp((c.hitRate ?? 0.85) + (r.next() - 0.5) * 0.02, 0.55, 0.99);
      c.invalidationsPerSecond = Math.max(0, Math.round(cps * (0.3 + r.next() * 0.15)));
      const refill = Math.round((n.role === "leader" ? 6 : n.connections / 30) + r.int(0, 12));
      const next = c.entries + refill - Math.round(c.invalidationsPerSecond * 0.05);
      if (next > MAX_ENTRIES) c.evictions += next - MAX_ENTRIES;
      c.entries = clamp(next, 50, MAX_ENTRIES);
      c.bytes = c.entries * ENTRY_BYTES + r.int(0, 64 * 1024);
      const weights = QUERIES.map((_, k) => (QUERIES.length - k) * (1 + (i % 3) * 0.1 * k));
      const sum = weights.reduce((a, b) => a + b, 0);
      c.topQueries = QUERIES.map((f, k) => ({
        function: f,
        entries: Math.round((c.entries * weights[k]!) / sum),
      })).sort((a, b) => b.entries - a.entries);
      n.actionsRunning = r.int(0, n.role === "leader" ? 3 : 2);
      // clients connect to followers; a leader alone holds them itself
      if (n.role === "follower" || single) {
        const base = single ? 420 : ([0, 410, 380, 60, 220, 190, 150, 120][i] ?? 100);
        n.connections = clamp(Math.round((n.connections || base) + r.int(-6, 6)), 0, 5000);
        n.subscriptions = Math.round(n.connections * 7.2);
      } else {
        n.connections = 0;
        n.subscriptions = 0;
      }
      if (n.role === "leader") n.commitsPerSecond = clamp((n.commitsPerSecond ?? 120) + r.int(-8, 8), 20, 400);
      if (n.lag) {
        // node-d (the third follower, or the last one) drifts: its lag grows, then it catches up
        const drifting = i === Math.min(3, this.nodes.length - 1);
        const prev = n.lag.ms;
        const ms = drifting
          ? clamp(prev + (prev > 300 ? r.int(-40, 140) : r.int(-10, 60)), 10, 2_400)
          : clamp(prev + r.int(-8, 8), 5, 80);
        const nextMs = drifting && ms >= 2_400 ? 30 : ms;
        n.lag = { ms: nextMs, commits: Math.max(0, Math.round(((leader.commitsPerSecond ?? 100) * nextMs) / 1000)) };
        const was = n.state;
        n.state = nextMs > LAGGING_MS ? "lagging" : "ok";
        if (live && was !== n.state)
          this.event(n.state === "lagging" ? "node_lagging" : "node_caught_up", n.id, `${nextMs} ms behind`);
      }
      const sample: NodeSample = {
        time: now,
        cpu: n.cpu,
        lagMs: n.lag ? n.lag.ms : null,
        connections: n.connections,
        cacheHitRate: c.hitRate,
        invalidationsPerSecond: c.invalidationsPerSecond,
      };
      n.history.push(sample);
      if (n.history.length > HISTORY) n.history.shift();
    }
    this.leaseExpiresAt = now + LEASE_TTL_MS - r.int(0, 3000);
    this.sizeBytes += r.int(0, 4096);
  }

  private single() {
    return this.driver === "memory" || this.driver === "sqlite";
  }

  snapshot(): Topology {
    const leader = this.nodes[0]!;
    const followers = this.nodes.slice(1).sort((a, b) => a.id.localeCompare(b.id));
    return {
      time: this.now,
      nodes: [leader, ...followers].map((n) => ({
        ...n,
        ...(this.clientsOf && n.connections > 0 && { clients: this.clientsOf(n.connections, this.nodes.indexOf(n)) }),
        ...(n.lag && { lag: { ...n.lag } }),
        ...(n.cache && { cache: { ...n.cache, topQueries: n.cache.topQueries?.map((q) => ({ ...q })) } }),
        history: n.history.map((h) => ({ ...h })),
      })),
      store: {
        driver: this.driver,
        singleNode: this.single(),
        // memory and SQLite are guarded by a file lock, not a lease (STUDY-24 H7)
        leaseHolder: this.single() ? null : leader.id,
        leaseExpiresAt: this.single() ? null : this.leaseExpiresAt,
        leaseTtlMs: this.single() ? null : LEASE_TTL_MS,
        latencyMs: this.driver === "memory" ? null : 3 + this.rnd.int(0, 3),
        sizeBytes: this.driver === "memory" ? null : Math.round(this.sizeBytes),
        connections:
          this.driver === "memory" || this.driver === "sqlite" ? null : { used: 6 + this.nodes.length * 4, max: 100 },
      },
      events: this.events.map((e) => ({ ...e })),
    };
  }
}
