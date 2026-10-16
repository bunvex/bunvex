// How many reads a transaction made, toward its read limit (`databaseQueries`, 4 096), as Convex counts them
// (STUDY-161 §16): `TransactionReadSet` (crates/database/src/reads.rs) keeps, per index, the intervals read, merged
// (`IntervalSet::add`: an interval folds into every overlapping or adjacent one; an empty one adds nothing), and its
// `num_intervals` moves only on a read the function made (`record_indexed_directly`), by the change of that index's set
// size; a read the engine takes on its own behalf (`record_indexed_derived`) joins the set without counting.
//
// Only the count: the intervals a transaction records for subscriptions and OCC are `Tx`'s `readList`, unchanged.
import type { Interval } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";
import type { IndexId } from "./persistence/index.ts";

/** One index's merged intervals, sorted by `lo`, disjoint and not adjacent. */
type Merged = { lo: Uint8Array[]; hi: Uint8Array[] };

export class ReadCount {
  private sets = new Map<IndexId, Merged>();
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
      set = { lo: [], hi: [] };
      this.sets.set(i.index, set);
    }
    const before = set.lo.length;
    // An empty interval adds nothing (`Interval::is_empty`).
    if (compareKeys(i.lo, i.hi) >= 0) return [before, before];
    // The first interval that ends at or after `i.lo` (overlapping or adjacent), by binary search on `hi`.
    let a = 0;
    let b = set.hi.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (compareKeys(set.hi[mid]!, i.lo) < 0) a = mid + 1;
      else b = mid;
    }
    // Then every interval that starts at or before `i.hi`.
    let end = a;
    while (end < set.lo.length && compareKeys(set.lo[end]!, i.hi) <= 0) end++;
    let lo = i.lo;
    let hi = i.hi;
    if (end > a) {
      if (compareKeys(set.lo[a]!, lo) < 0) lo = set.lo[a]!;
      if (compareKeys(set.hi[end - 1]!, hi) > 0) hi = set.hi[end - 1]!;
    }
    set.lo.splice(a, end - a, lo);
    set.hi.splice(a, end - a, hi);
    return [before, set.lo.length];
  }
}
