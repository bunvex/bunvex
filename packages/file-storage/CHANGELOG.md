# @bunvex/file-storage

## 0.1.0-alpha.2

### Minor Changes

- d4ef462: S3 uploads ask for server-side encryption (`x-amz-server-side-encryption: AES256`) and CRC32 part checksums, as Convex's, and `AWS_S3_DISABLE_SSE` / `AWS_S3_DISABLE_CHECKSUMS` (`true`) turn them off for S3-compatible stores that refuse them (`disableSse` / `disableChecksums` in `S3Options`). Every write is now a signed multipart upload, as Convex's, cut into parts as Convex's (5 MiB doubling up to `STORAGE_MAX_INTERMEDIATE_PART_SIZE`, 200 MiB; the remaining buffer, even empty, as the last part) with up to 8 in flight (STUDY-140). `S3Options.partSize` is replaced by `minPartSize` / `maxPartSize`.

## 0.1.0-alpha.1

### Minor Changes

- 4ac2aa2: Search and vector index segments are read from disk, memory-mapped, instead of held in memory, as Convex's: a local store's segment files are mapped in place, and an S3 store's go through a local cache (`<local storage>/search_cache`; the engine's `searchCacheDir` option). `LocalBlobStore.filePath` names a blob's file (STUDY-111).
