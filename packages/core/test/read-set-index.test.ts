import { describe, expect, test } from "bun:test";
import { type Interval, overlaps } from "../src/committer.ts";
import { prefixEnd } from "../src/keyenc.ts";
import { ReadSetIndex } from "../src/read-set-index.ts";

/** A small deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

const OPEN_END = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

describe("ReadSetIndex (STUDY-08 D9)", () => {
  // Keys from a tiny alphabet, so intervals collide, nest, share bounds and differ only by length.
  const makeKey = (r: () => number) =>
    Uint8Array.from({ length: Math.floor(r() * 4) }, () => [0, 1, 2, 0x7f, 0xff][Math.floor(r() * 5)]);

  const makeInterval = (r: () => number, n: number): Interval => {
    const index = `i${n}`;
    const a = makeKey(r);
    switch (Math.floor(r() * 6)) {
      case 0: // empty: lo == hi
        return { index, lo: a, hi: a };
      case 1: // open-ended
        return { index, lo: a, hi: OPEN_END };
      case 2: // a prefix
        return { index, lo: a, hi: prefixEnd(a) };
      case 3: // one key
        return { index, lo: a, hi: Uint8Array.from([...a, 0]) };
      default: {
        // arbitrary, possibly inverted (empty)
        return { index, lo: a, hi: makeKey(r) };
      }
    }
  };

  /** Today's linear scan: the reference the index must agree with. */
  const linear = (owners: Map<number, Interval[]>, writes: { index: string; key: Uint8Array; id: null }[]) =>
    [...owners].filter(([, reads]) => overlaps(writes, reads)).map(([o]) => o);

  for (const seed of [1, 2, 3, 42, 1234, 99999]) {
    test(`matches exactly what the linear scan matches (seed ${seed})`, () => {
      const r = rng(seed);
      const index = new ReadSetIndex<number>();
      const owners = new Map<number, Interval[]>();
      const bounds: Uint8Array[] = [];
      for (let step = 0; step < 3000; step++) {
        const op = r();
        const owner = Math.floor(r() * 200);
        if (op < 0.45) {
          const reads = Array.from({ length: Math.floor(r() * 6) }, () => makeInterval(r, Math.floor(r() * 3)));
          for (const i of reads) bounds.push(i.lo, i.hi);
          index.set(owner, reads);
          owners.set(owner, reads);
        } else if (op < 0.6) {
          expect(index.delete(owner)).toBe(owners.delete(owner));
        } else {
          // Writes on random keys and on the exact bounds of registered intervals.
          const writes = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
            index: `i${Math.floor(r() * 3)}`,
            key: r() < 0.5 && bounds.length ? bounds[Math.floor(r() * bounds.length)] : makeKey(r),
            id: null,
          }));
          const got = [...index.matching(writes)].sort((a, b) => a - b);
          expect(got).toEqual(linear(owners, writes).sort((a, b) => a - b));
        }
        expect(index.size).toBe(owners.size);
      }
    });
  }

  test("a key at an interval's lo is inside, a key at its hi is not", () => {
    const index = new ReadSetIndex<string>();
    index.set("a", [{ index: "i1", lo: Uint8Array.from([5]), hi: Uint8Array.from([9]) }]);
    const at = (k: number[], i = 1) => [...index.matching([{ index: `i${i}`, key: Uint8Array.from(k) }])];
    expect(at([5])).toEqual(["a"]);
    expect(at([8, 0xff])).toEqual(["a"]);
    expect(at([9])).toEqual([]);
    expect(at([4, 0xff])).toEqual([]);
    expect(at([5], 2)).toEqual([]); // another index
  });

  test("an owner is reported once however many of its intervals and writes match", () => {
    const index = new ReadSetIndex<string>();
    const all = { index: "i0", lo: new Uint8Array(0), hi: OPEN_END };
    index.set("a", [all, all, { index: "i0", lo: Uint8Array.from([1]), hi: Uint8Array.from([2]) }]);
    const w = { index: "i0", key: Uint8Array.from([1]) };
    expect([
      ...index.matchingEntries([
        {
          ts: 1n,
          writes: [
            { ...w, id: null },
            { ...w, id: null },
          ],
        },
      ]),
    ]).toEqual(["a"]);
  });

  test("many overlapping intervals: every one containing the key, and only those", () => {
    const index = new ReadSetIndex<number>();
    // Owner i reads [i, 1000 - i): nested intervals around 500.
    for (let i = 0; i < 500; i++)
      index.set(i, [
        {
          index: "i0",
          lo: Uint8Array.from([i >> 8, i & 0xff]),
          hi: Uint8Array.from([(1000 - i) >> 8, (1000 - i) & 0xff]),
        },
      ]);
    const at = (k: number) => [...index.matching([{ index: "i0", key: Uint8Array.from([k >> 8, k & 0xff]) }])].length;
    expect(at(500)).toBe(500);
    expect(at(100)).toBe(101); // owners 0..100
    expect(at(900)).toBe(100); // owners 0..99
    expect(at(1000)).toBe(0);
  });

  test("set replaces and delete removes every interval: nothing is left behind", () => {
    const index = new ReadSetIndex<number>();
    for (let round = 0; round < 3; round++)
      for (let o = 0; o < 300; o++)
        index.set(
          o,
          Array.from({ length: 1 + (o % 4) }, () => ({
            index: `i${o % 5}`,
            lo: Uint8Array.from([o % 7]),
            hi: OPEN_END,
          })),
        );
    expect(index.size).toBe(300);
    let expected = 0;
    for (let o = 0; o < 300; o++) expected += 1 + (o % 4);
    expect(index.intervalCount).toBe(expected);
    for (let o = 0; o < 300; o++) expect(index.delete(o)).toBe(true);
    expect(index.delete(0)).toBe(false);
    expect([index.size, index.intervalCount, index.indexCount]).toEqual([0, 0, 0]);
  });
});
