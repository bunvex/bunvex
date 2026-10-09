# @bunvex/file-storage

## 0.1.0-alpha.1

### Minor Changes

- 4ac2aa2: Search and vector index segments are read from disk, memory-mapped, instead of held in memory, as Convex's: a local store's segment files are mapped in place, and an S3 store's go through a local cache (`<local storage>/search_cache`; the engine's `searchCacheDir` option). `LocalBlobStore.filePath` names a blob's file (STUDY-111).
