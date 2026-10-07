// The index cache (STUDY-136): a cache of persistence index reads, under the query cache, as Convex's
// `IndexCache` (crates/indexing/src/index_cache). An entry is one `scan` (index, [lo, hi), limit, order) or one
// `get` by id, with the ts it is known valid at. Every transaction of the engine reads through it, queries and
// mutations alike.
//
// Validity is checked lazily against the write log, as the query cache does (STUDY-08 D8; DV-432): an entry
// valid at `a` is valid at `b` when no commit in between wrote into its interval (`changedBetween`, which is
// symmetric). So a commit never touches the cache, and a fill that races a commit cannot install a stale
// entry: it is stamped with the snapshot it read at, and the write log decides at every lookup. Convex
// invalidates eagerly at commit instead, which is what its two-phase populate (`populate_id`, `AtomicCache`)
// and its shuttle tests guard. Nothing here spans an `await` except the persistence read itself.
//
// What writes to persistence outside a commit cannot make an entry wrong: the index backfill writes into an
// index no transaction reads before its `readyTs` (`Tx.resolveIndex`), and retention deletes versions only
// below the oldest snapshot a transaction may read (`Retention.check`).
import type { Committer, Interval } from "./committer.ts";
import type { DocVersion, IndexedDoc } from "./persistence/index.ts";

type Entry = { ts: bigint; value: unknown; bytes: number };

/** Convex's INDEX_CACHE_SIZE default: 512 MiB. */
export const INDEX_CACHE_MAX_BYTES = 512 * 1024 * 1024;

/** An entry's bookkeeping beyond its key and value: the map slot, the entry object, the stamp. */
const ENTRY_OVERHEAD = 96;

export type IndexCacheStats = {
  hits: number;
  /** Lookups that read persistence: no entry (`new`), or one the write log showed changed (`stale`). */
  misses: { new: number; stale: number };
  /** Entries pushed out by the byte budget. */
  evictions: number;
  /** Hits also read from persistence (INDEX_CACHE_VERIFY_PERCENT), and how many differed. */
  verified: number;
  mismatches: number;
};

/** A cached read differed from persistence at the same ts (INDEX_CACHE_VERIFY_PERCENT): a bug in the cache. */
export class IndexCacheMismatchError extends Error {}

export class IndexCache {
  private readonly map = new Map<string, Entry>();
  private used = 0;
  readonly stats: IndexCacheStats = { hits: 0, misses: { new: 0, stale: 0 }, evictions: 0, verified: 0, mismatches: 0 };

  constructor(
    private readonly committer: Pick<Committer, "visibleTs" | "changedBetween">,
    readonly maxBytes = INDEX_CACHE_MAX_BYTES,
    /** The share of hits, in percent, also read from persistence and compared (Convex's verification). */
    readonly verifyPercent = 0,
  ) {}

  get bytes(): number {
    return this.used;
  }

  get entries(): number {
    return this.map.size;
  }

  /** `persistence.scan` through the cache. */
  scan(
    index: string,
    lo: Uint8Array,
    hi: Uint8Array,
    limit: number,
    desc: boolean,
    ts: bigint,
    read: () => IndexedDoc[] | Promise<IndexedDoc[]>,
  ): Promise<IndexedDoc[]> {
    const key = `s${index}|${keyString(lo)}|${keyString(hi)}|${limit}|${desc ? 1 : 0}`;
    return this.read(key, { index, lo, hi }, ts, read, scanBytes, sameRows);
  }

  /** `persistence.get` through the cache: `point` is the document's key in its table's `by_id` index. */
  get(
    byId: string,
    point: Uint8Array,
    pointEnd: Uint8Array,
    ts: bigint,
    read: () => DocVersion | Promise<DocVersion>,
  ): Promise<DocVersion> {
    const key = `g${byId}|${keyString(point)}`;
    return this.read(key, { index: byId, lo: point, hi: pointEnd }, ts, read, versionBytes, sameVersion);
  }

  private async read<T>(
    key: string,
    interval: Interval,
    ts: bigint,
    read: () => T | Promise<T>,
    size: (v: T) => number,
    same: (a: T, b: T) => boolean,
  ): Promise<T> {
    // A snapshot past the visible ts cannot be checked against the write log.
    if (ts > this.committer.visibleTs) return read();
    const e = this.map.get(key);
    if (e) {
      const changed =
        e.ts <= ts
          ? this.committer.changedBetween([interval], e.ts, ts)
          : this.committer.changedBetween([interval], ts, e.ts);
      if (!changed) {
        this.stats.hits++;
        // Most recently used; and known valid up to the newer of the two (the query cache's DV-153).
        this.map.delete(key);
        this.map.set(key, e);
        if (ts > e.ts) e.ts = ts;
        const value = e.value as T;
        if (this.verifyPercent > 0 && Math.random() * 100 < this.verifyPercent)
          await this.verify(key, ts, value, read, same);
        return value;
      }
      this.stats.misses.stale++;
      this.remove(key, e);
    } else this.stats.misses.new++;
    const value = await read();
    this.fill(key, ts, value, size(value));
    return value;
  }

  private async verify<T>(
    key: string,
    ts: bigint,
    cached: T,
    read: () => T | Promise<T>,
    same: (a: T, b: T) => boolean,
  ) {
    this.stats.verified++;
    const fresh = await read();
    if (same(fresh, cached)) return;
    this.stats.mismatches++;
    // Convex logs the difference and panics; here the transaction fails, loudly, and the entry is dropped.
    const e = this.map.get(key);
    if (e) this.remove(key, e);
    const message = `index cache: the cached read ${JSON.stringify(key)} differs from persistence at ts ${ts}`;
    console.error(`bunvex: ${message}`);
    throw new IndexCacheMismatchError(message);
  }

  /** Store a read made at `ts`, unless an entry known valid at a later ts is already there (a concurrent fill). */
  private fill(key: string, ts: bigint, value: unknown, size: number) {
    const prev = this.map.get(key);
    if (prev) {
      if (prev.ts >= ts) return;
      this.remove(key, prev);
    }
    const bytes = size + key.length * 2 + ENTRY_OVERHEAD;
    // One read bigger than a sixteenth of the budget would push out many small hot ones: not kept.
    if (bytes > this.maxBytes / 16) return;
    this.map.set(key, { ts, value, bytes });
    this.used += bytes;
    while (this.used > this.maxBytes) {
      const [k, oldest] = this.map.entries().next().value as [string, Entry];
      this.remove(k, oldest);
      this.stats.evictions++;
    }
  }

  private remove(key: string, e: Entry) {
    this.map.delete(key);
    this.used -= e.bytes;
  }
}

/** Index key bytes as a string for a cache key: latin1 maps each byte to one character. */
function keyString(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
}

// JS strings are UTF-16: two bytes a character, plus each row's object and id.
const scanBytes = (rows: IndexedDoc[]) => {
  let n = 16;
  for (const r of rows) n += 2 * (r.json.length + r.id.length) + 48;
  return n;
};
const versionBytes = (v: DocVersion) => (v ? 2 * v.json.length + 32 : 8);

const sameRows = (a: IndexedDoc[], b: IndexedDoc[]) =>
  a.length === b.length && a.every((r, i) => r.id === b[i]!.id && r.ts === b[i]!.ts && r.json === b[i]!.json);
const sameVersion = (a: DocVersion, b: DocVersion) =>
  a === null ? b === null : b !== null && a.ts === b.ts && a.json === b.json;
