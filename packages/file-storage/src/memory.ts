// Blobs in memory, for tests.
import { type BlobStore, type ByteRange, pumpHashing, type Written } from "./store.ts";

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written> {
    const chunks: Uint8Array[] = [];
    const { size, sha256 } = await pumpHashing(body, (c) => void chunks.push(c));
    const key = crypto.randomUUID();
    this.blobs.set(key, Buffer.concat(chunks));
    return { key, size, sha256 };
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const b = this.blobs.get(key);
    if (!b) return null;
    return new Blob([range ? b.subarray(range.start, range.end + 1) : b]).stream();
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async *keys(): AsyncIterable<string> {
    yield* [...this.blobs.keys()];
  }
}
