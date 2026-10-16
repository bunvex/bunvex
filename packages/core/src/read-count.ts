// How many reads a transaction made, toward its read limit (`databaseQueries`, 4 096), as Convex counts them
// (STUDY-161 §16): `TransactionReadSet` (crates/database/src/reads.rs) keeps, per index, the intervals read, merged
// (`IntervalSet::add`: an interval folds into every overlapping or adjacent one; an empty one adds nothing), and its
// `num_intervals` moves only on a read the function made (`record_indexed_directly`), by the change of that index's set
// size; a read the engine takes on its own behalf (`record_indexed_derived`) joins the set without counting.
//
// Only the count: the intervals a transaction records for subscriptions and OCC are `Tx`'s `readList`, unchanged.
//
// On the read path, so three shortcuts, none changing the count (a property test checks them against a plain sorted
// array, read after read):
// - a document by id is a point, `[key, key + 1)` with `key` an id's encoded key (no zero byte but its last): two
//   different points never overlap nor touch, so while an index has only points they are a hash set;
// - the interval the last read on an index merged into (and where the next one starts) is kept: a read inside it, or
//   one extending it short of the next, needs no search;
// - the rest are sorted chunks, so an insert moves at most a chunk.
import type { Interval } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";
import type { IndexId } from "./persistence/index.ts";

/** Chunks of at most twice this many intervals: a splice moves at most a chunk. */
const CHUNK = 128;

/** Where an interval of a `Chunked` set is: its chunk and its place in it. */
type At = { c: number; k: number };

/** An index's merged intervals as sorted chunks: a binary search over the chunks, then within one. */
class Chunked {
  /** Each chunk's `lo`s and `hi`s, sorted; no chunk is empty. */
  los: Uint8Array[][] = [];
  his: Uint8Array[][] = [];
  size = 0;

  /** Fold `[lo, hi)` (not empty) in, merging what overlaps or touches it: where the merged interval now is. */
  add(lo: Uint8Array, hi: Uint8Array): At {
    // The first interval ending at or after `lo` (the first that overlaps or touches it).
    let c = 0;
    let n = this.his.length;
    while (c < n) {
      const mid = (c + n) >>> 1;
      const h = this.his[mid]!;
      if (compareKeys(h[h.length - 1]!, lo) < 0) c = mid + 1;
      else n = mid;
    }
    let k = 0;
    if (c < this.los.length) {
      const hs = this.his[c]!;
      let m = hs.length;
      while (k < m) {
        const mid = (k + m) >>> 1;
        if (compareKeys(hs[mid]!, lo) < 0) k = mid + 1;
        else m = mid;
      }
      // Contained: nothing changes.
      if (compareKeys(this.los[c]![k]!, lo) <= 0 && compareKeys(hs[k]!, hi) >= 0) return { c, k };
    }
    let g = k;
    for (let x = 0; x < c; x++) g += this.los[x]!.length;
    // Fold in every interval from there that starts at or before the merged end.
    let from = lo;
    let to = hi;
    let removed = 0;
    for (let x = c, j = k; x < this.los.length; x++, j = 0) {
      const ls = this.los[x]!;
      const hs = this.his[x]!;
      for (; j < ls.length && compareKeys(ls[j]!, to) <= 0; j++, removed++) {
        if (compareKeys(ls[j]!, from) < 0) from = ls[j]!;
        if (compareKeys(hs[j]!, to) > 0) to = hs[j]!;
      }
      if (j < ls.length) break;
    }
    this.remove(g, removed);
    return this.insert(g, from, to);
  }

  /** The `lo` of the interval after the one at `at`, if any. */
  nextLo(at: At): Uint8Array | undefined {
    const ls = this.los[at.c]!;
    return at.k + 1 < ls.length ? ls[at.k + 1] : this.los[at.c + 1]?.[0];
  }

  /** Remove `count` intervals from global position `g` on. */
  private remove(g: number, count: number) {
    let c = 0;
    while (count > 0) {
      const len = this.los[c]!.length;
      if (g >= len) {
        g -= len;
        c++;
        continue;
      }
      const take = Math.min(count, len - g);
      this.los[c]!.splice(g, take);
      this.his[c]!.splice(g, take);
      count -= take;
      this.size -= take;
      if (this.los[c]!.length === 0) {
        this.los.splice(c, 1);
        this.his.splice(c, 1);
      } else c++;
      g = 0;
    }
  }

