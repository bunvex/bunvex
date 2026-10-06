// The container of a search segment (STUDY-111 §3.1): a header, then sections aligned to 8 bytes, each read as
// a typed array over the same buffer. Opening one decodes nothing but a small JSON section of metadata, so a
// segment costs its bytes in memory, whether they were read from a blob or mapped from a file.
//
// Layout (little-endian): magic "BVXS", format, kind, section count, then per section its offset and length
// (u32 each), then the sections.

const MAGIC = 0x53585642; // "BVXS"
/** The container's format; a segment of another format is refused (the index is rebuilt instead). */
export const SEGMENT_FILE_FORMAT = 1;

/** What a segment file holds. */
export enum SegmentKind {
  Text = 1,
  TextDeletes = 2,
  Vector = 3,
  VectorDeletes = 4,
}

/** Typed arrays read the buffer in the platform's order; the layout is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/** A document's filter key ordinal when it has no value for the field (never a query's key). */
export const NO_FILTER_KEY = 0xffff_ffff;

const align8 = (n: number) => (n + 7) & ~7;
const HEADER_WORDS = 4;

export class SegmentFileError extends Error {
  constructor(message: string) {
    super(`not a valid search segment: ${message}`);
    this.name = "SegmentFileError";
  }
}

/** Collects sections, then lays them out in one buffer. */
export class SegmentWriter {
  private sections: Uint8Array[] = [];

  constructor(private kind: SegmentKind) {
    if (!LITTLE_ENDIAN) throw new Error("search segments need a little-endian platform");
  }

  /** Adds a section and returns its number. */
  private add(bytes: Uint8Array): number {
    this.sections.push(bytes);
    return this.sections.length - 1;
  }

