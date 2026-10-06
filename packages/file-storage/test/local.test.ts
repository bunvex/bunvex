// The local layout, as Convex's: `<dir>/files/<key>.blob`; and choosing the backend from the environment.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobStoreFromEnv, LocalBlobStore, S3BlobStore } from "../src/index.ts";

test("blobs live at <dir>/files/<key>.blob", async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-blobs-"));
  try {
    const w = await new LocalBlobStore(d).put(new Uint8Array([1, 2, 3]));
    expect(existsSync(join(d, "files", `${w.key}.blob`))).toBe(true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("filePath names the file a blob is kept in, for readers that map it; null for a non-key", async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-blobs-"));
  try {
    const store = new LocalBlobStore(d);
    const w = await store.put(new Uint8Array([1, 2, 3]));
    expect(store.filePath(w.key)).toBe(join(d, "files", `${w.key}.blob`));
    expect(store.filePath("../escape")).toBeNull();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the environment picks S3 when its files bucket is set, else STORAGE_DIR, else <DATA>/storage", () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-env-"));
  try {
    expect(blobStoreFromEnv({ S3_STORAGE_FILES_BUCKET: "b", AWS_REGION: "us-east-1" })).toBeInstanceOf(S3BlobStore);
    expect(blobStoreFromEnv({ STORAGE_DIR: join(d, "s") })).toBeInstanceOf(LocalBlobStore);
    expect(existsSync(join(d, "s", "files"))).toBe(true);
    blobStoreFromEnv({ DATA: join(d, "data") });
    expect(existsSync(join(d, "data", "storage", "files"))).toBe(true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
