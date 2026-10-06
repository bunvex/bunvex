// C1 — order-preserving key encoding: Convex's sort keys (@bunvex/values `valuesToKey`, STUDY-18). The byte
// order of encode(a) vs encode(b) equals Convex's value order, so an index is a sorted set of byte strings.
// A tuple is the concatenation of its values' keys; `undefined` (a missing field) sorts below `null`.
import { isBytes, keyToValues, type Value, valuesToKey } from "@bunvex/values";

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

// ------------------------------------------------------------------ reading keys back (STUDY-131 AD-25)

/**
 * One end of a read interval, read back for people: the start or end of the index (`min`, `max`), the values a
 * key holds (`after`: the bound is just past every key that starts with them, as `afterValues` and
 * `prefixEnd` make it), or the bytes when they hold no whole value.
 */
export type KeyBound =
  | { kind: "min" }
  | { kind: "max" }
  | { kind: "key"; values: KeyValue[]; after: boolean }
  | { kind: "raw"; hex: string };

const MAX_BOUND = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

const whole = (key: Uint8Array): KeyValue[] | null => {
  const d = keyToValues(key);
  return d.consumed === key.length ? d.values : null;
};

/** A bound of an interval `[lo, hi)` as values: `lo` (true) or `hi` (false). */
export function describeBound(key: Uint8Array, lo: boolean): KeyBound {
  if (key.length === 0) return { kind: "min" };
  if (!lo && compareKeys(key, MAX_BOUND) === 0) return { kind: "max" };
  const exact = whole(key);
  if (exact) return { kind: "key", values: exact, after: false };
  // `afterValues`: the values, then 0xFF (which after a string reads as an escape, so it is cut first).
  if (key[key.length - 1] === 0xff) {
    const vals = whole(key.subarray(0, key.length - 1));
    if (vals) return { kind: "key", values: vals, after: true };
  }
  // `prefixEnd`: the values' last byte raised by one (trailing 0xFF bytes dropped).
  const down = Uint8Array.from(key);
  down[down.length - 1]!--;
  const vals = whole(down);
  if (vals) return { kind: "key", values: vals, after: true };
  return { kind: "raw", hex: hex(key) };
}

/** A key value as text: strings quoted, `5n` for an int64, `Bytes(base64)`, `undefined` for a missing field. */
export function keyValueText(v: KeyValue): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (isBytes(v)) return `Bytes(${Buffer.from(v as ArrayBuffer).toString("base64")})`;
  if (Array.isArray(v)) return `[${v.map(keyValueText).join(", ")}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${JSON.stringify(k)}: ${keyValueText(x)}`)
    .join(", ")}}`;
}

/** A bound as text: `-∞`, `+∞`, `["ana"]`, or `["ana", …]` for one just past every key starting with them. */
export function boundText(b: KeyBound): string {
  if (b.kind === "min") return "-∞";
  if (b.kind === "max") return "+∞";
  if (b.kind === "raw") return `0x${b.hex}`;
  const vals = b.values.map(keyValueText);
  return `[${b.after ? [...vals, "…"].join(", ") : vals.join(", ")}]`;
}
