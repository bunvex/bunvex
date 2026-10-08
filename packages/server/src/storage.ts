// File storage (STUDY-32), as Convex's crates/file_storage, crates/model/src/file_storage,
// crates/local_backend/src/storage.rs and npm-packages/convex/src/server/storage.ts:
// - Each file is a `_file_storage` document, as Convex's `FileStorageEntry` (STUDY-125): `storageId` (the UUID
//   in URLs), `storageKey` (the blob's key in the backend), `sha256` (bytes), `size` (int64), `contentType`.
//   Apps see it as the virtual `_storage` (core's virtual-tables.ts), with the same ids. Ids are `_storage`
//   document ids, or (legacy) the UUID.
// - `ctx.storage` reads and writes through the transaction (getUrl is reactive, delete transactional); in
//   actions each call is its own transaction. Deleting removes the row only: the blob stays, as Convex's
//   (STUDY-130; a reader at an earlier snapshot, an export, can still read it).
// - Uploads: a token valid for an hour (reusable), `POST /api/storage/upload?token=`, the body streamed to the
//   backend and hashed. Downloads: `GET /api/storage/<uuid>`, Convex's headers and single-range rule.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  BackendIsNotRunningError,
  type Engine,
  FILE_STORAGE_TABLE,
  type FileStorageDoc,
  isStopped,
  opaqueToInspect,
  readBackendState,
  type Tx,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { decodeId, type GenericId } from "@bunvex/values";
import { readCanonicalUrls } from "./canonical-urls.ts";
import { SpecBlob } from "./web-blob.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Convex's STORE_FILE_AUTHORIZATION_VALIDITY. */
export const UPLOAD_TOKEN_VALIDITY_MS = 60 * 60 * 1000;
/** Convex's MAX_CACHE_AGE for downloads. */
const CACHE_CONTROL = "private, max-age=2592000";

/** A `_file_storage` document, its sha256 in base64 and its size a number. */
export type StorageRow = {
  _id: string;
  _creationTime: number;
  storageId: string;
  storageKey: string;
  sha256: string;
  size: number;
  contentType: string | null;
};

const rowOf = (d: Record<string, unknown> | null): StorageRow | null => {
  if (!d) return null;
  const f = d as unknown as FileStorageDoc;
  return {
    _id: f._id,
    _creationTime: f._creationTime,
    storageId: f.storageId,
    storageKey: f.storageKey,
    sha256: Buffer.from(f.sha256).toString("base64"),
    size: Number(f.size),
    contentType: f.contentType ?? null,
  };
};

/** An error with Convex's code, as the HTTP routes answer it (`{code, message}`). */
/** An action's storage call: one call, with the bytes it read or wrote. */
export type StorageMeter = (call: { read?: number; written?: number }) => void;

export class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (b64s: string) => Buffer.from(b64s, "base64").toString("hex");

export class FileStorage {
  private readonly tokenKey: Buffer;

  constructor(
    readonly engine: Engine,
    readonly blobs: BlobStore,
    /** The API's public origin: upload and download URLs start with it (Convex's cloud origin; F2). */
    readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {
    this.tokenKey = Buffer.from(engine.secretKey("store file authorization"));
  }

  // ---------------------------------------------------------------- upload tokens

  /** An upload token: hex(version 1 ‖ 12-byte nonce ‖ AES-256-GCM(issued seconds) ‖ tag), the version as AAD. */
  uploadToken(): string {
    const version = Buffer.from([1]);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.tokenKey, nonce);
    cipher.setAAD(version);
    const body = Buffer.concat([
      cipher.update(JSON.stringify({ issued: Math.floor(this.now() / 1000) })),
      cipher.final(),
    ]);
    return Buffer.concat([version, nonce, body, cipher.getAuthTag()]).toString("hex");
  }

  /** An upload URL under `origin` (the canonical cloud URL, if set; else the server's). */
  uploadUrl(origin = this.origin): string {
    return `${origin}/api/storage/upload?token=${this.uploadToken()}`;
  }

  /**
   * The public origin of file URLs, read in `db`'s transaction: the canonical cloud URL if set (Convex's
   * `generate_upload_url` and `get_url`), else the server's.
   */
  async originIn(db: Tx): Promise<string> {
    return (await readCanonicalUrls(db)).cloud?.replace(/\/$/, "") ?? this.origin;
  }

