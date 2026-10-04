// Snapshot imports (STUDY-42 PR 3), as Convex's (crates/application/src/snapshot_import,
// crates/model/src/snapshot_imports, crates/local_backend/src/snapshot_import.rs):
//
// - the file is uploaded to the `snapshot_imports` blob store (in parts, or in one request) and a
//   `_snapshot_imports` row is created, `uploaded`;
// - the worker parses it and counts what it would change: `waiting_for_confirmation`, with Convex's summary
//   and one checkpoint per table; a table that must be empty and is not fails the import there;
// - once confirmed (`in_progress`), every table is written into a NEW HIDDEN TABLE in batches — numbered
//   from `_tables` or the ids so references between tables stay valid, checked against the schema with the
//   tables as they will be — then ONE transaction makes them active, replacing the old ones (`--replace-all`
//   also deletes the tables the import does not have). Appending into an existing table writes it directly,
//   as Convex. A failed or canceled import's hidden tables are dropped;
// - the row ends `completed` (the activation's timestamp, the documents written) or `failed`, with the
//   message prefixed "Hit an error while importing:" as Convex's.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type Engine,
  ImportIdError,
  insertAuditLogEvents,
  OccError,
  referencedTables,
  SNAPSHOT_IMPORTS_TABLE,
  SYSTEM_ACTOR,
  schemaToJson,
  type TableDef,
  type Tx,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { decodeId, type Value } from "@bunvex/values";
import { auditEvents } from "./audit-log.ts";
import { INTERNAL_SERVER_ERROR_MESSAGE, isSystemError } from "./errors.ts";
import {
  confirmationMessage,
  ImportError,
  type ImportFormat,
  type ImportTable,
  InvalidZipError,
  type ParsedImport,
  parseSingleTable,
  parseZip,
  rowToDocument,
  type TableChange,
} from "./import-parse.ts";
import { ZipReader } from "./zip-reader.ts";

export { ImportError };

const NS_PER_US = 1000n;
/** Convex's MAX_IMPORT_AGE (7 days). */
export const MAX_IMPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Half of Convex's transaction limits (TRANSACTION_MAX_USER_WRITE_SIZE_BYTES / NUM_USER_WRITES), per batch. */
const BATCH_MAX_BYTES = 8 * 1024 * 1024;
const BATCH_MAX_DOCUMENTS = 8000;
const PAGE_SIZE = 1000;
/** Tables Convex reaches through a virtual name (its `_storage`, `_scheduled_functions`). */
const VIRTUAL_SYSTEM_TABLES = new Set(["_storage", "_scheduled_functions"]);

export type ImportMode = "RequireEmpty" | "Append" | "Replace" | "ReplaceAll";
/** The modes as the HTTP API names them. */
export const MODE_ARGS: Record<string, ImportMode> = {
  requireEmpty: "RequireEmpty",
  append: "Append",
  replace: "Replace",
  replaceAll: "ReplaceAll",
};

export type ImportState =
  | { state: "uploaded" }
  | { state: "waiting_for_confirmation"; message_to_confirm: string; require_manual_confirmation: boolean }
  | { state: "in_progress"; progress_message: string; checkpoint_messages: string[] }
  | { state: "completed"; timestamp: bigint; num_rows_written: bigint }
  | { state: "failed"; error_message: string };

export type Checkpoint = {
  component_path: null;
  display_table_name: string;
  tablet_id: string | null;
  total_num_rows_to_write: bigint;
  num_rows_written: bigint;
  existing_rows_in_table: bigint;
  existing_rows_to_delete: bigint;
  is_missing_id_field: boolean;
};

export type ImportRow = {
  _id: string;
  _creationTime: number;
  state: ImportState;
  format: ImportFormat;
  mode: ImportMode;
  component_path: null;
  fq_object_key: string;
  /** The upload's size, for reading a ZIP by ranges (bunvex's own field). */
  object_size: bigint;
  /** The hidden tables this import created, by name (bunvex's own field): resumed, or dropped if it fails. */
  hidden_tables?: { name: string; tablet: string }[];
  member_id: null;
  checkpoints: Checkpoint[] | null;
  requestor: { type: "snapshotImport" };
};

/** An import, or a request about one, refused with Convex's code. */
export class ImportRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class Canceled extends Error {}

const STABLE = new Set(["waiting_for_confirmation", "completed", "failed"]);
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const commas = (n: number) => n.toLocaleString("en-US");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export type ImportOptions = {
  /** The current time in ms (tests). */
  now?: () => number;
  /** The backoff between attempts after a system error (Convex's: 30 s doubling to 5 minutes). */
  retryBackoffMs?: { initial: number; max: number };
};

/** Convex's SNAPSHOT_IMPORT_MAX_SYSTEM_FAILURES: after this many retries a system error fails the import. */
export const MAX_SYSTEM_FAILURES = 5;

