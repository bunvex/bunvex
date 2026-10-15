// The subscriptions and invalidation inspector (STUDY-131 AD-25, a bunvex addition: Convex keeps its read sets
// internal) over the server's admin routes, with the admin key and the dashboard's client header (ViewMetrics):
// `GET /api/debug/subscriptions` and `/api/debug/query_cache` read once per call, and `/api/debug/invalidations`
// followed as the log stream is (logs.ts): a long poll from a cursor, each answer's `newCursor` asked from next,
// failures backing off as Convex's log loop does and reported after 5 in a row. The follow starts from now (a
// first request that waits for nothing gives the feed's newest `seq`), stops while the deployment is disconnected
// (PR 6's rule for the polled reads) and, after a failure or a disconnection, asks the feed again from the start:
// what it missed is delivered, and a server that restarted (its `seq` behind ours) is followed from its own.
import {
  type CacheMissReason,
  type CallOptions,
  type ConnectionStatus,
  DataSourceError,
  type InspectorFilter,
  type InvalidationEvent,
  type LiveQuery,
  type LiveSession,
  type QueryCacheEntry,
  type QueryCacheSnapshot,
  type QueryHistoryEntry,
  type ReadBound,
  type ReadRange,
  type SubscriptionsSnapshot,
  type Unsubscribe,
} from "@bunvex/dashboard/data-source";
import type { AdminHttp } from "./admin-http.ts";
import { backoffWithJitter, REPORT_AFTER_FAILURES } from "./logs.ts";

// ------------------------------------------------------------------ the server's JSON (debug-routes.ts)

type BoundJson = ReadBound;
type RangeJson = { index: string; fields: string[]; lo: BoundJson; hi: BoundJson; text: string };
type HistoryJson =
  | { kind: "rerun"; reason: Extract<QueryHistoryEntry, { kind: "rerun" }>["reason"]; at: number }
  | {
      kind: "invalidation";
      seq: number;
      at: number;
      commitTs: number;
      source: string | null;
      table: string | null;
      index: string;
      key: BoundJson;
      sentAfterMs: number | null;
    };
type QueryJson = {
  queryId: number;
  path: string;
  argsDigest: string;
  ts: number | null;
  validAt?: number;
  cached: boolean;
  lastRunAt: number | null;
  result: LiveQuery["result"];
  documentsRead: number;
  bytesRead: number;
  readSet: RangeJson[];
  history: HistoryJson[];
};
type SubscriptionsJson = {
  ts: number;
  historySize: number;
  sessions: { sessionId: string | null; identity: LiveSession["identity"]; queries: QueryJson[] }[];
  totals: { sessions: number; queries: number };
};
type CacheEntryJson = {
  path: string;
  argsDigest: string;
  shared: boolean;
  state: "ready" | "running";
  size: number;
  originalTs?: number;
  tokenTs?: number;
  readSet?: RangeJson[];
};
type QueryCacheJson = {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  missReasons: Partial<Record<CacheMissReason, number>>;
  evictions: number;
  matching: number;
  biggest: CacheEntryJson[];
};
type FeedJson = { entries: (Extract<HistoryJson, { kind: "invalidation" }> & { path: string; argsDigest: string })[] };
type FeedAnswer = FeedJson & { newCursor: number };

const MISS_REASONS: CacheMissReason[] = ["new", "evicted", "invalidated", "expired", "snapshot"];

// ------------------------------------------------------------------ mapping to the contract

const boundOf = (b: BoundJson): ReadBound => {
  if (b.kind === "key") return { kind: "key", values: b.values, after: b.after, text: b.text };
  if (b.kind === "raw") return { kind: "raw", hex: b.hex, text: b.text };
  return { kind: b.kind, text: b.text };
};

const rangeOf = (r: RangeJson): ReadRange => ({
  index: r.index,
  fields: r.fields,
  lo: boundOf(r.lo),
  hi: boundOf(r.hi),
  text: r.text,
});

