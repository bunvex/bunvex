// How many reads a transaction made, toward its read limit (`databaseQueries`, 4 096), as Convex counts them
// (STUDY-161 §16): `TransactionReadSet` (crates/database/src/reads.rs) keeps, per index, the intervals read, merged
// (`IntervalSet::add`: an interval folds into every overlapping or adjacent one; an empty one adds nothing), and its
// `num_intervals` moves only on a read the function made (`record_indexed_directly`), by the change of that index's set
// size; a read the engine takes on its own behalf (`record_indexed_derived`) joins the set without counting.
//
// Only the count: the intervals a transaction records for subscriptions and OCC are `Tx`'s `readList`, unchanged.
import { BTree } from "./btree.ts";
import type { Interval } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";
import type { IndexId } from "./persistence/index.ts";

/** One index's merged intervals: disjoint and not adjacent, ordered by `lo`. */
interface MergedSet {
  readonly size: number;
  /** Fold `[lo, hi)` (not empty) in, merging what overlaps or touches it. */
  add(lo: Uint8Array, hi: Uint8Array): void;
}

/** The set as a B-tree of `lo → hi`: each step a logarithmic search. */
class TreeSet implements MergedSet {
  private tree = new BTree<Uint8Array, Uint8Array>(undefined, compareKeys);

  get size() {
    return this.tree.size;
  }

  add(lo: Uint8Array, hi: Uint8Array) {
    const t = this.tree;
    let from = lo;
    let to = hi;
    // The interval starting at or before `lo`: it contains the new one (nothing to do), or touches it (merge).
    const prev = t.getPairOrNextLower(lo);
    if (prev) {
      if (compareKeys(prev[1], hi) >= 0) return;
      if (compareKeys(prev[1], lo) >= 0) {
        from = prev[0];
        t.delete(prev[0]);
      }
    }
    // Then every interval starting within `[lo, hi]` (overlapping or adjacent), folded in.
    for (
      let next = t.getPairOrNextHigher(lo);
      next && compareKeys(next[0], to) <= 0;
      next = t.nextHigherPair(next[0])
    ) {
      if (compareKeys(next[1], to) > 0) to = next[1];
      t.delete(next[0]);
    }
    t.set(from, to);
  }
}

/** Chunks of at most twice this many intervals: a splice moves at most a chunk. */
const CHUNK = 128;

/** The set as sorted chunks of intervals: a binary search over the chunks, then within one. */
class ChunkedSet implements MergedSet {
  /** Each chunk's `lo`s and `hi`s, sorted; no chunk is empty. */
  private los: Uint8Array[][] = [];
  private his: Uint8Array[][] = [];
  size = 0;

  add(lo: Uint8Array, hi: Uint8Array) {
    // The first interval ending at or after `lo` (the first that overlaps or touches it), as a global position.
    let c = 0;
    let n = this.his.length;
    while (c < n) {
      const mid = (c + n) >>> 1;
      const h = this.his[mid]!;
      if (compareKeys(h[h.length - 1]!, lo) < 0) c = mid + 1;
      else n = mid;
    }
    let g = 0;
    for (let x = 0; x < c; x++) g += this.los[x]!.length;
    if (c < this.los.length) {
      const hs = this.his[c]!;
      let k = 0;
      let m = hs.length;
      while (k < m) {
        const mid = (k + m) >>> 1;
        if (compareKeys(hs[mid]!, lo) < 0) k = mid + 1;
        else m = mid;
      }
      // Contained: nothing changes.
      if (compareKeys(this.los[c]![k]!, lo) <= 0 && compareKeys(hs[k]!, hi) >= 0) return;
      g += k;
    }
    // Fold in every interval from there that starts at or before the merged end.
    let from = lo;
    let to = hi;
    let removed = 0;
    for (let x = c, k = g - this.before(c); x < this.los.length; x++, k = 0) {
      const ls = this.los[x]!;
      const hs = this.his[x]!;
      for (; k < ls.length && compareKeys(ls[k]!, to) <= 0; k++, removed++) {
        if (compareKeys(ls[k]!, from) < 0) from = ls[k]!;
        if (compareKeys(hs[k]!, to) > 0) to = hs[k]!;
      }
      if (k < ls.length) break;
    }
    this.remove(g, removed);
    this.insert(g, from, to);
  }

  /** How many intervals the chunks before chunk `c` hold. */
  private before(c: number): number {
    let n = 0;
    for (let x = 0; x < c; x++) n += this.los[x]!.length;
    return n;
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

/** The two ways to keep a set, measured against each other on the read path (one will stay). */
export type ReadCountSet = "tree" | "chunked";
/** Which one a transaction uses: `READ_COUNT_SET` (for the measurement), else the chunks. */
const DEFAULT_SET: ReadCountSet = process.env.READ_COUNT_SET === "tree" ? "tree" : "chunked";

export class ReadCount {
  private sets = new Map<IndexId, MergedSet>();
  constructor(private readonly kind: ReadCountSet = DEFAULT_SET) {}
  /** Convex's `num_intervals`. */
  count = 0;

  /** A read the function made: counted by the change of its index's merged set. */
  direct(i: Interval) {
    const [before, after] = this.add(i);
    // Convex's update: the old size taken off (saturating), the new one added.
    if (before !== after || this.count < before) this.count = Math.max(0, this.count - before) + after;
  }

  /** A read the engine took on its own behalf: in the set, not counted. */
  derived(i: Interval) {
    this.add(i);
  }

  /**
   * Reads Convex makes on indexes a function cannot reach (its configuration, its module): counted, never merged
   * with anything.
   */
  constant(n: number) {
    this.count += n;
  }

  /** Fold `i` into its index's set: that set's size before and after. */
  private add(i: Interval): [number, number] {
    let set = this.sets.get(i.index);
    if (!set) {
      set = this.kind === "tree" ? new TreeSet() : new ChunkedSet();
      this.sets.set(i.index, set);
    }
    const before = set.size;
    // An empty interval adds nothing (`Interval::is_empty`).
    if (compareKeys(i.lo, i.hi) < 0) set.add(i.lo, i.hi);
    return [before, set.size];
  }
}
