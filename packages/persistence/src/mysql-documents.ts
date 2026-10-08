// MySQL's document encoding: a stored version's `json_value` is the document's JSON text, and a deleted version is
// `null` (Convex's v0, crates/mysql/src/document_encoding.rs). Convex writes its v1 (an LZ4 block over the sort key,
// with a fixed dictionary) by default and reads both; bunvex reads and writes v0 only, so a MySQL store the Convex
// binary wrote does not open (STUDY-139 P5, DV-443, revisiting DV-414). Convex reads v0, so it opens bunvex's.

const NULL_JSON = new TextEncoder().encode("null");
const utf8 = new TextDecoder();

/** A version's `json_value`: the JSON text, `null` when deleted. */
export function encodeDocument(json: string | null): Uint8Array {
  return json === null ? NULL_JSON : new TextEncoder().encode(json);
}

/** A stored `json_value`: the document's JSON, or null for a deleted version. */
export function decodeDocument(bytes: Uint8Array): string | null {
  const tag = bytes[0];
  if (tag !== 0x7b /* { */ && tag !== 0x6e /* n */)
    throw new Error(
      tag === 0x01 || bytes.length === 0
        ? "a document in the v1 encoding (LZ4), which bunvex does not read: this store was written by another binary; export its data and import it"
        : `unknown document encoding (first byte ${tag})`,
    );
  const text = utf8.decode(bytes);
  return text === "null" ? null : text;
}
