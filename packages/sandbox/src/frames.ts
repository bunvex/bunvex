// The frames host and child exchange (`protocol.ts`): a 4-byte little-endian length, then that many bytes of
// UTF-8 JSON. Bun's own IPC channel is as fast (about 20 µs a round trip on this Mac, either way), but it reads and
// parses a message of any size before handing it over (a 64 MiB one went through); a frame's length comes first,
// so a reader can refuse one before reading it.

const HEADER = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A message as a frame. */
export function frame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(HEADER + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, HEADER);
  return out;
}

/** A frame whose header says more than the reader's limit; the stream cannot be trusted after it. */
export class FrameTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`a message of ${bytes} bytes, over the limit of ${limit} bytes`);
  }
}

/** A frame that is not UTF-8; the stream cannot be trusted after it. */
export class FrameEncodingError extends Error {}

/**
 * Splits a byte stream into frames' texts, in order. Chunks are kept as they arrive and joined once a frame is
 * complete, so a large frame costs one copy. A frame over `limit` throws from `push` as soon as its header is in.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** The length of the frame being read, once its header is in. */
  private expected: number | null = null;

  constructor(private readonly limit: number = 0xffff_ffff) {}

  /** The texts of the frames `chunk` completes. */
  push(chunk: Uint8Array): string[] {
    const out: string[] = [];
    if (chunk.byteLength === 0) return out;
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    for (;;) {
      if (this.expected === null) {
        if (this.buffered < HEADER) break;
        const header = this.take(HEADER);
        const bytes = new DataView(header.buffer, header.byteOffset, HEADER).getUint32(0, true);
        if (bytes > this.limit) throw new FrameTooLargeError(bytes, this.limit);
        this.expected = bytes;
      }
      if (this.buffered < this.expected) break;
      const body = this.take(this.expected);
      this.expected = null;
      try {
        out.push(decoder.decode(body));
      } catch {
        throw new FrameEncodingError("a message that is not UTF-8");
      }
    }
    return out;
  }

  /** The bytes of a frame still being read (a stream that ends mid-frame). */
  get pending(): number {
    return this.buffered;
  }

  /** The first `n` buffered bytes, removed. */
  private take(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength >= n) {
      const head = first.subarray(0, n);
      if (first.byteLength === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return head;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0]!;
      const used = Math.min(c.byteLength, n - filled);
      out.set(c.subarray(0, used), filled);
      filled += used;
      if (used === c.byteLength) this.chunks.shift();
      else this.chunks[0] = c.subarray(used);
    }
    this.buffered -= n;
    return out;
  }
}
