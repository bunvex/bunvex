// The frames host and child exchange (`protocol.ts`): a 4-byte little-endian length, then that many bytes of
// UTF-8 JSON. Bun's own IPC channel is as fast (about 20 µs a round trip on this Mac, either way), but it reads and
// parses a message of any size before handing it over (a 64 MiB one went through); a frame's length comes first,
// so a reader can refuse one before reading it.
//
// A **chunk** of a byte stream (STUDY-171 §12: a fetch's body, a stored file) is a frame of its own, with no JSON and
// no base64 (STUDY-168 §14.1): its length's top bit set, then the stream's id (4 bytes, little-endian), then the bytes.
// A message's length never reaches that bit (`MAX_MESSAGE_BYTES` is far below 2 GiB).

const HEADER = 4;
const CHUNK_FLAG = 0x8000_0000;
const STREAM_ID = 4;

/** A chunk of byte stream `s`, as the reader hands it over (a view of the bytes read, not a copy when it can be). */
export type Chunk = { s: number; bytes: Uint8Array };
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

/** A chunk of byte stream `s` as a frame. */
export function chunkFrame(s: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + STREAM_ID + bytes.byteLength);
  out.set(chunkHeader(s, bytes.byteLength), 0);
  out.set(bytes, HEADER + STREAM_ID);
  return out;
}

/** What comes before a chunk's `n` bytes in its frame (a writer sends the bytes after it, not copied into a frame). */
export function chunkHeader(s: number, n: number): Uint8Array {
  const out = new Uint8Array(HEADER + STREAM_ID);
  const view = new DataView(out.buffer);
  view.setUint32(0, (CHUNK_FLAG | (STREAM_ID + n)) >>> 0, true);
  view.setUint32(HEADER, s, true);
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
 * Splits a byte stream into frames, in order: a message's text, or a stream's chunk. What arrives is kept as it
 * arrives and joined once a message is complete, so a large message costs one copy (none when it arrived in one
 * piece). A chunk's bytes are never joined: each piece of it is handed over as it arrives, a view of what was read
 * (so one chunk frame may come out as several `Chunk`s of the same stream). A frame over `limit` throws from `push`
 * as soon as its header is in.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** The length of the frame being read, once its header is in. */
  private expected: number | null = null;
  /** Whether the frame being read is a chunk. */
  private chunk = false;
  /** The chunk frame whose bytes are being handed over: its stream, and how many of its bytes are still to come. */
  private streaming: { s: number; left: number } | null = null;

  /** `limit`: the largest message; `chunkLimit`: the most bytes one chunk may carry. */
  constructor(
    private readonly limit: number = 0xffff_ffff,
    private readonly chunkLimit: number = 0x7fff_ffff,
  ) {}

  /** The frames `chunk` completes: each message's text, each stream chunk. */
  push(chunk: Uint8Array): (string | Chunk)[] {
    const out: (string | Chunk)[] = [];
    if (chunk.byteLength === 0) return out;
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    for (;;) {
      if (this.streaming !== null) {
        const st = this.streaming;
        while (st.left > 0 && this.buffered > 0) {
          const piece = this.takeSome(st.left);
          st.left -= piece.byteLength;
          out.push({ s: st.s, bytes: piece });
        }
        if (st.left > 0) break;
        this.streaming = null;
        continue;
      }
      if (this.expected === null) {
        if (this.buffered < HEADER) break;
        const header = this.take(HEADER);
        const word = new DataView(header.buffer, header.byteOffset, HEADER).getUint32(0, true);
        this.chunk = (word & CHUNK_FLAG) !== 0;
        const bytes = word & ~CHUNK_FLAG;
        if (bytes > this.limit) throw new FrameTooLargeError(bytes, this.limit);
        if (this.chunk && bytes < STREAM_ID) throw new FrameEncodingError("a chunk without its stream");
        if (this.chunk && bytes - STREAM_ID > this.chunkLimit)
          throw new FrameTooLargeError(bytes - STREAM_ID, this.chunkLimit);
        this.expected = bytes;
      }
      if (this.chunk) {
        // Its stream's id, then its bytes as they come.
        if (this.buffered < STREAM_ID) break;
        const id = this.take(STREAM_ID);
        this.streaming = {
          s: new DataView(id.buffer, id.byteOffset, STREAM_ID).getUint32(0, true),
          left: this.expected - STREAM_ID,
        };
        this.expected = null;
        continue;
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
    return this.buffered + (this.streaming?.left ?? 0);
  }

  /** Up to `n` of the first buffered bytes, removed, as they were read (no copy). */
  private takeSome(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength <= n) {
      this.chunks.shift();
      this.buffered -= first.byteLength;
      return first;
    }
    this.chunks[0] = first.subarray(n);
    this.buffered -= n;
    return first.subarray(0, n);
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
