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

function base32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

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

function vint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

export type DecodedId = { tableNumber: number; internalId: Uint8Array };

export class IdDecodeError extends Error {}

/** Encode a document id from its table number and 16-byte internal id. */
export function encodeId(tableNumber: number, internalId: Uint8Array): string {
  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 0xffffffff)
    throw new Error(`invalid table number ${tableNumber}`);
  if (internalId.length !== INTERNAL_ID_LEN) throw new Error("an internal id is 16 bytes");
  const head = [...vint(tableNumber), ...internalId];
  const footer = fletcher16(Uint8Array.from(head)) ^ VERSION;
  return base32(Uint8Array.from([...head, footer & 0xff, footer >> 8]));
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
  const internalId = buf.slice(pos, pos + INTERNAL_ID_LEN);
  // One string per id, as in Convex: a string whose unused trailing bits are set re-encodes differently.
  if (encodeId(tableNumber, internalId) !== s)
    throw new IdDecodeError(`Unable to decode ID: Invalid ID length ${s.length}`);
  return { tableNumber, internalId };
}

/** The id's table number, or null when the string is not an id. */
export function idTableNumber(s: string): number | null {
  try {
    return decodeId(s).tableNumber;
  } catch {
    return null;
  }
}
