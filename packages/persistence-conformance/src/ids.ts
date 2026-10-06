// Test tablets and index ids (STUDY-133 §5.1): a store keys tables and indexes by internal ids, 16 bytes printed as
// base64url (22 characters). `tid(n)` is a distinct, stable one per number, so checks can name "table 900".
import { internalIdString } from "@bunvex/core";

const cache = new Map<number, string>();

/** The test internal id for `n`: 12 zero bytes, then `n` (big-endian). */
export function tid(n: number): string {
  let s = cache.get(n);
  if (s === undefined) {
    const b = new Uint8Array(16);
    new DataView(b.buffer).setUint32(12, n);
    s = internalIdString(b);
    cache.set(n, s);
  }
  return s;
}

const docCache = new Map<string, string>();

/**
 * The test document (internal) id for `name`: its UTF-8 bytes, zero-padded to 16 (a name of at most 16
 * bytes). Byte order equals the names' order for ASCII names, so checks can reason with the names.
 */
export function did(name: string): string {
  let s = docCache.get(name);
  if (s === undefined) {
    const raw = new TextEncoder().encode(name);
    if (raw.length > 16) throw new Error(`did: ${JSON.stringify(name)} is longer than 16 bytes`);
    const b = new Uint8Array(16);
    b.set(raw);
    s = internalIdString(b);
    docCache.set(name, s);
  }
  return s;
}

/** `did`'s inverse: the name a test document id was made from. */
export function didName(id: string): string {
  const b = Buffer.from(id, "base64url");
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return new TextDecoder().decode(b.subarray(0, n));
}
