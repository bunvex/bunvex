// C1 — order-preserving key encoding. The byte order of encode(a) vs encode(b) equals the value order,
// so an index is just a sorted set of byte strings (the shape Convex's `indexes.key BLOB` has).
//
// Tags: null < false < true < number < string < bytes(id). Tuples are the concatenation of their
// elements; strings are 0x00-escaped and 0x00-terminated so a prefix never sorts after a longer string.

const T_NULL = 0x01;
const T_FALSE = 0x02;
const T_TRUE = 0x03;
const T_NUM = 0x04;
const T_STR = 0x05;
const T_BYTES = 0x06;

export type KeyValue = null | boolean | number | string | Uint8Array;

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
const enc = new TextEncoder();

function pushNumber(out: number[], n: number) {
  f64[0] = n === 0 ? 0 : n; // -0 → 0
  // little-endian platform: reverse to big-endian, then make the IEEE order unsigned-comparable
  const neg = (f64b[7] & 0x80) !== 0;
  for (let i = 7; i >= 0; i--) out.push(neg ? ~f64b[i] & 0xff : i === 7 ? f64b[i] ^ 0x80 : f64b[i]);
}

function pushEscaped(out: number[], bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) out.push(0x00, 0xff);
    else out.push(b);
  }
  out.push(0x00);
}

export function encodeKey(values: readonly KeyValue[]): Uint8Array {
  const out: number[] = [];
  for (const v of values) {
    if (v === null) out.push(T_NULL);
    else if (v === false) out.push(T_FALSE);
    else if (v === true) out.push(T_TRUE);
    else if (typeof v === "number") {
      out.push(T_NUM);
      pushNumber(out, v);
    } else if (typeof v === "string") {
      out.push(T_STR);
      pushEscaped(out, enc.encode(v));
    } else {
      out.push(T_BYTES);
      pushEscaped(out, v);
    }
  }
  return Uint8Array.from(out);
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

export const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");
