// AWS Signature Version 4 for S3 requests signed in the Authorization header. Bun's S3Client signs its own
// requests but cannot send the headers Convex's multipart writes carry (server-side encryption, checksums),
// so the writes in s3.ts sign theirs here.
import { createHash, createHmac } from "node:crypto";

export type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** SHA-256 of `data`, as lowercase hex (the `x-amz-content-sha256` value). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** RFC 3986 encoding, as SigV4 wants it: everything but `A-Z a-z 0-9 - _ . ~` is percent-encoded. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!\x27()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/**
 * Sign a request: adds `x-amz-date`, `x-amz-content-sha256`, the session token if any, and `authorization` to
 * `headers` (lowercase names). Every header in `headers`, plus `host`, is signed.
 */
export function signRequest(
  req: { method: string; url: URL; headers: Record<string, string>; payloadHash: string },
  creds: Credentials,
  region: string,
  now: Date = new Date(),
): void {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const h = req.headers;
  h["x-amz-date"] = amzDate;
  h["x-amz-content-sha256"] = req.payloadHash;
  if (creds.sessionToken) h["x-amz-security-token"] = creds.sessionToken;

  const signed: [string, string][] = [["host", req.url.host], ...Object.entries(h)]
    .map(([k, v]): [string, string] => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = signed.map(([k]) => k).join(";");
  // The path is already encoded segment by segment (S3 keys are not normalized).
  const query = [...req.url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    req.method,
    req.url.pathname,
    query,
    signed.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders,
    req.payloadHash,
  ].join("\n");

  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
