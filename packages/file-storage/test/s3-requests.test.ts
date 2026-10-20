// What S3BlobStore sends to the bucket (STUDY-140): an in-process fake S3 records every request, so the tests
// check the headers and bodies of Convex's multipart writes with AWS_S3_DISABLE_SSE and AWS_S3_DISABLE_CHECKSUMS
// on and off. The fake also serves reads and listings, so the conformance suite runs against it too.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { describeBlobStoreConformance } from "../src/conformance.ts";
import { S3BlobStore, type S3Options, s3OptionsFromEnv } from "../src/index.ts";
import { PartSizer } from "../src/s3.ts";
import { signRequest } from "../src/sigv4.ts";

type Recorded = { method: string; path: string; query: URLSearchParams; headers: Headers; body: string };

const log: Recorded[] = [];
const objects = new Map<string, { data: Uint8Array; modified: Date }>();
const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
const fake = {
  /** Answer UploadPart without the part's checksum (an S3-compatible store that ignores checksums). */
  omitPartChecksum: false,
  /** Answer CompleteMultipartUpload 200 with an error document. */
  completeError: false,
};

const BUCKET = "b";
const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    log.push({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: new TextDecoder().decode(body),
    });
    const [, bucket, ...rest] = url.pathname.split("/");
    if (bucket !== BUCKET) return xml("<Error><Code>NoSuchBucket</Code></Error>", 404);
    const key = rest.map(decodeURIComponent).join("/");
    const q = url.searchParams;
    if (req.method === "POST" && q.has("uploads")) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return xml(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === "PUT" && q.has("partNumber")) {
      uploads.get(q.get("uploadId")!)!.parts.set(Number(q.get("partNumber")), body);
      const h: Record<string, string> = { etag: `"etag-${q.get("partNumber")}"` };
      const sum = req.headers.get("x-amz-checksum-crc32");
      if (sum && !fake.omitPartChecksum) h["x-amz-checksum-crc32"] = sum;
      return new Response(null, { headers: h });
    }
    if (req.method === "POST" && q.has("uploadId")) {
      if (fake.completeError) return xml("<Error><Code>InternalError</Code><Message>try again</Message></Error>");
      const u = uploads.get(q.get("uploadId")!)!;
      const nums = [...u.parts.keys()].sort((a, b) => a - b);
      objects.set(u.key, { data: Buffer.concat(nums.map((n) => u.parts.get(n)!)), modified: new Date() });
      uploads.delete(q.get("uploadId")!);
      return xml("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    }
    if (req.method === "DELETE" && q.has("uploadId")) {
      uploads.delete(q.get("uploadId")!);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && q.get("list-type") === "2") {
      const prefix = q.get("prefix") ?? "";
      const items = [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, o]) =>
            `<Contents><Key>${k}</Key><LastModified>${o.modified.toISOString()}</LastModified><Size>${o.data.length}</Size><ETag>"x"</ETag></Contents>`,
        );
      return xml(
        `<ListBucketResult><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated>${items.join("")}</ListBucketResult>`,
      );
    }
    const o = objects.get(key);
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!o)
      return req.method === "HEAD"
        ? new Response(null, { status: 404 })
        : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
    if (req.method === "HEAD") return new Response(null, { headers: { "content-length": String(o.data.length) } });
    const range = req.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), o.data.length - 1) : o.data.length - 1;
      return new Response(o.data.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${o.data.length}` },
      });
    }
    return new Response(o.data);
  },
});
afterAll(() => server.stop(true));

beforeEach(() => {
  log.length = 0;
  fake.omitPartChecksum = false;
  fake.completeError = false;
});

const store = (o: Partial<S3Options> = {}) =>
  new S3BlobStore({
    bucket: BUCKET,
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${server.port}`,
    forcePathStyle: true,
    accessKeyId: "AKID",
    secretAccessKey: "secret",
    prefix: "inst-1/",
    ...o,
  });

