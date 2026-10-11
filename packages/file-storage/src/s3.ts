// Blobs in an S3-compatible bucket. Configured with Convex's variable names (crates/aws_s3, crates/aws_utils):
// S3_STORAGE_FILES_BUCKET, AWS_REGION, S3_ENDPOINT_URL, AWS_S3_FORCE_PATH_STYLE, AWS_S3_DISABLE_SSE,
// AWS_S3_DISABLE_CHECKSUMS, and the AWS credentials. Keys are `<prefix><uuid>`: the deployment keeps its prefix
// (Convex's `<instance>-<uuid>/`) and passes it in.
//
// Writes are multipart uploads signed here, as Convex's (every write, even a small one, is one: STUDY-140): the
// upload asks for SSE-S3 (`AES256`) and CRC32 part checksums unless AWS_S3_DISABLE_SSE / AWS_S3_DISABLE_CHECKSUMS
// say otherwise, which Bun's S3Client cannot send. Reads, deletes and listings go through Bun's S3Client.
import { S3Client } from "bun";
import { type Credentials, sha256Hex, signRequest, uriEncode } from "./sigv4.ts";
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
  /** Prepended to every key (the deployment's `<instance>-<uuid>/`); may be read from the database first. */
  prefix?: string | (() => Promise<string>);
  /** Multipart part size in bytes (Convex: parts of 5 MiB and more). Default 8 MiB. */
  partSize?: number;
  /** No `x-amz-server-side-encryption: AES256` on uploads (Convex's AWS_S3_DISABLE_SSE), for stores without SSE-S3. */
  disableSse?: boolean;
  /**
   * No CRC32 part checksums asked for, expected back or sent with the completion (Convex's
   * AWS_S3_DISABLE_CHECKSUMS). Each part still carries its CRC32, as the AWS SDK sends one by default.
   */
  disableChecksums?: boolean;
};

/** Convex parses these flags as Rust's `bool`: exactly `true` or `false`; anything else is the default (off). */
const flag = (v: string | undefined) => v === "true";

/**
 * The S3 settings from Convex's variables, or null when the use case's bucket is not configured: one bucket
 * per use case, `S3_STORAGE_<USE CASE>_BUCKET` (`FILES`, `MODULES`), as Convex's `aws_s3`.
 */
export function s3OptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  useCase = "files",
): Omit<S3Options, "prefix"> | null {
  const bucket = env[`S3_STORAGE_${useCase.toUpperCase()}_BUCKET`];
  if (!bucket) return null;
  return {
    bucket,
    region: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT_URL,
    forcePathStyle: flag(env.AWS_S3_FORCE_PATH_STYLE),
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    disableSse: flag(env.AWS_S3_DISABLE_SSE),
    disableChecksums: flag(env.AWS_S3_DISABLE_CHECKSUMS),
  };
}

type Part = { partNumber: number; etag: string; checksum: string | null };

