// Key encoding (keyenc.ts) at its edges: `prefixEnd` over trailing 0xFF bytes, and the bounds and texts the
// property tests' values never reach. Mutation testing (TEST-01 §7) found these untested.
import { describe, expect, test } from "bun:test";
import { boundText, describeBound, hex, keyValueText, prefixEnd } from "../src/keyenc.ts";

describe("prefixEnd", () => {
  test("trailing 0xFF bytes are dropped and the byte before them raised", () => {
    expect(prefixEnd(Uint8Array.of(0x01, 0xff, 0xff))).toEqual(Uint8Array.of(0x02));
    expect(prefixEnd(Uint8Array.of(0x01, 0xfe, 0xff))).toEqual(Uint8Array.of(0x01, 0xff));
  });

  test("a prefix of only 0xFF bytes ends at the index's end", () => {
    expect(prefixEnd(Uint8Array.of(0xff, 0xff))).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(prefixEnd(new Uint8Array(0))).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  });
});

test("hex: two lowercase digits a byte", () => {
  expect(hex(Uint8Array.of(0x01, 0xab, 0x00))).toBe("01ab00");
});

describe("describeBound", () => {
  test("a key ending in 0xFF whose bytes before it hold no whole value either is its bytes", () => {
    // "a" without its terminator, then 0xFF: not whole, not whole cut, not whole lowered.
    expect(describeBound(Uint8Array.of(0x10, 0x61, 0xff), false)).toEqual({ kind: "raw", hex: "1061ff" });
  });

  test("a key that reads as no values, whole or raised, is its bytes", () => {
    expect(describeBound(Uint8Array.of(0x16), true)).toEqual({ kind: "raw", hex: "16" });
    expect(boundText({ kind: "raw", hex: "16" })).toBe("0x16");
  });
});

describe("text", () => {
  test("bytes as base64; an object's fields, comma-separated", () => {
    expect(keyValueText(Uint8Array.of(1, 2).buffer)).toBe("Bytes(AQI=)");
    expect(keyValueText({ a: 1n, b: "x" })).toBe('{"a": 1n, "b": "x"}');
  });

  test("a bound past every key starting with its values ends in an ellipsis", () => {
    expect(boundText({ kind: "key", values: ["ana", 2n], after: true })).toBe('["ana", 2n, …]');
    expect(boundText({ kind: "key", values: ["ana", 2n], after: false })).toBe('["ana", 2n]');
  });
});
