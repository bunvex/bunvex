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

/** The internal id (string form) of a document id. */
export const internalIdOf = (documentId: string): string => internalIdString(decodeId(documentId).internalId);

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
