// The edges of Convex values (value.ts): each limit at its value and one past it, Convex's messages with their
// paths, the JSON forms' refusals, values from another realm, and the error printer's cut. value.test.ts and the
// property tests check the common cases; mutation testing (TEST-01 §7) found these edges untested.
import { describe, expect, test } from "bun:test";
import { runInNewContext, runInThisContext } from "node:vm";
import { commitTsPlaceholder } from "../src/commit-ts.ts";
import {
  compareValues,
  copyValue,
  fromJsonValue,
  isBytes,
  isSimpleObject,
  MAX_VALUE_NESTING,
  measureRawValue,
  opaque,
  rawValueSize,
  stringifyValueForError,
  TOO_NESTED_MESSAGE,
  toJsonValue,
  type Value,
  validateObjectField,
  valueSize,
} from "../src/value.ts";

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};
const nested = (levels: number): Value => (levels === 0 ? 0 : [nested(levels - 1)]);
const nestedObject = (levels: number): Value => (levels === 0 ? 0 : { a: nestedObject(levels - 1) });
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

describe("field names", () => {
  test("1024 characters at most, no leading $, only non-control ASCII", () => {
    validateObjectField("a".repeat(1024));
    expect(err(() => validateObjectField("a".repeat(1025)))).toBe(
      `Field name ${"a".repeat(1025)} exceeds maximum field name length 1024.`,
    );
    expect(err(() => validateObjectField("$a"))).toBe("Field name $a starts with a '$', which is reserved.");
    validateObjectField(" ~"); // 32 and 126: the first and last allowed
    for (const c of ["\x1f", "\x7f", "é"])
      expect(err(() => validateObjectField(`ab${c}`))).toBe(
        `Field name ab${c} has invalid character '${c}': Field names can only contain non-control ASCII characters`,
      );
  });
});