/** The base64 big-endian CRC32 of `data`, as `x-amz-checksum-crc32` carries it. */
function crc32Base64(data: Uint8Array): string {
  const v = Bun.hash.crc32(data);
  return Buffer.from([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]).toString("base64");
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replaceAll('"', "&quot;");
const xmlText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

/** An S3 error response as an Error: the operation, the status, and S3's code and message. */
function s3Error(op: string, status: number, xml: string): Error {
  const code = xmlText(xml, "Code") ?? "";
  const message = xmlText(xml, "Message") ?? "";
  return new Error(`S3 ${op} failed (${status})${code ? `: ${code}` : ""}${message ? `: ${message}` : ""}`);
}

const MAX_PARTS_IN_FLIGHT = 8; // Convex's MAXIMUM_PARALLEL_UPLOADS (crates/storage/src/lib.rs)
const ATTEMPTS = 3; // the AWS SDK's standard retry mode, which Convex's client uses

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly prefixOf: () => Promise<string>;
  private readonly partSize: number;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string | undefined;
  private readonly pathStyle: boolean;
  private readonly creds: () => Credentials;
  private readonly sse: boolean;
  private readonly checksums: boolean;

  constructor(o: S3Options) {
    // Resolved once, as Bun's S3Client resolves them, so its reads and these writes reach the same bucket.
    const env = process.env;
    this.bucket = o.bucket;
    this.region = o.region ?? env.S3_REGION ?? env.AWS_REGION ?? "us-east-1";
    this.endpoint = o.endpoint ?? env.S3_ENDPOINT ?? env.AWS_ENDPOINT;
    this.pathStyle = !!o.forcePathStyle || this.endpoint !== undefined;
    this.creds = () => ({
      accessKeyId: o.accessKeyId ?? env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: o.secretAccessKey ?? env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? "",
      sessionToken: o.sessionToken ?? env.S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN,
    });
    this.sse = !o.disableSse;
    this.checksums = !o.disableChecksums;
    this.client = new S3Client({
      bucket: o.bucket,
      region: this.region,
      endpoint: this.endpoint,
      virtualHostedStyle: !this.pathStyle,
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      sessionToken: o.sessionToken,
    });
    const p = o.prefix ?? "";
    let resolved: Promise<string> | null = null;
    this.prefixOf = () => {
      if (resolved === null) resolved = typeof p === "string" ? Promise.resolve(p) : p();
      return resolved;
    };
    this.partSize = o.partSize ?? 8 << 20;
  }

  async put(body: ReadableStream<Uint8Array> | Blob | Uint8Array): Promise<Written> {
    const key = crypto.randomUUID();
    const objectKey = (await this.prefixOf()) + key;
    const uploadId = await this.createMultipartUpload(objectKey);
    // Up to MAX_PARTS_IN_FLIGHT parts upload at once while the body keeps streaming, as Convex's
    // `try_write_parallel` (MAXIMUM_PARALLEL_UPLOADS); the completion lists them by part number.
    const inFlight: Promise<Part>[] = [];
    let settled = 0;
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    const flush = async () => {
      const data = Buffer.concat(buffered, bufferedBytes);
      buffered = [];
      bufferedBytes = 0;
      const part = this.uploadPart(objectKey, uploadId, inFlight.length + 1, data);
      part.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
      inFlight.push(part);
      if (inFlight.length - settled >= MAX_PARTS_IN_FLIGHT) await inFlight[settled++];
    };
    try {
      const { size, sha256 } = await pumpHashing(body, async (chunk) => {
        buffered.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes >= this.partSize) await flush();
      });
      // S3 refuses a multipart upload with no parts, so an empty body is one empty part, as Convex's.
      if (bufferedBytes > 0 || inFlight.length === 0) await flush();
      const parts = await Promise.all(inFlight);
      await this.completeMultipartUpload(objectKey, uploadId, parts);
      return { key, size, sha256 };
    } catch (e) {
      await Promise.allSettled(inFlight);
      await this.abortMultipartUpload(objectKey, uploadId).catch(() => {});
      throw e;
    }
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.client.file((await this.prefixOf()) + key);
    if (!(await file.exists())) return null;
    return (range ? file.slice(range.start, range.end + 1) : file).stream();
  }

  async delete(key: string): Promise<void> {
    await this.client.file((await this.prefixOf()) + key).delete();
  }

  async *list(): AsyncIterable<Listed> {
    let token: string | undefined;
    const prefix = await this.prefixOf();
    for (;;) {
      const page = await this.client.list({ prefix, continuationToken: token });
      for (const o of page.contents ?? [])
        if (o.key)
          yield {
            key: o.key.slice(prefix.length),
            lastModified: o.lastModified ? Date.parse(String(o.lastModified)) : 0,
          };
      if (!page.isTruncated || !page.nextContinuationToken) return;
      token = page.nextContinuationToken;
    }
  }

  // CreateMultipartUpload: SSE-S3 and the parts' checksum algorithm (Convex's
  // `configure_multipart_upload_builder`, crates/aws_s3/src/storage.rs).
  private async createMultipartUpload(objectKey: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.sse) headers["x-amz-server-side-encryption"] = "AES256";
    if (this.checksums) headers["x-amz-checksum-algorithm"] = "CRC32";
    const res = await this.send("CreateMultipartUpload", "POST", objectKey, { uploads: "" }, headers);
    const uploadId = xmlText(await res.text(), "UploadId");
    if (!uploadId) throw new Error("Multipart upload is missing an upload_id.");
    return uploadId;
  }

  // UploadPart. The part's CRC32 is always sent: the AWS SDK computes one by default (its
  // `RequestChecksumCalculation::WhenSupported`) even when Convex leaves the algorithm unset. With checksums on,
  // the algorithm is named and the part's checksum must come back (Convex's `ObjectPart::new`).
  private async uploadPart(objectKey: string, uploadId: string, partNumber: number, data: Uint8Array): Promise<Part> {
    const headers: Record<string, string> = { "x-amz-checksum-crc32": crc32Base64(data) };
    if (this.checksums) headers["x-amz-sdk-checksum-algorithm"] = "CRC32";
    const res = await this.send(
      "UploadPart",
      "PUT",
      objectKey,
      { partNumber: String(partNumber), uploadId },
      headers,
      data,
    );
    await res.arrayBuffer();
    const etag = res.headers.get("etag");
    if (!etag) throw new Error("Object part missing etag");
    let checksum: string | null = null;
    if (this.checksums) {
      checksum = res.headers.get("x-amz-checksum-crc32");
      if (!checksum) throw new Error("Object part missing hash! Expected crc32");
    }
    return { partNumber, etag, checksum };
  }

  // CompleteMultipartUpload, each part with its CRC32 when checksums are on (Convex's `S3Upload::complete`).
  private async completeMultipartUpload(objectKey: string, uploadId: string, parts: Part[]): Promise<void> {
    const xml = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts
      .map(
        (p) =>
          `<Part>${p.checksum !== null ? `<ChecksumCRC32>${xmlEscape(p.checksum)}</ChecksumCRC32>` : ""}<ETag>${xmlEscape(p.etag)}</ETag><PartNumber>${p.partNumber}</PartNumber></Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const res = await this.send(
      "CompleteMultipartUpload",
      "POST",
      objectKey,
      { uploadId },
      { "content-type": "application/xml" },
      new TextEncoder().encode(xml),
    );
    // S3 can answer 200 and still fail the completion, with an error document as the body.
    const text = await res.text();
    if (text.includes("<Error>")) throw s3Error("CompleteMultipartUpload", res.status, text);
  }

  private async abortMultipartUpload(objectKey: string, uploadId: string): Promise<void> {
    await (await this.send("AbortMultipartUpload", "DELETE", objectKey, { uploadId }, {})).arrayBuffer();
  }

  private url(objectKey: string, query: Record<string, string>): URL {
    const path = objectKey.split("/").map(uriEncode).join("/");
    const url = this.endpoint
      ? new URL(`${this.endpoint.replace(/\/+$/, "")}/${uriEncode(this.bucket)}/${path}`)
      : this.pathStyle
        ? new URL(`https://s3.${this.region}.amazonaws.com/${uriEncode(this.bucket)}/${path}`)
        : new URL(`https://${this.bucket}.s3.${this.region}.amazonaws.com/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  /** A signed request, retried on a network error, a 5xx or a 429; any other non-2xx is the operation's error. */
  private async send(
    op: string,
    method: string,
    objectKey: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body?: Uint8Array,
  ): Promise<Response> {
    const url = this.url(objectKey, query);
    const payloadHash = sha256Hex(body ?? "");
    for (let attempt = 1; ; attempt++) {
      const h = { ...headers };
      signRequest({ method, url, headers: h, payloadHash }, this.creds(), this.region);
      let res: Response;
      try {
        res = await fetch(url, { method, headers: h, body: body as Uint8Array<ArrayBuffer> | undefined });
      } catch (e) {
        if (attempt >= ATTEMPTS) throw e;
        await Bun.sleep(Math.random() * 100 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      const text = await res.text();
      if ((res.status >= 500 || res.status === 429) && attempt < ATTEMPTS) {
        await Bun.sleep(Math.random() * 100 * 2 ** attempt);
        continue;
      }
      throw s3Error(op, res.status, text);
    }
  }
}
