// Document ids in Convex's format (STUDY-01): an id names its table and carries a checksum.
//
//   binary = VInt(table number) ++ internal id (16 bytes) ++ footer (2 bytes, little-endian)
//   footer = fletcher16(VInt(table number) ++ internal id) XOR version        (version 0)
//   string = base32(binary), Crockford's alphabet in lowercase, decoded strictly
//
// A user table's number is above 10 000, so its ids are 32 characters.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

const INTERNAL_ID_LEN = 16;
const VERSION = 0;
const MIN_BINARY_LEN = 1 + INTERNAL_ID_LEN + 2;
const MAX_BINARY_LEN = 5 + INTERNAL_ID_LEN + 2;
const encodedLen = (n: number) => Math.ceil((n * 8) / 5);
const MIN_LEN = encodedLen(MIN_BINARY_LEN); // 31
const MAX_LEN = encodedLen(MAX_BINARY_LEN); // 37

/** Only the lowercase alphabet is accepted. Trailing bits are not checked here: `decodeId` re-encodes. */
function unbase32(s: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? DECODE[c] : -1;
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function fletcher16(bytes: Uint8Array): number {
  let c0 = 0;
  let c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  return (c1 << 8) | c0;
}

export type DecodedId = { tableNumber: number; internalId: Uint8Array };

export class IdDecodeError extends Error {}

/** Scratch space for one id's bytes (an id is at most 23 bytes): ids are built and checked without allocating. */
const scratch = new Uint8Array(MAX_BINARY_LEN);
const codes: number[] = [];
const ALPHABET_CODES = Array.from(ALPHABET, (c) => c.charCodeAt(0));

/** Encode a document id from its table number and 16-byte internal id. */
export function encodeId(tableNumber: number, internalId: Uint8Array): string {
  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 0xffffffff)
    throw new Error(`invalid table number ${tableNumber}`);
  if (internalId.length !== INTERNAL_ID_LEN) throw new Error("an internal id is 16 bytes");
  // VInt(table number) ++ internal id ++ footer, written into the scratch bytes.
  let n = 0;
  let t = tableNumber;
  while (t >= 0x80) {
    scratch[n++] = (t & 0x7f) | 0x80;
    t >>>= 7;
  }
  scratch[n++] = t;
  scratch.set(internalId, n);
  n += INTERNAL_ID_LEN;
  let c0 = 0;
  let c1 = 0;
  for (let i = 0; i < n; i++) {
    c0 = (c0 + scratch[i]!) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  const footer = ((c1 << 8) | c0) ^ VERSION;
  scratch[n++] = footer & 0xff;
  scratch[n++] = footer >> 8;
  // base32 of those bytes.
  codes.length = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    acc = ((acc << 8) | scratch[i]!) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      codes.push(ALPHABET_CODES[(acc >> bits) & 31]!);
    }
  }
  if (bits > 0) codes.push(ALPHABET_CODES[(acc << (5 - bits)) & 31]!);
  return String.fromCharCode(...codes);
}

/** Decode a document id, throwing `IdDecodeError` with Convex's messages when it is not one. */
export function decodeId(s: string): DecodedId {
  if (s.length < MIN_LEN || s.length > MAX_LEN)
    throw new IdDecodeError(`Unable to decode ID: Invalid ID length ${s.length}`);
  const buf = unbase32(s);
  if (!buf) throw new IdDecodeError("Unable to decode ID: ID wasn't valid base32");
  let tableNumber = 0;
  let pos = 0;
  for (; ; pos++) {
    if (pos >= 5 || pos >= buf.length) throw new IdDecodeError("Unable to decode ID: Invalid table number");
    tableNumber += (buf[pos] & 0x7f) * 2 ** (7 * pos);
    if ((buf[pos] & 0x80) === 0) break;
  }
  pos++;
  if (tableNumber === 0 || tableNumber > 0xffffffff)
    throw new IdDecodeError("Unable to decode ID: Invalid table number");
  if (buf.length !== pos + INTERNAL_ID_LEN + 2)
    throw new IdDecodeError(`Unable to decode ID: Invalid ID length ${s.length}`);
  const expected = fletcher16(buf.subarray(0, pos + INTERNAL_ID_LEN)) ^ VERSION;
  const footer = buf[pos + INTERNAL_ID_LEN] | (buf[pos + INTERNAL_ID_LEN + 1] << 8);
  if (footer !== expected)
    throw new IdDecodeError(`Unable to decode ID: Invalid ID version ${footer} (expected ${expected})`);
  // One string per id, as in Convex: the string must be exactly the encoding of its bytes — no extra
  // character, and the unused trailing bits of the last one zero (what re-encoding would check).
  const spare = s.length * 5 - buf.length * 8;
  if (encodedLen(buf.length) !== s.length || (DECODE[s.charCodeAt(s.length - 1)]! & ((1 << spare) - 1)) !== 0)
    throw new IdDecodeError(`Unable to decode ID: Invalid ID length ${s.length}`);
  return { tableNumber, internalId: buf.slice(pos, pos + INTERNAL_ID_LEN) };
}

/**
 * The id's table number, or null when the string is not an id: `decodeId`'s checks, decoded into the scratch
 * bytes (this runs on every string a table summary sees).
 */
export function idTableNumber(s: string): number | null {
  const len = s.length;
  if (len < MIN_LEN || len > MAX_LEN) return null;
  // base32, strictly (decodeId's unbase32).
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? DECODE[c]! : -1;
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (n >= MAX_BINARY_LEN) return null;
      scratch[n++] = (acc >> bits) & 0xff;
    }
  }
  // The table number (a VInt of at most 5 bytes, not 0, at most 2^32 - 1).
  let tableNumber = 0;
  let pos = 0;
  for (; ; pos++) {
    if (pos >= 5 || pos >= n) return null;
    tableNumber += (scratch[pos]! & 0x7f) * 2 ** (7 * pos);
    if ((scratch[pos]! & 0x80) === 0) break;
  }
  pos++;
  if (tableNumber === 0 || tableNumber > 0xffffffff) return null;
  if (n !== pos + INTERNAL_ID_LEN + 2) return null;
  // The footer, the one encoding (no spare character), and zero trailing bits.
  let c0 = 0;
  let c1 = 0;
  for (let i = 0; i < pos + INTERNAL_ID_LEN; i++) {
    c0 = (c0 + scratch[i]!) & 0xff;
    c1 = (c1 + c0) & 0xff;
  }
  const footer = scratch[pos + INTERNAL_ID_LEN]! | (scratch[pos + INTERNAL_ID_LEN + 1]! << 8);
  if (footer !== (((c1 << 8) | c0) ^ VERSION)) return null;
  const spare = len * 5 - n * 8;
  if (encodedLen(n) !== len || (DECODE[s.charCodeAt(len - 1)]! & ((1 << spare) - 1)) !== 0) return null;
  return tableNumber;
}
