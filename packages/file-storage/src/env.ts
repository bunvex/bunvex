// Choosing the backend as Convex's self-hosted image does (self-hosted/docker-build/run_backend.sh): S3
// when the use case's bucket is configured, else a local directory — `STORAGE_DIR`, else `<DATA>/storage`
// (each use case in its own: user files, and pushed code's `modules`, STUDY-35).
import { LocalBlobStore } from "./local.ts";
import { S3BlobStore, s3OptionsFromEnv } from "./s3.ts";
import type { BlobStore } from "./store.ts";

export function blobStoreFromEnv(
  env = process.env,
  opts: { s3Prefix?: string | (() => Promise<string>); useCase?: "files" | "modules" } = {},
): BlobStore {
  const useCase = opts.useCase ?? "files";
  const s3 = s3OptionsFromEnv(env, useCase);
  if (s3) return new S3BlobStore({ ...s3, prefix: opts.s3Prefix });
  return new LocalBlobStore(env.STORAGE_DIR ?? `${env.DATA ?? "./.data"}/storage`, useCase);
}
