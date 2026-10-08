// MySQL's document encoding (STUDY-139 P5, DV-443): the JSON text (Convex's v0), `null` for a deleted version.
// Convex's v1 (an LZ4 block over the sort key) is neither read nor written: such a document is refused with a
// message that says the store came from another binary.
import { expect, test } from "bun:test";
import { decodeDocument, encodeDocument } from "../src/mysql-documents.ts";

test("a document round-trips as its JSON text; a deleted version is `null`", () => {
  for (const json of ['{"_id":"x","_creationTime":1,"a":{"$integer":"AQAAAAAAAAA="}}', "{}", '{"s":"é\\u0000"}']) {
    expect(Buffer.from(encodeDocument(json)).toString()).toBe(json);
    expect(decodeDocument(encodeDocument(json))).toBe(json);
  }
  expect(Buffer.from(encodeDocument(null)).toString()).toBe("null");
  expect(decodeDocument(encodeDocument(null))).toBeNull();
});

test("a v1 document (the Convex binary's default) is refused, naming the way out", () => {
  // v1's header: 0x01, the sort key's length (u32), then the LZ4 block; a deleted v1 version is empty.
  for (const bytes of [new Uint8Array([0x01, 0, 0, 0, 3, 0x30, 0x15, 0]), new Uint8Array(0)])
    expect(() => decodeDocument(bytes)).toThrow("export its data and import it");
  expect(() => decodeDocument(new Uint8Array([0x02]))).toThrow("unknown document encoding (first byte 2)");
});
