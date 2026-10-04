// Sort keys (STUDY-18): an order-preserving, self-delimiting byte encoding of values, in the layout Convex
// uses for index keys (`crates/value/src/sorting.rs`, after FoundationDB's tuple layer). Comparing two keys
// byte-wise compares the values in Convex's order; a tuple is the concatenation of its values' keys.

import { utf8Length } from "./bytes.ts";
import { isCommitTsPlaceholder, MAX_COMMIT_TS } from "./commit-ts.ts";
import { isBytes, type Value } from "./value.ts";

const UNDEFINED = 0x01;
const NULL = 0x03;
const ZERO_INT = 0x08; // negative ints below it, positive above; the distance is the byte width
const FLOAT = 0x0d;
const FALSE = 0x0e;
const TRUE = 0x0f;
const STRING = 0x10;
const BYTES = 0x11;
const ARRAY = 0x12;
const OBJECT = 0x15;
const TERMINATOR = 0x00;
const ESCAPE = 0xff;

class Writer {
  buf = new Uint8Array(64);
  n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  byte(b: number) {
    this.room(1);
    this.buf[this.n++] = b;
  }
  /** Bytes with every 0x00 escaped as 0x00 0xFF, then a 0x00 terminator. */
  escaped(bytes: Uint8Array) {
    this.room(bytes.length * 2 + 1);
    for (const b of bytes) {
      this.buf[this.n++] = b;
      if (b === TERMINATOR) this.buf[this.n++] = ESCAPE;
    }
    this.buf[this.n++] = TERMINATOR;
  }
  done() {
    return this.buf.slice(0, this.n);
  }
}

const utf8 = new TextEncoder();
const f64 = new DataView(new ArrayBuffer(8));

function writeInt(w: Writer, n: bigint) {
  if (n === 0n) return w.byte(ZERO_INT);
  const width =
    n >= -128n && n <= 127n ? 1 : n >= -32768n && n <= 32767n ? 2 : n >= -(2n ** 31n) && n < 2n ** 31n ? 3 : 4;
  w.byte(n < 0n ? ZERO_INT - width : ZERO_INT + width);
  const bytes = 1 << (width - 1);
  const u = BigInt.asUintN(64, n);
  for (let i = bytes - 1; i >= 0; i--) w.byte(Number((u >> BigInt(i * 8)) & 0xffn));
}

const f64bytes = new Uint8Array(f64.buffer);
function writeFloat(w: Writer, x: number) {
  // IEEE-754 total order, big-endian: flip every bit of a negative, only the sign bit of a positive.
  f64.setFloat64(0, x);
  w.byte(FLOAT);
  if (f64bytes[0] & 0x80) for (let i = 0; i < 8; i++) w.byte(~f64bytes[i] & 0xff);
  else {
    w.byte(f64bytes[0] | 0x80);
    for (let i = 1; i < 8; i++) w.byte(f64bytes[i]);
  }
}

function write(w: Writer, v: Value | undefined) {
  // A commit timestamp before the commit sorts as the largest int64 (Convex's max view, STUDY-53).
  if (isCommitTsPlaceholder(v)) v = MAX_COMMIT_TS;
  if (v === undefined) return w.byte(UNDEFINED);
  if (v === null) return w.byte(NULL);
  switch (typeof v) {
    case "bigint":
      return writeInt(w, v);
    case "number":
      return writeFloat(w, v);
    case "boolean":
      return w.byte(v ? TRUE : FALSE);
    case "string":
      w.byte(STRING);
      return w.escaped(utf8.encode(v));
  }
  if (isBytes(v)) {
    w.byte(BYTES);
    return w.escaped(new Uint8Array(v));
  }
  if (Array.isArray(v)) {
    w.byte(ARRAY);
    for (const e of v) write(w, e);
    return w.byte(TERMINATOR);
  }
  w.byte(OBJECT);
  const fields = Object.keys(v).sort();
  for (const k of fields) {
    const e = (v as Record<string, Value>)[k];
    if (e === undefined) continue;
    w.escaped(utf8.encode(k));
    if (k === "") w.byte(ESCAPE); // tells an empty field name from the object's terminator
    write(w, e);
  }
  w.byte(TERMINATOR);
}

/** The sort key of a tuple of values; `undefined` is a missing field, below `null`. */
export function valuesToKey(values: (Value | undefined)[]): Uint8Array {
  const w = new Writer();
  for (const v of values) write(w, v);
  return w.done();
}

/** A string's escaped length: its UTF-8 bytes, one escape per 0x00 (only U+0000 encodes one), a terminator. */
function escapedLength(s: string): number {
  let n = utf8Length(s) + 1;
  for (let i = s.indexOf("\0"); i !== -1; i = s.indexOf("\0", i + 1)) n++;
  return n;
}

function keyLength(v: Value | undefined): number {
  if (isCommitTsPlaceholder(v)) v = MAX_COMMIT_TS;
  if (v === undefined || v === null) return 1;
  switch (typeof v) {
    case "bigint":
      if (v === 0n) return 1;
      return (
        1 + (v >= -128n && v <= 127n ? 1 : v >= -32768n && v <= 32767n ? 2 : v >= -(2n ** 31n) && v < 2n ** 31n ? 4 : 8)
      );
    case "number":
      return 9;
    case "boolean":
      return 1;
    case "string":
      return 1 + escapedLength(v);
  }
  if (isBytes(v)) {
    const b = new Uint8Array(v);
    let n = 2 + b.length;
    for (const x of b) if (x === TERMINATOR) n++;
    return n;
  }
  let n = 2;
  if (Array.isArray(v)) {
    for (const e of v) n += keyLength(e);
    return n;
  }
  for (const k of Object.keys(v)) {
    const e = (v as Record<string, Value>)[k];
    if (e === undefined) continue;
    n += escapedLength(k) + (k === "" ? 1 : 0) + keyLength(e);
  }
  return n;
}

/** `valuesToKey(values).length`, without encoding: what Convex meters for an index key read (STUDY-71). */
export function keyBytesLength(values: (Value | undefined)[]): number {
  let n = 0;
  for (const v of values) n += keyLength(v);
  return n;
}
