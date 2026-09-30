import { describe, expect, test } from "bun:test";
import type { Document } from "../src/data-source.ts";
import { encodeInt64 } from "../src/filters.ts";
import { inferDocumentType } from "../src/mock/infer.ts";
import { displayValidator, validateValue } from "../src/validators.ts";

const doc = (n: number, fields: Record<string, unknown>) =>
  ({ _id: `d${n}`, _creationTime: n, ...fields }) as unknown as Document;
const noIds = () => null;
const code = (docs: Document[], tableOf: (id: string) => string | null = noIds) =>
  displayValidator(inferDocumentType(docs, tableOf)!, { width: 400 });

describe("a document type inferred from documents", () => {
  test("each field's type; system fields left out", () => {
    expect(code([doc(1, { a: "x", b: 1, c: true, d: null, e: encodeInt64(2n), f: { $bytes: "AA==" } })])).toBe(
      "v.object({ a: v.string(), b: v.float64(), c: v.boolean(), d: v.null(), e: v.int64(), f: v.bytes() })",
    );
  });

  test("missing from some documents: optional; several types: a union", () => {
    expect(code([doc(1, { a: 1, b: "x" }), doc(2, { a: "y" })])).toBe(
      "v.object({ a: v.union(v.float64(), v.string()), b: v.optional(v.string()) })",
    );
  });

  test("objects merge their fields; arrays hold the union of their elements; an empty array alone is any", () => {
    expect(
      code([doc(1, { m: { x: 1 }, t: [] }), doc(2, { m: { y: "z" }, t: ["a", 1] }), doc(3, { m: null, u: [] })]),
    ).toBe(
      "v.object({ m: v.union(v.object({ x: v.optional(v.float64()), y: v.optional(v.string()) }), v.null()), t: v.optional(v.array(v.union(v.string(), v.float64()))), u: v.optional(v.array(v.any())) })",
    );
  });

  test("text that is an id of a table is v.id(table)", () => {
    const tableOf = (id: string) => (id.startsWith("u") ? "users" : null);
    expect(code([doc(1, { owner: "u1", note: "hello" })], tableOf)).toBe(
      'v.object({ owner: v.id("users"), note: v.string() })',
    );
  });

  test("every document fits what is inferred; none gives null", () => {
    const docs = [doc(1, { a: [{ b: 1 }], c: "x" }), doc(2, { a: [{ b: "y", d: null }] }), doc(3, {})];
    const v = inferDocumentType(docs, noIds)!;
    for (const d of docs) {
      const { _id, _creationTime, ...own } = d;
      expect(validateValue(v, own)).toEqual([]);
    }
    expect(inferDocumentType([], noIds)).toBeNull();
  });
});
