# STUDY-32 — File storage (`ctx.storage`, `_storage`, uploads and downloads)

- **Status:** accepted: F1–F4 as recommended (owner, 2026-10-01)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** server-api.md §13, platform.md (file storage); STUDY-30 S2 (system tables projected through
  `db.system`); STUDY-31 (HTTP actions, which use `ctx.storage.get/store`); UI-01 §14 (the dashboard's files
  contract)

## 1. How Convex does it

### 1.1 The API (`npm-packages/convex/src/server/storage.ts`, `impl/storage_impl.ts`)

| Method | Where | Returns |
|---|---|---|
| `getUrl(id)` | query, mutation, action | `string \| null` |
| `getMetadata(id)` (deprecated) | all | `{storageId: <uuid>, sha256: <hex>, size, contentType} \| null` |
| `generateUploadUrl()` | mutation, action | `string` |
| `delete(id)` | mutation, action | `void` |
| `get(id)` | action, HTTP action | `Blob \| null` (streamed) |
| `store(blob, { sha256? })` | action, HTTP action | `Id<"_storage">` |

- **`store` from a mutation** exists at run time but always fails (`async_syscall.rs` L1008-1046):
  `ctx.storage.store() is not supported in queries and mutations yet. Please use an action, or ctx.storage.generateUploadUrl() to upload from a client.`
- **Ids** (`crates/model/src/file_storage/mod.rs` L120-145, L257-291). An id is a `_storage` document id,
  or a **legacy UUID string**, still accepted everywhere.
  - Otherwise: `Invalid storage ID: "<id>". Storage ID should be an Id of '_storage' table, or a UUID string.`
  - An id of another table: `Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'.`
  - Both are wrapped as ``Invalid argument `storageId` for `storage.getUrl`: …`` (and likewise for
    `storage.delete` and `storage.getMetadata`; `get` in actions reports `storage.getMetadata`, a Convex
    quirk).
- **Other messages:**
  - `getUrl` with no argument: ``Must provide arg 1 `storageId` to `getUrl` ``;
  - `store` with a non-Blob: ``store() expects a Blob. If you are trying to store a Request, `await request.blob()` will give you the correct input.``;
  - `get` with a non-string id: `storage.get requires a string storageId but received <x>`;
  - a sha256 mismatch: `Sha256 mismatch. Expected: <b64> Actual: <b64>` (the bytes are written first).
- **`getUrl`** returns `{cloud origin}/api/storage/<storage uuid>`. It is the API origin, not the site's.
  It is null for a missing file.
  - In queries and mutations the read is **in the read set**, so a query that called `getUrl` re-runs when
    the file is deleted. Consecutive calls are batched.
  - In actions it reads outside a transaction.
- **`delete`** deletes the metadata row in the mutation's transaction (only if it commits; from an action,
  in its own transaction).
  - A missing file is an **error**: `storage id <id> not found` (`StorageIdNotFound`).
  - **The bytes are never deleted** in the open-source backend. Nothing removes the blob of a deleted file,
    of a failed upload, or of an abandoned one.

### 1.2 The `_storage` table (`model/src/file_storage`, `virtual_table.rs`)

- **The physical table** `_file_storage` holds `{storageId: uuid, storageKey: uuid (the blob's key, a
  different one), sha256: bytes, size: int64, contentType: string | null}`, with index `by_storage_id`.
- **Apps read the virtual `_storage`** through `db.system.get` / `db.system.query`, with indexes `by_id`
  and `by_creation_time` only. Its documents are `{_id, _creationTime, sha256: base64, size: float64,
  contentType}`.
  - `contentType` is **`null`** when absent, although the TS schema says optional.
  - The docs show `sha256` as hex; the code returns base64.

### 1.3 Uploads (`crates/local_backend/src/storage.rs`, `crates/keybroker`)

- **`generateUploadUrl()`** returns `{cloud origin}/api/storage/upload?token=<token>`.
  - The token is an encrypted, hex-encoded `{instance, issued_s, StoreFile, component}`. It is **valid for
    1 hour** and **reusable** within it: nothing records its use.
  - Errors are 401:
    - `StorageTokenInvalid` "Couldn't decode the StoreFileAuthorization token";
    - `StorageTokenExpired` "Store File Authorization expired";
    - `InvalidStorageToken` (another instance, a bad component).
