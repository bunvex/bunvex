// Read intervals back for people (STUDY-131 AD-25): every bound a read set holds — the whole index, an `eq`
// prefix (`afterValues`), an exclusive or inclusive range end, a scan cut after a document (`prefixEnd`) —
// reads back as the values it was made from.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { afterValues, boundText, describeBound, encodeKey, keyValueText, prefixEnd } from "../src/keyenc.ts";

test("the whole index: -∞ to +∞", () => {
  expect(describeBound(new Uint8Array(0), true)).toEqual({ kind: "min" });
  expect(describeBound(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), false)).toEqual({ kind: "max" });
  expect(boundText({ kind: "min" })).toBe("-∞");
  expect(boundText({ kind: "max" })).toBe("+∞");
});

test("an eq prefix: from its values to just past every key starting with them", () => {
  const k = encodeKey(["ana"]);
  expect(describeBound(k, true)).toEqual({ kind: "key", values: ["ana"], after: false });
  const hi = describeBound(afterValues(k), false);
  expect(hi).toEqual({ kind: "key", values: ["ana"], after: true });
  expect(boundText(hi)).toBe('["ana", …]');
});

test("a scan cut after a document: prefixEnd of its key", () => {
  const k = encodeKey(["ana", 5n, "kd7abc"]);
  expect(describeBound(prefixEnd(k), false)).toEqual({ kind: "key", values: ["ana", 5n, "kd7abc"], after: true });
});

test("property: afterValues and prefixEnd of any key read back to its values", () => {
  const part = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
    fc.double({ noNaN: true }),
    fc.boolean(),
    fc.string(),
  );
  fc.assert(
    fc.property(fc.array(part, { minLength: 1, maxLength: 3 }), (vals) => {
      const k = encodeKey(vals);
      const exact = describeBound(k, true);
      expect(exact.kind === "key" && encodeKey(exact.values)).toEqual(k);
      const after = describeBound(afterValues(k), false);
      expect(after.kind === "key" && after.after && encodeKey(after.values)).toEqual(k);
      const end = describeBound(prefixEnd(k), false);
      // prefixEnd may drop trailing 0xFF bytes: then the bound is the next whole key (-1n's end is 0n), or
      // bytes shown raw; either way never below the values
      expect(end.kind === "key" || end.kind === "raw").toBe(true);
      if (end.kind === "key" && end.after) expect(encodeKey(end.values)).toEqual(k);
    }),
    { numRuns: 500 },
  );
});

test("values as text", () => {
  expect(
    [undefined, null, 5n, -0, 1.5, "a", true, [1n, "x"], { a: null }].map((v) => keyValueText(v as never)),
  ).toEqual(["undefined", "null", "5n", "-0", "1.5", '"a"', "true", '[1n, "x"]', '{"a": null}']);
  expect(boundText({ kind: "raw", hex: "ff" })).toBe("0xff");
});