const historyOf = (h: HistoryJson): QueryHistoryEntry =>
  h.kind === "rerun"
    ? { kind: "rerun", at: h.at, reason: h.reason }
    : {
        kind: "invalidation",
        seq: h.seq,
        at: h.at,
        commitTs: h.commitTs,
        source: h.source,
        table: h.table,
        index: h.index,
        key: boundOf(h.key),
        sentAfterMs: h.sentAfterMs,
      };

/** The server's snapshot as the contract's (the execution's `validAt` is the server's own, left out). */
export function subscriptionsOf(json: SubscriptionsJson): SubscriptionsSnapshot {
  return {
    ts: json.ts,
    historySize: json.historySize,
    sessions: json.sessions.map((s) => ({
      sessionId: s.sessionId,
      identity: s.identity,
      queries: s.queries.map(
        (q): LiveQuery => ({
          queryId: q.queryId,
          path: q.path,
          argsDigest: q.argsDigest,
          ts: q.ts,
          cached: q.cached,
          lastRunAt: q.lastRunAt,
          result: q.result,
          documentsRead: q.documentsRead,
          bytesRead: q.bytesRead,
          readSet: q.readSet.map(rangeOf),
          history: q.history.map(historyOf),
        }),
      ),
    })),
    totals: { sessions: json.totals.sessions, queries: json.totals.queries },
  };
}

/** The server's query cache as the contract's (its `waits`, a running entry's `ts` and `observedTime` left out). */
export function queryCacheOf(json: QueryCacheJson): QueryCacheSnapshot {
  const missReasons = Object.fromEntries(MISS_REASONS.map((r) => [r, json.missReasons[r] ?? 0])) as Record<
    CacheMissReason,
    number
  >;
  return {
    entries: json.entries,
    bytes: json.bytes,
    maxBytes: json.maxBytes,
    hits: json.hits,
    misses: json.misses,
    missReasons,
    evictions: json.evictions,
    matching: json.matching,
    biggest: json.biggest.map(
      (e): QueryCacheEntry => ({
        path: e.path,
        argsDigest: e.argsDigest,
        shared: e.shared,
        state: e.state,
        size: e.size,
        ...(e.originalTs !== undefined && { originalTs: e.originalTs }),
        ...(e.tokenTs !== undefined && { tokenTs: e.tokenTs }),
        ...(e.readSet && { readSet: e.readSet.map(rangeOf) }),
      }),
    ),
  };
}

export const invalidationsOf = (json: FeedJson): InvalidationEvent[] =>
  json.entries.map((e) => {
    const h = historyOf(e) as Extract<QueryHistoryEntry, { kind: "invalidation" }>;
    return { ...h, seq: e.seq, path: e.path, argsDigest: e.argsDigest };
  });

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// ------------------------------------------------------------------ the follow loop

/** The longest a follow request waits on the server (its `FOLLOW_MAX_MS`). */
export const FOLLOW_MS = 60_000;

export type InspectorOptions = {
  /** The deployment's connection status (the source's `watchConnection`); none: always connected. */
  connection?: (onStatus: (s: ConnectionStatus) => void) => Unsubscribe;
  /** For tests: the backoff between failures. Default: `backoffWithJitter`. */
  backoff?: (failures: number) => number;
  /** How long one follow request may wait on the server, in ms. Default: the server's longest, 60 000. */
  followTimeoutMs?: number;
};

export class Inspector {
  /** The follow loops running, each its stop. */
  private readonly loops = new Set<() => void>();

  constructor(
    private readonly http: AdminHttp,
    private readonly opts: InspectorOptions = {},
  ) {}

  async getSubscriptions(filter?: InspectorFilter, o?: CallOptions): Promise<SubscriptionsSnapshot> {
    const json = await this.http.json<SubscriptionsJson>(`/api/debug/subscriptions${query({ path: filter?.path })}`, {
      signal: o?.signal,
    });
    return subscriptionsOf(json);
  }