describe("values from another realm (a function's own context)", () => {
  test("its ArrayBuffer is bytes and its plain object is a plain object", () => {
    const bytes = runInNewContext("new ArrayBuffer(2)");
    expect(bytes instanceof ArrayBuffer).toBe(false);
    expect(isBytes(bytes)).toBe(true);
    expect(isBytes(new ArrayBuffer(1))).toBe(true);
    expect(isBytes(new Uint8Array(1))).toBe(false);
    // A tag is not a buffer: Convex's `instanceof ArrayBuffer` misses it, and it is an object (STUDY-18 §9).
    const tagged = runInNewContext('({ [Symbol.toStringTag]: "ArrayBuffer", a: 1 })');
    expect(isBytes(tagged)).toBe(false);
    expect(isBytes({ [Symbol.toStringTag]: "ArrayBuffer" })).toBe(false);
    expect(toJsonValue(tagged)).toEqual({ a: 1 });
    expect(copyValue(tagged)).toEqual({ a: 1 });
    expect(stringifyValueForError(tagged)).toBe('{"a":1}');
    const obj = runInNewContext("({ a: 1 })");
    expect(Object.getPrototypeOf(obj) === Object.prototype).toBe(false);
    expect(isSimpleObject(obj)).toBe(true);
    expect(isSimpleObject(Object.create(null))).toBe(true);
    expect(isSimpleObject(new (class Point {})())).toBe(false);
    expect(isSimpleObject("s")).toBe(false);
  });

  test("its Set or Map prints its entries, as this realm's (Convex's `instanceof Set`, STUDY-18 §9)", () => {
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("no error");
    };
    const cases: [string, string][] = [
      ["new Set()", "Set[]"],
      ["new Set([1])", "Set[1]"],
      ['new Set([1, "two", null, [3], { four: 4n }])', 'Set[1,"two",null,[3],{"four":"4n"}]'],
      ["new Map()", "Map[]"],
      ['new Map([["a", 1]])', 'Map[["a",1]]'],
      ['new Map([["a", 1], [2, [true]], [null, { b: "c" }]])', 'Map[["a",1],[2,[true]],[null,{"b":"c"}]]'],
      // what it holds prints as anything else does: a Set or Map inside it is named, not opened (DV-316)
      ["new Set([new Set([1]), new Map([[1, 2]])])", "Set[Set {…},Map {…}]"],
      ["new (class Tags extends Set {})([1])", "Set[1]"],
      ["new (class Index extends Map {})([[1, 2]])", "Map[[1,2]]"],
    ];
    for (const [source, shown] of cases) {
      const other = runInNewContext(`(${source})`, {});
      const own = runInThisContext(`(${source})`);
      expect(other instanceof Set || other instanceof Map).toBe(false);
      for (const v of [other, own]) {
        expect({ source, m: err(() => toJsonValue(v)) }).toEqual({
          source,
          m: `${shown} is not a supported value type.`,
        });
        expect({ source, m: err(() => copyValue(v)) }).toEqual({
          source,
          m: `${shown} is not a supported value type.`,
        });
      }
    }
    const inObject = runInNewContext('({ x: 1, m: new Map([["k", 1]]) })');
    expect(err(() => toJsonValue({ v: inObject }))).toBe(
      'Map[["k",1]] is not a supported value type (present at path .v.m in original object {"v":{"x":1,"m":Map {…}}}).',
    );
    const inArray = runInNewContext('[0, [new Set(["s"])]]');
    expect(err(() => copyValue(inArray))).toBe(
      'Set["s"] is not a supported value type (present at path [1][0] in original object [0,[Set {…}]]).',
    );
  });

  test("only a real Set or Map is one: a class named Set, a forged tag or a bare prototype is not", () => {
    const err = (v: unknown) => {
      try {
        toJsonValue(v as Value);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("no error");
    };
    // Convex: none is `instanceof Set` but the last, whose spread throws; each is an object it prints by class name.
    expect(err(runInNewContext("new (class Set { x = 1 })()"))).toBe("Set {…} is not a supported value type.");
    expect(err(runInThisContext("new (class Map {})()"))).toBe("Map {…} is not a supported value type.");
    expect(err(runInNewContext('({ [Symbol.toStringTag]: "Set", __proto__: { constructor: { name: "Set" } } })'))).toBe(
      "Set {…} is not a supported value type.",
    );
    expect(err(Object.create(Set.prototype))).toBe("Set {…} is not a supported value type.");
  });

  test("an object whose prototype cannot be read prints as {…}", () => {
    const p = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("no");
        },
      },
    );
    expect(opaque(p)).toBe("{…}");
    expect(opaque(new (class Point {})())).toBe("Point {…}");
  });
});

describe("toJsonValue: Convex's messages, with the path", () => {
  test("undefined, at the root and inside", () => {
    expect(err(() => toJsonValue(undefined as never))).toBe("undefined is not a valid value.");
    expect(err(() => toJsonValue([undefined] as never))).toBe(
      'undefined is not a valid value (present at path [0] in original object ["undefined"]).',
    );
  });

  test("a Map prints its entries; a commit-ts placeholder is its wire token", () => {
    expect(err(() => toJsonValue(new Map([["a", 1]]) as never))).toBe('Map[["a",1]] is not a supported value type.');
    expect(toJsonValue(commitTsPlaceholder as never)).toEqual({ $commitTs: null });
  });

  test("an int64 at each end fits; one past either does not", () => {
    const min = -(2n ** 63n);
    const max = 2n ** 63n - 1n;
    expect(fromJsonValue(toJsonValue(min))).toBe(min);
    expect(fromJsonValue(toJsonValue(max))).toBe(max);
    expect(err(() => toJsonValue(min - 1n))).toBe(`BigInt ${min - 1n} does not fit into a 64-bit signed integer.`);
    expect(err(() => toJsonValue(max + 1n))).toBe(`BigInt ${max + 1n} does not fit into a 64-bit signed integer.`);
  });
});