const ops = () =>
  log.map(
    (r) =>
      r.method +
      (r.query.has("uploads")
        ? " uploads"
        : r.query.has("partNumber")
          ? " part"
          : r.query.has("uploadId")
            ? " upload"
            : ""),
  );
const create = () => log.find((r) => r.method === "POST" && r.query.has("uploads"))!;
const partsOf = () => log.filter((r) => r.method === "PUT" && r.query.has("partNumber"));
const complete = () => log.find((r) => r.method === "POST" && r.query.has("uploadId"))!;
const signed = (r: Recorded) =>
  r.headers
    .get("authorization")!
    .match(/SignedHeaders=([^,]+)/)![1]!
    .split(";");
const crc32 = (s: string) => {
  const v = Bun.hash.crc32(s);
  return Buffer.from([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]).toString("base64");
};

test("by default a write asks for SSE-S3 and CRC32 part checksums, as Convex's", async () => {
  const w = await store().put(new TextEncoder().encode("hello"));
  // Every write is a multipart upload, even a small one.
  expect(ops()).toEqual(["POST uploads", "PUT part", "POST upload"]);
  const c = create();
  expect(c.path).toBe(`/${BUCKET}/inst-1/${w.key}`);
  expect(c.headers.get("x-amz-server-side-encryption")).toBe("AES256");
  expect(c.headers.get("x-amz-checksum-algorithm")).toBe("CRC32");
  expect(signed(c)).toEqual(
    expect.arrayContaining(["host", "x-amz-checksum-algorithm", "x-amz-server-side-encryption", "x-amz-date"]),
  );
  const [p] = partsOf();
  expect(p!.query.get("partNumber")).toBe("1");
  expect(p!.headers.get("x-amz-checksum-crc32")).toBe(crc32("hello"));
  expect(p!.headers.get("x-amz-sdk-checksum-algorithm")).toBe("CRC32");
  expect(p!.headers.get("x-amz-server-side-encryption")).toBeNull();
  expect(complete().body).toBe(
    `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><ChecksumCRC32>${crc32("hello")}</ChecksumCRC32><ETag>&quot;etag-1&quot;</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>`,
  );
  expect(new TextDecoder().decode(objects.get(`inst-1/${w.key}`)!.data)).toBe("hello");
});

test("AWS_S3_DISABLE_SSE drops the encryption header and nothing else", async () => {
  await store({ disableSse: true }).put(new TextEncoder().encode("hello"));
  expect(create().headers.get("x-amz-server-side-encryption")).toBeNull();
  expect(signed(create())).not.toContain("x-amz-server-side-encryption");
  expect(create().headers.get("x-amz-checksum-algorithm")).toBe("CRC32");
  expect(partsOf()[0]!.headers.get("x-amz-sdk-checksum-algorithm")).toBe("CRC32");
  expect(complete().body).toContain("<ChecksumCRC32>");
});

test("AWS_S3_DISABLE_CHECKSUMS: no algorithm asked for, none expected back, none in the completion", async () => {
  fake.omitPartChecksum = true;
  const w = await store({ disableChecksums: true }).put(new TextEncoder().encode("hello"));
  expect(create().headers.get("x-amz-checksum-algorithm")).toBeNull();
  expect(create().headers.get("x-amz-server-side-encryption")).toBe("AES256");
  const [p] = partsOf();
  expect(p!.headers.get("x-amz-sdk-checksum-algorithm")).toBeNull();
  // The AWS SDK still sends each part's CRC32 by default (RequestChecksumCalculation::WhenSupported).
  expect(p!.headers.get("x-amz-checksum-crc32")).toBe(crc32("hello"));
  expect(complete().body).not.toContain("Checksum");
  expect(complete().body).toContain("<ETag>&quot;etag-1&quot;</ETag><PartNumber>1</PartNumber>");
  expect(objects.has(`inst-1/${w.key}`)).toBe(true);
});

test("both flags off the wire at once", async () => {
  await store({ disableSse: true, disableChecksums: true }).put(new TextEncoder().encode("x"));
  const c = create();
  expect([c.headers.get("x-amz-server-side-encryption"), c.headers.get("x-amz-checksum-algorithm")]).toEqual([
    null,
    null,
  ]);
});