  async getQueryCache(filter?: InspectorFilter & { limit?: number }, o?: CallOptions): Promise<QueryCacheSnapshot> {
    const json = await this.http.json<QueryCacheJson>(
      `/api/debug/query_cache${query({ path: filter?.path, limit: filter?.limit })}`,
      { signal: o?.signal },
    );
    return queryCacheOf(json);
  }

  /**
   * New invalidations matching `filter`, oldest first, from the call on; never synchronously. One long-poll loop
   * per watcher (the server filters by path), stopped by the returned function.
   */
  watchInvalidations(
    filter: InspectorFilter,
    onEvents: (events: InvalidationEvent[]) => void,
    onError: (e: DataSourceError) => void,
  ): Unsubscribe {
    const stop = new AbortController();
    // the request in flight, aborted on a disconnection as well as by the stop
    let request: AbortController | null = null;
    let connected = true;
    // ends the wait in progress (a back-off, or the wait for the connection) when the connection comes back
    let wake: (() => void) | null = null;
    const offConnection = this.opts.connection?.((s) => {
      // only `disconnected` stops it (`unknown` is not settled yet), as the screens' overlay
      connected = s !== "disconnected";
      if (!connected) request?.abort();
      else wake?.();
    });
    /** Waits `ms` (forever when undefined), or until the connection comes back or the loop stops. */
    const wait = (ms?: number) =>
      new Promise<void>((resolve) => {
        const timer = ms === undefined ? undefined : setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          stop.signal.removeEventListener("abort", done);
          resolve();
        }
        wake = done;
        stop.signal.addEventListener("abort", done, { once: true });
      });

    const ask = async (cursor: number, timeoutMs: number): Promise<FeedAnswer> => {
      request = new AbortController();
      const signal = AbortSignal.any([stop.signal, request.signal]);
      try {
        return await this.http.json<FeedAnswer>(
          `/api/debug/invalidations${query({ cursor, timeoutMs, path: filter.path })}`,
          { signal },
        );
      } finally {
        request = null;
      }
    };

    const loop = async () => {
      // the last `seq` seen; null before the first answer
      let cursor: number | null = null;
      // the position must be found again: after a failure or a disconnection (the server may have restarted)
      let resync = false;
      let failures = 0;
      while (!stop.signal.aborted) {
        if (!connected) {
          await wait();
          resync = true;
          continue;
        }
        try {
          if (cursor === null || resync) {
            // where the feed is now: everything it holds, at once
            const a = await ask(0, 0);
            if (stop.signal.aborted) return;
            // the first time, nothing from before the call; later, what came after the last seen (all of it when
            // the feed is behind ours: a server that restarted)
            const seen = cursor;
            const missed = seen === null ? [] : a.entries.filter((e) => seen > a.newCursor || e.seq > seen);
            failures = 0;
            cursor = a.newCursor;
            resync = false;
            if (missed.length > 0) onEvents(invalidationsOf({ entries: missed }));
            continue;
          }
          const a = await ask(cursor, this.opts.followTimeoutMs ?? FOLLOW_MS);
          if (stop.signal.aborted) return;
          failures = 0;
          cursor = a.newCursor;
          if (a.entries.length > 0) onEvents(invalidationsOf(a));
        } catch (e) {
          if (stop.signal.aborted) return;
          // aborted by a disconnection: the loop's top waits for the connection, then catches up
          if (!connected) continue;
          const error = e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e));
          // a key that may not view metrics (or a refused key) stays so: stop, and say so at once
          if (error.code === "unauthorized") {
            onError(error);
            return;
          }
          failures++;
          if (failures > REPORT_AFTER_FAILURES) onError(error);
          resync = true;
          await wait((this.opts.backoff ?? backoffWithJitter)(failures));
        }
      }
    };
    // never synchronously: the first request goes out on a later tick
    const first = setTimeout(() => void loop(), 0);
    const off = () => {
      this.loops.delete(off);
      clearTimeout(first);
      stop.abort();
      offConnection?.();
    };
    this.loops.add(off);
    return off;
  }

  /** Stops every follow loop. */
  close() {
    for (const off of [...this.loops]) off();
  }
}
