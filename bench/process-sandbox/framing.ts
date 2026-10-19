// STUDY-168 prototype: the frames host and sandbox exchange. Each message is a 4-byte little-endian length and the
// message in `bun:jsc`'s serialization (structured clone: bigints, ArrayBuffers and nested values survive, as a
// bunvex value needs).
import { deserialize, serialize } from "bun:jsc";

export function frame(message: unknown): Uint8Array {
  const body = new Uint8Array(serialize(message));
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
}

/** Splits a byte stream into messages; `onMessage` is called once per complete frame, in order. */
export class FrameReader {
  private buf = new Uint8Array(0);
  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Uint8Array) {
    let buf = this.buf.byteLength === 0 ? chunk : concat(this.buf, chunk);
    while (buf.byteLength >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
      if (buf.byteLength < 4 + len) break;
      // `deserialize` takes an ArrayBuffer-backed view; copy out the frame so the stream's buffer is not retained.
      const body = buf.slice(4, 4 + len);
      buf = buf.subarray(4 + len);
      this.onMessage(deserialize(body));
    }
    this.buf = buf.byteLength === 0 ? new Uint8Array(0) : buf.slice();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