test("with checksums on, a part answered without its checksum fails the write and aborts the upload", async () => {
  fake.omitPartChecksum = true;
  const before = objects.size;
  const err = await store()
    .put(new TextEncoder().encode("hello"))
    .catch((e: Error) => e.message);
  expect(err).toBe("Object part missing hash! Expected crc32");
  expect(ops()).toEqual(["POST uploads", "PUT part", "DELETE upload"]);
  expect(objects.size).toBe(before);
  expect(uploads.size).toBe(0);
});

test("a body over several parts: each part's checksum, the parts in order in the completion", async () => {
  const chunks = ["aaaa", "bbbb", "cc"];
  const w = await store({ minPartSize: 4, maxPartSize: 4 }).put(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    }),
  );
  // The parts upload in parallel (MAX_PARTS_IN_FLIGHT), so they may reach the server in any order: by number.
  const parts = partsOf().map((p) => [p.query.get("partNumber"), p.headers.get("x-amz-checksum-crc32")]);
  expect(parts.sort(([a], [b]) => Number(a) - Number(b))).toEqual([
    ["1", crc32("aaaa")],
    ["2", crc32("bbbb")],
    ["3", crc32("cc")],
  ]);
  expect(
    [...complete().body.matchAll(/<ChecksumCRC32>([^<]+)<\/ChecksumCRC32><ETag>[^<]+<\/ETag><PartNumber>(\d)</g)].map(
      (m) => [m[2], m[1]],
    ),
  ).toEqual([
    ["1", crc32("aaaa")],
    ["2", crc32("bbbb")],
    ["3", crc32("cc")],
  ]);
  expect(new TextDecoder().decode(objects.get(`inst-1/${w.key}`)!.data)).toBe("aaaabbbbcc");
});

test("an empty body is one empty part", async () => {
  await store().put(new Uint8Array());
  expect(partsOf().map((p) => [p.body, p.headers.get("x-amz-checksum-crc32")])).toEqual([["", "AAAAAA=="]]);
});

test("a completion answered 200 with an error document fails the write", async () => {
  fake.completeError = true;
  const err = await store()
    .put(new TextEncoder().encode("hello"))
    .catch((e: Error) => e.message);
  expect(err).toBe("S3 CompleteMultipartUpload failed (200): InternalError: try again");
  expect(ops().at(-1)).toBe("DELETE upload");
});

/** The part sizes PartSizer cuts from chunks of the given sizes, the last (possibly empty) part included. */
const cut = (min: number, max: number, chunks: number[]) => {
  const sizer = new PartSizer(min, max);
  const parts: number[] = [];
  for (const n of chunks) {
    const ready = sizer.push(new Uint8Array(n));
    if (ready) parts.push(ready.byteLength);
  }
  parts.push(sizer.finish().byteLength);
  return parts;
};

test("part sizes as Convex's BufferedUpload: from the minimum, doubling up to the maximum", () => {
  // 100 one-byte chunks: 5, 10, 20, then the maximum, and the rest as the last part.
  expect(cut(5, 20, Array(100).fill(1))).toEqual([5, 10, 20, 20, 20, 20, 5]);
  // The target doubles each time a part ships, never past the maximum.
  expect(cut(5, 1000, Array(100).fill(1))).toEqual([5, 10, 20, 40, 25]);
  // A chunk at or above the target with nothing buffered ships as it is (up to the maximum).
  expect(cut(5, 20, [7, 3, 9])).toEqual([7, 12, 0]);
  // A buffer past the maximum ships its first `max` bytes and keeps the rest.
  expect(cut(5, 8, [20, 1])).toEqual([8, 8, 5]);
  // A body that ends exactly on a part still ends with an empty part; an empty body is one empty part.
  expect(cut(5, 20, [5])).toEqual([5, 0]);
  expect(cut(5, 20, [])).toEqual([0]);
});

