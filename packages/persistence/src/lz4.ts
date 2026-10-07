// LZ4 block format (https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md) with a dictionary: the
// dictionary is the window before the input, so a match may start in it. What MySQL's v1 document encoding
// needs (STUDY-133 Q4, DV-414): written from the format's specification, a block any conforming decoder reads.
//
// A block is a run of sequences: a token (literal length in the high nibble, match length − 4 in the low one,
// 15 meaning "more bytes follow, 255 each"), the literals, a 2-byte little-endian offset, and the extra match
// length bytes. The last sequence has literals only. The format's end rules hold: the last 5 bytes are
// literals, and no match starts within the last 12.

const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MF_LIMIT = 12;
const MAX_OFFSET = 65535;
const HASH_LOG = 12;

/** The largest block `compress` can produce for `n` input bytes (the format's worst case). */
export const maxCompressedSize = (n: number) => n + Math.floor(n / 255) + 16;

const read32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const hash = (x: number) => Math.imul(x, 2654435761) >>> (32 - HASH_LOG);

/**
 * Compress `input` as one LZ4 block, with `dict` as the window before it. Greedy, one hash table over the
 * dictionary and the input: the output is valid LZ4, not byte-identical to another compressor's.
 */
export function compress(input: Uint8Array, dict: Uint8Array): Uint8Array {
  // One buffer: the dictionary (its last 64 KiB) then the input, so offsets are plain differences.
  const d = dict.length > MAX_OFFSET ? dict.subarray(dict.length - MAX_OFFSET) : dict;
  const src = new Uint8Array(d.length + input.length);
  src.set(d);
  src.set(input, d.length);
  const start = d.length;
  const end = src.length;
  const out = new Uint8Array(maxCompressedSize(input.length));
  let o = 0;
  const table = new Int32Array(1 << HASH_LOG).fill(-1);
  for (let i = 0; i + MIN_MATCH <= start; i++) table[hash(read32(src, i))] = i;

  let anchor = start;
  let i = start;
  const matchLimit = end - LAST_LITERALS;
  const searchLimit = end - MF_LIMIT;
  while (i < searchLimit) {
    const h = hash(read32(src, i));
    const ref = table[h]!;
    table[h] = i;
    if (ref < 0 || i - ref > MAX_OFFSET || read32(src, ref) !== read32(src, i)) {
      i++;
      continue;
    }
    // Extend the match forward (never into the last literals) and backward (over pending literals).
    let len = MIN_MATCH;
    while (i + len < matchLimit && src[ref + len] === src[i + len]) len++;
    let s = i;
    let r = ref;
    while (s > anchor && r > 0 && src[s - 1] === src[r - 1]) {
      s--;
      r--;
      len++;
    }
    o = writeSequence(out, o, src, anchor, s - anchor, s - r, len);
    i = s + len;
    anchor = i;
    if (i - 2 >= start) table[hash(read32(src, i - 2))] = i - 2;
  }
  // The last literals.
  o = writeSequence(out, o, src, anchor, end - anchor, 0, 0);
  return out.slice(0, o);
}

function writeLength(out: Uint8Array, o: number, n: number) {
  while (n >= 255) {
    out[o++] = 255;
    n -= 255;
  }
  out[o++] = n;
  return o;
}

/** One sequence: `litLen` literals from `src[from]`, then (when `matchLen` > 0) a match at `offset`. */
function writeSequence(
  out: Uint8Array,
  o: number,
  src: Uint8Array,
  from: number,
  litLen: number,
  offset: number,
  matchLen: number,
) {
  const tokenAt = o++;
  const ml = matchLen ? matchLen - MIN_MATCH : 0;
  out[tokenAt] = ((litLen >= 15 ? 15 : litLen) << 4) | (ml >= 15 ? 15 : ml);
  if (litLen >= 15) o = writeLength(out, o, litLen - 15);
  out.set(src.subarray(from, from + litLen), o);
  o += litLen;
  if (!matchLen) return o;
  out[o++] = offset & 0xff;
  out[o++] = offset >>> 8;
  if (ml >= 15) o = writeLength(out, o, ml - 15);
  return o;
}

/**
 * Decompress one LZ4 block of exactly `size` bytes, with `dict` as the window before it. Throws on a block
 * that does not decode to exactly `size` bytes, or that reaches before the dictionary.
 */
export function decompress(block: Uint8Array, size: number, dict: Uint8Array): Uint8Array {
  const out = new Uint8Array(dict.length + size);
  out.set(dict);
  let o = dict.length;
  const end = out.length;
  let i = 0;
  const bad = (why: string) => new Error(`corrupt LZ4 block: ${why}`);
  for (;;) {
    if (i >= block.length) throw bad("it ends before its last literals");
    const token = block[i++]!;
    let lit = token >>> 4;
    if (lit === 15)
      for (;;) {
        const b = block[i++];
        if (b === undefined) throw bad("a literal length runs past its end");
        lit += b;
        if (b !== 255) break;
      }
    if (i + lit > block.length || o + lit > end) throw bad("literals past the end");
    out.set(block.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i === block.length) break; // the last sequence: literals only
    if (i + 2 > block.length) throw bad("a match offset past its end");
    const offset = block[i]! | (block[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw bad("a match offset before the dictionary");
    let len = (token & 15) + MIN_MATCH;
    if ((token & 15) === 15)
      for (;;) {
        const b = block[i++];
        if (b === undefined) throw bad("a match length runs past its end");
        len += b;
        if (b !== 255) break;
      }
    if (o + len > end) throw bad("a match past the end");
    // Byte by byte: a match may overlap what it copies (offset < length).
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset]!;
  }
  if (o !== end) throw bad(`it decodes to ${o - dict.length} bytes, not ${size}`);
  return out.subarray(dict.length);
}
