// Convex's value utilities (values/size.ts, values/base64.ts): `valueSize` (Convex's `getConvexSize`) with
// its edges, `getDocumentSize` with its system-field estimates, and the `Base64` namespace. The expected values
// were checked against Convex's own functions (20 000 random cases, STUDY-97).
import { expect, test } from "bun:test";
import { Base64, commitTsPlaceholder, getDocumentSize, rawValueSize, valueSize } from "../src/index.ts";

test("valueSize: Convex's sizes, 0 for undefined, 9 for a commit-ts placeholder", () => {
  expect(valueSize(undefined)).toBe(0);
  expect(valueSize(null)).toBe(1);
  expect(valueSize(true)).toBe(1);
  expect(valueSize(1.5)).toBe(9);
  expect(valueSize(2n)).toBe(9);
  expect(valueSize("hé")).toBe(5);
  expect(valueSize(new ArrayBuffer(7))).toBe(9);
  expect(valueSize([1, "a"])).toBe(2 + 9 + 3);
  expect(valueSize({ a: 1, b: undefined } as never)).toBe(2 + 2 + 9);
  expect(valueSize(commitTsPlaceholder as never)).toBe(9);
  expect(valueSize(Object.create(null) as never)).toBe(2);
});

test("valueSize: anything else throws Convex's message", () => {
  expect(() => valueSize(new Date() as never)).toThrow("Unsupported value type: object");
  expect(() => valueSize({ a: new Map() } as never)).toThrow("Unsupported value type: object");
  expect(() => valueSize((() => 1) as never)).toThrow("Unsupported value type: function");
  expect(() => valueSize(Symbol("s") as never)).toThrow("Unsupported value type: symbol");
});

test("getDocumentSize: the value's size plus the system fields it lacks (38 for _id, 23 for _creationTime)", () => {
  expect(getDocumentSize({})).toBe(2 + 38 + 23);
  expect(getDocumentSize({ a: 1 })).toBe(2 + 2 + 9 + 38 + 23);
  expect(getDocumentSize({ _id: "abc", a: 1 })).toBe(valueSize({ _id: "abc", a: 1 }) + 23);
  expect(getDocumentSize({ _creationTime: 1 })).toBe(valueSize({ _creationTime: 1 }) + 38);
  expect(getDocumentSize({ _id: "abc", _creationTime: 2 })).toBe(valueSize({ _id: "abc", _creationTime: 2 }));
  expect(getDocumentSize({ _id: undefined } as never)).toBe(2 + 38 + 23);
  expect(getDocumentSize({}, { customIdLength: 10 })).toBe(2 + 16 + 23);
  expect(getDocumentSize({}, { customIdLength: 0 })).toBe(2 + 38 + 23); // 0 is no custom length
});

test("Base64: encodes padded and URL-safe, decodes both", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x01]);
  expect(Base64.fromByteArray(bytes)).toBe("+/+/AQ==");
  expect(Base64.fromByteArrayUrlSafeNoPadding(bytes)).toBe("-_-_AQ");
  expect([...Base64.toByteArray("+/+/AQ==")]).toEqual([...bytes]);
  expect([...Base64.toByteArray("-_-_AQ==")]).toEqual([...bytes]);
  expect([...Base64.toByteArray("aGk=")]).toEqual([104, 105]);
  expect(Base64.byteLength("+/+/AQ==")).toBe(4);
  expect(Base64.byteLength("aGk=")).toBe(2);
  expect(Base64.fromByteArray(new Uint8Array())).toBe("");
});

test("Base64: base64-js's edges — length a multiple of 4, characters outside the alphabet read as 0", () => {
  expect(() => Base64.toByteArray("-_-_AQ")).toThrow("Invalid string. Length must be a multiple of 4");
  expect(() => Base64.byteLength("abc")).toThrow("Invalid string. Length must be a multiple of 4");
  expect([...Base64.toByteArray("!!!!")]).toEqual([0, 0, 0]);
  expect([...Base64.toByteArray("aGk=ignored=")]).toEqual([104, 105]);
});

test("Base64 round-trips every length", () => {
  for (let n = 0; n < 64; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
    expect([...Base64.toByteArray(Base64.fromByteArray(bytes))]).toEqual([...bytes]);
    expect(Base64.fromByteArray(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  }
});

test("rawValueSize, for values not validated yet: a non-value counts as an object, its validation reports it", () => {
  expect(rawValueSize({ a: 1 })).toBe(valueSize({ a: 1 }));
  expect(rawValueSize({ d: new Date() } as never)).toBe(2 + 2 + 2);
  expect(rawValueSize((() => 1) as never)).toBe(2);
});
