// Lone surrogates (STUDY-135): finding one, and serde_json's message for the JSON text Convex sends. The
// columns are the ones Convex's local backend answered (STUDY-135 §1.2), each for the syscall text shown.
import { describe, expect, test } from "bun:test";
import { hasLoneSurrogate, jsonSurrogateError, valueHasLoneSurrogate, withoutLoneSurrogates } from "../src/index.ts";

const H = "\ud800";
const L = "\udc00";

describe("finding a lone surrogate", () => {
  test("in a string, a field name, or anywhere in a value", () => {
    expect(hasLoneSurrogate(H)).toBe(true);
    expect(hasLoneSurrogate(`a${L}`)).toBe(true);
    expect(hasLoneSurrogate("😀")).toBe(false);
    expect(valueHasLoneSurrogate({ a: [1, { b: `x${H}` }] })).toBe(true);
    expect(valueHasLoneSurrogate({ [`f${H}`]: 1 })).toBe(true);
    expect(valueHasLoneSurrogate({ a: [1, "é", null, 2n, new ArrayBuffer(2)] })).toBe(false);
  });
});

test("U+FFFD in place of each lone surrogate, a pair kept, as Convex's lossy conversion", () => {
  expect(withoutLoneSurrogates(`a${H}b${L}c😀${L}${H}`)).toBe("a\ufffdb\ufffdc😀\ufffd\ufffd");
  expect(withoutLoneSurrogates("plain")).toBe("plain");
});

describe("serde_json's message for the text JSON.stringify writes", () => {
  const insert = (value: unknown) => JSON.stringify({ table: "a", value });
  test("Convex's columns for db.insert (STUDY-135 §1.2)", () => {
    expect(jsonSurrogateError(insert({ k: H }))).toBe("unexpected end of hex escape at line 1 column 34");
    expect(jsonSurrogateError(insert({ k: L }))).toBe("lone leading surrogate in hex escape at line 1 column 33");
    expect(jsonSurrogateError(insert({ k: H + H }))).toBe("lone leading surrogate in hex escape at line 1 column 39");
    expect(jsonSurrogateError(insert({ k: L + H }))).toBe("lone leading surrogate in hex escape at line 1 column 33");
    expect(jsonSurrogateError(insert({ k: `a${H}b` }))).toBe("unexpected end of hex escape at line 1 column 35");
    expect(jsonSurrogateError(insert({ x: 1, y: { z: [1, H] } }))).toBe(
      "unexpected end of hex escape at line 1 column 48",
    );
  });

  test("Convex's columns for a query, a nested call and the scheduler", () => {
    const withIndex =
      '{"query":{"source":{"type":"IndexRange","indexName":"a.by_k","range":[{"type":"Eq","fieldPath":"k","value":"\\ud800"}],"order":null},"operators":[]},"version":"1.46.0"}';
    expect(jsonSurrogateError(withIndex)).toBe("unexpected end of hex escape at line 1 column 115");
    expect(jsonSurrogateError(JSON.stringify({ udfType: "query", args: { s: H }, name: "probe:echoQ" }))).toBe(
      "unexpected end of hex escape at line 1 column 39",
    );
    expect(
      jsonSurrogateError(JSON.stringify({ name: "probe:echoM", ts: 1791311933.477, args: { s: H }, version: "1" })),
    ).toBe("unexpected end of hex escape at line 1 column 62");
  });

  test("columns count UTF-8 bytes; serde takes one byte past a lone high surrogate", () => {
    // "é" is 2 bytes, "😀" 4.
    expect(jsonSurrogateError(insert({ k: `é${H}` }))).toBe("unexpected end of hex escape at line 1 column 36");
    expect(jsonSurrogateError(insert({ k: `😀${L}` }))).toBe(
      "lone leading surrogate in hex escape at line 1 column 37",
    );
    // The byte after the escape is the first of "é": one byte, as serde consumes it.
    expect(jsonSurrogateError(insert({ k: `${H}é` }))).toBe("unexpected end of hex escape at line 1 column 34");
    // A high surrogate, then another escape that is not `\u`: serde reads the backslash and the next byte.
    expect(jsonSurrogateError(insert({ k: `${H}\n` }))).toBe("unexpected end of hex escape at line 1 column 35");
  });

  test("no error for valid text", () => {
    expect(jsonSurrogateError(insert({ k: "😀", e: 'A\n"\\' }))).toBeNull();
    expect(jsonSurrogateError('{"a":"\\\\ud800"}')).toBeNull(); // an escaped backslash, then letters
  });
});
