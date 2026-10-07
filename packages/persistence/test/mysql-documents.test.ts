// MySQL's document encodings (STUDY-133 Q4, DV-414): v1 documents the Convex binary wrote decode, and bunvex's
// own v1 and v0 round-trip; the LZ4 block codec reads what it writes for any input.
import { expect, test } from "bun:test";
import { compress, decompress } from "../src/lz4.ts";
import { documentEncodingFromEnv } from "../src/mysql.ts";
import { decodeDocument, encodeV0, encodeV1 } from "../src/mysql-documents.ts";

const CONVEX_V1 = (await Bun.file(`${import.meta.dir}/fixtures/mysql-v1-documents.json`).json()) as {
  hex: string;
  json: string;
}[];

test("v1 documents the Convex binary wrote decode", () => {
  for (const d of CONVEX_V1) {
    const bytes = new Uint8Array(Buffer.from(d.hex, "hex"));
    expect(bytes[0]).toBe(1);
    const json = decodeDocument(bytes)!;
    expect(json).toBe(d.json);
    const doc = JSON.parse(json);
    expect(typeof doc._id).toBe("string");
    expect(typeof doc._creationTime).toBe("number");
  }
});

test("bunvex's v1 and v0 round-trip, and a deleted version is empty (v1) or `null` (v0)", () => {
  for (const d of CONVEX_V1) {
    expect(decodeDocument(encodeV1(d.json))).toBe(d.json);
    expect(decodeDocument(encodeV0(d.json))).toBe(d.json);
  }
  expect(encodeV1(null).length).toBe(0);
  expect(decodeDocument(new Uint8Array(0))).toBeNull();
  expect(Buffer.from(encodeV0(null)).toString()).toBe("null");
  expect(decodeDocument(encodeV0(null))).toBeNull();
});

test("the LZ4 block codec round-trips with a dictionary, compressible or not", () => {
  const dict = new TextEncoder().encode("dictionary words _id _creationTime");
  const inputs = [
    new Uint8Array(0),
    new Uint8Array(5).fill(7),
    new TextEncoder().encode("_id _creationTime dictionary words, ".repeat(200)),
    crypto.getRandomValues(new Uint8Array(70_000)),
    new Uint8Array(70_000).fill(1),
  ];
  for (const input of inputs) {
    const block = compress(input, dict);
    expect(Buffer.from(decompress(block, input.length, dict))).toEqual(Buffer.from(input));
  }
  // A block that does not decode to the declared size is refused.
  const block = compress(inputs[2]!, dict);
  let err: unknown = null;
  try {
    decompress(block, inputs[2]!.length + 1, dict);
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
});

test("MYSQL_DOCUMENT_ENCODING: unset or empty is 0 (bunvex's default, DV-414), 0 and 1 as given, else refused", () => {
  expect(documentEncodingFromEnv(undefined)).toBe(0);
  expect(documentEncodingFromEnv("")).toBe(0);
  expect(documentEncodingFromEnv("0")).toBe(0);
  expect(documentEncodingFromEnv("1")).toBe(1);
  let err: unknown = null;
  try {
    documentEncodingFromEnv("2");
  } catch (e) {
    err = e;
  }
  expect(String(err)).toContain("Unknown encoding version 2");
});
