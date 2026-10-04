// Base64 and UTF-8 lengths for every runtime. Under Bun and Node, Node's `Buffer` (native, as before); in a
// browser, which has no `Buffer`, the web's `btoa` / `atob` and a counted UTF-8 length. The client and the
// values it decodes run in browsers (a page's first message decodes a timestamp).

type NodeBuffer = {
  from(
    data: Uint8Array | ArrayBuffer | string,
    byteOffsetOrEncoding?: number | string,
    length?: number,
  ): Uint8Array & {
    toString(encoding: string): string;
  };
  byteLength(s: string, encoding: string): number;
  compare(a: Uint8Array, b: Uint8Array): number;
};
const NodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** The bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer)
    return NodeBuffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  // In chunks: `String.fromCharCode(...)` takes its bytes as arguments, which engines cap.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 (standard or URL-safe, padding optional, as Node's decoder takes it) to bytes. */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(s, "base64"));
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A string's length in UTF-8 bytes (a lone surrogate counts 3, as its U+FFFD replacement). */
export function utf8Length(s: string): number {
  if (NodeBuffer) return NodeBuffer.byteLength(s, "utf8");
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

const encoder = new TextEncoder();
/** Two strings in the order of their UTF-8 bytes. */
export function compareUtf8(a: string, b: string): number {
  if (NodeBuffer) return NodeBuffer.compare(NodeBuffer.from(a), NodeBuffer.from(b));
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