describe("fromJsonValue: the JSON forms' refusals", () => {
  test("a $-key that is not exactly a special form is a field, refused for its $", () => {
    const reserved = (k: string) => `Field name ${k} starts with a '$', which is reserved.`;
    expect(err(() => fromJsonValue({ $integer: 5 } as never))).toBe(reserved("$integer"));
    expect(err(() => fromJsonValue({ $float: 5 } as never))).toBe(reserved("$float"));
    expect(err(() => fromJsonValue({ $bytes: 5 } as never))).toBe(reserved("$bytes"));
    expect(err(() => fromJsonValue({ $integer: b64([0, 0, 0, 0, 0, 0, 0, 0]), x: 1 }))).toBe(reserved("$integer"));
    expect(err(() => fromJsonValue({ "a\x01": 1 }))).toContain("has invalid character");
  });

  test("an $integer or $float of other than 8 bytes, and a $float that is a plain number", () => {
    expect(err(() => fromJsonValue({ $integer: b64([1, 2, 3, 4]) }))).toBe("Received 4 bytes, expected 8 for $integer");
    expect(err(() => fromJsonValue({ $float: b64([1, 2, 3, 4]) }))).toBe("Received 4 bytes, expected 8 for $float");
    const onePointFive = b64([...new Uint8Array(new Float64Array([1.5]).buffer)]);
    expect(err(() => fromJsonValue({ $float: onePointFive }))).toBe("Float 1.5 should be encoded as a number");
    expect(Number.isNaN(fromJsonValue(toJsonValue(Number.NaN)))).toBe(true);
    expect(new Uint8Array(fromJsonValue({ $bytes: b64([1, 2, 3]) }) as ArrayBuffer)).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
  });

  test("nesting: 64 levels of arrays or objects, not 65", () => {
    for (const make of [nested, nestedObject]) {
      fromJsonValue(toJsonValue(make(MAX_VALUE_NESTING)));
      expect(err(() => fromJsonValue(toJsonValue(make(MAX_VALUE_NESTING + 1))))).toBe(TOO_NESTED_MESSAGE);
    }
  });
});

describe("compareValues", () => {
  test("arrays compare item by item, not as objects keyed by index text", () => {
    // As objects, key "10" would come before "2".
    const a = Array.from({ length: 11 }, (_, i) => (i === 10 ? 1 : 0));
    const b = Array.from({ length: 11 }, (_, i) => (i === 2 ? 1 : 0));
    expect(compareValues(a, b)).toBeLessThan(0);
    expect(compareValues(b, a)).toBeGreaterThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
});

describe("copyValue: a validated deep copy", () => {
  test("arrays of 8192 items at most, objects of 1024 fields at most", () => {
    expect((copyValue(new Array(8192).fill(0)) as Value[]).length).toBe(8192);
    expect(err(() => copyValue(new Array(8193).fill(0)))).toBe("Array length is too long (8193 > maximum length 8192)");
    const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i]));
    expect(Object.keys(copyValue(fields(1024)) as object).length).toBe(1024);
    expect(err(() => copyValue(fields(1025)))).toBe("Object has too many fields (1025 > maximum number 1024)");
    // Undefined fields do not count, and are dropped.
    expect(copyValue({ ...fields(1024), u: undefined } as never)).toEqual(fields(1024));
  });

  test("nesting past the maximum, arrays or objects, the default or a given one", () => {
    for (const make of [nested, nestedObject]) {
      copyValue(make(MAX_VALUE_NESTING));
      expect(err(() => copyValue(make(MAX_VALUE_NESTING + 1)))).toBe(TOO_NESTED_MESSAGE);
      copyValue(make(2), 2);
      expect(err(() => copyValue(make(3), 2))).toBe(TOO_NESTED_MESSAGE);
    }
  });

  test("fields sorted and checked; what is not a value refused with its path", () => {
    expect(Object.keys(copyValue({ b: 1, a: 2 }) as object)).toEqual(["a", "b"]);
    expect(err(() => copyValue({ $x: 1 }))).toBe("Field name $x starts with a '$', which is reserved.");
    expect(err(() => copyValue({ a: [undefined] } as never))).toBe(
      'undefined is not a valid value (present at path .a[0] in original object {"a":["undefined"]}).',
    );
    expect(err(() => copyValue([undefined] as never))).toBe(
      'undefined is not a valid value (present at path [0] in original object ["undefined"]).',
    );
    expect(err(() => copyValue(new Map() as never))).toBe("Map[] is not a supported value type.");
    const bytes = new ArrayBuffer(2);
    const copied = copyValue(bytes) as ArrayBuffer;
    expect(copied).not.toBe(bytes);
    expect(copied.byteLength).toBe(2);
  });
});

