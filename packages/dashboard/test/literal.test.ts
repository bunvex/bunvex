import { describe, expect, test } from "bun:test";
import { formatLiteral, type Literal, parseLiteral, UNSET } from "../src/database/literal.ts";
import { encodeInt64 } from "../src/filters.ts";

const ok = (text: string) => {
  const r = parseLiteral(text);
  if (!r.ok) throw new Error(`${text}: ${r.error} at ${r.offset}`);
  return r.value;
};
const err = (text: string) => {
  const r = parseLiteral(text);
  if (r.ok) throw new Error(`${text} parsed`);
  return [r.error, r.offset] as const;
};

describe("JavaScript literals", () => {
  test("JSON is a subset", () => {
    expect(ok('{"a": [1, 2.5, -3e2, true, null, "x\\n"]}')).toEqual({ a: [1, 2.5, -300, true, null, "x\n"] });
  });

  test("what JavaScript adds: bare keys, single quotes, trailing commas, comments", () => {
    expect(ok("{ name: 'Ada', tags: ['a',], /* why */ n: 1, // done\n }")).toEqual({ name: "Ada", tags: ["a"], n: 1 });
  });

  test("64-bit integers, bytes, and undefined", () => {
    expect(ok("10n")).toEqual(encodeInt64(10n));
    expect(ok("-9223372036854775808n")).toEqual(encodeInt64(-(2n ** 63n)));
    expect(ok('Bytes("AAE=")')).toEqual({ $bytes: "AAE=" });
    expect(ok("undefined")).toBe(UNSET);
    expect(ok("{ a: 1, b: undefined }")).toEqual({ a: 1 }); // an undefined field is not there
  });

  test("mistakes are named, with where they are", () => {
    expect(err("ada")).toEqual(['"ada" is not a value: text needs quotes, like "ada"', 0]);
    expect(err("{ a: ada }")).toEqual(['"ada" is not a value: text needs quotes', 5]);
    expect(err("{ a: 1")).toEqual(['Expected "}" before the end', 6]);
    expect(err("[1 2]")).toEqual(['Expected "," or "]"', 3]);
    expect(err("'open")).toEqual(["Unclosed text", 0]);
    expect(err("{ a: 1, a: 2 }")).toEqual(['"a" appears twice', 8]);
    expect(err("9223372036854775808n")).toEqual(["Out of the 64-bit integer range", 0]);
    expect(err("1.5n")[0]).toBe("Not a number");
    expect(err("NaN")[0]).toBe("NaN cannot be stored: values are JSON numbers");
    expect(err('Bytes("not base64!")')[0]).toBe("Bytes(…) takes a base64 string");
    expect(err("[undefined]")[0]).toBe("undefined cannot be in a list");
    expect(err("1 2")[0]).toBe("Unexpected text after the value");
    expect(err("   ")[0]).toBe("Type a value");
    expect(err("{ a: 1 } // fine\n x")[0]).toBe("Unexpected text after the value");
  });

  test("formatting reads back to the same value, compact or spread over lines", () => {
    const values: Literal[] = [
      42,
      -1.5,
      "hello",
      'quote " and \\',
      "",
      true,
      null,
      UNSET,
      [],
      {},
      [1, "a", [null]],
      { name: "Ada", "not-an-identifier": 1, credits: encodeInt64(10n), raw: { $bytes: "AAE=" }, nested: { x: [1] } },
    ];
    for (const v of values) {
      expect(ok(formatLiteral(v))).toEqual(v);
      expect(ok(formatLiteral(v, "  "))).toEqual(v);
    }
    expect(formatLiteral({ a: 1, b: [2] })).toBe("{ a: 1, b: [2] }");
    expect(formatLiteral({ a: 1, b: [2] }, "  ")).toBe("{\n  a: 1,\n  b: [\n    2,\n  ],\n}");
  });
});
