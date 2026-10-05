// The `Base64` namespace of Convex's values package (values/base64.ts, base64-js): the same results and
// errors, written for bunvex. Decoding takes standard and URL-safe characters; the length must be a multiple
// of 4 ("Invalid string. Length must be a multiple of 4"); anything after the first `=` is ignored, and a
// character outside the alphabet reads as 0, as base64-js does.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SIXTETS = new Map<number, number>();
for (let i = 0; i < ALPHABET.length; i++) SIXTETS.set(ALPHABET.charCodeAt(i), i);
SIXTETS.set("-".charCodeAt(0), 62);
SIXTETS.set("_".charCodeAt(0), 63);

const sixtet = (s: string, i: number) => SIXTETS.get(s.charCodeAt(i)) ?? 0;

/** The string's length before its padding, and how many padding characters that leaves to a quad. */
function lengths(b64: string): [number, number] {
  if (b64.length % 4 > 0) throw new Error("Invalid string. Length must be a multiple of 4");
  const pad = b64.indexOf("=");
  const valid = pad === -1 ? b64.length : pad;
  return [valid, valid === b64.length ? 0 : 4 - (valid % 4)];
}

/** How many bytes `b64` decodes to. */
export function byteLength(b64: string): number {
  const [valid, padding] = lengths(b64);
  return ((valid + padding) * 3) / 4 - padding;
}

/** `b64` (standard or URL-safe) to bytes. */
export function toByteArray(b64: string): Uint8Array {
  const [valid, padding] = lengths(b64);
  const out = new Uint8Array(((valid + padding) * 3) / 4 - padding);
  const whole = padding > 0 ? valid - 4 : valid;
  let o = 0;
  let i = 0;
  for (; i < whole; i += 4) {
    const n = (sixtet(b64, i) << 18) | (sixtet(b64, i + 1) << 12) | (sixtet(b64, i + 2) << 6) | sixtet(b64, i + 3);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (padding === 2) {
    out[o++] = ((sixtet(b64, i) << 2) | (sixtet(b64, i + 1) >> 4)) & 0xff;
  } else if (padding === 1) {
    const n = (sixtet(b64, i) << 10) | (sixtet(b64, i + 1) << 4) | (sixtet(b64, i + 2) >> 2);
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  return out;
}

/** Bytes to standard base64, padded. */
export function fromByteArray(bytes: Uint8Array): string {
  let out = "";
  const rest = bytes.length % 3;
  const whole = bytes.length - rest;
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  if (rest === 1) {
    const n = bytes[whole]!;
    out += `${ALPHABET[n >> 2]}${ALPHABET[(n << 4) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[whole]! << 8) | bytes[whole + 1]!;
    out += `${ALPHABET[n >> 10]}${ALPHABET[(n >> 4) & 63]}${ALPHABET[(n << 2) & 63]}=`;
  }
  return out;
}

/** Bytes to URL-safe base64 without padding. */
export function fromByteArrayUrlSafeNoPadding(bytes: Uint8Array): string {
  return fromByteArray(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
