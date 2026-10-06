// The subscriptions and invalidation inspector in the dashboard contract (STUDY-131 AD-25) — a bunvex addition:
// Convex keeps its read sets internal and no screen says why a query re-ran. A server source maps these to
// `GET /api/debug/subscriptions`, `/api/debug/query_cache` and `/api/debug/invalidations` (a long poll). Every
// method is optional — a source offers the screen by having them (detected with `typeof`) — and needs the
// `viewMetrics` operation. Re-exported by `data-source.ts`.
import type { CallOptions, DataSourceError, Json, Unsubscribe } from "./data-source.ts";

/** One end of a read interval, read back to values (`after`: just past every key starting with them). */
export type ReadBound =
  | { kind: "min"; text: string }
  | { kind: "max"; text: string }
  | { kind: "key"; values: Json[]; after: boolean; text: string }
  | { kind: "raw"; hex: string; text: string };

/** One index range a query read. */
export type ReadRange = {
  /** `table.index`. */
  index: string;
  /** The index's key fields, `_id` last. */
  fields: string[];
  lo: ReadBound;
  hi: ReadBound;
  /** `[lo, hi)` as text. */
  text: string;
};

/** What made a live query's execution run again, newest first. */
export type QueryHistoryEntry =
  | {
      kind: "invalidation";
      /** Its number in the follow stream; what a log entry's link names (STUDY-131 AD-27). */
      seq?: number;
      /** Wall-clock ms when the commit was matched. */
      at: number;
      commitTs: number;
      /** The mutation that wrote, when it gave its name. */
      source: string | null;
      table: string | null;
      index: string;
      /** The key it wrote, read back to values (the index's fields, then the document's `_id`). */
      key: ReadBound;
      /** ms until the new result was sent; null until it was. */
      sentAfterMs: number | null;
    }
  | {
      kind: "rerun";
      at: number;
      reason: "newSubscriber" | "identityChange" | "codeChange" | "retry";
    };

export type LiveQuery = {
  queryId: number;
  path: string;
  /** A short digest of the canonical arguments: equal for equal arguments. */
  argsDigest: string;
  /** The snapshot its result is at; null before its first run. */
  ts: number | null;
  /** Its last result came from another session's run (no run of its own). */
  cached: boolean;
  lastRunAt: number | null;
  result: "pending" | "value" | "error";
  documentsRead: number;
  bytesRead: number;
  readSet: ReadRange[];
  history: QueryHistoryEntry[];
};

export type LiveSession = {
  sessionId: string | null;
  /** Who the connection acts as. */
  identity: "none" | "user" | "admin";
  queries: LiveQuery[];
};

export type SubscriptionsSnapshot = {
  /** The latest visible commit ts. */
  ts: number;
  /** How many history entries each query keeps; 0 when recording is off. */
  historySize: number;
  sessions: LiveSession[];
  totals: { sessions: number; queries: number };
};

export type CacheMissReason = "new" | "evicted" | "invalidated" | "expired" | "snapshot";

export type QueryCacheEntry = {
  path: string;
  argsDigest: string;
  /** Shared by every caller (the run read no identity), or one caller's. */
  shared: boolean;
  state: "ready" | "running";
  size: number;
  originalTs?: number;
  tokenTs?: number;
  readSet?: ReadRange[];
};

export type QueryCacheSnapshot = {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  missReasons: Record<CacheMissReason, number>;
  evictions: number;
  /** Entries matching the filter. */
  matching: number;
  /** The biggest matching entries, biggest first. */
  biggest: QueryCacheEntry[];
};

/** An invalidation as the follow stream delivers it. */
export type InvalidationEvent = Omit<Extract<QueryHistoryEntry, { kind: "invalidation" }>, "seq"> & {
  seq: number;
  path: string;
  argsDigest: string;
};

/** `path`: only functions whose path contains it. */
export type InspectorFilter = { path?: string };

export interface SubscriptionsFeatures {
  getSubscriptions?(filter?: InspectorFilter, opts?: CallOptions): Promise<SubscriptionsSnapshot>;
  getQueryCache?(filter?: InspectorFilter & { limit?: number }, opts?: CallOptions): Promise<QueryCacheSnapshot>;
  /** New invalidations as they happen, oldest first, from now on. Never synchronously. */
  watchInvalidations?(
    filter: InspectorFilter,
    onEvents: (events: InvalidationEvent[]) => void,
    onError: (error: DataSourceError) => void,
  ): Unsubscribe;
}
