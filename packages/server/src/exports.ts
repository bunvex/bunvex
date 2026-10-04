// Snapshot exports (STUDY-42 PR 1), as Convex's (crates/exports, crates/application/src/exports,
// crates/model/src/exports, crates/local_backend/src/snapshot_export.rs):
//
// - `_exports` rows: `requested` → `in_progress` (with `progress_message`) → `completed`, or `failed` /
//   `canceled`; one export at a time; timestamps in nanoseconds, as Convex stores them;
// - the export reads ONE snapshot: `_tables/documents.jsonl`, each user table's `documents.jsonl` (in `_id`
//   order, Convex's lossless encoding) and `generated_schema.jsonl` (`"uniform"`), smallest table first, and
//   with `includeStorage` `_storage/documents.jsonl` and every file as `_storage/<id><.ext>`;
// - the ZIP goes to the `exports` blob store; it expires 14 days after its start, and is deleted (with its
//   row) 30 days after that; a download does not check the expiration, as Convex's.
import { createHmac, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditLogActor,
  type Engine,
  EXPORTS_TABLE,
  formatBytes,
  insertAuditLogEvents,
  STORAGE_TABLE,
  SYSTEM_ACTOR,
  type Tx,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { formatExportFloat, toExportJson, type Value } from "@bunvex/values";
import { auditEvents } from "./audit-log.ts";
import { ZipFileWriter } from "./zip-writer.ts";

const NS_PER_MS = 1_000_000n;
const DAY_NS = 86_400_000n * NS_PER_MS;
/** Convex's DEFAULT_EXPORT_RETENTION, and the longest custom expiration. */
export const EXPORT_RETENTION_NS = 14n * DAY_NS;
const MAX_EXPIRATION_DAYS = 60n;
/** Convex's MAX_EXPIRED_SNAPSHOT_AGE: an expired export is deleted this long after its expiration. */
export const MAX_EXPIRED_SNAPSHOT_AGE_NS = 30n * DAY_NS;
/** Convex's MAX_FILE_STORAGE_EXPORT_SIZE_BYTES (1 TiB). */
export const MAX_FILE_STORAGE_EXPORT_BYTES = 2 ** 40;
const PAGE_SIZE = 1000;
const PROGRESS_INTERVAL_MS = 5000;
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const CACHE_CONTROL = "private, max-age=2592000";

export const EXPORT_README = `# Welcome to your bunvex snapshot export!

This ZIP file contains a snapshot of the tables in your bunvex deployment.

Documents for each table are listed as lines of JSON in
<table_name>/documents.jsonl files.

To restore it into a deployment, use \`bunvex import\` with this file.
`;

/** An export request or download refused, with Convex's code. */
export class ExportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ExportRow = {
  _id: string;
  _creationTime: number;
  state: "requested" | "in_progress" | "completed" | "failed" | "canceled";
  format: { format: "zip"; include_storage: boolean };
  component: null;
  requestor: "snapshotExport";
  expiration_ts?: bigint;
  start_ts?: bigint;
  complete_ts?: bigint;
  failed_ts?: bigint;
  canceled_ts?: bigint;
  progress_message?: string;
  zip_object_key?: string;
  size?: bigint;
};

/** Convex's thousands separators (`separate_with_commas`). */
const commas = (n: number) => n.toLocaleString("en-US");

/** A file extension for a content type (Convex's `mime2ext`; only a guess, ignored by import). */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/xml": "xml",
  "application/octet-stream": "bin",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/javascript": "js",
  "application/javascript": "js",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "oga",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const extensionOf = (contentType: string | null) => {
  const ext = contentType ? EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] : undefined;
  return ext ? `.${ext}` : "";
};

type StorageRow = {
  _id: string;
  _creationTime: number;
  storageId: string;
  storageKey: string;
  sha256: string;
  size: number;
  contentType: string | null;
};