  /** Convex's checks of a token: it decodes, and was issued less than an hour ago. Not single-use. */
  checkToken(token: string | null) {
    const invalid = () =>
      new StorageError(401, "StorageTokenInvalid", "Couldn't decode the StoreFileAuthorization token");
    if (!token || !/^[0-9a-f]+$/i.test(token)) throw invalid();
    const raw = Buffer.from(token, "hex");
    if (raw.length < 1 + 12 + 16 || raw[0] !== 1) throw invalid();
    let issued: number;
    try {
      const d = createDecipheriv("aes-256-gcm", this.tokenKey, raw.subarray(1, 13));
      d.setAAD(raw.subarray(0, 1));
      d.setAuthTag(raw.subarray(raw.length - 16));
      issued = (
        JSON.parse(Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString()) as {
          issued: number;
        }
      ).issued;
    } catch {
      throw invalid();
    }
    if (issued * 1000 + UPLOAD_TOKEN_VALIDITY_MS <= this.now())
      throw new StorageError(401, "StorageTokenExpired", "Store File Authorization expired");
  }

  // ---------------------------------------------------------------- ids and rows

  /**
   * The row an id names: a `_storage` id, or a legacy UUID; null when there is no such file. The messages are
   * Convex's, wrapped as ``Invalid argument `storageId` for `<method>`: …``.
   */
  async resolve(db: Tx, id: unknown, method: string): Promise<StorageRow | null> {
    const arg = (cause: string) => new Error(`Invalid argument \`storageId\` for \`${method}\`: ${cause}`);
    if (typeof id !== "string")
      throw arg(
        `Invalid storage ID: "${String(id)}". Storage ID should be an Id of '_storage' table, or a UUID string.`,
      );
    // A `_storage` id is a `_file_storage` one: the virtual table shares its number.
    const docId = db.asSystemSync(() => db.normalizeId(FILE_STORAGE_TABLE, id));
    if (docId) return rowOf(await db.asSystem(() => db.get(FILE_STORAGE_TABLE, docId)));
    let isOtherId = false;
    try {
      decodeId(id);
      isOtherId = true;
    } catch {}
    if (isOtherId) throw arg("Invalid storage ID. Storage ID cannot be an ID on any table other than '_storage'.");
    if (UUID.test(id)) return this.byUuid(db, id.toLowerCase());
    throw arg(`Invalid storage ID: "${id}". Storage ID should be an Id of '_storage' table, or a UUID string.`);
  }

  async byUuid(db: Tx, uuid: string): Promise<StorageRow | null> {
    return rowOf(
      await db.asSystem(() =>
        db
          .query(FILE_STORAGE_TABLE)
          .withIndex("by_storage_id", (q) => q.eq("storageId", uuid))
          .unique(),
      ),
    );
  }

  urlOf(row: StorageRow, origin = this.origin) {
    return `${origin}/api/storage/${row.storageId}`;
  }

  /** The row of a stored blob, committed after the upload, in its own transaction (Convex: "to avoid OCC risk"). */
  async addRow(
    written: { key: string; size: number; sha256: Uint8Array },
    contentType: string | null,
  ): Promise<string> {
    return this.engine.mutation(
      (db) =>
        db.asSystem(() =>
          db.insert(FILE_STORAGE_TABLE, {
            storageId: crypto.randomUUID(),
            storageKey: written.key,
            sha256: written.sha256.slice().buffer as ArrayBuffer,
            size: BigInt(written.size),
            contentType,
          }),
        ),
      "_system/storage",
    );
  }

  /**
   * Delete a file's row in `db` (Convex's `delete_file`): the row only. The blob stays, as Convex never
   * removes one (STUDY-130), so a reader at an earlier snapshot (an export) still finds it.
   */
  async deleteIn(db: Tx, id: unknown, method = "storage.delete") {
    const row = await this.resolve(db, id, method);
    if (!row) throw new Error(`storage id ${String(id)} not found`);
    await db.asSystem(() => db.delete(FILE_STORAGE_TABLE, row._id));
  }

  /**
   * Store a blob (an action's `store`, an upload): the bytes first, then the row. A digest that does not
   * match fails after the bytes were written (as Convex), and the blob is removed.
   */
  async store(
    body: ReadableStream<Uint8Array> | Blob,
    contentType: string | null,
    expectedSha256?: string,
  ): Promise<string> {
    const written = await this.blobs.put(body);
    if (expectedSha256 !== undefined && expectedSha256 !== b64(written.sha256)) {
      await this.blobs.delete(written.key);
      throw new StorageError(
        400,
        "Sha256Mismatch",
        `Sha256 mismatch. Expected: ${expectedSha256} Actual: ${b64(written.sha256)}`,
      );
    }
    return this.addRow(written, contentType);
  }

