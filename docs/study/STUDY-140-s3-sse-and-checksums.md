# STUDY-140 — S3 server-side encryption and checksums (`AWS_S3_DISABLE_SSE`, `AWS_S3_DISABLE_CHECKSUMS`)

- **Status:** implemented; DV-445 and DV-446 pending (owner)
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend (the reference, [upstream.md](../parity/upstream.md));
  the AWS SDK at Convex's `Cargo.lock` versions: `aws-sdk-s3` 1.143.0, `aws-config` 1.6.2, `aws-smithy-types` 1.6.3,
  `aws-smithy-checksums` 0.65.0
- **Related:** [STUDY-32](STUDY-32-file-storage.md) (file storage), [STUDY-38](STUDY-38-docker.md) (self-hosted
  configuration), [platform.md §22](../parity/platform.md) (the S3 env row)

## 1. How Convex does it

### 1.1 The variables

`crates/aws_utils/src/lib.rs:32-44` reads both once (`LazyLock`), as `AWS_S3_FORCE_PATH_STYLE`:
`env::var(..).ok().and_then(|s| s.parse().ok()).unwrap_or_default()`. Rust's `bool::from_str` takes exactly `true` or
`false`, so `true` turns a flag on and anything else (`1`, `TRUE`, `yes`, an empty value, unset) leaves it off. Both
default to off: SSE and checksums are on. `is_sse_disabled()` and `are_checksums_disabled()` (`:137-144`) expose them.
The self-hosted `docker-compose.yml` passes both through (`self-hosted/docker/docker-compose.yml:21-22`); the
self-hosted docs do not describe them (`self-hosted/advanced/s3_storage.md` lists the buckets, `S3_ENDPOINT_URL` for
R2 and other S3 replacements). The changelog of 2025-09-03 adds them "for better compatibility with AWS compatible
services" (`self-hosted/CHANGELOG.md:29`).

### 1.2 Every write is a multipart upload

`S3Storage` (`crates/aws_s3/src/storage.rs`) writes only through multipart uploads: `start_upload` (file uploads,
exports, modules, search segments), `start_client_driven_upload`, and `put_object` (`:548-553`), which opens an
upload, writes the bytes as one part and completes it. There is no `PutObject` call on the write path (the presigned
upload URL, `:404-420`, signs a `PutObject` with neither SSE nor checksums: `TODO(CX-4921)`). Parts start at 5 MiB and
double up to `STORAGE_MAX_INTERMEDIATE_PART_SIZE` (200 MiB; `crates/storage/src/lib.rs` `BufferedUpload`, `:380-410`);
`complete` always writes the remaining buffer, even empty, as the last part (`:474-482`). Up to
`MAXIMUM_PARALLEL_UPLOADS` = 8 parts upload at once (`crates/storage/src/lib.rs:95`, `try_write_parallel`).

### 1.3 What the flags change

| Request | SSE on (default) | SSE off | Checksums on (default) | Checksums off |
|---|---|---|---|---|
| CreateMultipartUpload (`configure_multipart_upload_builder`, `storage.rs:169-188`) | `x-amz-server-side-encryption: AES256` | — | `x-amz-checksum-algorithm: CRC32` ("we're really specifying the part checksum algorithm") | — |
| UploadPart (`start_write`, `:707-729`) | — | — | `ChecksumAlgorithm::Crc32` set: `x-amz-sdk-checksum-algorithm: CRC32`, and the SDK sends the part's `x-amz-checksum-crc32` | algorithm unset; the SDK still sends `x-amz-checksum-crc32` (§1.4) |
| UploadPart's response (`ObjectPart::new`, `crates/aws_s3/src/types.rs:58-80`) | — | — | `checksum_crc32` must be there, else the write fails: `Object part missing hash! Expected crc32` | not read; the part token stores `"disabled"` |
| CompleteMultipartUpload (`complete`, `storage.rs:786-815`) | — | — | each part carries `ChecksumCRC32` | parts carry `PartNumber` and `ETag` only |

SSE touches only CreateMultipartUpload (S3 applies it to the object); no other request carries an SSE header, and
reads never send one (SSE-S3 is transparent to readers). The client-driven upload (`upload_part`,
`finish_client_driven_upload`) goes through the same three builders, and its part token carries the checksum (or
`"disabled"`) between the calls.

### 1.4 What the AWS SDK adds on its own

`must_s3_config_from_env` builds the client from `aws_config::defaults(BehaviorVersion::v2026_01_12())`, so the
SDK's flexible checksums apply with their defaults:

