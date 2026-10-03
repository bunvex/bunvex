// C1 — order-preserving key encoding: Convex's sort keys (@bunvex/values `valuesToKey`, STUDY-18). The byte
// order of encode(a) vs encode(b) equals Convex's value order, so an index is a sorted set of byte strings.
// A tuple is the concatenation of its values' keys; `undefined` (a missing field) sorts below `null`.
import { type Value, valuesToKey } from "@bunvex/values";

export type KeyValue = Value | undefined;

export function encodeKey(values: readonly KeyValue[]): Uint8Array {
  return valuesToKey(values as KeyValue[]);
}

/** memcmp order. */
export function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The smallest key strictly greater than every key starting with `prefix` (for eq-prefix ranges). */
export function prefixEnd(prefix: Uint8Array): Uint8Array {
  const out = Uint8Array.from(prefix);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== 0xff) {
      out[i]++;
      return out.slice(0, i + 1);
    }
  }
  return Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
}

/**
 * The smallest key above every key whose leading components are exactly the values encoded in `key`
 * (DV-310). What follows a complete value in an index key is the next value's type tag (at most 0x15) — or,
 * for a longer value that merely starts with these bytes ("\0…" after "", {"": x} after {}), the 0xFF
 * escape. So `key + [0xFF]` ends the values equal to it and nothing more, where `prefixEnd` (Convex's
 * `BinaryKey::increment`) would also take in those longer values.
 */
export function afterValues(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  out[key.length] = 0xff;
  return out;
}

export const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");
