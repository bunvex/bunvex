// The deployment's topology in the dashboard contract (UI-01 §22, STUDY-12 §15) — a bunvex addition: Convex
// has no such view. It follows STUDY-24's shape for a horizontally scaled deployment: one leader commits
// (it holds the lease on the store, runs the scheduler and pushes the commit stream), followers hold the
// clients' WebSockets and serve queries and subscriptions, catching up by commit timestamp. A single-node
// deployment is a leader alone. Every method is optional — a source offers the view by having them (detected
// with `typeof`) — and needs the `viewMetrics` operation. Re-exported by `data-source.ts`.
import type { CallOptions, DataSourceError, Unsubscribe } from "./data-source.ts";

export type NodeRole = "leader" | "follower";

/**
 * `lagging`: a follower behind the commit stream by more than the source's threshold (STUDY-24 H9: past it,
 * the node refuses new connections). `down`: the node stopped reporting; its last values are kept.
 */
export type NodeState = "ok" | "lagging" | "down";

/** One reading of a node's vitals, for its recent history. */
export type NodeSample = {
  time: number;
  /** 0–1 of the node's CPU budget; `null` when the node cannot tell. */
  cpu: number | null;
  /** Followers: how far behind the leader, in ms. `null` on the leader. */
  lagMs: number | null;
  connections: number;
  /** The node's query cache: hit rate 0–1 (`null` before any query) and invalidations per second. */
  cacheHitRate?: number | null;
  invalidationsPerSecond?: number;
};

/**
 * A node's own query cache: an in-process LRU of query results, as each Convex process keeps its own
 * (`CacheManager`); there is no cache shared between nodes. Entries are invalidated by the commit stream
 * (STUDY-24 §4.5), so invalidations follow the commits a node applies.
 */
export type NodeCache = {
  entries: number;
  /** The LRU's capacity in entries. */
  maxEntries: number;
  /** What the entries hold, and the limit, when the node measures it. */
  bytes?: number;
  maxBytes?: number;
  /** 0–1 over the recent window; `null` before any query ran. */
  hitRate: number | null;
  /** Entries dropped because a commit touched what they read, per second over the recent window. */
  invalidationsPerSecond: number;
  /** Entries pushed out by the LRU (capacity), since the node started. */
  evictions: number;
  /** The functions with the most cached entries, most first. */
  topQueries?: { function: string; entries: number }[];
};

export type TopologyNode = {
  /** Stable for the node's life, e.g. a host name. */
  id: string;
  role: NodeRole;
  state: NodeState;
  /** The server's version on this node. */
  version: string;
  /** When the node started (wall-clock ms): its uptime. */
  startedAt: number;
  cpu: number | null;
  memoryBytes: number | null;
  /** The node's memory limit, when it has one. */
  memoryLimitBytes: number | null;
  /** Client WebSocket connections the node holds. */
  connections: number;
  /** Live query subscriptions across those connections. */
  subscriptions: number;
  /** The node's own query cache (absent when the source cannot tell). */
  cache?: NodeCache;
  /** Followers: how far behind the leader's commit stream. Absent on the leader. */
  lag?: { commits: number; ms: number };
  /** The leader: commits per second over the recent window. */
  commitsPerSecond?: number;
  /** Whether this node runs the scheduler loop (the leader, STUDY-24 H6). */
  scheduler: boolean;
  /** Actions this node is running now (they run on any node after a claim, H6). */
  actionsRunning: number;
  /** Recent samples, oldest first (a source keeps a minute or so). */
  history: NodeSample[];
};

export type StoreDriver = "memory" | "sqlite" | "postgres" | "mysql" | "mongodb";

export type TopologyStore = {
  driver: StoreDriver;
  /** Memory and SQLite keep one node (STUDY-24 H7): the view says followers cannot join. */
  singleNode: boolean;
  /** The node holding the lease (the leader), or `null` when none does (between leaders). */
  leaseHolder: string | null;
  /** When the lease expires unless renewed, on the store's clock (ms); `null` without a lease. */
  leaseExpiresAt: number | null;
  /** The lease's time to live (H5). */
  leaseTtlMs: number | null;
  /** A round trip to the store from the leader, in ms. */
  latencyMs: number | null;
  sizeBytes: number | null;
  /** Connections in use, and the store's limit when it has one. */
  connections: { used: number; max: number | null } | null;
};

export type TopologyEventKind =
  | "node_joined"
  | "node_left"
  | "leader_changed"
  | "lease_acquired"
  | "lease_expired"
  | "node_lagging"
  | "node_caught_up";

export type TopologyEvent = {
  id: string;
  time: number;
  kind: TopologyEventKind;
  /** The node it is about. */
  node?: string;
  /** e.g. the previous leader on `leader_changed`, or the lag on `node_lagging`. */
  detail?: string;
};

export type Topology = {
  /** When this picture was taken (wall-clock ms). */
  time: number;
  /** The leader first, then followers by id. */
  nodes: TopologyNode[];
  store: TopologyStore;
  /** Recent topology events, newest first (a source keeps a bounded number). */
  events: TopologyEvent[];
};

export interface TopologyFeatures {
  getTopology?(opts?: CallOptions): Promise<Topology>;
  /** Pushes a fresh picture whenever the source has one (an implementation may poll). Never synchronously. */
  watchTopology?(onTopology: (t: Topology) => void, onError: (error: DataSourceError) => void): Unsubscribe;
}
