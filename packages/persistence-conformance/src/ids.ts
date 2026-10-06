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
