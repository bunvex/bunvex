// Blobs in memory, for tests.
import { type BlobStore, type ByteRange, type Listed, pumpHashing, type Written } from "./store.ts";

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly written = new Map<string, number>();

  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written> {
    const chunks: Uint8Array[] = [];
    const { size, sha256 } = await pumpHashing(body, (c) => void chunks.push(c));
    const key = crypto.randomUUID();
    this.blobs.set(key, Buffer.concat(chunks));
    this.written.set(key, Date.now());
    return { key, size, sha256 };
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const b = this.blobs.get(key);
    if (!b) return null;
    return new Blob([(range ? b.subarray(range.start, range.end + 1) : b) as Uint8Array<ArrayBuffer>]).stream();
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
    this.written.delete(key);
  }

  async *list(): AsyncIterable<Listed> {
    for (const [key, lastModified] of this.written) yield { key, lastModified };
  }
}
