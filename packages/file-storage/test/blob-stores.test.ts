// Every backend against the conformance suite. S3 runs when a bucket is configured for tests
// (S3_TEST_BUCKET, with S3_ENDPOINT_URL and credentials; CI uses SeaweedFS).
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBlobStoreConformance } from "../src/conformance.ts";
import { LocalBlobStore, MemoryBlobStore, S3BlobStore } from "../src/index.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describeBlobStoreConformance("memory", () => new MemoryBlobStore());
describeBlobStoreConformance(
  "local",
  () => {
    const d = mkdtempSync(join(tmpdir(), "bunvex-blobs-"));
    dirs.push(d);
    return new LocalBlobStore(d);
  },
  { large: true },
);

const bucket = process.env.S3_TEST_BUCKET;
if (bucket)
  describeBlobStoreConformance(
    "s3",
    () =>
      new S3BlobStore({
        bucket,
        region: process.env.AWS_REGION ?? "us-east-1",
        endpoint: process.env.S3_ENDPOINT_URL,
        forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        prefix: `test-${crypto.randomUUID()}/`,
        partSize: 5 << 20,
      }),
    { large: true },
  );
