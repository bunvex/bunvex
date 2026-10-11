// Every backend against the conformance suite. S3 runs when a bucket is configured for tests
// (S3_TEST_BUCKET, with S3_ENDPOINT_URL, credentials and the AWS_S3_* flags; CI uses RustFS).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";
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
        // CI runs it with Convex's defaults (SSE-S3, CRC32 checksums) and again with both disabled.
        disableSse: process.env.AWS_S3_DISABLE_SSE === "true",
        disableChecksums: process.env.AWS_S3_DISABLE_CHECKSUMS === "true",
        prefix: `test-${crypto.randomUUID()}/`,
      }),
    { large: true },
  );

// Against a real store: an object written with Convex's defaults is stored encrypted (SSE-S3), and with
// AWS_S3_DISABLE_SSE it is not (STUDY-140).
if (bucket)
  test("s3: SSE-S3 on the stored object unless AWS_S3_DISABLE_SSE", async () => {
    const opts = {
      bucket,
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT_URL,
      forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
    const disableSse = process.env.AWS_S3_DISABLE_SSE === "true";
    const prefix = `test-${crypto.randomUUID()}/`;
    const w = await new S3BlobStore({ ...opts, prefix, disableSse }).put(new TextEncoder().encode("secret"));
    const head = await fetch(new S3Client(opts).presign(prefix + w.key, { method: "HEAD" }), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-amz-server-side-encryption")).toBe(disableSse ? null : "AES256");
  });

// Against a real store: a body that ends exactly on a part ends with Convex's empty last part (STUDY-140), which
// the store must accept.
if (bucket)
  test("s3: a body of exactly one 5 MiB part, then the empty last part", async () => {
    const store = new S3BlobStore({
      bucket,
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT_URL,
      forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      disableSse: process.env.AWS_S3_DISABLE_SSE === "true",
      disableChecksums: process.env.AWS_S3_DISABLE_CHECKSUMS === "true",
      prefix: `test-${crypto.randomUUID()}/`,
    });
    const bytes = new Uint8Array(5 << 20).map((_, i) => i % 253);
    const w = await store.put(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    );
    expect(w.size).toBe(5 << 20);
    const back = new Uint8Array(await new Response(await store.get(w.key)).arrayBuffer());
    expect(back.length).toBe(bytes.length);
    expect(Buffer.compare(back, bytes)).toBe(0);
  });
