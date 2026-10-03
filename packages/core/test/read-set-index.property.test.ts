// The read-set index against a model (TEST-01 §2), as Convex property-tests its interval map against a
// simple one (crates/interval_map/src/tests.rs: random insert / remove / query actions, convex-backend
// bea52bde0). Random sequences of set (replace an owner's read-set), delete and match, over index keys built
// from real values — exact points, prefix ranges (`eq` on a leading field) and arbitrary ranges — must find
// exactly the owners whose intervals contain a written key: never miss a subscription a write touched
// (a stale query), never report one it did not touch.
import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Interval } from "../src/committer.ts";
import { compareKeys, encodeKey, prefixEnd } from "../src/keyenc.ts";
import { ReadSetIndex } from "../src/read-set-index.ts";
import { runs } from "./property-runs.ts";
import { keyPart } from "./value-arbitraries.ts";

const indexId = fc.integer({ min: 0, max: 2 });
const point = fc.tuple(indexId, fc.array(keyPart, { minLength: 1, maxLength: 2 })).map(([index, t]) => ({
  index,
  key: encodeKey(t),
}));
const interval: fc.Arbitrary<Interval> = fc.oneof(
  // a point read
  point.map(({ index, key }) => ({ index, lo: key, hi: Uint8Array.from([...key, 0]) })),
  // an eq-prefix read: every key starting with the first component
  fc.tuple(indexId, keyPart).map(([index, x]) => {
    const p = encodeKey([x]);
    return { index, lo: p, hi: prefixEnd(p) };
  }),
  // a range between two keys (possibly empty)
  fc.tuple(point, point).map(([a, b]) => ({ index: a.index, lo: a.key, hi: b.key })),
);

type Action =
  | { kind: "set"; owner: number; reads: Interval[] }
  | { kind: "delete"; owner: number }
  | { kind: "match"; writes: { index: number; key: Uint8Array }[]; useBounds: boolean };
const owner = fc.integer({ min: 0, max: 7 });
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), owner, reads: fc.array(interval, { maxLength: 4 }) }),
  fc.record({ kind: fc.constant("delete" as const), owner }),
  fc.record({
    kind: fc.constant("match" as const),
    writes: fc.array(point, { minLength: 1, maxLength: 3 }),
    useBounds: fc.boolean(),
  }),
);

const contains = (i: Interval, w: { index: number; key: Uint8Array }) =>
  i.index === w.index && compareKeys(i.lo, w.key) <= 0 && compareKeys(w.key, i.hi) < 0;

test("set / delete / match agree with a plain list of read-sets", () => {
  fc.assert(
    fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
      const index = new ReadSetIndex<number>();
      const model = new Map<number, Interval[]>();
      for (const a of actions) {
        if (a.kind === "set") {
          index.set(a.owner, a.reads);
          model.set(a.owner, a.reads);
        } else if (a.kind === "delete") {
          expect(index.delete(a.owner)).toBe(model.delete(a.owner));
        } else {
          // writes exactly on registered bounds are where off-by-one errors live
          const bounds = [...model.values()].flat();
          const writes =
            a.useBounds && bounds.length
              ? a.writes.map((w, i) => ({
                  index: bounds[i % bounds.length]!.index,
                  key: i % 2 ? bounds[i % bounds.length]!.hi : bounds[i % bounds.length]!.lo,
                }))
              : a.writes;
          const want = [...model]
            .filter(([, rs]) => rs.some((r) => writes.some((w) => contains(r, w))))
            .map(([o]) => o);
          const got = [...index.matching(writes.map((w) => ({ ...w })))];
          expect(got.sort((x, y) => x - y)).toEqual(want.sort((x, y) => x - y));
        }
        expect(index.size).toBe(model.size);
      }
    }),
    { numRuns: runs(300) },
  );
});