  /** Insert `[lo, hi)` at global position `g`: where it is. */
  private insert(g: number, lo: Uint8Array, hi: Uint8Array): At {
    this.size++;
    if (this.los.length === 0) {
      this.los.push([lo]);
      this.his.push([hi]);
      return { c: 0, k: 0 };
    }
    let c = 0;
    while (c < this.los.length - 1 && g > this.los[c]!.length) g -= this.los[c++]!.length;
    const ls = this.los[c]!;
    const hs = this.his[c]!;
    ls.splice(g, 0, lo);
    hs.splice(g, 0, hi);
    if (ls.length > 2 * CHUNK) {
      this.los.splice(c + 1, 0, ls.splice(CHUNK));
      this.his.splice(c + 1, 0, hs.splice(CHUNK));
      if (g >= CHUNK) return { c: c + 1, k: g - CHUNK };
    }
    return { c, k: g };
  }
}

/** A point's key in the hash set: its bytes as a string. */
const pointKey = (lo: Uint8Array) => String.fromCharCode.apply(null, lo as unknown as number[]);

/** One index's set. */
class IndexSet {
  /** While the index has only points: each one's `lo` and `hi`, by key. Null once a range came (then all is `ranges`). */
  points: Map<string, [Uint8Array, Uint8Array]> | null;
  ranges = new Chunked();
  /** The interval the last read merged into, where it is, and the next one's `lo` (none: it is the last). */
  private last: { lo: Uint8Array; hi: Uint8Array; at: At; next: Uint8Array | undefined } | null = null;

  constructor(point: boolean) {
    this.points = point ? new Map() : null;
  }

  get size(): number {
    return this.ranges.size + (this.points?.size ?? 0);
  }

  addPoint(lo: Uint8Array, hi: Uint8Array) {
    if (this.points) this.points.set(pointKey(lo), [lo, hi]);
    else this.addRange(lo, hi);
  }

  addRange(lo: Uint8Array, hi: Uint8Array) {
    if (this.points) {
      // The first range: the points join the sorted set (in order, so each is appended), then everything is there.
      const points = [...this.points.values()].sort((a, b) => compareKeys(a[0], b[0]));
      this.points = null;
      // (No last interval to forget: only a range sets it.)
      for (const [l, h] of points) this.ranges.add(l, h);
    }
    const last = this.last;
    if (last && compareKeys(last.lo, lo) <= 0 && compareKeys(lo, last.hi) <= 0) {
      // Inside the last merged interval: nothing changes. (The set only grows, so it still holds that interval.)
      if (compareKeys(hi, last.hi) <= 0) return;
      // Extending it, short of the next interval: it grows in place.
      if (!last.next || compareKeys(hi, last.next) < 0) {
        this.ranges.his[last.at.c]![last.at.k] = hi;
        last.hi = hi;
        return;
      }
    }
    const at = this.ranges.add(lo, hi);
    this.last = {
      lo: this.ranges.los[at.c]![at.k]!,
      hi: this.ranges.his[at.c]![at.k]!,
      at,
      next: this.ranges.nextLo(at),
    };
  }
}

export class ReadCount {
  private sets = new Map<IndexId, IndexSet>();
  /** Convex's `num_intervals`. */
  count = 0;

  /**
   * A read the function made: counted by the change of its index's merged set. `point`: a document by id (its key
   * an encoded id, `hi` just past it).
   */
  direct(i: Interval, point = false) {
    const [before, after] = this.add(i, point);
    // Convex's update: the old size taken off (saturating), the new one added.
    if (before !== after || this.count < before) this.count = Math.max(0, this.count - before) + after;
  }

  /** A read the engine took on its own behalf: in the set, not counted. */
  derived(i: Interval, point = false) {
    this.add(i, point);
  }

  /**
   * Reads Convex makes on indexes a function cannot reach (its configuration, its module): counted, never merged
   * with anything.
   */
  constant(n: number) {
    this.count += n;
  }

  /** Fold `i` into its index's set: that set's size before and after. */
  private add(i: Interval, point: boolean): [number, number] {
    let set = this.sets.get(i.index);
    if (!set) {
      set = new IndexSet(point);
      this.sets.set(i.index, set);
    }
    const before = set.size;
    // An empty interval adds nothing (`Interval::is_empty`).
    if (compareKeys(i.lo, i.hi) < 0) {
      if (point) set.addPoint(i.lo, i.hi);
      else set.addRange(i.lo, i.hi);
    }
    return [before, set.size];
  }
}
