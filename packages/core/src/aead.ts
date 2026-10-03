// AES-128-GCM-SIV (RFC 8452), the AEAD Convex's keybroker seals its tokens with (crates/keybroker,
// `Encryptor`): admin keys (server) and pagination cursors (cursor.ts). Node has no GCM-SIV, so it is built
// here from AES-128-ECB and POLYVAL (on 32-bit words: a cursor is sealed or opened in a few microseconds).
import { createCipheriv, timingSafeEqual } from "node:crypto";

/** AES-128-ECB over whole blocks: one cipher for all of them (the blocks are independent). */
const aesEcb = (key: Uint8Array, blocks: Uint8Array) => {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(c.update(blocks));
};
/**
 * a · b · x^-128 in POLYVAL's field (x^128 + x^127 + x^126 + x^121 + 1), on little-endian 32-bit words:
 * for each bit of b from the lowest, add a if it is set, then multiply by x^-1 (shift right; an odd value
 * first adds the polynomial, whose x^128 term becomes x^127 and the rest x^126 + x^125 + x^120).
 */
function dot(a: Uint32Array, b: Uint32Array, out: Uint32Array) {
  const [a0, a1, a2, a3] = a as unknown as [number, number, number, number];
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  let r3 = 0;
  for (let w = 0; w < 4; w++) {
    let bits = b[w]!;
    for (let k = 0; k < 32; k++) {
      if (bits & 1) {
        r0 ^= a0;
        r1 ^= a1;
        r2 ^= a2;
        r3 ^= a3;
      }
      bits >>>= 1;
      const odd = r0 & 1;
      r0 = (r0 >>> 1) | (r1 << 31);
      r1 = (r1 >>> 1) | (r2 << 31);
      r2 = (r2 >>> 1) | (r3 << 31);
      r3 >>>= 1;
      if (odd) r3 ^= 0xe1000000;
    }
  }
  out[0] = r0;
  out[1] = r1;
  out[2] = r2;
  out[3] = r3;
}
const words = (b: Uint8Array, at: number, out: Uint32Array) => {
  const dv = new DataView(b.buffer, b.byteOffset + at, 16);
  for (let i = 0; i < 4; i++) out[i] = dv.getUint32(i * 4, true);
};
/** POLYVAL(h, data) for `data` a whole number of blocks. */
function polyval(h: Uint8Array, data: Uint8Array) {
  const H = new Uint32Array(4);
  words(h, 0, H);
  const s = new Uint32Array(4);
  const x = new Uint32Array(4);
  for (let i = 0; i < data.length; i += 16) {
    words(data, i, x);
    for (let j = 0; j < 4; j++) x[j] = (x[j]! ^ s[j]!) >>> 0;
    dot(x, H, s);
  }
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint32(i * 4, s[i]!, true);
  return out;
}
const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 16) * 16);
  out.set(b);
  return out;
};
function sivKeys(key: Uint8Array, nonce: Uint8Array) {
  // The four blocks `i ‖ nonce` (i = 0…3, little-endian), encrypted at once; the first half of each.
  const blocks = new Uint8Array(64);
  const dv = new DataView(blocks.buffer);
  for (let i = 0; i < 4; i++) {
    dv.setUint32(i * 16, i, true);
    blocks.set(nonce, i * 16 + 4);
  }
  const e = aesEcb(key, blocks);
  const auth = new Uint8Array(16);
  auth.set(e.subarray(0, 8), 0);
  auth.set(e.subarray(16, 24), 8);
  const enc = new Uint8Array(16);
  enc.set(e.subarray(32, 40), 0);
  enc.set(e.subarray(48, 56), 8);
  return { auth, enc };
}
function sivTag(keys: { auth: Uint8Array; enc: Uint8Array }, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array) {
  const lengths = new Uint8Array(16);
  const dv = new DataView(lengths.buffer);
  dv.setBigUint64(0, BigInt(aad.length * 8), true);
  dv.setBigUint64(8, BigInt(pt.length * 8), true);
  const pa = padded(aad);
  const pp = padded(pt);
  const all = new Uint8Array(pa.length + pp.length + 16);
  all.set(pa, 0);
  all.set(pp, pa.length);
  all.set(lengths, pa.length + pp.length);
  const s = polyval(keys.auth, all);
  for (let i = 0; i < 12; i++) s[i]! ^= nonce[i]!;
  s[15]! &= 0x7f;
  return aesEcb(keys.enc, s);
}
function sivCtr(key: Uint8Array, tag: Uint8Array, data: Uint8Array) {
  // Every counter block (the tag with its top bit set, the low 32 bits counting up), encrypted at once.
  const n = Math.ceil(data.length / 16);
  const blocks = new Uint8Array(n * 16);
  const first = new Uint8Array(tag);
  first[15]! |= 0x80;
  const start = new DataView(first.buffer).getUint32(0, true);
  const dv = new DataView(blocks.buffer);
  for (let i = 0; i < n; i++) {
    blocks.set(first, i * 16);
    dv.setUint32(i * 16, (start + i) >>> 0, true);
  }
  const ks = aesEcb(key, blocks);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ ks[i]!;
  return out;
}

/** AES-128-GCM-SIV: the ciphertext followed by its 16-byte tag. */
export function aes128GcmSivSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  const keys = sivKeys(key, nonce);
  const tag = sivTag(keys, nonce, aad, plaintext);
  const out = new Uint8Array(plaintext.length + 16);
  out.set(sivCtr(keys.enc, tag, plaintext));
  out.set(tag, plaintext.length);
  return out;
}

/** The plaintext, or null when the tag does not match. */
export function aes128GcmSivOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array) {
  if (sealed.length < 16) return null;
  const keys = sivKeys(key, nonce);
  const tag = sealed.subarray(sealed.length - 16);
  const pt = sivCtr(keys.enc, tag, sealed.subarray(0, sealed.length - 16));
  return timingSafeEqual(sivTag(keys, nonce, aad, pt), tag) ? pt : null;
}