- **`POST /api/storage/upload?token=…`** streams the body to the blob store, hashing as it goes.
  - Headers:
    - `Content-Type` is stored as is;
    - `Content-Length` is only logged;
    - `Digest: sha-256=<base64>` is checked against the hash;
    - a bad header gives 400 `BadHeader` `Bad header for <name>: …`.
  - The metadata row is committed after the upload, in its own transaction.
  - The answer is `{"storageId": "<_storage id>"}`.
  - **No size limit** (no body limit on the route; the docs mention a 2-minute timeout).

### 1.4 Downloads

`GET /api/storage/<uuid>[?component=]`:
- **The path must be the UUID,** not the document id. Otherwise: 400 `InvalidStoragePath`
  `Invalid storage path: "<x>". Please use storage.getUrl(...) …`.
- **Missing file:** 404 `{"code":"FileNotFound","message":"File <id> not found"}`.
- **Full response:** 200 with `Digest: sha-256=<base64>`, `Content-Type` (if stored), `Content-Length`,
  `Cache-Control: private, max-age=2592000` and `Accept-Ranges: bytes`. No ETag or Last-Modified.
- **Ranges:** one range gives 206 with `Content-Range` and no Digest; several, or an unsatisfiable one,
  give a bare 416. An unparsable `Range` header means the whole file. A 0-byte file is always 200.
- **HEAD** is answered as GET without the body.
- **CORS:** the `/api` CORS layer applies. It mirrors the `Origin` and the request headers, allows
  credentials and GET/POST/OPTIONS/PATCH/DELETE/PUT, and sets a max age of 86400.

### 1.5 Where the bytes live

- **Local:** `--local-storage <dir>` (the image uses `$DATA_DIR/storage`). Files go to
  `<dir>/files/<blob uuid>.blob`, written in place, then synced.
- **S3:** `--s3-storage`. The image picks it when its S3 variables are all set.
  - Variables: `S3_STORAGE_FILES_BUCKET` (one bucket per use: files, exports, modules, search,
    snapshot_imports), `AWS_REGION`, `S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE`, `AWS_S3_DISABLE_SSE`,
    `AWS_S3_DISABLE_CHECKSUMS`, and the AWS credential chain.
  - Keys are `<instance>-<uuid>/` + blob uuid. The prefix is stored in the database's globals and checked
    at boot.
  - Switching between local and S3 takes an export and an import.

### 1.6 The rest

- **Transaction limits** for files (10 files, 16 MiB, read and written) are declared but not enforced:
  the counter is never incremented.
- **Dashboard** (`system-udfs/convex/_system/frontend/fileStorageV2.ts`):
  - `numFiles`;
  - `fileMetadata` (paged by creation time, asc or desc, each file with its `url`);
  - `getFile`;
  - `deleteFile` / `deleteFiles` and `generateUploadUrl`, with audit-log entries;
  - uploads use the public upload URL, several in parallel.
- **Export and import:** `_storage/documents.jsonl` plus the blobs `_storage/<_id><ext>`. An import
  re-uploads the blobs and keeps `_id`, `_creationTime` and the UUID, so old URLs still work. That comes
  with Phase 3 item 8.

## 2. What an app can observe

- The methods, contexts, results and messages of §1.1, legacy UUID ids included.
- `getUrl` re-running a query when the file is deleted.
- `_storage` documents in their exact shape (base64 sha256, `contentType: null`).
- The upload protocol, the token's hour and its reuse.
- The download headers, ranges, 404 and CORS.
- `delete` of a missing file throwing.

## 3. How bunvex does it

### 3.1 Bytes: `@bunvex/file-storage`

- **One interface:** `put(key, stream) → {size, sha256}`, hashing while streaming (`Bun.CryptoHasher`);
  `get(key, range?)`; `delete(key)`.
- **Two backends:**
  - **Local:** `<dir>/files/<key>.blob`, as Convex lays it out. The directory defaults to
    `$STORAGE_DIR`, else `<DATA>/storage`, as Convex's image.
  - **S3:** Bun's built-in `S3Client`, which does multipart uploads and ranges. It reads Convex's variable
    names (none of them contains "convex"; DV-88 did the same for the database). Keys use the stored
    `<instance>-<uuid>/` prefix.
- **A conformance suite** for any backend: local always, S3 against MinIO when configured.

### 3.2 Metadata: `_storage`

