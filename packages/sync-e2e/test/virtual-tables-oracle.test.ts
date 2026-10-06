// The stored encodings behind the virtual system tables (STUDY-125), against the official `convex` package as
// the oracle: a `_scheduled_job_args` document's `args` are Convex's `args_to_bytes` — the UTF-8 of the
// arguments array's JSON, `convexToJson`'s encoding — and read back as `jsonToConvex` reads them; a
// `_storage` document's `sha256` is the digest's standard base64, as Convex's v2 virtual table gives it.
import { expect, test } from "bun:test";
import { argsFromBytes, argsToBytes, virtualFile } from "@bunvex/core";
import type { Value } from "@bunvex/values";
import { type Value as ConvexValue, convexToJson, jsonToConvex } from "convex/values";
import fc from "fast-check";

const SAMPLES: Value[][] = [
  [{}],
  [{ n: 1n, f: 1.5, neg: -0, s: "olá 🌍", b: true, z: null }],
  [{ big: -(2n ** 63n), max: 2n ** 63n - 1n, inf: Number.POSITIVE_INFINITY, nan: Number.NaN }],
  [{ bytes: new Uint8Array([0, 1, 254, 255]).buffer, nested: { list: [1n, [2.5, { x: "y" }], new ArrayBuffer(0)] } }],
];

const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);

test("args bytes are the JSON of convexToJson(args), and decode as jsonToConvex does", () => {
  for (const args of SAMPLES) {
    const bytes = argsToBytes(args);
    expect(decode(bytes)).toBe(JSON.stringify(convexToJson(args as ConvexValue)));
    expect(argsFromBytes(bytes)).toEqual(jsonToConvex(JSON.parse(decode(bytes))) as Value[]);
  }
});

// Values both packages accept: what a scheduled function's arguments object may hold.
const leaf = fc.oneof(
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
  fc.double(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.uint8Array({ maxLength: 8 }).map((a) => a.slice().buffer as ArrayBuffer),
);
const key = fc.string({ minLength: 1, maxLength: 6 }).filter((k) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(k));
const value: fc.Arbitrary<Value> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: "small" },
    leaf,
    fc.array(tie("v"), { maxLength: 3 }),
    fc.dictionary(key, tie("v"), { maxKeys: 3 }),
  ),
})).v as fc.Arbitrary<Value>;

test("property: any arguments object round-trips the same as Convex's encoding", () => {
  fc.assert(
    fc.property(fc.dictionary(key, value, { maxKeys: 4 }), (obj) => {
      const args = [obj as Value];
      const bytes = argsToBytes(args);
      expect(decode(bytes)).toBe(JSON.stringify(convexToJson(args as ConvexValue)));
      expect(argsFromBytes(bytes)).toEqual(jsonToConvex(JSON.parse(decode(bytes))) as Value[]);
    }),
    { numRuns: 300 },
  );
});

test("a `_storage` document's sha256 is the digest in standard base64", () => {
  const digest = new Bun.CryptoHasher("sha256").update("hello").digest();
  const doc = virtualFile({
    _id: "x",
    _creationTime: 1,
    storageId: "u",
    storageKey: "k",
    sha256: digest.buffer.slice(digest.byteOffset, digest.byteOffset + 32),
    size: 5n,
    contentType: null,
  } as never);
  expect(doc).toEqual({ _creationTime: 1, _id: "x", contentType: null, sha256: digest.toString("base64"), size: 5 });
});
