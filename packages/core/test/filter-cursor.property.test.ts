// Filters and cursors, by property (TEST-01 §2).
// - A filter's comparisons must agree with index order: `q.lt(field, c)` passes exactly when the field's
//   index key sorts below c's, so a filter and an index range select the same documents (Convex evaluates
//   both through the same value order: crates/common/src/query.rs `Expression::eval`,
//   crates/value/src/sorting.rs). and / or / not follow boolean logic and short-circuit as Convex's do.
// - A cursor decodes to the position it was made from, and only for its own query and instance (Convex
//   property-tests cursor serialization: crates/common/src/query.rs `proptest_cursor_serialization`,
//   convex-backend bea52bde0).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { decodeCursor, encodeCursor } from "../src/cursor.ts";
import { passes, filterBuilder as q } from "../src/filter.ts";
import { compareKeys, encodeKey } from "../src/keyenc.ts";
import type { Doc } from "../src/schema.ts";
import { runs } from "./property-runs.ts";
import { keyPart, value } from "./value-arbitraries.ts";

const doc = (x: unknown): Doc => ({ _id: "x", _creationTime: 0, ...(x === undefined ? {} : { f: x }) });
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("filters agree with index order", () => {
  test("eq / neq / lt / lte / gt / gte against a constant are the index keys' order", () => {
    fc.assert(
      fc.property(keyPart, value, (x, c) => {
        const k = sign(compareKeys(encodeKey([x]), encodeKey([c])));
        const d = doc(x);
        expect(passes(q.eq(q.field("f"), c), d)).toBe(k === 0);
        expect(passes(q.neq(q.field("f"), c), d)).toBe(k !== 0);
        expect(passes(q.lt(q.field("f"), c), d)).toBe(k < 0);
        expect(passes(q.lte(q.field("f"), c), d)).toBe(k <= 0);
        expect(passes(q.gt(q.field("f"), c), d)).toBe(k > 0);
        expect(passes(q.gte(q.field("f"), c), d)).toBe(k >= 0);
      }),
      { numRuns: runs(500) },
    );
  });

  test("and / or / not are boolean logic over the comparisons", () => {
    const leaf = fc.tuple(fc.constantFrom("eq", "lt", "gte") as fc.Arbitrary<"eq" | "lt" | "gte">, value);
    fc.assert(
      fc.property(keyPart, fc.array(leaf, { minLength: 1, maxLength: 4 }), (x, leaves) => {
        const d = doc(x);
        const exprs = leaves.map(([op, c]) => q[op](q.field("f"), c));
        const truth = exprs.map((e) => passes(e, d));
        expect(passes(q.and(...exprs), d)).toBe(truth.every(Boolean));
        expect(passes(q.or(...exprs), d)).toBe(truth.some(Boolean));
        expect(passes(q.not(q.and(...exprs)), d)).toBe(passes(q.or(...exprs.map((e) => q.not(e))), d));
      }),
      { numRuns: runs(300) },
    );
  });

  test("and / or stop at the first deciding operand: a later non-boolean is not evaluated", () => {
    fc.assert(
      fc.property(value, (junk) => {
        const d = doc(1n);
        expect(passes(q.and(false, junk as never), d)).toBe(false);
        expect(passes(q.or(true, junk as never), d)).toBe(true);
      }),
      { numRuns: runs(100) },
    );
  });

  test("int64 arithmetic is exact or refused, never wrapped", () => {
    const i64 = fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n });
    fc.assert(
      fc.property(i64, i64, (a, b) => {
        const exact = a + b;
        const fits = exact >= -(2n ** 63n) && exact <= 2n ** 63n - 1n;
        const run = () => q.add(a, b).evaluate(doc(undefined));
        if (fits) expect(run()).toBe(exact);
        else expect(run).toThrow(/out of range for Int64/);
      }),
      { numRuns: runs(500) },
    );
  });
});

describe("cursors", () => {
  const codec = { key: new Uint8Array(16).fill(7), instanceName: "test-instance" };
  const position = fc.oneof(
    fc.constant("end" as const),
    fc.uint8Array({ maxLength: 64 }).map((after) => ({ after })),
  );
  const fingerprint = fc.uint8Array({ minLength: 32, maxLength: 32 });

  test("decode(encode(position)) is the position, for the same query", () => {
    fc.assert(
      fc.property(position, fingerprint, (pos, fp) => {
        const back = decodeCursor(codec, encodeCursor(codec, pos, fp), fp);
        if (pos === "end") expect(back).toBe("end");
        else expect(back !== "end" && [...back.after]).toEqual([...pos.after]);
      }),
      { numRuns: runs(300) },
    );
  });

  test("a cursor is refused for another query or another instance", () => {
    fc.assert(
      fc.property(position, fingerprint, fingerprint, (pos, fp, other) => {
        fc.pre(Buffer.compare(Buffer.from(fp), Buffer.from(other)) !== 0);
        const c = encodeCursor(codec, pos, fp);
        expect(() => decodeCursor(codec, c, other)).toThrow();
        expect(() => decodeCursor({ ...codec, instanceName: "another" }, c, fp)).toThrow();
      }),
      { numRuns: runs(200) },
    );
  });
});
