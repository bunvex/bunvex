// The conformance suite every blob backend passes (`@bunvex/file-storage/conformance`), in the spirit of
// PERSIST-01's: writes hash and count while streaming, reads (whole or a range) give the bytes back,
// missing keys are null, deletes are idempotent, failed writes leave nothing, and keys lists what is stored.
import { describe, expect, test } from "bun:test";
import type { BlobStore } from "./store.ts";

const sha256 = (b: Uint8Array) => new Uint8Array(new Bun.CryptoHasher("sha256").update(b).digest());
const read = async (s: ReadableStream<Uint8Array> | null) =>
  s ? new Uint8Array(await new Response(s).arrayBuffer()) : null;
const all = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const k of it) out.push(k);
  return out;
};

export function describeBlobStoreConformance(
  name: string,
  make: () => Promise<BlobStore> | BlobStore,
  opts: { large?: boolean } = {},
) {
  describe(`blob store conformance: ${name}`, () => {
    test("a write gives a fresh key, the size and the SHA-256; a read gives the bytes back", async () => {
      const store = await make();
      const bytes = new TextEncoder().encode("hello, files");
      const w = await store.put(bytes);
      expect(w.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(w.size).toBe(bytes.length);
      expect(w.sha256).toEqual(sha256(bytes));
      expect(await read(await store.get(w.key))).toEqual(bytes);
      expect((await store.put(bytes)).key).not.toBe(w.key);
    });

    test("streams, Blobs and an empty body", async () => {
      const store = await make();
      const chunks = ["a", "bc", "def"].map((s) => new TextEncoder().encode(s));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      });
      const w = await store.put(stream);
      expect([w.size, new TextDecoder().decode((await read(await store.get(w.key)))!)]).toEqual([6, "abcdef"]);
      const b = await store.put(new Blob(["blob!"]));
      expect(new TextDecoder().decode((await read(await store.get(b.key)))!)).toBe("blob!");
      const empty = await store.put(new Uint8Array());
      expect([empty.size, (await read(await store.get(empty.key)))!.length]).toEqual([0, 0]);
      expect(empty.sha256).toEqual(sha256(new Uint8Array()));
    });

    test("a range, both ends inclusive", async () => {
      const store = await make();
      const bytes = new TextEncoder().encode("0123456789");
      const w = await store.put(bytes);
      expect(new TextDecoder().decode((await read(await store.get(w.key, { start: 2, end: 5 })))!)).toBe("2345");
      expect(new TextDecoder().decode((await read(await store.get(w.key, { start: 9, end: 9 })))!)).toBe("9");
    });

    test("a missing key reads as null; delete is idempotent; keys lists what is stored", async () => {
      const store = await make();
      expect(await store.get(crypto.randomUUID())).toBeNull();
      const a = await store.put(new Uint8Array([1]));
      const b = await store.put(new Uint8Array([2]));
      const keys = await all(store.keys());
      expect(keys).toContain(a.key);
      expect(keys).toContain(b.key);
      await store.delete(a.key);
      await store.delete(a.key);
      expect(await store.get(a.key)).toBeNull();
      expect(await all(store.keys())).not.toContain(a.key);
      await store.delete(crypto.randomUUID());
    });

    test("a write whose body fails leaves no blob", async () => {
      const store = await make();
      const before = new Set(await all(store.keys()));
      const failing = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1024));
          c.error(new Error("client went away"));
        },
      });
      expect(await store.put(failing).catch((e: Error) => e.message)).toBe("client went away");
      expect((await all(store.keys())).filter((k) => !before.has(k))).toEqual([]);
    });

    if (opts.large)
      test("a large body (above a multipart part) streams through", async () => {
        const store = await make();
        const mib = new Uint8Array(1 << 20).map((_, i) => i % 251);
        const hasher = new Bun.CryptoHasher("sha256");
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (i++ === 20) return c.close();
            hasher.update(mib);
            c.enqueue(mib);
          },
        });
        const w = await store.put(body);
        expect(w.size).toBe(20 << 20);
        expect(w.sha256).toEqual(new Uint8Array(hasher.digest()));
        const tail = await read(await store.get(w.key, { start: (20 << 20) - 3, end: (20 << 20) - 1 }));
        expect(tail).toEqual(mib.subarray((1 << 20) - 3));
      });
  });
}