/** The blob store failed (Convex's storage errors): not the import's fault, so retried. */
class StorageFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * A failure of the system rather than of the import's content, which Convex retries (an error without
 * `ErrorMetadata`): a storage failure, a server error, a conflict that outlasted its retries.
 */
const isRetryable = (e: unknown) => e instanceof StorageFailure || isSystemError(e) || e instanceof OccError;

/** A stream whose read errors are storage failures. */
function storageStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try {
        r = await reader.read();
      } catch (e) {
        throw new StorageFailure(e);
      }
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel: (why) => reader.cancel(why),
  });
}

export class ImportService {
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  /** Resolved whenever a row changes, for `waitStable`. */
  private changed: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
  private readonly tokenKey: Buffer;
  private readonly now: () => number;
  private readonly backoff: { initial: number; max: number };
  /** The import the worker is running, if any. */
  private current: string | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly store: BlobStore,
    /** The file storage's blobs, to restore `_storage` files into. */
    private readonly files: BlobStore | null,
    opts: ImportOptions = {},
  ) {
    this.tokenKey = Buffer.from(engine.secretKey("snapshot import upload"));
    this.now = opts.now ?? Date.now;
    this.backoff = opts.retryBackoffMs ?? { initial: 30_000, max: 300_000 };
  }

  private sys<T>(fn: (db: Tx) => Promise<T>, write = false): Promise<T> {
    return write
      ? this.engine.mutation((db) => db.asSystem(() => fn(db)), "_system/snapshot_import")
      : this.engine.query((db) => db.asSystem(() => fn(db)));
  }

  private notify() {
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }

  async row(id: string): Promise<ImportRow | null> {
    return this.sys(async (db) => {
      const nid = db.normalizeId(SNAPSHOT_IMPORTS_TABLE, id);
      return nid ? ((await db.get(SNAPSHOT_IMPORTS_TABLE, nid)) as unknown as ImportRow | null) : null;
    });
  }

  private async mustGet(db: Tx, id: string): Promise<ImportRow> {
    const nid = db.normalizeId(SNAPSHOT_IMPORTS_TABLE, id);
    const row = nid ? ((await db.get(SNAPSHOT_IMPORTS_TABLE, nid)) as unknown as ImportRow | null) : null;
    if (!row) throw new ImportRequestError(404, "ImportNotFound", `import ${id} not found`);
    return row;
  }

  /** Convex's `update_state`, with its allowed transitions. */
  private async setState(db: Tx, id: string, next: (cur: ImportState) => ImportState) {
    const row = await this.mustGet(db, id);
    const to = next(row.state);
    const ok =
      (row.state.state === "uploaded" && (to.state === "waiting_for_confirmation" || to.state === "failed")) ||
      (row.state.state === "waiting_for_confirmation" && (to.state === "in_progress" || to.state === "failed")) ||
      (row.state.state === "in_progress" &&
        (to.state === "in_progress" || to.state === "completed" || to.state === "failed"));
    if (!ok) throw new Error(`invalid import state transition ${row.state.state} -> ${to.state}`);
    await db.patch(SNAPSHOT_IMPORTS_TABLE, row._id, { state: to });
  }

  private async write(fn: (db: Tx) => Promise<void>) {
    await this.sys(fn, true);
    this.notify();
  }

  // ---------------------------------------------------------------- uploads and requests

  /** Store an upload in one piece (the one-shot `/api/import`). */
  upload(body: ReadableStream<Uint8Array> | Uint8Array) {
    return this.store.put(body);
  }

  startUpload(): string {
    return crypto.randomUUID();
  }

  private mac(uploadToken: string, key: string) {
    return createHmac("sha256", this.tokenKey).update(`${uploadToken}:${key}`).digest("base64url");
  }

  /** Store one part; its token names it, signed for this upload. */
  async uploadPart(uploadToken: string, part: Uint8Array): Promise<string> {
    const written = await this.store.put(part);
    return `${written.key}.${this.mac(uploadToken, written.key)}`;
  }

  /** Join the parts, in order, into the upload; the parts are deleted. */
  async finishUpload(uploadToken: string, partTokens: string[]): Promise<{ key: string; size: number }> {
    const keys = partTokens.map((t) => {
      const dot = t.lastIndexOf(".");
      const key = t.slice(0, dot);
      const want = Buffer.from(this.mac(uploadToken, key));
      const got = Buffer.from(t.slice(dot + 1));
      if (dot < 0 || got.length !== want.length || !timingSafeEqual(got, want))
        throw new ImportRequestError(400, "InvalidUploadToken", "An upload part token is not valid for this upload.");
      return key;
    });
    const store = this.store;
    const joined = streamFrom(
      (async function* () {
        for (const k of keys) {
          const body = await store.get(k);
          if (!body) throw new ImportRequestError(400, "InvalidUploadToken", "An upload part is missing.");
          yield* body as unknown as AsyncIterable<Uint8Array>;
        }
      })(),
    );
    const written = await this.store.put(joined);
    for (const k of keys) await this.store.delete(k).catch(() => {});
    return { key: written.key, size: written.size };
  }

  /** Convex's `start_import`: the row, `uploaded`; the worker takes it from there. */
  async start(format: ImportFormat, mode: ImportMode, upload: { key: string; size: number }): Promise<string> {
    let id = "";
    await this.write(async (db) => {
      id = await db.insert(SNAPSHOT_IMPORTS_TABLE, {
        state: { state: "uploaded" },
        format,
        mode,
        component_path: null,
        fq_object_key: upload.key,
        object_size: BigInt(upload.size),
        member_id: null,
        checkpoints: null,
        requestor: { type: "snapshotImport" },
      });
    });
    this.wake?.();
    return id;
  }

  /** Convex's `confirm_import`: a no-op unless it is waiting for confirmation. */
  async perform(id: string) {
    await this.write(async (db) => {
      const row = await this.mustGet(db, id);
      if (row.state.state === "waiting_for_confirmation")
        await this.setState(db, id, () => ({
          state: "in_progress",
          progress_message: "Importing",
          checkpoint_messages: [],
        }));
    });
    this.wake?.();
  }

  /** Convex's `cancel_import`. */
  async cancel(id: string) {
    await this.write(async (db) => {
      const row = await this.mustGet(db, id);
      if (row.state.state === "completed" || row.state.state === "failed")
        throw new ImportRequestError(
          400,
          "CannotCancelImport",
          `Cannot cancel an import that has ${row.state.state === "completed" ? "completed" : "failed"}`,
        );
      await this.setState(db, id, () => ({ state: "failed", error_message: "Import canceled" }));
    });
    // The worker drops a running import's tables itself, when it sees the cancellation.
    if (this.current !== id) await this.dropHidden(id);
  }

  /** Drop the hidden tables a failed or canceled import created. */
  private async dropHidden(id: string) {
    // Best effort, never thrown (the worker calls it from its loop): tables a failure leaves behind are
    // dropped later by `cleanup()`, as a crash's are.
    try {
      const row = await this.row(id);
      const tablets = (row?.hidden_tables ?? []).map((h) => Number(h.tablet));
      if (tablets.length) await this.engine.dropHiddenTables(tablets);
    } catch (e) {
      if (!this.engine.committer.stopped)
        console.error(`bunvex: import ${id}: dropping its tables failed, left to the cleanup: ${(e as Error).message}`);
    }
  }

  /** Wait until the import is waiting for confirmation, completed or failed (Convex's `wait_for_import_worker`). */
  async waitStable(id: string): Promise<ImportRow> {
    for (;;) {
      const changed = this.changed.promise;
      const row = await this.sys((db) => this.mustGet(db, id));
      if (STABLE.has(row.state.state)) return row;
      await Promise.race([changed, Bun.sleep(1000)]);
    }
  }

  /** The one-shot import (Convex's `do_import`): the documents written. */
  async importNow(format: ImportFormat, mode: ImportMode, upload: { key: string; size: number }): Promise<number> {
    const id = await this.start(format, mode, upload);
    let row = await this.waitStable(id);
    if (row.state.state === "failed") throw new ImportRequestError(400, "ImportFailed", row.state.error_message);
    await this.perform(id);
    row = await this.waitStable(id);
    if (row.state.state === "failed") throw new ImportRequestError(400, "ImportFailed", row.state.error_message);
    if (row.state.state !== "completed") throw new Error(`should be done, is ${row.state.state}`);
    return Number(row.state.num_rows_written);
  }

  // ---------------------------------------------------------------- the worker

  /** Start the worker (the lease holder's). */
  startWorker() {
    this.running ??= this.loop();
    this.cleanupTimer ??= setInterval(() => void this.cleanup().catch(() => {}), 30 * 60 * 1000);
  }

  /**
   * Drop hidden tables left behind for more than twice the import age limit (Convex's system-table cleanup):
   * an import's own are dropped when it fails, so these are a crash's.
   */
  cleanup(): Promise<number> {
    return this.engine.dropStaleHiddenTables(2 * MAX_IMPORT_AGE_MS, this.now());
  }

  async stop() {
    this.stopped = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.wake?.();
    await this.running;
  }

  private async loop() {
    let failures = 0;
    let readFailures = 0;
    while (!this.stopped) {
      let next: ImportRow | null;
      try {
        next = await this.sys(async (db) => {
          const rows = (await db.query(SNAPSHOT_IMPORTS_TABLE).collect()) as unknown as ImportRow[];
          // As Convex's worker: a new upload first, then an import to run.
          return (
            rows.find((r) => r.state.state === "uploaded") ?? rows.find((r) => r.state.state === "in_progress") ?? null
          );
        });
        readFailures = 0;
      } catch (e) {
        // As Convex's worker loop: logged, retried with backoff; never out of the loop (an unhandled rejection
        // would end the process).
        if (this.stopped || this.engine.committer.stopped) return;
        const delay =
          Math.min(this.backoff.initial * 2 ** readFailures++, this.backoff.max) * (0.5 + Math.random() / 2);
        console.error(`bunvex: imports: finding the next import failed, retrying: ${(e as Error).message}`);
        // Woken early by a request or a stop.
        await Promise.race([
          Bun.sleep(delay),
          new Promise<void>((done) => {
            this.wake = done;
          }),
        ]);
        this.wake = null;
        continue;
      }
      if (!next) {
        await new Promise<void>((done) => {
          this.wake = done;
        });
        this.wake = null;
        continue;
      }
      this.current = next._id;
      try {
        if (next.state.state === "uploaded") await this.confirmable(next);
        else await this.run(next);
        failures = 0;
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof Canceled) {
          await this.dropHidden(next._id);
          continue;
        }
        // As Convex's worker: a system error is retried (the next attempt resumes from the checkpoints) with a
        // backoff, until it has failed too often; an error of the import's own fails it at once.
        if (isRetryable(e) && failures < MAX_SYSTEM_FAILURES) {
          const delay = Math.min(this.backoff.initial * 2 ** failures, this.backoff.max) * (0.5 + Math.random() / 2);
          failures++;
          console.error(`bunvex: import ${next._id} failed, retrying: ${(e as Error).message}`);
          // Not running while it waits: a cancellation meanwhile drops its tables itself.
          this.current = null;
          await Promise.race([
            Bun.sleep(delay),
            new Promise<void>((done) => {
              this.wake = done;
            }),
          ]);
          this.wake = null;
          continue;
        }
        failures = 0;
        // Its tables go first, so whoever sees it failed sees nothing left behind.
        await this.dropHidden(next._id);
        const msg = isRetryable(e)
          ? INTERNAL_SERVER_ERROR_MESSAGE
          : `Hit an error while importing:\n${e instanceof Error ? e.message : String(e)}`;
        await this.write((db) => this.setState(db, next._id, () => ({ state: "failed", error_message: msg }))).catch(
          () => {},
        );
      } finally {
        this.current = null;
      }
    }
  }

  private failIfTooOld(row: ImportRow) {
    if (this.now() - row._creationTime > MAX_IMPORT_AGE_MS)
      throw new ImportError("ImportFailed", "Import took too long. Try again.");
  }

  private async parse(row: ImportRow): Promise<ParsedImport> {
    const key = row.fq_object_key;
    const store = this.store;
    const get = async (range?: { start: number; end: number }) => {
      let body: ReadableStream<Uint8Array> | null;
      try {
        body = await store.get(key, range);
      } catch (e) {
        throw new StorageFailure(e);
      }
      if (!body) throw new Error(`the uploaded import ${key} is missing`);
      return storageStream(body);
    };
    if (row.format.format !== "zip")
      return parseSingleTable(row.format, async () => (await get()) as unknown as AsyncIterable<Uint8Array>);
    const zip = await ZipReader.open({
      size: Number(row.object_size),
      read: async (start, end) => new Uint8Array(await new Response(await get({ start, end })).arrayBuffer()),
      stream: (start, end) => get({ start, end }),
    });
    return parseZip(zip);
  }

  /** The documents of an active table. */
  private async count(t: TableDef): Promise<number> {
    let n = 0;
    let last: string | null = null;
    for (;;) {
      const page = await this.engine.query((db) =>
        db.asSystem(() =>
          db
            .queryDef(t)
            .withIndex("by_id", (q) => (last === null ? q : q.gt("_id", last)))
            .take(PAGE_SIZE),
        ),
      );
      n += page.length;
      if (page.length < PAGE_SIZE) return n;
      last = page[page.length - 1]!._id as string;
    }
  }

  /** `_tables` rows: names and numbers (Convex's `parse_tables_table`). */
  private async *tablesEntries(t: ImportTable): AsyncGenerator<{ name: string; number: number }> {
    let n = 0;
    for await (const r of t.rows()) {
      n++;
      const o = r.json as Record<string, unknown>;
      if (!o || typeof o !== "object" || Array.isArray(o))
        throw new ImportError("NotAnObject", `Row ${n} wasn't an object`);
      if (typeof o.name !== "string")
        throw new ImportError("InvalidValue", `Row ${n} wasn't a valid value: table requires name`);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(o.name))
        throw new ImportError(
          "InvalidName",
          `${JSON.stringify(o.name)} isn't a valid table name: not a valid table name`,
        );
      const id = o.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 0xffffffff)
        throw new ImportError(
          "InvalidValue",
          `Row ${n} wasn't a valid value: table requires id (received ${JSON.stringify(id) ?? "nothing"})`,
        );
      yield { name: o.name, number: id };
    }
  }

  /** Parse and count: the confirmation message and checkpoints (Convex's `messages_to_confirm_replace`). */
  private async confirmable(row: ImportRow) {
    try {
      this.failIfTooOld(row);
      const parsed = await this.parse(row);
      const counts = new Map<string, number>();
      const missingId = new Set<string>();
      for (const t of parsed.tables) {
        let n = 0;
        if (t.name === "_tables")
          for await (const e of this.tablesEntries(t)) counts.set(e.name, counts.get(e.name) ?? 0);
        for await (const r of t.rows()) {
          n++;
          const o = r.json as Record<string, unknown> | null;
          if (!missingId.has(t.name) && !(o && typeof o === "object" && !Array.isArray(o) && "_id" in o))
            missingId.add(t.name);
        }
        counts.set(t.name, (counts.get(t.name) ?? 0) + n);
      }
      if (row.mode === "ReplaceAll")
        for (const t of this.engine.catalog.tables.values())
          if (!t.name.startsWith("_") && !counts.has(t.name)) counts.set(t.name, 0);
      const changes: (TableChange & { missingId: boolean })[] = [];
      for (const name of [...counts.keys()].sort(byteOrder)) {
        const isStorage = name === "_storage";
        if (name.startsWith("_") && !isStorage) continue;
        const active = this.engine.catalog.tables.get(name);
        const existing = active ? await this.count(active) : 0;
        let deleted = 0;
        if (row.mode === "Replace" || row.mode === "ReplaceAll") deleted = existing;
        else if (row.mode === "RequireEmpty" && existing > 0)
          throw new ImportError(
            "TableExists",
            `Table ${name} already exists. Please choose a new table name or use replace/append modes.`,
          );
        changes.push({
          table: name,
          added: counts.get(name)!,
          deleted,
          existing,
          unit: isStorage ? " files" : "",
          missingId: missingId.has(name),
        });
      }
      const checkpoints: Checkpoint[] = changes.map((c) => ({
        component_path: null,
        display_table_name: c.table,
        tablet_id: null,
        total_num_rows_to_write: BigInt(c.added),
        num_rows_written: 0n,
        existing_rows_in_table: BigInt(c.existing),
        existing_rows_to_delete: BigInt(c.deleted),
        is_missing_id_field: c.missingId,
      }));
      await this.write(async (db) => {
        await this.setState(db, row._id, () => ({
          state: "waiting_for_confirmation",
          message_to_confirm: confirmationMessage(changes),
          // Deleting documents or files needs a manual confirmation.
          require_manual_confirmation: changes.some((c) => c.deleted > 0),
        }));
        await db.patch(SNAPSHOT_IMPORTS_TABLE, row._id, { checkpoints });
      });
    } catch (e) {
      throw this.userError(e);
    }
  }

  /** A content error as Convex words it. */
  private userError(e: unknown): unknown {
    if (e instanceof ImportIdError) return new ImportError(e.code, e.message);
    if (e instanceof InvalidZipError) return new ImportError("InvalidZip", e.message);
    return e;
  }

  // ---------------------------------------------------------------- progress

  private async progress(id: string, message: string, table: string, written: number, checkpoint = false) {
    const update = async (db: Tx) => {
      const row = await this.mustGet(db, id);
      if (row.state.state !== "in_progress") throw new Canceled();
      let noop = false;
      const checkpoints = (row.checkpoints ?? []).map((c) => {
        if (c.display_table_name !== table) return c;
        if ((checkpoint || c.num_rows_written > 0n) && BigInt(written) <= c.num_rows_written) {
          noop = true;
          return c;
        }
        return { ...c, num_rows_written: BigInt(written) };
      });
      const messages = [...row.state.checkpoint_messages];
      if (checkpoint && !messages.includes(message)) messages.push(message);
      if (noop && !checkpoint) return;
      await db.patch(SNAPSHOT_IMPORTS_TABLE, row._id, {
        checkpoints,
        state: {
          state: "in_progress",
          progress_message: noop ? row.state.progress_message : message,
          checkpoint_messages: messages,
        },
      });
    };
    if (checkpoint) await this.write(update);
    // Best effort, as Convex's: a progress message is not worth failing the import for.
    else
      await this.write(update).catch((e) => {
        if (e instanceof Canceled) throw e;
      });
  }

  // ---------------------------------------------------------------- running an import

  /** Table numbers (Convex's `assign_table_numbers`): from `_tables`, then the first `_id`, then the existing table's. */
  private async assignNumbers(
    mode: ImportMode,
    tablesTables: ImportTable[],
    tables: ImportTable[],
  ): Promise<Map<string, number | undefined>> {
    const toNumber = new Map<string, number | undefined>();
    const numberToName = new Map<number, string>();
    const assign = (name: string, n: number) => {
      const other = numberToName.get(n);
      if (other !== undefined)
        throw new ImportError("InvalidId", `conflict between \`${other}\` and \`${name}\` with number ${n}`);
      numberToName.set(n, name);
    };
    for (const t of tablesTables)
      for await (const e of this.tablesEntries(t)) {
        if (toNumber.has(e.name))
          throw new ImportError("DuplicateTableName", `\`_tables\` contains duplicate entries for \`${e.name}\``);
        toNumber.set(e.name, e.number);
        assign(e.name, e.number);
      }
    for (const t of tables) {
      if (toNumber.has(t.name)) continue;
      let first: unknown;
      for await (const r of t.rows()) {
        first = r.json;
        break;
      }
      const id = first && typeof first === "object" ? (first as { _id?: unknown })._id : undefined;
      if (typeof id !== "string") continue;
      let n: number;
      try {
        n = decodeId(id).tableNumber;
      } catch {
        continue;
      }
      toNumber.set(t.name, n);
      assign(t.name, n);
    }
    const catalog = this.engine.catalog;
    const assignExisting = (name: string) => {
      if (toNumber.has(name)) return;
      const active = catalog.tables.get(name);
      if (active && !numberToName.has(active.number)) {
        numberToName.set(active.number, name);
        toNumber.set(name, active.number);
      } else toNumber.set(name, undefined);
    };
    for (const t of tables) assignExisting(t.name);
    if (mode === "ReplaceAll") {
      // The schema's tables the import does not have are replaced by empty ones.
      for (const name of this.engine.schema.tables.keys()) assignExisting(name);
    } else
      for (const t of catalog.tables.values()) {
        const imported = numberToName.get(t.number);
        if (!toNumber.has(t.name) && imported !== undefined) throw tableConflict(imported, t.name);
      }
    return toNumber;
  }

  private async run(row: ImportRow) {
    // The hidden tables to activate; a retried or restarted run resumes into the ones it created before
    // (Convex's checkpoints), skipping the documents already in them.
    const hidden: number[] = [];
    const previous = new Map((row.hidden_tables ?? []).map((h) => [h.name, Number(h.tablet)]));
    const skip = new Map<string, number>();
    try {
      this.failIfTooOld(row);
      const parsed = await this.parse(row);
      const schemaBefore = JSON.stringify(schemaToJson(this.engine.schema));
      const mode = row.mode;
      const tablesTables = parsed.tables.filter((t) => t.name === "_tables");
      const tables = parsed.tables.filter((t) => t.name !== "_tables");
      const numbers = await this.assignNumbers(mode, tablesTables, tables);
      const catalog = this.engine.catalog;
      const replacedByAll =
        mode === "ReplaceAll"
          ? [...catalog.tables.values()].filter((t) => !t.name.startsWith("_")).map((t) => t.name)
          : [];
      // Prepare every table: a new hidden one, or (appending) the existing one.
      const defs = new Map<string, TableDef>();
      for (const name of [...numbers.keys()].sort(byteOrder)) {
        if (name.startsWith("_") && name !== "_storage")
          throw new ImportError("InvalidTableName", `Invalid table name ${name} starts with metadata prefix '_'`);
        const number = numbers.get(name);
        const active = this.engine.catalog.tables.get(name);
        let def: TableDef;
        const resumed = previous.get(name);
        const kept = resumed === undefined ? undefined : this.engine.catalog.hidden.get(resumed);
        if (kept) {
          // As Convex: an append into a new table cannot resume (nothing records how far it got).
          if (mode === "Append") throw new Error("can't resume append import");
          def = kept;
          hidden.push(def.id);
          skip.set(name, await this.count(def));
        } else if (mode === "Append" && active) def = active;
        else {
          if (mode === "RequireEmpty" && active && (await this.count(active)) > 0)
            throw new ImportError(
              "TableExists",
              `Table ${name} already exists. Please choose a new table name or use replace/append modes.`,
            );
          def = await this.engine.createHiddenTable(name, {
            ...(number !== undefined ? { number } : {}),
            ...(active ? { copyIndexesOf: name } : {}),
            replacing: replacedByAll,
          });
          hidden.push(def.id);
          const tablet = String(def.id);
          await this.write(async (db) => {
            const cur = await this.mustGet(db, row._id);
            await db.patch(SNAPSHOT_IMPORTS_TABLE, cur._id, {
              hidden_tables: [...(cur.hidden_tables ?? []).filter((h) => h.name !== name), { name, tablet }],
              checkpoints: (cur.checkpoints ?? []).map((c) =>
                c.display_table_name === name ? { ...c, tablet_id: tablet } : c,
              ),
            });
          });
        }
        if (number !== undefined && number !== def.number)
          throw new ImportError(
            "TableNumberConflict",
            `table ${name} wants table number ${number} but was already assigned ${def.number}`,
          );
        defs.set(name, def);
      }
      this.validatePreparedNumbers(mode, defs);
      // The tables as they will be once activated, for the schema's `v.id` checks.
      const schemaTables = new Map<number, string>();
      for (const t of catalog.tables.values())
        if (!((mode === "ReplaceAll" && !t.name.startsWith("_")) || numbers.has(t.name)))
          schemaTables.set(t.number, t.name);
      for (const [name, def] of defs) schemaTables.set(def.number, name);

      let total = 0;
      for (const t of tables) {
        const def = defs.get(t.name)!;
        const skipped = skip.get(t.name) ?? 0;
        if (t.name === "_storage") await this.importStorage(row, t, def, parsed, schemaTables, skipped);
        else total += await this.importTable(row, t, def, schemaTables, skipped);
      }

      const imported = new Set(defs.keys());
      const deleteNames = mode === "ReplaceAll" ? replacedByAll.filter((n) => !imported.has(n)) : [];
      const schema = this.engine.schema;
      const { ts } = await this.engine.activateTables(hidden, deleteNames, async (db) => {
        // Only an import still running is finished (it may have been canceled).
        const cur = await db.asSystem(() => this.mustGet(db, row._id));
        if (cur.state.state === "failed") throw new Canceled();
        if (cur.state.state !== "in_progress") throw new Error("Import is not in progress");
        if (JSON.stringify(schemaToJson(this.engine.schema)) !== schemaBefore)
          throw new ImportError(
            "ImportSchemaChanged",
            "Could not complete import because schema changed. Avoid modifying schema.ts while importing tables",
          );
        // Convex's `snapshot_import` event, in the finishing transaction, as the import's member (none here).
        await insertAuditLogEvents(
          db,
          [
            auditEvents.snapshotImport({
              tables: [...imported].sort(byteOrder),
              deleted: deleteNames,
              mode,
              format: row.format as unknown as Value,
            }),
          ],
          SYSTEM_ACTOR,
        );
        // A schema table outside the import that points into it must not see that table's number change
        // (Convex's `ImportSchemaConstraints`).
        for (const [table, declared] of schema.tables) {
          if (imported.has(table)) continue;
          const holder = this.engine.catalog.tables.get(table);
          if (!holder) continue;
          for (const fk of referencedTables(declared.document.json)) {
            const def = defs.get(fk);
            const existing = this.engine.catalog.tables.get(fk);
            if (!def || !existing || existing.number === def.number) continue;
            if (await db.asSystem(() => db.queryDef(holder).first()))
              throw new ImportError(
                "ImportForeignKey",
                `Import changes table '${fk}' which is referenced by '${table}' in the schema`,
              );
          }
        }
      });
      await this.write((db) =>
        this.setState(db, row._id, () => ({
          state: "completed",
          timestamp: BigInt(ts) * NS_PER_US,
          num_rows_written: BigInt(total),
        })),
      );
    } catch (e) {
      throw this.userError(e);
    }
  }

  /** Convex's `validate_prepared_table_numbers`: the numbers can coexist once the import is activated. */
  private validatePreparedNumbers(mode: ImportMode, defs: Map<string, TableDef>) {
    const prepared = new Map<number, string[]>();
    for (const [name, def] of defs) prepared.set(def.number, [...(prepared.get(def.number) ?? []), name]);
    for (const [number, names] of prepared) {
      names.sort(byteOrder);
      if (names.length > 1)
        throw new ImportError(
          "TableNumberConflict",
          `conflict between \`${names[0]}\` and \`${names[1]}\` with table number ${number}`,
        );
      for (const t of this.engine.catalog.tables.values()) {
        if (t.number !== number || defs.has(t.name) || (mode === "ReplaceAll" && !t.name.startsWith("_"))) continue;
        throw tableConflict(names[0]!, t.name);
      }
    }
  }

  private async insertBatch(def: TableDef, docs: Record<string, Value>[], schemaTables: Map<number, string>) {
    if (!docs.length) return;
    const ids = docs.map((d) => d._id).filter((id) => id !== undefined);
    if (new Set(ids).size < ids.length)
      throw new ImportError("DuplicateId", `Objects in table "${def.name}" have duplicate _id fields`);
    await this.engine.mutation(
      (db) =>
        db.asSystem(async () => {
          db.schemaTables = (n) => schemaTables.get(n);
          for (const d of docs) await db.importInsert(def, d);
        }),
      "_system/snapshot_import",
    );
  }

  /** One table's rows, in batches (Convex's `import_single_table`); the documents written. */
  private async importTable(
    row: ImportRow,
    t: ImportTable,
    def: TableDef,
    schemaTables: Map<number, string>,
    skip: number,
  ) {
    await this.progress(row._id, `Importing "${t.name}"`, t.name, 0);
    let n = 0;
    let batch: Record<string, Value>[] = [];
    let size = 0;
    for await (const r of t.rows()) {
      n++;
      // Written by an earlier attempt (batches commit whole and in order, so a count is a prefix).
      if (n <= skip) continue;
      batch.push(rowToDocument(r, t.uniform, n));
      size += r.text?.length ?? JSON.stringify(r.json).length;
      if (size > BATCH_MAX_BYTES || batch.length > BATCH_MAX_DOCUMENTS) {
        await this.insertBatch(def, batch, schemaTables);
        batch = [];
        size = 0;
        await this.progress(row._id, `Importing "${t.name}" (${commas(n - 1)} documents)`, t.name, n - 1);
      }
    }
    await this.insertBatch(def, batch, schemaTables);
    await this.progress(row._id, `Imported "${t.name}" (${commas(n)} documents)`, t.name, n, true);
    return n;
  }

  /** `_storage`: the files' metadata, then each file stored again under its id (Convex's `import_storage_table`). */
  private async importStorage(
    row: ImportRow,
    t: ImportTable,
    def: TableDef,
    parsed: ParsedImport,
    schemaTables: Map<number, string>,
    skip: number,
  ) {
    await this.progress(row._id, `Importing "_storage"`, "_storage", 0);
    type Meta = { _creationTime?: number; sha256?: string; contentType?: string; internalId?: string };
    const metadata = new Map<string, Meta>();
    let n = 0;
    for await (const r of t.rows()) {
      n++;
      const bad = (msg: string) => new ImportError("InvalidValue", `Row ${n} wasn't a valid value: ${msg}`);
      const m = r.json as Record<string, unknown>;
      if (!m || typeof m !== "object" || typeof m._id !== "string") throw bad("missing field `_id`");
      let number: number;
      try {
        number = decodeId(m._id).tableNumber;
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (number !== def.number)
        throw new ImportError("InvalidId", `_storage entry has invalid ID ${m._id} (${number} != ${def.number})`);
      metadata.set(m._id, {
        ...(typeof m._creationTime === "number" ? { _creationTime: m._creationTime } : {}),
        ...(typeof m.sha256 === "string" ? { sha256: m.sha256 } : {}),
        ...(typeof m.contentType === "string" ? { contentType: m.contentType } : {}),
        ...(typeof m.internalId === "string" ? { internalId: m.internalId } : {}),
      });
    }
    const total = parsed.storageFiles.length;
    let done = 0;
    for (const file of parsed.storageFiles) {
      if (!this.files) throw new ImportError("FileStorageDisabled", "File storage is not configured on this server.");
      // Stored by an earlier attempt: one file per transaction, in order.
      if (done < skip) {
        done++;
        continue;
      }
      const m = metadata.get(file.id) ?? {};
      let written: Awaited<ReturnType<BlobStore["put"]>>;
      try {
        written = await this.files.put(streamFrom(file.read()));
      } catch (e) {
        throw e instanceof InvalidZipError || e instanceof ImportError || e instanceof StorageFailure
          ? e
          : new StorageFailure(e);
      }
      const sha256 = b64(written.sha256);
      if (m.sha256 !== undefined && m.sha256 !== sha256) {
        await this.files.delete(written.key).catch(() => {});
        throw new ImportError("Sha256Mismatch", `Sha256 mismatch. Expected: ${m.sha256} Actual: ${sha256}`);
      }
      try {
        await this.insertBatch(
          def,
          [
            {
              _id: file.id,
              ...(m._creationTime !== undefined ? { _creationTime: m._creationTime } : {}),
              storageId: m.internalId ?? crypto.randomUUID(),
              storageKey: written.key,
              sha256,
              size: written.size,
              contentType: m.contentType ?? null,
            },
          ],
          schemaTables,
        );
      } catch (e) {
        await this.files.delete(written.key).catch(() => {});
        throw e;
      }
      done++;
      await this.progress(row._id, `Importing "_storage" (${commas(done)}/${commas(total)} files)`, "_storage", done);
    }
    await this.progress(row._id, `Imported "_storage" (${commas(done)} files)`, "_storage", done, true);
  }
}

/** A stream of an async iterable's chunks. */
function streamFrom(it: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iter = it[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await iter.next();
      if (done) c.close();
      else c.enqueue(value);
    },
    async cancel() {
      await iter.return?.();
    },
  });
}

/** Convex's `table_conflict_error`. */
function tableConflict(table: string, existing: string): ImportError {
  const msg = VIRTUAL_SYSTEM_TABLES.has(existing)
    ? `New table \`${table}\` has IDs that conflict with existing system table`
    : existing.startsWith("_")
      ? `New table \`${table}\` has IDs that conflict with existing internal table. Consider importing this table without \`_id\` fields or import into a new deployment.`
      : `New table \`${table}\` has IDs that conflict with existing table \`${existing}\`. To delete all existing tables, import with \`bunvex import --replace-all\`.`;
  return new ImportError("TableConflict", msg);
}