- **Storage (F1).** As STUDY-30 S2, `_storage` is a real system table that holds the public fields plus
  hidden ones (`storageId` uuid, `storageKey`). `db.system` projects it to Convex's shape, with
  `contentType: null` when absent, `size` a float, and only the two public indexes. A
  `by_storage_id` index serves downloads and legacy ids.
- **`ctx.storage`** follows §1.1 with Convex's messages (the docs link dropped, DV-03):
  - `getUrl` and `getMetadata` read through the transaction, so they are reactive;
  - `delete` writes in it, so it is transactional;
  - in actions each call is its own transaction;
  - `get` / `store` exist in actions and HTTP actions;
  - `store` from a mutation gives Convex's "not supported" error.

### 3.3 HTTP

- **Routes** on the API port, with Convex's `/api` CORS:
  - `POST /api/storage/upload?token=`: the body streams to the backend, hashing, then the row is
    committed. `Digest` is checked; the answer is `{storageId}`.
  - `GET` (and HEAD) `/api/storage/<uuid>`: Convex's headers and range rules.
- **Upload tokens:** AES-256-GCM with a key derived from the instance secret (STUDY-17), hex, carrying the
  issue time. They are valid for an hour, reusable, and fail with Convex's codes and messages. The format
  is opaque, as Convex's is.
- **Origins (F2):** URLs use the API's public origin; HTTP actions' `siteUrl` uses the site's. Both can be
  configured.
- **Upload size (F4):** see §4.

### 3.4 PRs

1. `@bunvex/file-storage`: the local and S3 backends, and the conformance suite.
2. `_storage`, `ctx.storage`, `db.system("_storage")`, the upload and download routes, tokens and CORS.
3. The dashboard's system functions (`fileStorageV2`), mapped to the files contract (UI-01 §14).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| F1 | `_storage` is a real system table projected to the public shape (hidden `storageId` / `storageKey`), not a virtual table over `_file_storage` | same documents, ids and indexes for apps; as STUDY-30 S2 (DV-140) | **accepted** (owner, 2026-10-01) |
| F2 | The public origins are configured as `BUNVEX_CLOUD_ORIGIN` / `BUNVEX_SITE_ORIGIN` (and `cloudOrigin` / `siteOrigin` options), not `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` | owner rule: no "convex" in shipped names | **accepted** (owner, 2026-10-01) |
| F3 | A deleted file's bytes are removed after the deleting transaction commits, and a sweep removes blobs no row points to (failed or abandoned uploads, after an hour). Convex never removes them | not observable through the API (the URL already answers 404); without it disk use only grows | **accepted** (owner, 2026-10-01); **reversed** (owner, 2026-10-05, STUDY-130): bytes stay, as Convex |
| F4 | Uploads have no size limit, as Convex: the upload route is exempt from `maxRequestBodySize` (H3), and other routes keep their caps | Bun applies one cap to a whole server, so the exemption needs its own path (the API server's cap raised, other routes checked per route) | **accepted** (owner, 2026-10-01) |

Recorded in [docs/parity/divergences.md](../parity/divergences.md) as DV-148–DV-151 (decided).

## 5. Tests

- **Backends:** put/get/range/delete, the hash while streaming, a missing key, large files (multipart on
  S3).
- **API, per context:**
  - every message of §1.1;
  - legacy UUID ids;
  - `getUrl` reactive (a subscription re-runs on delete);
  - `delete` transactional and throwing on a missing file;
  - `store` refused in mutations;
  - `get` streaming and null.
- **`_storage`:** the exact projected shape (base64 sha256, `contentType: null`, float size), the indexes,
  `db.system.get`.
- **HTTP:**
  - upload with and without `Content-Type` and `Digest` (and a mismatch);
  - the expired and invalid tokens (with a test clock); the token reused within its hour;
  - download headers; one range; several ranges; an invalid range; the 0-byte file; HEAD; 404; the bad
    path; CORS.
- **Through the official client:** `generateUploadUrl` from a mutation, a `fetch` upload, `getUrl` in a
  subscribed query.
- **F3:** bytes gone after a committed delete, kept after a rolled-back one; orphan sweep.
- **Performance:** upload and download throughput (MB/s) on local disk, against a plain file copy.

## 6. Open questions

- Components (`?component=`) wait for Phase 4.
- Export and import of files come with Phase 3 item 8.
