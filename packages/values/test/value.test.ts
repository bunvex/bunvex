import { describe, expect, test } from "bun:test";
import { valuesToKey } from "../src/sorting.ts";
import { compareValues, fromJsonValue, toJsonValue, type Value } from "../src/value.ts";

const bytes = (...b: number[]) => Uint8Array.from(b).buffer;
const cmpBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const sign = (n: number) => Math.sign(n);

describe("Convex value order (crates/value/src/sorting.rs)", () => {
  // Strictly increasing, across and within types.
  const ordered: (Value | undefined)[] = [
    undefined,
    null,
    -(2n ** 63n),
    -(2n ** 31n) - 1n,
    -129n,
    -1n,
    0n,
    1n,
    127n,
    128n,
    2n ** 31n,
    2n ** 63n - 1n,
    Number.NEGATIVE_INFINITY,
    -1e308,
    -1,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    false,
    true,
    "",
    "\0",
    "a",
    "a\0",
    "ab",
    "é",
    bytes(),
    bytes(0),
    bytes(1, 2),
    [],
    [null],
    [1n],
    [1n, 2n],
    ["a"],
    {},
    { "": 1n },
    { a: 1n },
    { a: 1n, b: 1n },
    { a: 2n },
    { b: 0n },
  ];

  test("the fixed vector is strictly increasing by key and by compareValues", () => {
    for (let i = 1; i < ordered.length; i++) {
      const [a, b] = [ordered[i - 1], ordered[i]];
      expect({ i, key: sign(cmpBytes(valuesToKey([a]), valuesToKey([b]))) }).toEqual({ i, key: -1 });
      expect({ i, cmp: sign(compareValues(a, b)) }).toEqual({ i, cmp: -1 });
    }
  });

  test("property: compareValues agrees with the byte order of sort keys, tuples included", () => {
    let seed = 42;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const gen = (depth: number): Value | undefined => {
      switch (rnd(depth > 2 ? 8 : 10)) {
        case 0:
          return rnd(3) ? null : undefined;
        case 1:
          return BigInt(rnd(2) ? rnd(300) - 150 : rnd(2 ** 30) * (rnd(2) ? 1 : -1)) * (rnd(4) ? 1n : 2n ** 32n);
        case 2:
          return [0, -0, 1.5, -2.25, 1e-310, Number.NaN, Number.POSITIVE_INFINITY, -1e300][rnd(8)] * (rnd(2) ? 1 : -1);
        case 3:
          return rnd(2) === 1;
        case 4:
          return ["", "a", "ab", "\0", "a\0b", "b", "zz"][rnd(7)];
        case 5:
          return bytes(...Array.from({ length: rnd(3) }, () => [0, 1, 255][rnd(3)]));
        case 6:
        case 8:
          return Array.from({ length: rnd(3) }, () => gen(depth + 1) ?? null);
        default: {
          const o: Record<string, Value> = {};
          for (let i = 0; i < rnd(3); i++) o[["", "a", "b", "ab"][rnd(4)]] = gen(depth + 1) ?? null;
          return o;
        }
      }
    };
    for (let i = 0; i < 5000; i++) {
      const a = [gen(0), gen(0)];
      const b = rnd(4) ? [gen(0), gen(0)] : [...a];
      const byKey = sign(cmpBytes(valuesToKey(a), valuesToKey(b)));
      const byValue = sign(compareValues(a[0], b[0]) || compareValues(a[1], b[1]));
      if (byKey !== byValue) throw new Error(`mismatch ${Bun.inspect(a)} vs ${Bun.inspect(b)}: ${byKey} vs ${byValue}`);
    }
  });
});

describe("JSON form (toJsonValue / fromJsonValue)", () => {
  test("special values round-trip exactly", () => {
    const v: Value = {
      big: 2n ** 62n,
      neg: -5n,
      nan: Number.NaN,
      inf: Number.NEGATIVE_INFINITY,
      negZero: -0,
      bytes: bytes(0, 1, 255),
      nested: [{ x: [1, "s", null, true] }],
    };
    const json = toJsonValue(v);
    expect(JSON.stringify(json)).toBe(
      '{"big":{"$integer":"AAAAAAAAAEA="},"bytes":{"$bytes":"AAH/"},"inf":{"$float":"AAAAAAAA8P8="},"nan":{"$float":"AAAAAAAA+H8="},"neg":{"$integer":"+/////////8="},"negZero":{"$float":"AAAAAAAAAIA="},"nested":[{"x":[1,"s",null,true]}]}',
    );
    const back = fromJsonValue(JSON.parse(JSON.stringify(json))) as Record<string, Value>;
    expect(back.big).toBe(2n ** 62n);
    expect(Number.isNaN(back.nan)).toBe(true);
    expect(Object.is(back.negZero, -0)).toBe(true);
    expect([...new Uint8Array(back.bytes as ArrayBuffer)]).toEqual([0, 1, 255]);
    expect(Object.keys(back)).toEqual(["big", "bytes", "inf", "nan", "neg", "negZero", "nested"]); // sorted
  });

  test("undefined fields are dropped; undefined elsewhere is refused", () => {
    expect(toJsonValue({ a: 1, b: undefined } as never)).toEqual({ a: 1 });
    expect(() => toJsonValue([1, undefined] as never)).toThrow("undefined is not a valid value");
  });

  test("unsupported types and field names are refused with Convex's messages", () => {
    expect(() => toJsonValue({ d: new Date(0) } as never)).toThrow("is not a supported value type (present at path .d");
    expect(() => toJsonValue(new Map() as never)).toThrow("Map[] is not a supported value type.");
    expect(() => toJsonValue(new Set([1]) as never)).toThrow("Set[1] is not a supported value type.");
    class Point {
      x = 1;
    }
    expect(() => toJsonValue(new Point() as never)).toThrow('Point {"x":1} is not a supported value type.');
    expect(() => toJsonValue({ $x: 1 })).toThrow("Field name $x starts with a '$', which is reserved.");
    expect(() => toJsonValue({ é: 1 })).toThrow("Field names can only contain non-control ASCII characters");
    expect(() => toJsonValue(2n ** 63n)).toThrow("does not fit into a 64-bit signed integer");
  });
});
