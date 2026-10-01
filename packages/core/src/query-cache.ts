// The query cache's store (STUDY-08 §1.1, D8): an LRU bounded by bytes, whose entries are either a result
// ("ready") or an execution under way that later callers wait for ("waiting"). How results are looked up,
// validated and coalesced is the engine's (`Engine.cachedQuery`); this file only keeps them.

import type { Interval } from "./committer.ts";

/** The byte budget, as Convex's UDF_CACHE_MAX_SIZE (`crates/common/src/knobs.rs`): 100 MiB. */
export const QUERY_CACHE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * How long a result that read the clock (`Date.now()`, `new Date()`, `performance.now()`) may be served, as
 * Convex's MAX_CACHE_AGE: its total query timeout (1 s of user time + 15 s of system time) plus 1 s.
 */
export const MAX_CACHE_AGE_MS = 17_000;

/** A query's result, valid from `originalTs` on as long as no commit after `tokenTs` writes into `reads`. */
export type CachedResult = {
  /** The result, serialized: every caller gets its own copy. */
  json: string;
  /** What the caller's companion stored with it (the execution's log lines). */
  extra: unknown;
  /** The snapshot the query ran at. */
  originalTs: number;
  /** The ts up to which `reads` are known unchanged (Convex's token ts). */
  tokenTs: number;
  reads: Interval[];
  /** Whether the run read the clock: then the result expires after MAX_CACHE_AGE_MS. */
  observedTime: boolean;
  /** The clock the run saw (ms since the epoch). */
  unixMs: number;
  /** Whether the run read the caller's identity: then it is stored under that caller's key. */
  identityObserved: boolean;
};

export type ReadyEntry = { kind: "ready"; result: CachedResult; size: number };
export type WaitingEntry = {
  kind: "waiting";
  id: number;
  /** The snapshot the execution runs at. */
  ts: number;
  /** Settles with the result when it is stored under this entry's key, with null otherwise (retry). */
  result: Promise<CachedResult | null>;
  size: number;
};
export type CacheEntry = ReadyEntry | WaitingEntry;

/**
 * Rough heap bytes per entry beyond its strings: the Map slot, the entry and result objects, the read-set
 * array and the companion's array. Measured: 200 000 entries of a 100-byte result take about 500 bytes each
 * (`packages/server/bench/query-cache.ts memory`).
 */
const ENTRY_OVERHEAD = 360;
/** Rough heap bytes per read interval beyond its key bytes: the object and two Uint8Array headers. */
const INTERVAL_OVERHEAD = 96;

/** A rough size of what a companion stored (log lines are an array of strings). */
function extraSize(extra: unknown): number {
  if (extra == null) return 0;
  if (typeof extra === "string") return extra.length;
  if (Array.isArray(extra)) {
    let n = 16;
    for (const x of extra) n += 16 + extraSize(x);
    return n;
  }
  return 64;
}

/** Approximate heap bytes of a ready entry under `key`, as Convex sizes its key plus its result and token. */
export function readySize(key: string, r: CachedResult): number {
  let n = ENTRY_OVERHEAD + key.length + r.json.length + extraSize(r.extra);
  for (const i of r.reads) n += INTERVAL_OVERHEAD + i.lo.length + i.hi.length;
  return n;
}
const waitingSize = (key: string) => ENTRY_OVERHEAD + key.length;

export class QueryCache {
  /** Least recently used first: a Map keeps insertion order, and a use re-inserts. */
  private entries = new Map<string, CacheEntry>();
  private nextWaitingId = 0;
  /** Bytes of every entry, as `readySize` / `waitingSize` count them. */
  bytes = 0;
  /** Entries dropped to stay within the budget. */
  evictions = 0;

  constructor(readonly maxBytes: number = QUERY_CACHE_MAX_BYTES) {}

  get size() {
    return this.entries.size;
  }

  /** The first of `keys` present, marked as just used. */
  find(keys: readonly string[]): { key: string; entry: CacheEntry } | undefined {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return { key, entry };
    }
    return undefined;
  }

  /** Mark `key` as being computed at `ts`; `settle` hands its outcome to whoever waits. */
  putWaiting(key: string, ts: number): { id: number; settle(r: CachedResult | null): void } {
    const id = this.nextWaitingId++;
    let settle!: (r: CachedResult | null) => void;
    const result = new Promise<CachedResult | null>((ok) => (settle = ok));
    this.set(key, { kind: "waiting", id, ts, result, size: waitingSize(key) });
    this.enforceLimit();
    return { id, settle };
  }

  /** Drop the waiting entry `id` of `key`, if it is still there. */
  removeWaiting(key: string, id: number) {
    const e = this.entries.get(key);
    if (e?.kind === "waiting" && e.id === id) this.delete(key, e);
  }

  /** Drop the result of `key` computed at `originalTs`, if it is still there. */
  removeReady(key: string, originalTs: number) {
    const e = this.entries.get(key);
    if (e?.kind === "ready" && e.result.originalTs === originalTs) this.delete(key, e);
  }

  /**
   * Store `r` under `key`: in place of a waiting entry, or of an older result; a result older than the
   * one stored (lower `originalTs`, or the same with a lower `tokenTs`) is dropped. Then evict to the budget.
   */
  putReady(key: string, r: CachedResult) {
    const e = this.entries.get(key);
    if (e?.kind === "ready") {
      const cur = e.result;
      const newer = cur.originalTs < r.originalTs || (cur.originalTs === r.originalTs && cur.tokenTs < r.tokenTs);
      if (!newer) return;
    }
    this.set(key, { kind: "ready", result: r, size: readySize(key, r) });
    this.enforceLimit();
  }

  /** Drop everything (the catalog changed under the cached results). */
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  private set(key: string, entry: CacheEntry) {
    const old = this.entries.get(key);
    if (old) this.delete(key, old);
    this.entries.set(key, entry);
    this.bytes += entry.size;
  }

  private delete(key: string, e: CacheEntry) {
    this.entries.delete(key);
    this.bytes -= e.size;
  }

  /**
   * Evict least recently used entries until the bytes fit, the newest included, as Convex's
   * `enforce_size_limit`: a result larger than the whole budget empties the cache and is not kept.
   */
  private enforceLimit() {
    while (this.bytes > this.maxBytes) {
      const first = this.entries.entries().next();
      if (first.done) break;
      this.delete(first.value[0], first.value[1]);
      this.evictions++;
    }
  }
}