export type ExportOptions = {
  /** The deployment's name, in download file names. */
  deploymentName: string;
  /** Where the archive is assembled before it is stored (default: the OS's temporary directory). */
  tmpDir?: string;
  /** The current time in ms (tests). */
  now?: () => number;
  /** The file storage total the usage gauges last measured (STUDY-73), null before they ran. */
  fileStorageBytes?: () => number | null;
};

export class ExportService {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tokenKey: Buffer;
  private readonly now: () => number;

  constructor(
    private readonly engine: Engine,
    private readonly store: BlobStore,
    /** The file storage's blobs (`_storage` files), when it is configured. */
    private readonly files: BlobStore | null,
    private readonly opts: ExportOptions,
  ) {
    this.tokenKey = Buffer.from(engine.secretKey("export download token"));
    this.now = opts.now ?? Date.now;
  }

  private nowNs = () => BigInt(Math.floor(this.now())) * NS_PER_MS;

  private sys<T>(fn: (db: Tx) => Promise<T>, write = false): Promise<T> {
    return write
      ? this.engine.mutation((db) => db.asSystem(() => fn(db)), "_system/exports")
      : this.engine.query((db) => db.asSystem(() => fn(db)));
  }

  /** Convex's `request_export`: one at a time. */
  async request(includeStorage: boolean, actor: AuditLogActor = SYSTEM_ACTOR): Promise<string> {
    // Convex's `ensure_export_file_storage_within_limit`, on the gauges' last total (none yet: no check).
    const files = includeStorage ? (this.opts.fileStorageBytes?.() ?? null) : null;
    if (files !== null && files > MAX_FILE_STORAGE_EXPORT_BYTES)
      throw new ExportError(
        400,
        "ExportFileStorageTooLarge",
        `File storage is too large to include in this backup (${formatBytes(files)} > maximum size ${formatBytes(MAX_FILE_STORAGE_EXPORT_BYTES)}). You can still create a tables-only backup. Restoring it replaces table data while leaving the target deployment's current file storage unchanged.`,
      );
    const id = await this.sys(async (db) => {
      for (const state of ["requested", "in_progress"])
        if (
          await db
            .query(EXPORTS_TABLE)
            .withIndex("by_state_and_ts", (q) => q.eq("state", state))
            .first()
        )
          throw new ExportError(400, "ExportInProgress", "There is already an export requested or in progress.");
      const id = await db.insert(EXPORTS_TABLE, {
        state: "requested",
        format: { format: "zip", include_storage: includeStorage },
        component: null,
        requestor: "snapshotExport",
        expiration_ts: this.nowNs() + EXPORT_RETENTION_NS,
      });
      await insertAuditLogEvents(db, [auditEvents.requestExport(id, includeStorage)], actor);
      return id;
    }, true);
    this.wake?.();
    return id;
  }

  /** The newest export (Convex's `_system/cli/exports:getLatest`), or null. */
  latest(db: Tx): Promise<ExportRow | null> {
    return db.asSystem(
      async () =>
        (await db
          .query(EXPORTS_TABLE)
          .withIndex("by_requestor", (q) => q.eq("requestor", "snapshotExport"))
          .order("desc")
          .first()) as unknown as ExportRow | null,
    );
  }

  private async row(id: string): Promise<ExportRow | null> {
    return this.sys(async (db) => (await db.get(EXPORTS_TABLE, id)) as unknown as ExportRow | null);
  }

  private async patch(id: string, fields: Record<string, unknown>) {
    await this.sys((db) => db.patch(EXPORTS_TABLE, id, fields), true);
  }

  /** Start the worker (the lease holder's) and the cleanup of expired exports. */
  start() {
    this.running ??= this.loop();
    this.cleanupTimer ??= setInterval(() => void this.cleanup().catch(() => {}), 30 * 60 * 1000);
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.running;
  }

