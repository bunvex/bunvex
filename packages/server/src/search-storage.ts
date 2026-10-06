// The search and vector indexes' segments in a blob store (STUDY-111): the `search` use case, Convex's search
// bucket (`S3_STORAGE_SEARCH_BUCKET`, else `<storage>/search`). The store is made on first use, so a server can
// pass one whose S3 prefix is the engine's own setting.
import type { SearchSegmentStore } from "@bunvex/core";
import { type BlobStore, LocalBlobStore } from "@bunvex/file-storage";

export function searchSegmentStore(blobs: () => BlobStore): SearchSegmentStore {
  return {
    put: async (data) => (await blobs().put(data)).key,
    get: async (key) => {
      const stream = await blobs().get(key);
      return stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : null;
    },
    delete: (key) => blobs().delete(key),
    // A local store keeps each blob as a file: segments are mapped from it (STUDY-111 PR 9).
    localPath: (key) => {
      const store = blobs();
      return store instanceof LocalBlobStore ? store.filePath(key) : null;
    },
  };
}
