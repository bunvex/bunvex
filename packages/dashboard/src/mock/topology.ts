// The mock's deployment topology (UI-01 §22): a leader alone by default, as bunvex runs today, or a leader and
// followers (`nodes`), one of which drifts behind the commit stream and catches up again, so the view has a
// lagging state and events to show. Vitals wander a little on every tick. Not part of the contract: the
// source wraps it.
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
const NAMES = ["node-a", "node-b", "node-c", "node-d", "node-e", "node-f", "node-g", "node-h"];

export type MockTopologyOptions = {
  /** How many nodes, 1–8; 1 is a leader alone. */
  nodes: number;
  now: number;
  version: string;
  /** The deployment's persistence: memory or SQLite keep one node; more nodes use Postgres. */
  persistence: string;
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

  constructor(
    private readonly rnd: Random,
    opts: MockTopologyOptions,
  ) {
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
      cacheHitRate: 0.86,
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
      n.cacheHitRate = clamp((n.cacheHitRate ?? 0.85) + (r.next() - 0.5) * 0.02, 0.5, 0.99);
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
        ...(n.lag && { lag: { ...n.lag } }),
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
