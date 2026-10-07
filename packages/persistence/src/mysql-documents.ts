// MySQL's document encodings (Convex's `crates/mysql/src/document_encoding.rs`, STUDY-133 Q4, DV-414). A stored
// version's `json_value` is one of:
//   v0: the document's JSON text; a deleted version is `null`;
//   v1: the byte 0x01, the length of the document's sort key (u32, big-endian), then that sort key as one LZ4
//       block with a fixed dictionary; a deleted version is empty.
// Convex writes v1 (its `MYSQL_DOCUMENT_ENCODING` knob defaults to 1) and reads both, telling them apart by the
// first byte; so does this driver. The dictionary is format data: a v1 document cannot be read without it
// (owner, 2026-10-05, DV-414).
import { fromJsonValue, sortKeyToJsonText, valuesToKey } from "@bunvex/core/persistence";
import { compress, decompress } from "./lz4.ts";

const V1 = 0x01;
/** The v1 dictionary, byte for byte (format data, needed to read v1). */
const DICT = new TextEncoder().encode('{"$integer":"AAAAAAAAAAA="},\x00_id\x00\x10\x15_creationTime\x00\x0d');
const NULL_JSON = new TextEncoder().encode("null");
const utf8 = new TextDecoder();
const EMPTY = new Uint8Array(0);

/** A version's `json_value` in v1 (`null`: deleted, stored empty). */
export function encodeV1(json: string | null): Uint8Array {
  if (json === null) return EMPTY;
  // The document's sort key: one value, an object (Convex's `write_sort_key(Object(doc))`).
  const key = valuesToKey([fromJsonValue(JSON.parse(json))]);
  const block = compress(key, DICT);
  const out = new Uint8Array(5 + block.length);
  out[0] = V1;
  new DataView(out.buffer).setUint32(1, key.length);
  out.set(block, 5);
  return out;
}

/** A version's `json_value` in v0: the JSON text, `null` when deleted. */
export function encodeV0(json: string | null): Uint8Array {
  return json === null ? NULL_JSON : new TextEncoder().encode(json);
}

/** A stored `json_value`, in either encoding: the document's JSON, or null for a deleted version. */
export function decodeDocument(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const tag = bytes[0];
  if (tag === 0x7b /* { */ || tag === 0x6e /* n */) {
    const text = utf8.decode(bytes);
    return text === "null" ? null : text;
  }
  if (tag !== V1) throw new Error(`unknown document encoding version ${tag}`);
  if (bytes.length < 5) throw new Error("a v1 document shorter than its header");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const key = decompress(bytes.subarray(5), size, DICT);
  return sortKeyToJsonText(key);
}