- **Requests.** `request_checksum_calculation` defaults to `WhenSupported` (`aws-config`
  `default_provider/checksums.rs:25-47`, from `AWS_REQUEST_CHECKSUM_CALCULATION` or the profile's
  `request_checksum_calculation`, case-insensitive `when_supported` / `when_required`). With `WhenSupported` the
  SDK computes a checksum for every operation that supports one, defaulting to CRC32 when the caller set no algorithm
  (`aws-sdk-s3` `http_request_checksum.rs:180-200, 310-330`). UploadPart is one (`operation/upload_part.rs:137`),
  CreateMultipartUpload and CompleteMultipartUpload are not. Convex's parts are in-memory `Bytes`, so the CRC32 goes
  in a header (`x-amz-checksum-crc32`, base64 of the big-endian value), not a trailer (`:205-240`). So **with
  `AWS_S3_DISABLE_CHECKSUMS=true` each part still carries its CRC32**; only the algorithm header, the response check
  and the completion's checksums go.
- **Responses.** `response_checksum_validation` defaults to `WhenSupported` too: GetObject asks for the checksum
  (`x-amz-checksum-mode: ENABLED`) and validates the body against a full-object checksum in the response
  (`operation/get_object.rs:139-175`, `http_response_checksum.rs:110-200`). A part-level checksum (`<base64>-<n>`, what
  a multipart upload with CRC32 parts gets) is skipped with a warning, and a ranged GET carries no checksum. The two
  flags do not touch this.

### 1.5 Errors

A refused request is the SDK's error with S3's code and message ("Failed to create multipart upload" for the
creation). An S3-compatible store without SSE-S3 refuses the creation; RustFS 1.0.0, for one, answers 400
`InvalidRequest: SSE-S3 requires RUSTFS_SSE_S3_MASTER_KEY to be set to a base64-encoded 32-byte key when KMS is not
configured` (seen locally), which is what `AWS_S3_DISABLE_SSE` is for.

## 2. What an app can observe

Nothing: the flags change what the backend sends to its bucket, not what `ctx.storage`, uploads, exports or imports
answer. Whoever runs the server observes:

- with the defaults, objects are stored with SSE-S3 (a HEAD answers `x-amz-server-side-encryption: AES256`) and with
  CRC32 part checksums; a store that cannot do either refuses every write until the flag is set;
- `AWS_S3_DISABLE_SSE=true` and `AWS_S3_DISABLE_CHECKSUMS=true` (exactly `true`) take them off the wire, as §1.3.

## 3. How bunvex does it

`packages/file-storage/src/s3.ts`. Bun's `S3Client` cannot send SSE or checksum headers, nor run a multipart upload
whose requests it does not build itself, so writes are now signed here (`sigv4.ts`, AWS Signature V4 in the
`Authorization` header, checked against AWS's published GetObject example) and sent with `fetch`; reads, deletes and
listings stay on Bun's `S3Client`. The region, endpoint and credentials are resolved once, with Bun's fallbacks
(`S3_*`, then `AWS_*` variables), and given to both, so they reach the same bucket.

- `s3OptionsFromEnv` reads `AWS_S3_DISABLE_SSE` and `AWS_S3_DISABLE_CHECKSUMS` as Convex: exactly `true` is on
  (`disableSse`, `disableChecksums` in `S3Options`).
- `put` is a multipart upload, as Convex's, whatever the size (before, Bun's writer sent one `PutObject` below a
  part): CreateMultipartUpload with §1.3's headers; parts of `partSize` (default 8 MiB), up to 8 in flight while the
  body streams; each with `x-amz-checksum-crc32`, plus `x-amz-sdk-checksum-algorithm: CRC32` when checksums are on, in
  which case the response's `x-amz-checksum-crc32` is required (`Object part missing hash! Expected crc32`, Convex's
  message); CompleteMultipartUpload with each part's `ChecksumCRC32` when checksums are on. An empty body is one empty
  part. A completion answered 200 with an error document fails the write, as the SDK does. On any failure the upload
  is aborted, so nothing is left.
