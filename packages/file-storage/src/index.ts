// Package @bunvex/file-storage — the bytes behind ctx.storage (STUDY-32 §3.1). The metadata (`_storage`)
// lives in the engine; a backend only stores blobs under keys it makes up:
// - `local`: a directory, `<dir>/files/<key>.blob`, as Convex lays out its local storage;
// - `s3`: an S3-compatible bucket through Bun's S3Client, configured with Convex's variable names;
// - `memory`: for tests.
// Every write hashes (SHA-256) and counts the bytes as they stream, as Convex's `upload_file` does.

export { blobStoreFromEnv } from "./env.ts";
export { LocalBlobStore } from "./local.ts";
export { MemoryBlobStore } from "./memory.ts";
export { S3BlobStore, type S3Options, s3OptionsFromEnv } from "./s3.ts";
export type { BlobStore, ByteRange, Written } from "./store.ts";