test("the defaults: 5 MiB parts doubling to 200 MiB (STORAGE_MAX_INTERMEDIATE_PART_SIZE, capped at 5 GiB)", async () => {
  const mib = 1 << 20;
  expect(cut(5 * mib, 200 * mib, Array(700).fill(mib))).toEqual([5, 10, 20, 40, 80, 160, 200, 185].map((n) => n * mib));
  const max = (v: string | undefined) =>
    s3OptionsFromEnv({ S3_STORAGE_FILES_BUCKET: "b", STORAGE_MAX_INTERMEDIATE_PART_SIZE: v })?.maxPartSize;
  expect(max(undefined)).toBe(200 * mib);
  expect(max("10485760")).toBe(10 * mib);
  expect(max(String(6 * 1024 * mib))).toBe(5 * 1024 * mib);
  const warn = console.warn;
  console.warn = () => {};
  try {
    expect([max("ten"), max("-1"), max("1.5")]).toEqual([200 * mib, 200 * mib, 200 * mib]);
  } finally {
    console.warn = warn;
  }
  // Through a store: the parts it sends follow the same sequence.
  const parts = async (body: Uint8Array[]) => {
    log.length = 0;
    await store({ minPartSize: 2, maxPartSize: 4 }).put(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const b of body) c.enqueue(b);
          c.close();
        },
      }),
    );
    return partsOf().map((p) => p.body.length);
  };
  expect(await parts([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1].map(() => new Uint8Array(1)))).toEqual([2, 4, 4, 3]);
  expect(await parts([new Uint8Array(2)])).toEqual([2, 0]);
  // One part per chunk at most, as Convex's: a single chunk past the maximum leaves a larger last part.
  log.length = 0;
  await store({ minPartSize: 2, maxPartSize: 4 }).put(new Uint8Array(13));
  expect(partsOf().map((p) => p.body.length)).toEqual([4, 9]);
});

test("S3's part numbers: the 10 000th part is never written, as Convex's next_part_number", async () => {
  const s = store({ minPartSize: 1, maxPartSize: 1 });
  const ones = (n: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < n; i++) c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
  // 9 998 one-byte parts and the empty last one: part 9 999, the last that can be written.
  await s.put(ones(9998));
  expect(partsOf().length).toBe(9999);
  log.length = 0;
  const err = await s.put(ones(9999)).catch((e: Error) => e.message);
  expect(err).toBe("Object part number cannot exceed 10,000 or be 0.");
  expect(partsOf().length).toBe(9999);
  expect(ops().at(-1)).toBe("DELETE upload");
}, 60_000);

test("the flags are read as Convex reads them: exactly `true`, anything else is off", () => {
  const opts = (v: string | undefined) =>
    s3OptionsFromEnv({ S3_STORAGE_FILES_BUCKET: "b", AWS_S3_DISABLE_SSE: v, AWS_S3_DISABLE_CHECKSUMS: v });
  expect([opts("true")?.disableSse, opts("true")?.disableChecksums]).toEqual([true, true]);
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"])
    expect([opts(v)?.disableSse, opts(v)?.disableChecksums]).toEqual([false, false]);
  expect(s3OptionsFromEnv({ S3_STORAGE_FILES_BUCKET: "b", AWS_S3_DISABLE_SSE: "true" })).toMatchObject({
    disableSse: true,
    disableChecksums: false,
  });
});

test("SigV4: AWS's own GetObject example signs to its published signature", () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  const headers: Record<string, string> = { range: "bytes=0-9" };
  signRequest(
    {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    "us-east-1",
    new Date("2013-05-24T00:00:00Z"),
  );
  expect(headers.authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

describeBlobStoreConformance("s3 (fake)", () => store({ prefix: `c-${crypto.randomUUID()}/`, minPartSize: 1 << 20 }), {
  large: true,
});
describeBlobStoreConformance("s3 (fake, SSE and checksums disabled)", () =>
  store({ prefix: `d-${crypto.randomUUID()}/`, disableSse: true, disableChecksums: true }),
);
