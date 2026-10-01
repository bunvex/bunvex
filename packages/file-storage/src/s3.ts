// Blobs in an S3-compatible bucket, through Bun's built-in S3Client (multipart uploads, ranged reads).
// Configured with Convex's variable names (crates/aws_s3, crates/aws_utils): S3_STORAGE_FILES_BUCKET,
// AWS_REGION, S3_ENDPOINT_URL, AWS_S3_FORCE_PATH_STYLE, and the AWS credentials. Keys are
// `<prefix><uuid>`: the deployment keeps its prefix (Convex's `<instance>-<uuid>/`) and passes it in.
import { S3Client } from "bun";
import { type BlobStore, type ByteRange, type Listed, pumpHashing, type Written } from "./store.ts";

export type S3Options = {
  bucket: string;
  region?: string;
  endpoint?: string;
  /** Path-style URLs (`endpoint/bucket/key`), which most self-hosted S3-compatible stores need. */
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Prepended to every key (the deployment's `<instance>-<uuid>/`). */
  prefix?: string;
  /** Multipart part size in bytes (Convex: parts of 5 MiB and more). Default 8 MiB. */
  partSize?: number;
};

/** The S3 settings from Convex's variables, or null when no files bucket is configured. */
export function s3OptionsFromEnv(env = process.env): Omit<S3Options, "prefix"> | null {
  const bucket = env.S3_STORAGE_FILES_BUCKET;
  if (!bucket) return null;
  return {
    bucket,
    region: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT_URL,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE === "true",
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly partSize: number;

  constructor(o: S3Options) {
    this.client = new S3Client({
      bucket: o.bucket,
      region: o.region,
      endpoint: o.endpoint,
      virtualHostedStyle: !o.forcePathStyle && o.endpoint === undefined,
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      sessionToken: o.sessionToken,
    });
    this.prefix = o.prefix ?? "";
    this.partSize = o.partSize ?? 8 << 20;
  }

  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written> {
    const key = crypto.randomUUID();
    const file = this.client.file(this.prefix + key);
    const writer = file.writer({ partSize: this.partSize, retry: 3 });
    try {
      const { size, sha256 } = await pumpHashing(body, (chunk) => writer.write(chunk));
      await writer.end();
      return { key, size, sha256 };
    } catch (e) {
      await Promise.resolve(writer.end()).catch(() => {});
      await file.delete().catch(() => {});
      throw e;
    }
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.client.file(this.prefix + key);
    if (!(await file.exists())) return null;
    return (range ? file.slice(range.start, range.end + 1) : file).stream();
  }

  async delete(key: string): Promise<void> {
    await this.client.file(this.prefix + key).delete();
  }

  async *list(): AsyncIterable<Listed> {
    let token: string | undefined;
    for (;;) {
      const page = await this.client.list({ prefix: this.prefix, continuationToken: token });
      for (const o of page.contents ?? [])
        if (o.key)
          yield {
            key: o.key.slice(this.prefix.length),
            lastModified: o.lastModified ? Date.parse(String(o.lastModified)) : 0,
          };
      if (!page.isTruncated || !page.nextContinuationToken) return;
      token = page.nextContinuationToken;
    }
  }
}