  // ---------------------------------------------------------------- ctx.storage

  /** `ctx.storage` in a query: getUrl, getMetadata (deprecated). */
  reader(db: Tx) {
    return {
      getUrl: async (storageId: string) => {
        if (storageId === undefined) throw new TypeError("Must provide arg 1 `storageId` to `getUrl`");
        const row = await this.resolve(db, storageId, "storage.getUrl");
        return row ? this.urlOf(row, await this.originIn(db)) : null;
      },
      getMetadata: async (storageId: string) => {
        const row = await this.resolve(db, storageId, "storage.getMetadata");
        return (
          row && { storageId: row.storageId, sha256: hex(row.sha256), size: row.size, contentType: row.contentType }
        );
      },
    };
  }

  /** `ctx.storage` in a mutation: the reader, generateUploadUrl, delete; `store` refused as in Convex. */
  writer(db: Tx) {
    return {
      ...this.reader(db),
      generateUploadUrl: async () => this.uploadUrl(await this.originIn(db)),
      delete: async (storageId: string) => this.deleteIn(db, storageId),
      store: async (_blob: Blob, _opts?: { sha256?: string }): Promise<string> => {
        throw new Error(
          "ctx.storage.store() is not supported in queries and mutations yet. Please use an action, or ctx.storage.generateUploadUrl() to upload from a client.",
        );
      },
    };
  }

  /**
   * `ctx.storage` in an action (and an HTTP action): each call its own transaction; get and store, metered
   * through `meter` as Convex's action storage calls (STUDY-71): a call and the bytes stored or read.
   */
  actionWriter(meter?: StorageMeter) {
    const q = <T>(f: (db: Tx) => Promise<T>) => this.engine.query(f);
    // Convex's action storage callbacks (all but generateUploadUrl) refuse while the deployment is stopped.
    const running = <T>(f: (db: Tx) => Promise<T>) =>
      q(async (db) => {
        await this.ensureRunningIn(db);
        return f(db);
      });
    return {
      getUrl: (storageId: string) => running((db) => this.reader(db).getUrl(storageId)),
      getMetadata: (storageId: string) => running((db) => this.reader(db).getMetadata(storageId)),
      generateUploadUrl: async () => this.uploadUrl(await q((db) => this.originIn(db))),
      delete: (storageId: string) =>
        this.engine.mutation(async (db) => {
          await this.ensureRunningIn(db);
          return this.deleteIn(db, storageId);
        }, "_system/storage"),
      get: async (storageId: string): Promise<Blob | null> => {
        if (typeof storageId !== "string")
          throw new Error(`storage.get requires a string storageId but received ${storageId}`);
        // Convex reports `get`'s id errors as `storage.getMetadata`'s.
        const row = await running((db) => this.resolve(db, storageId, "storage.getMetadata"));
        if (!row) return null;
        const stream = await this.blobs.get(row.storageKey);
        if (!stream) return null;
        const bytes = await new Response(stream).arrayBuffer();
        meter?.({ read: bytes.byteLength });
        return new SpecBlob([bytes], row.contentType ? { type: row.contentType } : {});
      },
      // The new file's id, typed as Convex's `Id<"_storage">`: it passes to a `v.id("_storage")` argument as is.
      store: async (blob: Blob, opts?: { sha256?: string }): Promise<GenericId<"_storage">> => {
        if (!(blob instanceof Blob))
          throw new Error(
            "store() expects a Blob. If you are trying to store a Request, `await request.blob()` will give you the correct input.",
          );
        await this.ensureRunning();
        const id = await this.store(blob, blob.type === "" ? null : blob.type, opts?.sha256);
        meter?.({ written: blob.size });
        return id as GenericId<"_storage">;
      },
    };
  }

  /** Convex's `bail_if_not_running`: file storage refuses while the deployment is stopped (STUDY-63). */
  private async ensureRunningIn(db: Tx): Promise<void> {
    if (isStopped(await readBackendState(db))) throw new BackendIsNotRunningError();
  }

  private ensureRunning(): Promise<void> {
    return this.engine.query((db) => this.ensureRunningIn(db));
  }

  // ---------------------------------------------------------------- HTTP

