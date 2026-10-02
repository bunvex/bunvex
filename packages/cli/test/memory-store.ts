// Test helper.
/** A blob store in memory (the CLI's package does not depend on @bunvex/file-storage). */
export function memoryStore() {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(body: Uint8Array | Blob | ReadableStream<Uint8Array>) {
      const bytes = new Uint8Array(await new Response(body as never).arrayBuffer());
      const key = crypto.randomUUID();
      blobs.set(key, bytes);
      return { key, size: bytes.length, sha256: new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest()) };
    },
    async get(key: string) {
      const b = blobs.get(key);
      return b ? new Blob([b as Uint8Array<ArrayBuffer>]).stream() : null;
    },
    async delete(key: string) {
      blobs.delete(key);
    },
    async *list() {
      for (const key of blobs.keys()) yield { key, lastModified: 0 };
    },
  };
}
