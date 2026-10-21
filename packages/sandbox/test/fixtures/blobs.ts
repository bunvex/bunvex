// Files in memory, for the parity tests' servers.
/** Files in memory (the server's `BlobStore`; this package does not depend on `@bunvex/file-storage`). */
export class TestBlobs {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array) {
    const bytes = new Uint8Array(await new Response(body as Blob).arrayBuffer());
    const key = crypto.randomUUID();
    this.blobs.set(key, bytes);
    return {
      key,
      size: bytes.byteLength,
      sha256: new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest()),
    };
  }
  async get(key: string, range?: { start: number; end: number }) {
    const b = this.blobs.get(key);
    if (!b) return null;
    return new Blob([(range ? b.subarray(range.start, range.end + 1) : b) as Uint8Array<ArrayBuffer>]).stream();
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  async *list() {
    for (const key of this.blobs.keys()) yield { key, lastModified: 0 };
  }
}