  /** `POST /api/storage/upload?token=`: the body to the backend, hashed; `{storageId}`. */
  async upload(req: Request, url: URL): Promise<Response> {
    this.checkToken(url.searchParams.get("token"));
    await this.ensureRunning();
    let expected: string | undefined;
    const digest = req.headers.get("digest");
    if (digest !== null) {
      const m = /^sha-256=([A-Za-z0-9+/]+={0,2})$/i.exec(digest.trim());
      if (!m || Buffer.from(m[1], "base64").length !== 32)
        throw new StorageError(
          400,
          "BadHeader",
          `Bad header for digest: invalid sha-256 digest ${JSON.stringify(digest)}`,
        );
      expected = m[1];
    }
    const contentType = req.headers.get("content-type");
    const id = await this.store(req.body ?? new Blob([]), contentType, expected);
    return Response.json({ storageId: id });
  }

  /**
   * `GET /api/storage/<uuid>`: Convex's headers; one range gives 206, several or none satisfiable 416. The
   * body is metered as it is sent (Convex's `track_storage_egress` per chunk, `add_on_complete` once it ends
   * or the client leaves): `sent.chunk` per chunk, `sent.done` once with the file's id and the bytes sent.
   */
  async download(req: Request, uuid: string, sent?: DownloadMeter): Promise<Response> {
    if (!UUID.test(uuid))
      throw new StorageError(
        400,
        "InvalidStoragePath",
        `Invalid storage path: "${uuid}". Please use \`storage.getUrl(storageId: Id<"_storage">)\` to generate a valid URL to retrieve files.`,
      );
    const row = await this.engine.query(async (db) => {
      await this.ensureRunningIn(db);
      return this.byUuid(db, uuid.toLowerCase());
    });
    const missing = () => new StorageError(404, "FileNotFound", `File ${uuid} not found`);
    if (!row) throw missing();
    const headers: Record<string, string> = { "cache-control": CACHE_CONTROL, "accept-ranges": "bytes" };
    if (row.contentType) headers["content-type"] = row.contentType;
    const rangeHeader = req.headers.get("range");
    const range = rangeHeader === null || row.size === 0 ? null : parseRange(rangeHeader, row.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416 });
    const stored = await this.blobs.get(row.storageKey, range ?? undefined);
    if (!stored) throw missing();
    // A HEAD request sends no body: nothing to count, and its sized body keeps Bun's `content-length`.
    if (sent && req.method === "HEAD") sent.done?.(row._id, 0);
    const body = sent && req.method !== "HEAD" ? meteredDownload(stored, row._id, sent) : stored;
    if (range) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${row.size}`;
      headers["content-length"] = String(range.end - range.start + 1);
      return new Response(body, { status: 206, headers });
    }
    headers.digest = `sha-256=${row.sha256}`;
    headers["content-length"] = String(row.size);
    return new Response(body, { status: 200, headers });
  }
}

/** How a download's bytes are counted as they are sent. */
export type DownloadMeter = { chunk?: (bytes: number) => void; done?: (storageId: string, bytes: number) => void };

/**
 * `body` as it is sent: pulled only as the client reads (so what is counted is what went out), `done` called
 * once when it ends, fails, or the client leaves.
 */
function meteredDownload(body: ReadableStream<Uint8Array>, storageId: string, meter: DownloadMeter) {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    meter.done?.(storageId, bytes);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (finished) return; // the client left while this chunk was read
          if (done) {
            finish();
            controller.close();
            return;
          }
          bytes += value.byteLength;
          meter.chunk?.(value.byteLength);
          controller.enqueue(value);
        } catch (e) {
          if (finished) return;
          finish();
          controller.error(e);
        }
      },
      cancel(reason) {
        finish();
        void reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * A `Range` header against a file of `size` bytes: one satisfiable range, `unsatisfiable` (none, or several:
 * Convex serves one, "because underlying AWS S3 only supports a single range"), or null when the header does
 * not parse (the whole file, as Convex ignores it).
 */
export function parseRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return null;
  const specs = m[1].split(",").map((s) => s.trim());
  const ranges: { start: number; end: number }[] = [];
  for (const spec of specs) {
    const r = /^(\d*)-(\d*)$/.exec(spec);
    if (!r || (r[1] === "" && r[2] === "")) return null;
    let start: number;
    let end: number;
    if (r[1] === "") {
      const n = Number(r[2]);
      if (n === 0) continue;
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(r[1]);
      end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
      if (r[2] !== "" && Number(r[2]) < start) return null;
    }
    if (start < size) ranges.push({ start, end });
  }
  return ranges.length === 1 ? ranges[0] : "unsatisfiable";
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(FileStorage);
