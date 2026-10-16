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

// Short keys from a small alphabet, so intervals overlap, touch and repeat often.
const key = fc.uint8Array({ minLength: 1, maxLength: 3, max: 4, size: "max" });
const op = fc.record({
  derived: fc.boolean(),
  index: fc.constantFrom("a", "b", "c"),
  lo: key,
  hi: key,
});

for (const kind of ["tree", "chunked"] as const)
  test(`the ${kind} set counts as the reference, read after read`, () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 20, maxLength: 400, size: "max" }), (ops) => {
        const ref = new Reference();
        const got = new ReadCount(kind);
        for (const o of ops) {
          const i = { index: o.index as never, lo: o.lo, hi: o.hi };
          if (o.derived) {
            ref.derived(o.index, o.lo, o.hi);
            got.derived(i);
          } else {
            ref.direct(o.index, o.lo, o.hi);
            got.direct(i);
          }
          expect(got.count).toBe(ref.count);
        }
      }),
      { numRuns: 300 },
    );
  });

test("the chunked set across many chunks (thousands of points, then ranges bridging chunks)", () => {
  const ref = new Reference();
  const got = new ReadCount("chunked");
  const tree = new ReadCount("tree");
  const k = (n: number) => Uint8Array.of(n >> 8, n & 255);
  // points in a scrambled order (ids are random), then wide ranges
  for (let i = 0; i < 3000; i++) {
    const n = (i * 7919) % 6000;
    for (const c of [ref, got, tree] as const)
      c instanceof Reference
        ? c.direct("a", k(n), Uint8Array.of(...k(n), 0))
        : c.direct({ index: "a" as never, lo: k(n), hi: Uint8Array.of(...k(n), 0) });
  }
  for (const [lo, hi] of [
    [100, 900],
    [2000, 2001],
    [5990, 6100],
    [0, 3000],
  ]) {
    ref.direct("a", k(lo), k(hi));
    got.direct({ index: "a" as never, lo: k(lo), hi: k(hi) });
    tree.direct({ index: "a" as never, lo: k(lo), hi: k(hi) });
    expect([got.count, tree.count]).toEqual([ref.count, ref.count]);
  }
});