- Each request is retried up to 3 attempts on a network error, a 5xx or a 429 (the SDK's standard mode, which
  Convex's client uses), with a jittered backoff.
- `docker/docker-compose.yml` passes both variables, as Convex's; `docker/README.md` lists them.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-445 | Reads do not ask for or validate checksums (no `x-amz-checksum-mode: ENABLED` on GetObject), and the SDK's `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION` (and their profile keys) are not read: each part always carries its CRC32, as the default `when_supported` | Reads go through Bun's `S3Client`, which has neither. Objects Convex or bunvex write are multipart, so S3 answers a part-level checksum the SDK skips, and ranged reads carry none: validation could only catch a corrupted transfer of an object some other writer stored whole. `when_required` would only drop the default part CRC32 under `AWS_S3_DISABLE_CHECKSUMS` | pending (owner); recommendation: accept |
| DV-446 | Part sizes: a fixed `partSize` (8 MiB by default), not Convex's 5 MiB doubling up to 200 MiB (`STORAGE_MAX_INTERMEDIATE_PART_SIZE`); a body that is an exact multiple of the part size ends without Convex's extra empty part | Older than this study (STUDY-32 used Bun's writer). Not observable outside the bucket; with 8 parts in flight, Convex's growing parts hold up to 1.6 GiB of a large upload in memory, bunvex's 64 MiB. S3's 10 000-part cap bounds a bunvex object at about 78 GiB (Convex: about 2 TiB) | pending (owner); recommendation: accept |

## 5. Tests

- `packages/file-storage/test/s3-requests.test.ts`: an in-process fake S3 records every request. With the defaults,
  CreateMultipartUpload carries `AES256` and `CRC32` (and signs them), each part its big-endian CRC32 and
  `x-amz-sdk-checksum-algorithm`, and the completion's exact XML has each part's `ChecksumCRC32`. Each flag alone, and
  both, take off exactly their headers; with checksums disabled the part still carries its CRC32 and a part answered
  without one is accepted. With checksums on, a part answered without its checksum fails the write with Convex's
  message and aborts the upload. Several parts in order; an empty body is one empty part; a completion answered 200
  with an error fails. The flags are parsed as Convex: only `true`. The signer reproduces AWS's published signature.
  The conformance suite runs against the fake, with the defaults and with both flags.
- `packages/file-storage/test/blob-stores.test.ts` (CI, against RustFS 1.0.0, now started with an SSE-S3 master key):
  the conformance suite with Convex's defaults, then again with both flags `true`; and a HEAD of a written object
  answers `x-amz-server-side-encryption: AES256`, or nothing with `AWS_S3_DISABLE_SSE`. Run locally against the
  RustFS binary: without the master key the defaults are refused with the 400 of §1.5 and both flags pass; with it,
  all three runs pass.

**Sabotage** (each applied to `s3.ts`, the request tests run, restored; `git diff` clean after):

| Sabotage | Tests that failed |
|---|---|
| S1 no SSE header by default | defaults; checksums disabled |
| S2 the SSE header despite `disableSse` | SSE disabled; both disabled |
| S3 no `x-amz-checksum-algorithm` on the creation | defaults; SSE disabled |
| S4 the algorithm despite `disableChecksums` | checksums disabled; both disabled |
| S5 no `ChecksumCRC32` in the completion | defaults; SSE disabled; several parts |
| S6 the part's checksum not required back | part answered without its checksum |
| S7 the flags read as any non-empty value | flag parsing |
| S8 no default part CRC32 with checksums disabled | checksums disabled |
| S9 the CRC32 little-endian | defaults; checksums disabled; several parts |
| S10 no `x-amz-sdk-checksum-algorithm` on parts | defaults; SSE disabled |
| S11 no part for an empty body | empty body |

**Measurement** (local RustFS 1.0.0 on this Mac, `put` of a stream, two rounds each, the old writer against the new):

| Body | Bun's writer (before) | New, SSE and CRC32 | New, both disabled |
|---|---|---|---|
| 64 MiB (5 puts) | 278–281 ms, 228–230 MiB/s | 256–259 ms, 247–250 MiB/s | 255–257 ms, 249–251 MiB/s |
| 1 KiB (200 puts) | 5.2–5.4 ms | 73.5–74.9 ms | 71.1–77.4 ms |

Large bodies are as fast (8 parts in flight, as Convex). A small body costs three requests instead of one, and RustFS
is slow at multipart: its CreateMultipartUpload takes 12–18 ms and a 1 KiB UploadPart 27–57 ms, against 2–5 ms for a
`PutObject` (measured with bare signed requests). That is Convex's cost too, since it writes every object this way;
on AWS S3 it is two more round trips.

## 6. Open questions

- DV-445 and DV-446 (above).
- A single `PutObject` (with the same SSE and checksum headers) for a body under one part would keep small uploads at
  one request, as bunvex did before. It diverges from Convex only in the bucket (a full-object instead of a
  part-level checksum, a different ETag form). Recommendation: keep Convex's multipart unless small-upload latency
  matters on a deployment.
