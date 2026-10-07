// Internal ids (STUDY-133 §5.1): the 16 bytes inside every document id. Convex prints one as base64url without
// padding, 22 characters (`InternalId`'s Display, crates/value/src/document_id.rs); a table's persistence id
// (`TabletId`) is its `_tables` document's internal id, an index's (`IndexId`) its `_index` document's. bunvex
// carries them as those strings: they key maps by value and read as Convex prints them. Drivers bind the bytes.
import { decodeId } from "@bunvex/values";
import type { IndexId, TabletId } from "./persistence/index.ts";

const INTERNAL_ID_LEN = 16;

/** Convex's string form of an internal id: base64url, no padding. */
export function internalIdString(bytes: Uint8Array): string {
  if (bytes.length !== INTERNAL_ID_LEN) throw new Error("an internal id is 16 bytes");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** The bytes of an internal id's string form; throws on anything else (Convex's `InternalId::from_str`). */
export function internalIdBytes(s: string): Uint8Array {
  if (typeof s !== "string" || s.length !== 22 || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(s))
    throw new Error(`invalid internal id ${JSON.stringify(s)}`);
  return new Uint8Array(Buffer.from(s, "base64url"));
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const B64_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++)
  B64_DECODE["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".charCodeAt(i)] = i;

/** Bytes as lowercase hex, without a Buffer (the SQL drivers send ids and keys as hex, on every write). */
export function bytesToHex(b: Uint8Array): string {
  if (b.length > 256) return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!]!;
  return s;
}

/** An internal id's 16 bytes as hex, decoded straight from its base64url; throws on anything else. */
export function internalIdHex(s: string): string {
  if (typeof s !== "string" || s.length !== 22) return bytesToHex(internalIdBytes(s));
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 22; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_DECODE[c]! : -1;
    if (v < 0) return bytesToHex(internalIdBytes(s)); // throws its error
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += HEX[(acc >> bits) & 0xff]!;
    }
  }
  // 22 characters carry 132 bits: the last 4 must be zero, as in a canonical internal id.
  if (acc & ((1 << bits) - 1)) return bytesToHex(internalIdBytes(s));
  return out;
}

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
const B32_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < 32; i++) B32_DECODE[B32.charCodeAt(i)] = i;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const bytes = new Uint8Array(24);

/**
 * The internal id (string form) of a document id: on every read and write, so it decodes the base32 straight
 * into the 16 bytes after the table number and prints them, without the id's other checks (an id reaching
 * persistence was checked when it entered the transaction). A string that is not an id falls back to
 * `decodeId`, which throws its error.
 */
export function internalIdOf(documentId: string): string {
  const len = documentId.length;
  if (len < 31 || len > 37) return internalIdString(decodeId(documentId).internalId);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < len; i++) {
    const c = documentId.charCodeAt(i);
    const v = c < 128 ? B32_DECODE[c]! : -1;
    if (v < 0) return internalIdString(decodeId(documentId).internalId);
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[n++] = (acc >> bits) & 0xff;
    }
  }
  // VInt(table number) ++ 16 bytes ++ 2-byte footer.
  let p = 0;
  while (p < 5 && bytes[p]! & 0x80) p++;
  p++;
  if (n !== p + 18) return internalIdString(decodeId(documentId).internalId);
  let out = "";
  for (let i = 0; i < 15; i += 3) {
    const x = (bytes[p + i]! << 16) | (bytes[p + i + 1]! << 8) | bytes[p + i + 2]!;
    out += B64URL[x >> 18]! + B64URL[(x >> 12) & 63]! + B64URL[(x >> 6) & 63]! + B64URL[x & 63]!;
  }
  const last = bytes[p + 15]!;
  return out + B64URL[last >> 2]! + B64URL[(last & 3) << 4]!;
}

/** A table's tablet: the internal id of its `_tables` document. */
export const tabletOf = (tablesDocumentId: string): TabletId => internalIdOf(tablesDocumentId);
/** An index's id: the internal id of its `_index` document. */
export const indexIdOf = (indexDocumentId: string): IndexId => internalIdOf(indexDocumentId);

/** Byte order of two internal ids in string form (base64url's character order is not byte order). */
export function compareInternalIds(a: string, b: string): number {
  if (a === b) return 0;
  // Engine-only ids (a search index's synthetic read-set index) are not 22 characters: they sort last.
  const ra = a.length === 22;
  const rb = b.length === 22;
  if (ra && rb) return Buffer.compare(Buffer.from(a, "base64url"), Buffer.from(b, "base64url"));
  if (ra !== rb) return ra ? -1 : 1;
  return a < b ? -1 : 1;
}
