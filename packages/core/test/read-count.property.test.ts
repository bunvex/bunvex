// `ReadCount`'s two sets (a B-tree, sorted chunks) count exactly as the plain sorted array it replaced, Convex's
// `IntervalSet::add` and `num_intervals` (STUDY-161 §16): every random sequence of reads, direct and derived, over a few
// indexes, gives the same count after each read.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { compareKeys } from "../src/keyenc.ts";
import { ReadCount } from "../src/read-count.ts";

/** The reference: one sorted array per index, scanned linearly, as first built. */
class Reference {
  private sets = new Map<string, { lo: Uint8Array[]; hi: Uint8Array[] }>();
  count = 0;
  private add(index: string, lo: Uint8Array, hi: Uint8Array): [number, number] {
    let set = this.sets.get(index);
    if (!set) {
      set = { lo: [], hi: [] };
      this.sets.set(index, set);
    }
    const before = set.lo.length;
    if (compareKeys(lo, hi) >= 0) return [before, before];
    let a = 0;
    while (a < set.hi.length && compareKeys(set.hi[a]!, lo) < 0) a++;
    let end = a;
    while (end < set.lo.length && compareKeys(set.lo[end]!, hi) <= 0) end++;
    let l = lo;
    let h = hi;
    if (end > a) {
      if (compareKeys(set.lo[a]!, l) < 0) l = set.lo[a]!;
      if (compareKeys(set.hi[end - 1]!, h) > 0) h = set.hi[end - 1]!;
    }
    set.lo.splice(a, end - a, l);
    set.hi.splice(a, end - a, h);
    return [before, set.lo.length];
  }
  direct(index: string, lo: Uint8Array, hi: Uint8Array) {
    const [b, a] = this.add(index, lo, hi);
    this.count = Math.max(0, this.count - b) + a;
  }
  derived(index: string, lo: Uint8Array, hi: Uint8Array) {
    this.add(index, lo, hi);
  }
}

// Short keys from a small alphabet, so intervals overlap, touch and repeat often. A point is a document by id as `Tx`
// records it: a key with no zero byte but its last, and just past it.
const key = fc.uint8Array({ minLength: 1, maxLength: 3, max: 4, size: "max" });
const pointKey = fc
  .uint8Array({ minLength: 1, maxLength: 2, min: 1, max: 3, size: "max" })
  .map((b) => Uint8Array.of(...b, 0));
const op = fc.oneof(
  fc.record({
    derived: fc.boolean(),
    index: fc.constantFrom("a", "b", "c"),
    lo: key,
    hi: key,
    point: fc.constant(false),
  }),
  fc
    .record({ derived: fc.boolean(), index: fc.constantFrom("a", "b", "c"), point: fc.constant(true), lo: pointKey })
    .map((o) => ({ ...o, hi: Uint8Array.of(...o.lo.slice(0, -1), 1) })),
);
type Op = { derived: boolean; index: string; lo: Uint8Array; hi: Uint8Array; point: boolean };

/** Play `ops` on the reference and on `ReadCount`, the counts compared after each. */
function play(ops: Op[]) {
  const ref = new Reference();
  const got = new ReadCount();
  for (const o of ops) {
    const i = { index: o.index as never, lo: o.lo, hi: o.hi };
    if (o.derived) {
      ref.derived(o.index, o.lo, o.hi);
      got.derived(i, o.point);
    } else {
      ref.direct(o.index, o.lo, o.hi);
      got.direct(i, o.point);
    }
    expect(got.count).toBe(ref.count);
  }
}

test("ReadCount counts as the reference, read after read (points, ranges, direct and derived)", () => {
  fc.assert(
    fc.property(fc.array(op, { minLength: 20, maxLength: 400, size: "max" }), (ops) => play(ops as Op[])),
    { numRuns: 400 },
  );
});

const pt = (n: number, derived = false): Op => ({
  derived,
  index: "a",
  lo: Uint8Array.of(2, n, 0),
  hi: Uint8Array.of(2, n, 1),
  point: true,
});
const range = (lo: number[], hi: number[], derived = false): Op => ({
  derived,
  index: "a",
  lo: Uint8Array.of(...lo),
  hi: Uint8Array.of(...hi),
  point: false,
});

test("each shortcut, on its own", () => {
  // points (some twice, some derived), then a range covering some of them, then a range touching one
  play([pt(5), pt(9), pt(5), pt(7, true), pt(9), range([2, 6], [2, 9]), range([2, 9, 1], [3])]);
  // a range, then points inside it, around it and touching it
  play([range([2, 4], [2, 8]), pt(5), pt(4), pt(9), pt(3), range([2, 3, 1], [2, 4])]);
  // the last interval: read inside it, extended short of the next, extended onto the next, then a stale one merged away
  play([
    range([1], [2]),
    range([5], [6]),
    range([1, 1], [1, 5]),
    range([1, 2], [3]),
    range([2, 9], [5]),
    range([1], [1, 1]),
    range([0], [7]),
    range([6], [6, 5]),
  ]);
  // thousands of points in a scrambled order, then ranges bridging many of them (across chunks)
  const many: Op[] = [];
  for (let i = 0; i < 3000; i++) {
    const n = (i * 7919) % 6000;
    many.push({
      derived: false,
      index: "a",
      lo: Uint8Array.of(9, 1 + (n >> 8), 1 + ((n & 255) % 255), 0),
      hi: Uint8Array.of(9, 1 + (n >> 8), 1 + ((n & 255) % 255), 1),
      point: true,
    });
  }
  many.push(range([9, 2], [9, 5]), range([9, 9, 9], [9, 9, 10]), range([9, 1], [9, 30]), range([9], [10]));
  play(many);
});
