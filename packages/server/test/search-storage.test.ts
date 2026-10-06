// The search use case's store (STUDY-111 PR 9): over a local blob store, each segment's file is named so it is
// memory-mapped from there; over another store (S3), none is, and segments go through the local cache.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, LocalBlobStore } from "@bunvex/file-storage";
import { searchSegmentStore } from "../src/search-storage.ts";

test("a local store names each segment's file; another store names none", async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-search-store-"));
  try {
    const local = searchSegmentStore(() => new LocalBlobStore(d));
    const key = await local.put(new Uint8Array([1, 2, 3]));
    const path = local.localPath?.(key);
    expect(path).toBe(join(d, "files", `${key}.blob`));
    expect([...Bun.mmap(path!, { shared: false })]).toEqual([1, 2, 3]);
    const other = searchSegmentStore(() => ({}) as BlobStore);
    expect(other.localPath?.(key)).toBeNull();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
