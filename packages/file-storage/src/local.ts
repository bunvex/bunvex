// Blobs in a directory, as Convex's local storage: `<dir>/files/<key>.blob`, written in place and synced
// before the write returns (Convex's `complete()` calls `sync_all`). A failed write removes what it wrote.
import { mkdirSync } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BlobStore, type ByteRange, pumpHashing, type Written } from "./store.ts";

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LocalBlobStore implements BlobStore {
  private readonly files: string;

  constructor(dir: string) {
    this.files = join(dir, "files");
    mkdirSync(this.files, { recursive: true });
  }

  private path(key: string) {
    if (!KEY.test(key)) throw new Error(`not a blob key: ${key}`);
    return join(this.files, `${key}.blob`);
  }

  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written> {
    const key = crypto.randomUUID();
    const path = this.path(key);
    const handle = await open(path, "wx");
    try {
      const { size, sha256 } = await pumpHashing(body, (chunk) => handle.write(chunk));
      await handle.sync();
      await handle.close();
      return { key, size, sha256 };
    } catch (e) {
      await handle.close().catch(() => {});
      await rm(path, { force: true });
      throw e;
    }
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    if (!KEY.test(key)) return null;
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) return null;
    return (range ? file.slice(range.start, range.end + 1) : file).stream();
  }

  async delete(key: string): Promise<void> {
    if (!KEY.test(key)) return;
    await rm(this.path(key), { force: true });
  }

  async *keys(): AsyncIterable<string> {
    for (const name of await readdir(this.files)) {
      const key = name.endsWith(".blob") ? name.slice(0, -5) : "";
      if (KEY.test(key)) yield key;
    }
  }
}
