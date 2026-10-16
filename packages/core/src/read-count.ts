// How many reads a transaction made, toward its read limit (`databaseQueries`, 4 096), as Convex counts them
// (STUDY-161 §16): `TransactionReadSet` (crates/database/src/reads.rs) keeps, per index, the intervals read, merged
// (`IntervalSet::add`: an interval folds into every overlapping or adjacent one; an empty one adds nothing), and its
// `num_intervals` moves only on a read the function made (`record_indexed_directly`), by the change of that index's set
// size; a read the engine takes on its own behalf (`record_indexed_derived`) joins the set without counting.
//
// Only the count: the intervals a transaction records for subscriptions and OCC are `Tx`'s `readList`, unchanged.
//
// Counted exactly only when it can matter (`ReadCounter`): until then a bound, one per interval added (direct or
// derived) plus the constants, and a log of the additions in order; the exact count is the log replayed into
// `ReadCount`, at the first moment an answer depends on it.
import type { Interval } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";
import type { IndexId } from "./persistence/index.ts";

/** Chunks of at most twice this many intervals: a splice moves at most a chunk. */
const CHUNK = 128;

/** An index's merged intervals as sorted chunks: a binary search over the chunks, then within one. */
class Chunked {
  /** Each chunk's `lo`s and `hi`s, sorted; no chunk is empty. */
  private los: Uint8Array[][] = [];
  private his: Uint8Array[][] = [];
  size = 0;

  /** Fold `[lo, hi)` (not empty) in, merging what overlaps or touches it. */
  add(lo: Uint8Array, hi: Uint8Array) {
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
      if (compareKeys(this.los[c]![k]!, lo) <= 0 && compareKeys(hs[k]!, hi) >= 0) return;
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
    this.insert(g, from, to);
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

  /** Insert `[lo, hi)` at global position `g`. */
  private insert(g: number, lo: Uint8Array, hi: Uint8Array) {
    this.size++;
    if (this.los.length === 0) {
      this.los.push([lo]);
      this.his.push([hi]);
      return;
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
    }
  }
}

/** Convex's count, exactly: per index the merged intervals (sorted chunks), and `num_intervals`. */
export class ReadCount {
  private sets = new Map<IndexId, Chunked>();
  /** Convex's `num_intervals`. */
  count = 0;

  /** A read the function made: counted by the change of its index's merged set. */
  direct(i: Interval) {
    const [before, after] = this.add(i);
    // Convex's update: the old size taken off (saturating), the new one added.
    this.count = Math.max(0, this.count - before) + after;
  }

  /** A read the engine took on its own behalf: in the set, not counted. */
  derived(i: Interval) {
    this.add(i);
  }

  /** Reads Convex makes on indexes a function cannot reach (its configuration, its modules): counted as they are. */
  constant(n: number) {
    this.count += n;
  }

  /** Fold `i` into its index's set: that set's size before and after. */
  private add(i: Interval): [number, number] {
    let set = this.sets.get(i.index);
    if (!set) {
      set = new Chunked();
      this.sets.set(i.index, set);
    }
    const before = set.size;
    // An empty interval adds nothing (`Interval::is_empty`).
    if (compareKeys(i.lo, i.hi) < 0) set.add(i.lo, i.hi);
    return [before, set.size];
  }
}

/** One addition, as the exact count would take it: a direct read, a derived one, or a scan's first read (resolved late). */
type Entry =
  | { kind: "direct" | "derived"; i: Interval }
  | { kind: "constant"; n: number }
  | { kind: "scan"; resolve: () => Interval };

/**
 * The count a transaction keeps (STUDY-161 §16.6): `bound` until an answer depends on the exact count, then `ReadCount`.
 *
 * `bound` is never below the exact count: it is one per interval added (direct or derived) plus the constants. A direct
 * addition moves the exact count to `max(0, count − before) + after`: with `count ≥ before` that is at most one more (an
 * addition grows its set by at most one), and with `count < before` it is `after`, the set's size, which is at most the
 * intervals ever added to it. A derived one does not move it. So each consumer compares the bound to its own point
 * (the limit, the warning's floor) and needs the exact count only past it.
 */
export class ReadCounter {
  /** One per interval added, plus the constants: never below the exact count. */
  bound = 0;
  private log: Entry[] | null = [];
  private exact: ReadCount | null = null;

  /** A read the function made. */
  direct(i: Interval) {
    if (this.exact) this.exact.direct(i);
    else {
      this.bound++;
      this.log!.push({ kind: "direct", i: { index: i.index, lo: i.lo, hi: i.hi } });
    }
  }

  /** A scan's first read: its interval, known later (it ends at its first document). */
  scan(resolve: () => Interval) {
    if (this.exact) this.exact.direct(resolve());
    else {
      this.bound++;
      this.log!.push({ kind: "scan", resolve });
    }
  }

  /** A read the engine took on its own behalf. */
  derived(i: Interval) {
    if (this.exact) this.exact.derived(i);
    else {
      this.bound++;
      this.log!.push({ kind: "derived", i: { index: i.index, lo: i.lo, hi: i.hi } });
    }
  }

  /** Reads Convex makes outside what a function reads (counted as they are, in both). */
  constant(n: number) {
    if (this.exact) this.exact.constant(n);
    else {
      this.bound += n;
      this.log!.push({ kind: "constant", n });
    }
  }

  /** Whether the exact count is known (the log replayed). */
  get isExact(): boolean {
    return this.exact !== null;
  }

  /** The exact count: the log replayed in order, the first time it is asked. */
  count(): number {
    if (!this.exact) {
      const exact = new ReadCount();
      for (const e of this.log!)
        switch (e.kind) {
          case "direct":
            exact.direct(e.i);
            break;
          case "derived":
            exact.derived(e.i);
            break;
          case "scan":
            exact.direct(e.resolve());
            break;
          case "constant":
            exact.constant(e.n);
        }
      this.exact = exact;
      this.log = null;
    }
    return this.exact.count;
  }

  /** Whether the exact count is past `limit`: the bound answers while it is not past it. */
  over(limit: number): boolean {
    return (this.exact ? this.exact.count : this.bound) > limit && this.count() > limit;
  }

  /** The count where it is above `floor` (exact), else a number not above it (the bound): what a warning needs. */
  upTo(floor: number): number {
    return this.exact || this.bound > floor ? this.count() : this.bound;
  }
}