describe("sizes and the first oversized container", () => {
  test("measureRawValue reports the first array or object over its limit, innermost first", () => {
    expect(measureRawValue(new Array(8192).fill(0)).tooBig).toBeUndefined();
    expect(measureRawValue(new Array(8193).fill(0))).toEqual({
      size: 2 + 8193 * 9,
      nesting: 1,
      tooBig: "Array length is too long (8193 > maximum length 8192)",
    });
    const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, true]));
    expect(measureRawValue(fields(1024)).tooBig).toBeUndefined();
    expect(measureRawValue(fields(1025)).tooBig).toBe("Object has too many fields (1025 > maximum number 1024)");
    // An oversized object inside an oversized array: the object is met first.
    const both = [fields(1025), ...new Array(8192).fill(0)];
    expect(measureRawValue(both).tooBig).toBe("Object has too many fields (1025 > maximum number 1024)");
    expect(measureRawValue({ a: 1 })).toEqual({ size: 2 + 2 + 9, nesting: 1 });
    expect("tooBig" in measureRawValue({ a: 1 })).toBe(false);
    // Two oversized objects, one inside the other: the inner one is reported.
    const inner = Object.fromEntries(Array.from({ length: 1026 }, (_, i) => [`g${i}`, true]));
    expect(measureRawValue({ ...fields(1024), inner }).tooBig).toBe(
      "Object has too many fields (1026 > maximum number 1024)",
    );
  });

  test("what is not a value: counted (2) when raw, refused when strict", () => {
    const f = () => 1;
    expect(rawValueSize(f as never)).toBe(2);
    expect(measureRawValue({ f } as never).size).toBe(2 + 2 + 2);
    expect(err(() => valueSize(f as never))).toBe("Unsupported value type: function");
    expect(err(() => valueSize(new (class Point {})() as never))).toBe("Unsupported value type: object");
  });
});

describe("stringifyValueForError's cut at 16384 characters", () => {
  test("a text of exactly the limit is whole; one past is cut, with [...truncated] at the end", () => {
    expect(stringifyValueForError("x".repeat(16382))).toBe(`"${"x".repeat(16382)}"`); // 16384 with quotes
    const cut = stringifyValueForError("x".repeat(16383));
    expect(cut.length).toBe(16384);
    expect(cut.endsWith("x[...truncated]")).toBe(true);
  });

  test("reaching the limit mid-value is not the end: the rest makes it longer, so it is cut", () => {
    // "[" + the 16383-character quoted string = 16384 exactly, then ",\"b\"]" follows.
    const s = stringifyValueForError(["x".repeat(16381), "b"]);
    expect(s.length).toBe(16384);
    expect(s.endsWith("[...truncated]")).toBe(true);
  });

  test("the cut never splits a surrogate pair, and only a pair moves it", () => {
    // The text is `"` + the string; the cut keeps 16370 characters, so index 16369 is the last kept.
    const astral = stringifyValueForError(`${"a".repeat(16368)}😀${"a".repeat(100)}`);
    expect(astral).toBe(`"${"a".repeat(16368)}[...truncated]`);
    const bmp = stringifyValueForError(`${"a".repeat(16368)}￿${"a".repeat(100)}`);
    expect(bmp).toBe(`"${"a".repeat(16368)}￿[...truncated]`);
  });
});
