// The search indexes' segments in a blob store (STUDY-111; STUDY-96's snapshots before them): the `search` use
// case, Convex's search bucket (`S3_STORAGE_SEARCH_BUCKET`, else `<storage>/search`). The store is made on first
// use, so a server can pass one whose S3 prefix is the engine's own setting.
import type { SearchSnapshotStore } from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";

export function searchSnapshotStore(blobs: () => BlobStore): SearchSnapshotStore {
  return {
    put: async (data) => (await blobs().put(data)).key,
    get: async (key) => {
      const stream = await blobs().get(key);
      return stream ? new Uint8Array(await new Response(stream).arrayBuffer()) : null;
    },
    delete: (key) => blobs().delete(key),
  };
}