  private async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      const next = await this.sys(async (db) => {
        for (const state of ["in_progress", "requested"]) {
          const r = await db
            .query(EXPORTS_TABLE)
            .withIndex("by_state_and_ts", (q) => q.eq("state", state))
            .first();
          if (r) return r as unknown as ExportRow;
        }
        return null;
      }).catch(() => null);
      if (!next) {
        // Every request goes through `request()`, which wakes the worker: nothing to poll.
        await new Promise<void>((done) => {
          this.wake = done;
        });
        this.wake = null;
        continue;
      }
      try {
        await this.run(next);
        backoff = 1000;
      } catch (e) {
        if (e instanceof ExportError) {
          await this.patch(next._id, { state: "failed", failed_ts: this.nowNs(), progress_message: undefined });
          continue;
        }
        if (this.stopped) return;
        // As Convex: a transient failure retries the export, with a backoff from 1 s to 15 minutes.
        console.error(`bunvex: export ${next._id} failed, retrying: ${(e as Error).message}`);
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 15 * 60 * 1000);
      }
    }
  }

  /** Export one row's snapshot (Convex's `export_and_mark_complete`). */
  private async run(r: ExportRow) {
    const startTs = this.nowNs();
    await this.patch(r._id, { state: "in_progress", start_ts: startTs, progress_message: "Beginning backup" });
    let lastProgress = 0;
    const progress = async (message: string, force = false) => {
      if (!force && this.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = this.now();
      await this.patch(r._id, { progress_message: message });
      const cur = await this.row(r._id);
      if (!cur || cur.state === "canceled") throw new Canceled();
    };
    // One snapshot for everything.
    const at = this.engine.committer.visibleTs;
    const zip = new ZipFileWriter(join(this.opts.tmpDir ?? tmpdir(), `bunvex-export-${r._id}.zip`));
    try {
      await zip.add("README.md", EXPORT_README);
      const catalog = this.engine.catalog;
      const tables = [...catalog.tables.values()]
        .filter((t) => !t.name.startsWith("_"))
        .sort((a, b) => a.number - b.number);
      await progress("Backing up _tables", true);
      await zip.add(
        "_tables/documents.jsonl",
        tables.map((t) => `{"name":${JSON.stringify(t.name)},"id":${t.number}}\n`).join(""),
      );
      // Each table compressed first, so they can be written smallest first, as Convex.
      const prepared = [];
      for (const t of tables) {
        await progress(`Backing up ${t.name}`, true);
        let written = 0;
        const self = this;
        const lines = async function* () {
          let last: string | null = null;
          for (;;) {
            const page = (await self.engine.query(
              (db) =>
                db
                  .query(t.name)
                  .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
                  .take(PAGE_SIZE),
              undefined,
              undefined,
              undefined,
              at,
            )) as Record<string, Value>[];
            if (!page.length) return;
            yield new TextEncoder().encode(page.map((d) => `${toExportJson(d)}\n`).join(""));
            written += page.length;
            last = page[page.length - 1]!._id as string;
            await progress(`Backing up ${t.name}: ${commas(written)} documents`);
            if (page.length < PAGE_SIZE) return;
          }
        };
        prepared.push({
          docs: await zip.prepare(`${t.name}/documents.jsonl`, lines()),
          schema: await zip.prepare(`${t.name}/generated_schema.jsonl`, '"uniform"\n'),
        });
      }
      prepared.sort((a, b) => a.docs.usize - b.docs.usize);
      for (const p of prepared) {
        await zip.append(p.docs);
        await zip.append(p.schema);
      }
      if (r.format.include_storage) await this.exportStorage(zip, at, progress);
      await progress("Uploading backup", true);
      const size = await zip.finish();
      const written = await this.store.put(Bun.file(zip.path).stream());
      await zip.discard();
      const cur = await this.row(r._id);
      if (!cur || cur.state !== "in_progress") {
        await this.store.delete(written.key);
        return;
      }
      // As Convex: `start_ts` becomes the snapshot's ts.
      await this.patch(r._id, {
        state: "completed",
        start_ts: BigInt(at) * 1000n,
        complete_ts: this.nowNs(),
        zip_object_key: written.key,
        size: BigInt(size),
        progress_message: undefined,
      });
    } catch (e) {
      await zip.discard();
      if (e instanceof Canceled) return;
      throw e;
    }
  }

  private async exportStorage(zip: ZipFileWriter, at: number, progress: (m: string, force?: boolean) => Promise<void>) {
    const rows: StorageRow[] = [];
    let last: string | null = null;
    for (;;) {
      const page = (await this.engine.query(
        (db) =>
          db.asSystem(() =>
            db
              .query(STORAGE_TABLE)
              .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
              .take(PAGE_SIZE),
          ),
        undefined,
        undefined,
        undefined,
        at,
      )) as unknown as StorageRow[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      last = page[page.length - 1]!._id;
    }
    let total = 0;
    for (const row of rows) {
      total += row.size;
      if (total > MAX_FILE_STORAGE_EXPORT_BYTES)
        throw new ExportError(
          400,
          "ExportFileStorageTooLarge",
          `File storage is too large to include in this backup (${formatBytes(total)} > maximum size ${formatBytes(MAX_FILE_STORAGE_EXPORT_BYTES)}). You can still create a tables-only backup. Restoring it replaces table data while leaving the target deployment's current file storage unchanged.`,
        );
    }
    await progress(`Backing up _storage: ${commas(rows.length)} / ${commas(rows.length)} entries (metadata)`, true);
    await zip.add(
      "_storage/documents.jsonl",
      rows
        .map(
          (r) =>
            `{"_id":${JSON.stringify(r._id)},"_creationTime":${formatExportFloat(r._creationTime)},"sha256":${JSON.stringify(r.sha256)},"size":${r.size},"contentType":${JSON.stringify(r.contentType)},"internalId":${JSON.stringify(r.storageId)}}\n`,
        )
        .join(""),
    );
    let n = 0;
    for (const row of rows) {
      const body = this.files ? await this.files.get(row.storageKey) : null;
      if (!body) throw new Error(`file missing from storage: ${row._id} with key ${row.storageKey}`);
      await zip.add(`_storage/${row._id}${extensionOf(row.contentType)}`, body as unknown as AsyncIterable<Uint8Array>);
      n++;
      await progress(`Backing up _storage: ${commas(n)} / ${commas(rows.length)} files (downloading)`);
    }
  }

  /** The completed export named by its id or its snapshot ts (Convex's `get_zip_export`). */
  async completed(idOrTs: string): Promise<ExportRow> {
    const row = await this.sys(async (db) => {
      if (/^\d+$/.test(idOrTs)) {
        const ts = BigInt(idOrTs);
        return (await db
          .query(EXPORTS_TABLE)
          .withIndex("by_state_and_ts", (q) => q.eq("state", "completed").eq("start_ts", ts))
          .first()) as unknown as ExportRow | null;
      }
      const id = db.normalizeId(EXPORTS_TABLE, idOrTs);
      if (!id) throw new ExportError(400, "BadSnapshotId", "Snapshot Id did not parse to an ID.");
      return (await db.get(EXPORTS_TABLE, id)) as unknown as ExportRow | null;
    });
    if (!row) throw new ExportError(404, "ExportNotFound", `The requested export ${idOrTs} was not found`);
    if (row.state !== "completed")
      throw new ExportError(400, "ExportNotComplete", `The requested export ${idOrTs} has not completed`);
    return row;
  }

  /** The ZIP, as Convex's download answers it. */
  async download(idOrTs: string): Promise<Response> {
    const row = await this.completed(idOrTs);
    const body = await this.store.get(row.zip_object_key!);
    if (!body) throw new ExportError(404, "ExportNotFound", `The requested export ${idOrTs} was not found`);
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(row.size),
        "content-disposition": `attachment; filename=snapshot_${this.opts.deploymentName}_${row.start_ts}.zip`,
        "cache-control": CACHE_CONTROL,
      },
    });
  }

  /** A short-lived download token for a browser (Convex's `request_zip_export_token`). */
  async token(idOrTs: string): Promise<string> {
    await this.completed(idOrTs);
    const expires = this.now() + DOWNLOAD_TOKEN_TTL_MS;
    const mac = createHmac("sha256", this.tokenKey).update(`${idOrTs}:${expires}`).digest("base64url");
    return `${expires}.${mac}`;
  }

  checkToken(idOrTs: string, token: string): boolean {
    const [expires, mac] = token.split(".");
    if (!expires || !mac || Number(expires) < this.now()) return false;
    const want = createHmac("sha256", this.tokenKey).update(`${idOrTs}:${expires}`).digest();
    const got = Buffer.from(mac, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Convex's `set_export_expiration`: completed exports only, not in the past, at most 60 days ahead. */
  async setExpiration(id: string, expirationTsNs: bigint, actor: AuditLogActor = SYSTEM_ACTOR) {
    const now = this.nowNs();
    if (expirationTsNs < now) throw new ExportError(400, "InvalidExpiration", "Snapshot expiration in past.");
    const days = (expirationTsNs - now) / DAY_NS;
    if (days > MAX_EXPIRATION_DAYS)
      throw new ExportError(
        400,
        "InvalidExpiration",
        `Snapshot expiration is ${days} days in the future. Must be <= ${MAX_EXPIRATION_DAYS}`,
      );
    const row = await this.completed(id);
    await this.sys(async (db) => {
      await db.patch(EXPORTS_TABLE, row._id, { expiration_ts: expirationTsNs });
      await insertAuditLogEvents(db, [auditEvents.setExportExpiration(id, expirationTsNs / 1_000_000n)], actor);
    }, true);
  }

  /** Convex's `cancel_export`: a requested or running export stops. */
  async cancel(id: string, actor: AuditLogActor = SYSTEM_ACTOR) {
    await this.sys(async (db) => {
      const nid = db.normalizeId(EXPORTS_TABLE, id);
      const row = nid ? ((await db.get(EXPORTS_TABLE, nid)) as unknown as ExportRow | null) : null;
      if (!row) throw new ExportError(404, "ExportNotFound", `The requested export ${id} was not found`);
      if (row.state !== "requested" && row.state !== "in_progress")
        throw new ExportError(400, "ExportNotCancelable", `The requested export ${id} has already ${row.state}`);
      await db.patch(EXPORTS_TABLE, row._id, {
        state: "canceled",
        canceled_ts: this.nowNs(),
        progress_message: undefined,
      });
      await insertAuditLogEvents(db, [auditEvents.cancelExport(id)], actor);
    }, true);
  }

  /** Delete exports past their age (Convex's `cleanup_expired_exports`), and their ZIPs. */
  async cleanup(): Promise<number> {
    const cutoff = this.nowNs() - MAX_EXPIRED_SNAPSHOT_AGE_NS;
    const old = await this.sys(async (db) => {
      const rows = (await db.query(EXPORTS_TABLE).collect()) as unknown as ExportRow[];
      return rows.filter(
        (r) =>
          (r.state === "completed" && (r.expiration_ts ?? 0n) < cutoff) ||
          (r.state === "failed" && (r.failed_ts ?? 0n) < cutoff) ||
          (r.state === "canceled" && (r.canceled_ts ?? 0n) < cutoff),
      );
    });
    for (const r of old) {
      await this.sys((db) => db.delete(EXPORTS_TABLE, r._id), true);
      if (r.zip_object_key) await this.store.delete(r.zip_object_key).catch(() => {});
    }
    return old.length;
  }
}

class Canceled extends Error {}
