// The interface every blob backend implements.

/** What a write stored: its new key, its size and its SHA-256 (raw bytes). */
export type Written = { key: string; size: number; sha256: Uint8Array };

/** A byte range, both ends inclusive (as HTTP's `bytes=start-end`). */
export type ByteRange = { start: number; end: number };

export interface BlobStore {
  /** Store `body` under a new key (a UUIDv4), hashing and counting it as it streams. A failed write leaves nothing. */
  put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written>;
  /** The blob's bytes (or one range of them), or null when there is no such key. */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  /** Remove a blob; a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Every key, for sweeping blobs no metadata points to. */
  keys(): AsyncIterable<string>;
}

/** The body as a stream of bytes. */
export function streamOf(body: ReadableStream<Uint8Array> | Blob | Uint8Array): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  if (body instanceof Blob) return body.stream();
  return new Blob([body]).stream();
}

/** Feed each chunk to `write`, hashing and counting as it goes. */
export async function pumpHashing(
  body: ReadableStream<Uint8Array> | Blob | Uint8Array,
  write: (chunk: Uint8Array) => Promise<unknown> | unknown,
): Promise<{ size: number; sha256: Uint8Array }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  const reader = streamOf(body).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    size += value.byteLength;
    await write(value);
  }
  return { size, sha256: new Uint8Array(hasher.digest()) };
}
