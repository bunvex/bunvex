import { describe, expect, test } from "bun:test";
import { compareValues } from "@bunvex/values";
import { compareKeys, encodeKey, type KeyValue, prefixEnd } from "../src/keyenc.ts";

/** The reference order the byte encoding must reproduce: Convex's (STUDY-18). */
const cmpValue = (a: KeyValue, b: KeyValue) => compareValues(a, b);
const sign = (n: number) => Math.sign(n);

describe("keyenc", () => {
  test("byte order equals value order over random mixed-type tuples (property)", () => {
    const pick = [0, -0, 1, -1, 1e-300, -1e-300, 2 ** 53, -(2 ** 53), Number.MAX_VALUE, -Number.MAX_VALUE];
    const rnd = (): KeyValue => {
      const r = Math.random();
      if (r < 0.05) return null;
      if (r < 0.1) return Math.random() < 0.5;
      if (r < 0.55)
        return Math.random() < 0.2 ? pick[Math.floor(Math.random() * pick.length)] : (Math.random() - 0.5) * 1e6;
      let s = "";
      for (let i = 0; i < Math.floor(Math.random() * 6); i++)
        s += String.fromCharCode([0, 1, 97, 98, 0xe9, 0x4e2d][Math.floor(Math.random() * 6)]);
      return s;
    };
    for (let i = 0; i < 20_000; i++) {
      const a = [rnd(), rnd()];
      const b = [rnd(), rnd()];
      const want = sign(cmpValue(a[0], b[0]) || cmpValue(a[1], b[1]));
      expect(sign(compareKeys(encodeKey(a), encodeKey(b)))).toBe(want);
    }
  });

  test("a string sorts before any string it prefixes, NUL included", () => {
    expect(compareKeys(encodeKey(["a"]), encodeKey(["a\u0000"]))).toBeLessThan(0);
    expect(compareKeys(encodeKey(["a\u0000"]), encodeKey(["ab"]))).toBeLessThan(0);
    expect(compareKeys(encodeKey(["t1"]), encodeKey(["t10"]))).toBeLessThan(0);
  });

  test("-0 sorts just below 0 (IEEE-754 total order, as Convex)", () => {
    expect(compareKeys(encodeKey([-0]), encodeKey([0]))).toBeLessThan(0);
    expect(compareKeys(encodeKey([-Number.MIN_VALUE]), encodeKey([-0]))).toBeLessThan(0);
  });

  test("prefixEnd bounds exactly the keys that start with the prefix", () => {
    const p = encodeKey(["t1"]);
    const end = prefixEnd(p);
    expect(compareKeys(encodeKey(["t1", 5]), end)).toBeLessThan(0);
    expect(compareKeys(encodeKey(["t10"]), end)).toBeGreaterThanOrEqual(0);
  });
});
