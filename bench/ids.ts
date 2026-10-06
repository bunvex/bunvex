// Bench tablets and index ids (STUDY-133 §5.1): internal ids, 16 bytes printed as base64url. `tid(n)` is a
// distinct, stable one per number.
import { internalIdString } from "@bunvex/core";

const cache = new Map<number, string>();

/** The bench internal id for `n`: 12 zero bytes, then `n` (big-endian). */
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
