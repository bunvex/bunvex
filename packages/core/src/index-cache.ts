// STUDY-136 prototype: a cache of persistence index reads (Convex's IndexCache, crates/indexing/src/index_cache),
// shared by every transaction of the engine. An entry is one `scan` (index, [lo, hi), limit, order) or one
// `get` by id, with the ts it is known valid at.
//
// Validity is checked lazily against the write log, as the query cache does (STUDY-08 D8): an entry valid at
// `a` is valid at `b` when no commit in between wrote into its interval (`changedBetween`, symmetric). So a
// commit never touches the cache, and a fill that races a commit is safe: it is stamped with the snapshot it
// read at, and the write log decides at every lookup. Convex invalidates eagerly at commit instead, which is
// what its populate protocol (populate_id, AtomicCache, the shuttle tests) guards.
import type { Committer, Interval } from "./committer.ts";

type Entry<T> = { ts: bigint; value: T; bytes: number; interval: Interval };

export type IndexCacheStats = {
  hits: number;
  misses: number;
  /** Misses on an entry the write log showed changed (or could not prove unchanged). */
  stale: number;
  /** Hits re-read from persistence (`verifyPercent`), and how many differed. */
  verified: number;
  mismatches: number;
  bytes: number;
  entries: number;
};

export class IndexCache {
  private readonly map = new Map<string, Entry<unknown>>();
  private bytes = 0;
  readonly stats: IndexCacheStats = {
    hits: 0,
    misses: 0,
    stale: 0,
    verified: 0,
    mismatches: 0,
    bytes: 0,
    entries: 0,
  };

  constructor(
    private readonly committer: Committer,
    private readonly maxBytes = 64 * 1024 * 1024,
    /** Convex's INDEX_CACHE_VERIFY_PERCENT: the share of hits also read from persistence and compared. */
    private readonly verifyPercent = 0,
  ) {}

  /**
   * The value of `read()` at `ts`, from the cache when an entry for `key` is provably the same at `ts`.
   * `interval` is everything the read depends on; `size` estimates an entry's bytes.
   */
  async read<T>(
    key: string,
    interval: Interval,
    ts: bigint,
    read: () => T | Promise<T>,
    size: (v: T) => number,
    equal: (a: T, b: T) => boolean,
  ): Promise<T> {
    // A snapshot past the visible ts cannot be checked against the log (no transaction reads there today).
    if (ts > this.committer.visibleTs) return read();
    const e = this.map.get(key) as Entry<T> | undefined;
    if (e) {
      const [from, to] = e.ts <= ts ? [e.ts, ts] : [ts, e.ts];
      if (!this.committer.changedBetween([interval], from, to)) {
        this.stats.hits++;
        // Most recently used, and valid up to the newer end.
        this.map.delete(key);
        this.map.set(key, e);
        if (ts > e.ts) e.ts = ts;
        if (this.verifyPercent > 0 && Math.random() * 100 < this.verifyPercent) {
          this.stats.verified++;
          const fresh = await read();
          if (!equal(fresh, e.value)) {
            this.stats.mismatches++;
            throw new Error(`index cache: the cached read of ${key} differs from persistence at ${ts}`);
          }
        }
        return e.value;
      }
      this.stats.stale++;
      this.drop(key, e);
    }
    this.stats.misses++;
    const value = await read();
    const prev = this.map.get(key) as Entry<T> | undefined;
    // A concurrent fill may have stored one already: keep the newer.
    if (prev && prev.ts >= ts) return value;
    if (prev) this.drop(key, prev);
    const bytes = size(value) + key.length + 64;
    if (bytes > this.maxBytes / 16) return value; // too big to be worth a slot
    this.map.set(key, { ts, value, bytes, interval });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      const [k, oldest] = this.map.entries().next().value as [string, Entry<unknown>];
      this.drop(k, oldest);
    }
    this.stats.bytes = this.bytes;
    this.stats.entries = this.map.size;
    return value;
  }

  private drop(key: string, e: Entry<unknown>) {
    this.map.delete(key);
    this.bytes -= e.bytes;
    this.stats.bytes = this.bytes;
    this.stats.entries = this.map.size;
  }
}

/** A cache key for raw key bytes: latin1 maps each byte to one char. */
export const keyBytes = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
