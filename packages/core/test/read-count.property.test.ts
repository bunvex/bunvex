// The read count (STUDY-161 §16): `ReadCount` (sorted chunks) and the two-mode `ReadCounter` (a bound and a log, the
// exact count replayed when asked) against the plain sorted array, Convex's `IntervalSet::add` and `num_intervals`, read
// after read: the bound never below the exact count, the exact count the reference's from whatever read it is first
// asked at, and a limit's answer the reference's, with limits low enough that the bound crosses them often.
import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Interval } from "../src/committer.ts";
import { compareKeys } from "../src/keyenc.ts";
import { ReadCount, ReadCounter } from "../src/read-count.ts";

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
const op = fc.oneof(
  fc.record({
    kind: fc.constantFrom("direct", "derived", "scan"),
    index: fc.constantFrom("a", "b", "c"),
    lo: key,
    hi: key,
  }),
  fc.record({ kind: fc.constant("constant"), n: fc.integer({ min: 1, max: 3 }) }),
);
type Op =
  | { kind: "direct" | "derived" | "scan"; index: string; lo: Uint8Array; hi: Uint8Array }
  | { kind: "constant"; n: number };

const interval = (o: { index: string; lo: Uint8Array; hi: Uint8Array }): Interval => ({
  index: o.index as never,
  lo: o.lo,
  hi: o.hi,
});

/** Play `ops` on the reference and on `count`, with what to check after each read. */
function play(ops: Op[], check: (ref: Reference, step: number) => void, apply: (o: Op) => void) {
  const ref = new Reference();
  ops.forEach((o, step) => {
    if (o.kind === "constant") ref.count += o.n;
    else if (o.kind === "derived") ref.derived(o.index, o.lo, o.hi);
    else ref.direct(o.index, o.lo, o.hi);
    apply(o);
    check(ref, step);
  });
}

const applyTo = (c: ReadCount | ReadCounter) => (o: Op) => {
  if (o.kind === "constant") c.constant(o.n);
  else if (o.kind === "derived") c.derived(interval(o));
  else if (o.kind === "scan" && c instanceof ReadCounter) c.scan(() => interval(o));
  else c.direct(interval(o));
};

const ops = fc.array(op, { minLength: 20, maxLength: 400, size: "max" }) as fc.Arbitrary<Op[]>;

test("ReadCount counts as the reference, read after read", () => {
  fc.assert(
    fc.property(ops, (list) => {
      const c = new ReadCount();
      play(list, (ref) => expect(c.count).toBe(ref.count), applyTo(c));
    }),
    { numRuns: 300 },
  );
});

test("ReadCounter: the bound is never below the exact count; the exact count, from any first ask on, is the reference's", () => {
  fc.assert(
    fc.property(ops, fc.nat(400), (list, at) => {
      const c = new ReadCounter();
      play(
        list,
        (ref, step) => {
          if (!c.isExact) expect(c.bound).toBeGreaterThanOrEqual(ref.count);
          if (step >= at) expect(c.count()).toBe(ref.count);
        },
        applyTo(c),
      );
    }),
    { numRuns: 300 },
  );
});

test("ReadCounter: a limit's answer (and the warning's number) is the reference's, the bound crossing low limits often", () => {
  fc.assert(
    fc.property(ops, fc.integer({ min: 0, max: 12 }), (list, limit) => {
      const c = new ReadCounter();
      play(
        list,
        (ref) => {
          expect(c.over(limit)).toBe(ref.count > limit);
        },
        applyTo(c),
      );
      // a warning past `limit` gets the exact number; under it, any number not past it (on a counter of its own:
      // the limit's question above makes the count exact)
      const w = new ReadCounter();
      play(
        list,
        (ref) => {
          const n = w.upTo(limit);
          if (ref.count > limit) expect(n).toBe(ref.count);
          else expect(n).toBeLessThanOrEqual(limit);
        },
        applyTo(w),
      );
    }),
    { numRuns: 300 },
  );
});

test("a scan's first read is taken as it is when the exact count is first asked", () => {
  const c = new ReadCounter();
  let hi = Uint8Array.of(2);
  c.direct({ index: "a" as never, lo: Uint8Array.of(5), hi: Uint8Array.of(6) });
  c.scan(() => ({ index: "a" as never, lo: Uint8Array.of(1), hi }));
  hi = Uint8Array.of(5); // known only later: it touches [5, 6)
  expect(c.count()).toBe(1);
});
