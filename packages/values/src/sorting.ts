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
  /**
   * A string's UTF-8 bytes, escaped and terminated (`escaped(utf8.encode(s))`). A string of ASCII without
   * U+0000 (ids, field names, most values) is written unit by unit, with nothing allocated; the rest is
   * encoded.
   */
  escapedString(s: string) {
    const len = s.length;
    this.room(len + 1);
    const start = this.n;
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === 0 || c > 0x7f) {
        this.n = start;
        return this.escaped(utf8.encode(s));
      }
      this.buf[this.n++] = c;
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
      return w.escapedString(v);
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
    w.escapedString(k);
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

// ------------------------------------------------------------------ decoding (STUDY-131 AD-25)

class Reader {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  /** The next byte, or throws at the end. */
  next(): number {
    if (this.i >= this.b.length) throw new RangeError("key ends inside a value");
    return this.b[this.i++]!;
  }
  /** Bytes up to an unescaped 0x00 (consumed), with each 0x00 0xFF read as 0x00. */
  escaped(): Uint8Array {
    const out: number[] = [];
    for (;;) {
      const x = this.next();
      if (x !== TERMINATOR) {
        out.push(x);
        continue;
      }
      if (this.i < this.b.length && this.b[this.i] === ESCAPE) {
        this.i++;
        out.push(TERMINATOR);
        continue;
      }
      return Uint8Array.from(out);
    }
  }
}

const utf8Decoder = new TextDecoder();

function read(r: Reader): Value | undefined {
  const tag = r.next();
  if (tag === UNDEFINED) return undefined;
  if (tag === NULL) return null;
  if (tag >= ZERO_INT - 4 && tag <= ZERO_INT + 4) {
    if (tag === ZERO_INT) return 0n;
    const width = Math.abs(tag - ZERO_INT);
    const bytes = 1 << (width - 1);
    let u = 0n;
    for (let k = 0; k < bytes; k++) u = (u << 8n) | BigInt(r.next());
    return BigInt.asIntN(bytes * 8, u);
  }
  if (tag === FLOAT) {
    const raw = new Uint8Array(8);
    for (let k = 0; k < 8; k++) raw[k] = r.next();
    if (raw[0]! & 0x80) raw[0] = raw[0]! & 0x7f;
    else for (let k = 0; k < 8; k++) raw[k] = ~raw[k]! & 0xff;
    return new DataView(raw.buffer).getFloat64(0);
  }
  if (tag === FALSE) return false;
  if (tag === TRUE) return true;
  if (tag === STRING) return utf8Decoder.decode(r.escaped());
  if (tag === BYTES) return r.escaped().slice().buffer as ArrayBuffer;
  if (tag === ARRAY) {
    const out: Value[] = [];
    for (;;) {
      if (r.i < r.b.length && r.b[r.i] === TERMINATOR) {
        r.i++;
        return out;
      }
      out.push(read(r) as Value);
    }
  }
  if (tag === OBJECT) {
    const out: Record<string, Value> = {};
    for (;;) {
      // An empty field name is its terminator then the escape; the object's own terminator is a lone 0x00.
      if (r.i < r.b.length && r.b[r.i] === TERMINATOR && r.b[r.i + 1] !== ESCAPE) {
        r.i++;
        return out;
      }
      let name: string;
      if (r.b[r.i] === TERMINATOR && r.b[r.i + 1] === ESCAPE) {
        r.i += 2;
        name = "";
      } else name = utf8Decoder.decode(r.escaped());
      out[name] = read(r) as Value;
    }
  }
  throw new RangeError(`unknown type tag 0x${tag.toString(16)}`);
}

/**
 * The values a sort key encodes, read back (the inverse of `valuesToKey`), as far as they are complete:
 * `consumed` is how many bytes they took. What follows (an interval bound's `0xFF`, or a key cut short) is
 * left to the caller. For reading keys back for people (STUDY-131 AD-25), not on any hot path.
 */
export function keyToValues(key: Uint8Array): { values: (Value | undefined)[]; consumed: number } {
  const r = new Reader(key);
  const values: (Value | undefined)[] = [];
  let consumed = 0;
  while (r.i < key.length) {
    try {
      values.push(read(r));
    } catch {
      break;
    }
    consumed = r.i;
  }
  return { values, consumed };
}
