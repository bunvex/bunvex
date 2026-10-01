// Choosing the backend as Convex's self-hosted image does (self-hosted/docker-build/run_backend.sh): S3
// when its files bucket is configured, else a local directory — `STORAGE_DIR`, else `<DATA>/storage`.
import { LocalBlobStore } from "./local.ts";
import { S3BlobStore, s3OptionsFromEnv } from "./s3.ts";
import type { BlobStore } from "./store.ts";

export function blobStoreFromEnv(env = process.env, opts: { s3Prefix?: string } = {}): BlobStore {
  const s3 = s3OptionsFromEnv(env);
  if (s3) return new S3BlobStore({ ...s3, prefix: opts.s3Prefix });
  return new LocalBlobStore(env.STORAGE_DIR ?? `${env.DATA ?? "./.data"}/storage`);
}
