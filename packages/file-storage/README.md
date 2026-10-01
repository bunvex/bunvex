# @bunvex/file-storage

The bytes behind `ctx.storage` (STUDY-32). The metadata (`_storage`) lives in the engine; a backend stores
blobs under keys it makes up, hashing (SHA-256) and counting them as they stream.

- `LocalBlobStore(dir)`: `<dir>/files/<key>.blob`, as Convex lays out its local storage; synced before a
  write returns.
- `S3BlobStore(options)`: an S3-compatible bucket through Bun's built-in `S3Client` (multipart uploads,
  ranged reads). `s3OptionsFromEnv()` reads Convex's variables: `S3_STORAGE_FILES_BUCKET`, `AWS_REGION`,
  `S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`.
- `MemoryBlobStore()`: for tests.
- `blobStoreFromEnv()`: S3 when its files bucket is set, else `STORAGE_DIR`, else `<DATA>/storage`, as
  Convex's self-hosted image.

`@bunvex/file-storage/conformance` exports `describeBlobStoreConformance(name, make)`, the suite every
backend passes. CI runs it on S3 against RustFS.
