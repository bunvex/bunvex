// The write log indexed for conflict checks (STUDY-06 D11, DV-61), as Convex indexes its own
// (crates/database/src/write_log.rs `WritesByIndex`, crates/database/src/reads.rs `writes_overlap_by_index`).
//
// Per index id, the writes into that index in commit order: a timestamp column and the write itself. A
// read-set is checked index by index: only the indexes it read are looked at, the writes in the timestamp
// window are found by binary search, and each of their keys is tested against the read intervals of that
// index, sorted and merged, by binary search too. So a validation costs O(Σ over the indexes read of
// (log n + w log i)) for w writes into that index inside the window and i intervals, instead of the scan
// over every log entry × its writes × every interval. Convex's cost is the same.

import type { Conflict, Interval, LogEntry } from "./committer.ts";
import { compareKeys } from "./keyenc.ts";

type Write = LogEntry["writes"][number];

/** The writes into one index, oldest first, from `head` (trimmed by advancing it, compacted now and then). */
type Column = { ts: bigint[]; writes: Write[]; head: number };

/** One index's read intervals, sorted by `lo`, disjoint and non-adjacent (Convex's `IntervalSet`). */
export type IntervalSet = { lo: Uint8Array[]; hi: Uint8Array[] };

/**
 * A read-set grouped per index, each index's intervals normalized for binary search, the indexes in
 * ascending id order (Convex walks its read-set's `BTreeMap` by index). Empty intervals contain nothing
 * and are dropped.
 */
export function intervalSetsByIndex(reads: readonly Interval[]): [number, IntervalSet][] {
  const by = new Map<number, Interval[]>();
  for (const r of reads) {
    if (compareKeys(r.lo, r.hi) >= 0) continue;
    const list = by.get(r.index);
    if (list) list.push(r);
    else by.set(r.index, [r]);
  }
  const out: [number, IntervalSet][] = [];
  for (const [index, list] of by) {
    list.sort((a, b) => compareKeys(a.lo, b.lo));
    const set: IntervalSet = { lo: [list[0].lo], hi: [list[0].hi] };
    for (let i = 1; i < list.length; i++) {
      const last = set.hi.length - 1;
      // Overlapping or adjacent ([a, b) then [b, c)): one interval.
      if (compareKeys(list[i].lo, set.hi[last]) <= 0) {
        if (compareKeys(list[i].hi, set.hi[last]) > 0) set.hi[last] = list[i].hi;
      } else {
        set.lo.push(list[i].lo);
        set.hi.push(list[i].hi);
      }
    }
    out.push([index, set]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Whether `key` is in one of the set's intervals: the only candidate is the last one starting at or before it. */
export function intervalSetContains(set: IntervalSet, key: Uint8Array): boolean {
  let lo = 0;
  let hi = set.lo.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareKeys(set.lo[mid], key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && compareKeys(key, set.hi[lo - 1]) < 0;
}

export class WritesByIndex {
  private columns = new Map<number, Column>();

  /** How many indexes have writes in the log. */
  get indexCount(): number {
    return this.columns.size;
  }

  /** How many writes it holds, over every index (tests check it against the retained log). */
  get writeCount(): number {
    let n = 0;
    for (const c of this.columns.values()) n += c.ts.length - c.head;
    return n;
  }

  /** Add a commit's writes; commits are appended in ts order. */
  append(e: LogEntry) {
    for (const w of e.writes) {
      let c = this.columns.get(w.index);
      if (!c) {
        c = { ts: [], writes: [], head: 0 };
        this.columns.set(w.index, c);
      }
      c.ts.push(e.ts);
      c.writes.push(w);
    }
  }

  /** Remove the OLDEST commit's writes (the log is trimmed oldest first, so they are at each column's head). */
  removeOldest(e: LogEntry) {
    for (const w of e.writes) {
      const c = this.columns.get(w.index);
      if (!c || c.ts[c.head] !== e.ts || c.writes[c.head] !== w)
        throw new Error(`write log index: the write of ${e.ts} on index ${w.index} is not the oldest`);
      c.ts[c.head] = 0n;
      c.writes[c.head] = undefined as unknown as Write; // release it now
      c.head++;
    }
    for (const w of e.writes) {
      const c = this.columns.get(w.index);
      if (!c) continue; // already dropped (several writes into one index)
      if (c.head === c.ts.length) this.columns.delete(w.index);
      else if (c.head > 1024 && c.head * 2 > c.ts.length) {
        // Compact once the dropped prefix is the larger part: amortized O(1) per write.
        c.ts = c.ts.slice(c.head);
        c.writes = c.writes.slice(c.head);
        c.head = 0;
      }
    }
  }

  /**
   * A write with a ts in `(from, to]` whose key is in `reads`, or null. The indexes read are looked at in
   * ascending order, and within the first index that has one, the write named is the oldest, as Convex's
   * `writes_overlap_by_index` names it for published commits; with `lowestKey`, the one with the lowest key
   * (the oldest among equal keys), as Convex's `PendingKeysInIndex::overlaps` names it for pending ones.
   * `sourceOf` gives the write source of the commit at a ts.
   */
  conflict(
    reads: readonly [number, IntervalSet][],
    from: bigint,
    to: bigint,
    sourceOf: (ts: bigint) => string | undefined,
    lowestKey = false,
  ): Conflict | null {
    for (const [index, set] of reads) {
      const c = this.columns.get(index);
      if (!c) continue;
      // The first write with ts > from.
      let lo = c.head;
      let hi = c.ts.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (c.ts[mid] <= from) lo = mid + 1;
        else hi = mid;
      }
      let hit = -1;
      for (let i = lo; i < c.ts.length && c.ts[i] <= to; i++) {
        const w = c.writes[i];
        if (!intervalSetContains(set, w.key)) continue;
        if (!lowestKey) {
          hit = i;
          break;
        }
        if (hit < 0 || compareKeys(w.key, c.writes[hit].key) < 0) hit = i;
      }
      if (hit >= 0) return { writeTs: c.ts[hit], index, id: c.writes[hit].id, source: sourceOf(c.ts[hit]) };
    }
    return null;
  }
}