  json(value: unknown): number {
    return this.add(new TextEncoder().encode(JSON.stringify(value)));
  }
  bytes(a: Uint8Array): number {
    return this.add(a);
  }
  u32(a: Uint32Array): number {
    return this.add(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  f32(a: Float32Array): number {
    return this.add(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  f64(a: Float64Array): number {
    return this.add(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  /** Strings as one section of their UTF-8 bytes and one of offsets (n + 1); returns the first. */
  strings(values: readonly Uint8Array[]): number {
    const offsets = new Uint32Array(values.length + 1);
    let total = 0;
    values.forEach((v, i) => {
      offsets[i] = total;
      total += v.length;
    });
    offsets[values.length] = total;
    const bytes = new Uint8Array(total);
    values.forEach((v, i) => {
      bytes.set(v, offsets[i]!);
    });
    const first = this.bytes(bytes);
    this.u32(offsets);
    return first;
  }

  finish(): Uint8Array {
    const n = this.sections.length;
    let at = align8((HEADER_WORDS + 2 * n) * 4);
    const places = this.sections.map((s) => {
      const place = at;
      at = align8(at + s.length);
      return place;
    });
    const out = new Uint8Array(at);
    const head = new Uint32Array(out.buffer, 0, HEADER_WORDS + 2 * n);
    head.set([MAGIC, SEGMENT_FILE_FORMAT, this.kind, n]);
    this.sections.forEach((s, i) => {
      head[HEADER_WORDS + 2 * i] = places[i]!;
      head[HEADER_WORDS + 2 * i + 1] = s.length;
      out.set(s, places[i]!);
    });
    return out;
  }
}

/** A segment file's sections, as views over its buffer. */
export class SegmentReader {
  private readonly table: Uint32Array;
  readonly bytes: Uint8Array;

  constructor(data: Uint8Array, kind: SegmentKind) {
    if (!LITTLE_ENDIAN) throw new Error("search segments need a little-endian platform");
    // Views need aligned offsets: a buffer that is not (a slice of a pooled one) is copied once.
    this.bytes = data.byteOffset % 8 === 0 ? data : data.slice();
    const b = this.bytes;
    if (b.length < HEADER_WORDS * 4) throw new SegmentFileError("too short");
    const head = new Uint32Array(b.buffer, b.byteOffset, HEADER_WORDS);
    if (head[0] !== MAGIC) throw new SegmentFileError("bad magic");
    if (head[1] !== SEGMENT_FILE_FORMAT) throw new SegmentFileError(`format ${head[1]}`);
    if (head[2] !== kind) throw new SegmentFileError(`kind ${head[2]}, expected ${kind}`);
    const n = head[3]!;
    if (b.length < (HEADER_WORDS + 2 * n) * 4) throw new SegmentFileError("truncated header");
    this.table = new Uint32Array(b.buffer, b.byteOffset + HEADER_WORDS * 4, 2 * n);
    for (let i = 0; i < n; i++) {
      const [at, len] = [this.table[2 * i]!, this.table[2 * i + 1]!];
      if (at % 8 !== 0 || at + len > b.length) throw new SegmentFileError(`section ${i} out of bounds`);
    }
  }

  get count(): number {
    return this.table.length / 2;
  }

  private section(i: number, width: number): { at: number; length: number } {
    if (i >= this.count) throw new SegmentFileError(`missing section ${i}`);
    const at = this.bytes.byteOffset + this.table[2 * i]!;
    const len = this.table[2 * i + 1]!;
    if (len % width !== 0) throw new SegmentFileError(`section ${i} is not a whole array`);
    return { at, length: len / width };
  }

  json<T>(i: number): T {
    const s = this.section(i, 1);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(this.bytes.buffer, s.at, s.length))) as T;
  }
  u8(i: number): Uint8Array {
    const s = this.section(i, 1);
    return new Uint8Array(this.bytes.buffer, s.at, s.length);
  }
  u32(i: number): Uint32Array {
    const s = this.section(i, 4);
    return new Uint32Array(this.bytes.buffer, s.at, s.length);
  }
  f32(i: number): Float32Array {
    const s = this.section(i, 4);
    return new Float32Array(this.bytes.buffer, s.at, s.length);
  }
  f64(i: number): Float64Array {
    const s = this.section(i, 8);
    return new Float64Array(this.bytes.buffer, s.at, s.length);
  }
  strings(i: number, expected?: number): StringTable {
    const t = new StringTable(this.u8(i), this.u32(i + 1));
    if (expected !== undefined && t.size !== expected) throw new SegmentFileError(`section ${i}: ${t.size} strings`);
    return t;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8 = (s: string) => encoder.encode(s);

/** Byte order of two UTF-8 strings (what the tables are sorted by). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Two strings in the order of their UTF-8 bytes (code point order), without encoding them: UTF-16 code units
 * compare the same except a surrogate (U+D800–DFFF, half of a code point above U+FFFF) against U+E000–FFFF, so
 * those two ranges are swapped before comparing.
 */
export function compareUtf8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x += x < 0xe000 ? 0x2000 : -0x800;
      y += y < 0xe000 ? 0x2000 : -0x800;
    }
    return x - y;
  }
  return a.length - b.length;
}

/** Code units where UTF-16 order and UTF-8 order can differ. */
const OUT_OF_ORDER = /[\uD800-\uFFFF]/;

/** Sorts `items` by the UTF-8 bytes of `key` (JavaScript's own string order when no key needs `compareUtf8`). */
export function sortUtf8<T>(items: T[], key: (item: T) => string): T[] {
  if (items.some((x) => OUT_OF_ORDER.test(key(x)))) return items.sort((a, b) => compareUtf8(key(a), key(b)));
  return items.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** UTF-8 strings stored back to back, with their offsets; sorted tables are searched in place. */
export class StringTable {
  constructor(
    readonly data: Uint8Array,
    readonly offsets: Uint32Array,
  ) {
    if (offsets.length < 1 || offsets[offsets.length - 1] !== data.length)
      throw new SegmentFileError("string table offsets do not match its bytes");
  }

  get size(): number {
    return this.offsets.length - 1;
  }

  bytesAt(i: number): Uint8Array {
    return this.data.subarray(this.offsets[i]!, this.offsets[i + 1]!);
  }

  at(i: number): string {
    return decoder.decode(this.bytesAt(i));
  }

  /** Byte order of string `i` against `key`. */
  compare(i: number, key: Uint8Array): number {
    const from = this.offsets[i]!;
    const len = this.offsets[i + 1]! - from;
    const n = Math.min(len, key.length);
    const d = this.data;
    for (let k = 0; k < n; k++) {
      const x = d[from + k]!;
      const y = key[k]!;
      if (x !== y) return x - y;
    }
    return len - key.length;
  }

  /** The first string not below `key` (in a sorted table). */
  lowerBound(key: Uint8Array): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compare(mid, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The position of `key` in a sorted table, or -1. */
  find(key: Uint8Array): number {
    const i = this.lowerBound(key);
    return i < this.size && this.compare(i, key) === 0 ? i : -1;
  }

  /** Whether string `i` starts with `prefix`. */
  startsWith(i: number, prefix: Uint8Array): boolean {
    const from = this.offsets[i]!;
    if (this.offsets[i + 1]! - from < prefix.length) return false;
    for (let k = 0; k < prefix.length; k++) if (this.data[from + k] !== prefix[k]) return false;
    return true;
  }

  /** The range of strings starting with `prefix` (in a sorted table). */
  prefixRange(prefix: Uint8Array): [number, number] {
    const from = this.lowerBound(prefix);
    let to = from;
    while (to < this.size && this.startsWith(to, prefix)) to++;
    return [from, to];
  }
}

/**
 * The union of sorted string tables, sorted, each string once (`include` leaves strings out), and per table the
 * position of each of its strings in the union (-1 when left out). Tables are merged, not re-sorted.
 */
export function mergeTables(
  tables: readonly StringTable[],
  include: (table: number, i: number) => boolean = () => true,
): { strings: Uint8Array[]; remap: Int32Array[] } {
  const strings: Uint8Array[] = [];
  const remap = tables.map((t) => new Int32Array(t.size).fill(-1));
  const at = tables.map(() => 0);
  const skip = (k: number) => {
    while (at[k]! < tables[k]!.size && !include(k, at[k]!)) at[k]!++;
  };
  for (let k = 0; k < tables.length; k++) skip(k);
  for (;;) {
    let min: Uint8Array | null = null;
    for (let k = 0; k < tables.length; k++)
      if (at[k]! < tables[k]!.size) {
        const s = tables[k]!.bytesAt(at[k]!);
        if (!min || compareBytes(s, min) < 0) min = s;
      }
    if (!min) break;
    const pos = strings.length;
    strings.push(min);
    for (let k = 0; k < tables.length; k++)
      if (at[k]! < tables[k]!.size && compareBytes(tables[k]!.bytesAt(at[k]!), min) === 0) {
        remap[k]![at[k]!] = pos;
        at[k]!++;
        skip(k);
      }
  }
  return { strings, remap };
}

/** A set of document numbers, one bit each. */
export class Bitset {
  constructor(readonly bits: Uint8Array) {}
  static empty(n: number): Bitset {
    return new Bitset(new Uint8Array((n + 7) >> 3));
  }
  has(i: number): boolean {
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }
  /** Sets bit `i`; false if it was already set. */
  add(i: number): boolean {
    const mask = 1 << (i & 7);
    const byte = this.bits[i >> 3]!;
    if (byte & mask) return false;
    this.bits[i >> 3] = byte | mask;
    return true;
  }
  clone(): Bitset {
    return new Bitset(this.bits.slice());
  }
}
