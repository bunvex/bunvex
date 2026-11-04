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
//
// Components (STUDY-204): every table and file is in a namespace, the import's `componentPath` with the ZIP entry's
// `_components/<name>/` prefixes appended; a missing component is created unmounted, its parents first; numbers,
// hidden tables and checks are each namespace's, all activated in the one commit; `--replace-all` empties every
// namespace that has a component path.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  allComponentPaths,
  componentDefinitionRow,
  componentRow,
  declaredTables,
  type Engine,
  type EngineSchema,
  FILE_STORAGE_TABLE,
  formatComponentPath,
  ImportBackfillingError,
  ImportIdError,
  insertAuditLogEvents,
  knob,
  OccError,
  occBackoffMs,
  primaryVirtualTable,
  referencedTables,
  resolveComponentPath,
  rootComponent,
  SNAPSHOT_IMPORTS_TABLE,
  STORAGE_TABLE,
  SYSTEM_ACTOR,
  SYSTEM_TO_VIRTUAL_TABLE,
  schemaToJson,
  secondsKnob,
  type TableDef,
  type Tx,
} from "@bunvex/core";
import type { BlobStore } from "@bunvex/file-storage";
import { decodeId, type GenericValidator, type Value } from "@bunvex/values";
import { auditEvents } from "./audit-log.ts";
import { ensureRootComponent } from "./code-store.ts";
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

/** Convex's MAX_IMPORT_AGE (7 days). */
export const MAX_IMPORT_AGE_MS = secondsKnob("MAX_IMPORT_AGE_SECONDS", 7 * 24 * 60 * 60);
/** Half of Convex's transaction limits (TRANSACTION_MAX_USER_WRITE_SIZE_BYTES / NUM_USER_WRITES), per batch. */
const BATCH_MAX_BYTES = 8 * 1024 * 1024;
const BATCH_MAX_DOCUMENTS = 8000;
const PAGE_SIZE = 1000;
/**
 * An imported table's system table (STUDY-125): `_storage` is imported into `_file_storage`, as Convex's
 * snapshot import does; any other name is its own table.
 */
const physicalName = (name: string) => (name === STORAGE_TABLE ? FILE_STORAGE_TABLE : name);
/** A table's name in an import: a system table under the virtual table it backs (`_file_storage` → `_storage`). */
const importName = (name: string) => primaryVirtualTable(name) ?? name;

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
  /** The table's component path (`a/b`), null for the root's, as Convex's `ComponentPath::serialize`. */
  component_path: string | null;
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
  /** The component the import goes into (`--component`), null for the root's. */
  component_path: string | null;
  fq_object_key: string;
  /** The upload's size, for reading a ZIP by ranges (bunvex's own field). */
  object_size: bigint;
  /**
   * The hidden tables this import created, by component path (absent or null: the root's) and name (bunvex's own
   * field): resumed, or dropped if it fails.
   */
  hidden_tables?: { name: string; tablet: string; component?: string | null }[];
  /** The admin key's member that started it (Convex's `Option<MemberId>`, an int64), or none. */
  member_id: bigint | null;
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

/** Convex's `MAX_IMPORT_UPLOAD_PART_BYTES` (1056bba): the most bytes one upload part may have. */
export const maxImportUploadPartBytes = (env = process.env) =>
  knob("MAX_IMPORT_UPLOAD_PART_BYTES", 64 * 1024 * 1024, "uint", env);

/**
 * An upload part's body, read up to `limit` bytes (Convex's `to_bytes` with its limit): past it, a 400
 * `ImportPartTooLarge`, as soon as the declared length or the bytes read pass it; a body that breaks, `ImportFailed`.
 */
export async function importPartBody(req: Request, limit = maxImportUploadPartBytes()): Promise<Uint8Array> {
  const tooLarge = () =>
    new ImportRequestError(400, "ImportPartTooLarge", `Import upload parts must be at most ${limit} bytes.`);
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await req.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof ImportRequestError) throw e;
    throw new ImportRequestError(400, "ImportFailed", "failed to read request body");
  }
  return parts.length === 1 ? parts[0]! : new Uint8Array(Buffer.concat(parts));
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
  /**
   * A wake with no worker waiting yet (it was reading the store): the worker's next sleep returns at once.
   * Without it, a request or a stop that races the worker's read is lost, and the worker sleeps for good.
   */
  private woken = false;

  /** Wake the worker, now or at its next sleep. */
  private signal() {
    if (this.wake) this.wake();
    else this.woken = true;
  }

  /** The worker waits for a signal (one already given returns at once). */
  private sleep(): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise<void>((done) => {
      this.wake = done;
    });
  }
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

  /**
   * Convex's `start_import`: the row, `uploaded`, under the member that started it (Convex's
   * `identity.member_id()`: an admin key's member); the worker takes it from there.
   */
  async start(
    format: ImportFormat,
    mode: ImportMode,
    upload: { key: string; size: number },
    memberId: bigint | null = null,
    /** The component to import into (`a/b`), null or empty for the app's own. */
    componentPath: string | null = null,
  ): Promise<string> {
    let id = "";
    await this.write(async (db) => {
      id = await db.insert(SNAPSHOT_IMPORTS_TABLE, {
        state: { state: "uploaded" },
        format,
        mode,
        component_path: componentPath || null,
        fq_object_key: upload.key,
        object_size: BigInt(upload.size),
        member_id: memberId,
        checkpoints: null,
        requestor: { type: "snapshotImport" },
      });
    });
    this.signal();
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
    this.signal();
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
      const tablets = (row?.hidden_tables ?? []).map((h) => h.tablet);
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
  async importNow(
    format: ImportFormat,
    mode: ImportMode,
    upload: { key: string; size: number },
    memberId: bigint | null = null,
    componentPath: string | null = null,
  ): Promise<number> {
    const id = await this.start(format, mode, upload, memberId, componentPath);
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
    this.signal();
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
        await Promise.race([Bun.sleep(delay), this.sleep()]);
        this.wake = null;
        continue;
      }
      if (!next) {
        await this.sleep();
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
          await Promise.race([Bun.sleep(delay), this.sleep()]);
          this.wake = null;
          continue;
        }
        failures = 0;
        // Its tables go first, so whoever sees it failed sees nothing left behind.
        await this.dropHidden(next._id);
        // Convex's `wrap_import_err`: an `ImportError` it raised bare keeps its message alone.
        const msg = isRetryable(e)
          ? INTERNAL_SERVER_ERROR_MESSAGE
          : e instanceof ImportError && e.bare
            ? e.message
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

  /** The upload parsed; the component it goes into is prepared first, as Convex's `parse_import`. */
  private async parse(row: ImportRow): Promise<ParsedImport> {
    await this.prepareComponent(basePath(row));
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

  // ---------------------------------------------------------------- namespaces (STUDY-204)

  /** The `_components` id of the component at `path`, or null for the root's; undefined when there is none. */
  private async componentIdAt(path: string[]): Promise<string | null | undefined> {
    if (!path.length) return null;
    const c = await this.engine.query((db) => resolveComponentPath(db, path));
    return c ? c._id : undefined;
  }

  /**
   * The component at `path`, created unmounted when missing, its parents first (Convex's
   * `prepare_component_for_import`): a namespace of its own, a definition named by its path, and its `_components`
   * row under its parent's. The root's rows are written if a push never did. Its id; null for the root.
   */
  private async prepareComponent(path: string[]): Promise<string | null> {
    if (!path.length) return null;
    const existing = await this.componentIdAt(path);
    if (existing !== undefined) return existing;
    const parentPath = path.slice(0, -1);
    const parent = await this.prepareComponent(parentPath);
    const name = path[path.length - 1]!;
    const id = await this.engine.initializeComponentNamespace();
    await this.sys(async (db) => {
      await ensureRootComponent(db);
      const parentRow = parent === null ? await rootComponent(db) : await resolveComponentPath(db, parentPath);
      if (!parentRow) throw new Error(`${formatComponentPath(parentPath)} not found while creating a component`);
      const definitionId = await db.insert(
        "_component_definitions",
        componentDefinitionRow({
          path: formatComponentPath(path),
          definitionType: { type: "childComponent", name, args: [] },
          childComponents: [],
          httpMounts: {},
          httpPrefix: null,
          exports: { type: "branch", branch: [] },
          envVars: [],
        }) as never,
      );
      await db.importInsert(this.engine.catalog.table("_components")!, {
        _id: id,
        ...componentRow({
          definitionId,
          parent: parentRow._id,
          name,
          args: [],
          env: [],
          state: "unmounted",
          httpPrefix: null,
        }),
      } as Record<string, Value>);
    }, true);
    return id;
  }

  /** The tables of namespace `id` (null: the root's); none for a component with no tables yet. */
  private spaceCatalog(id: string | null): CatalogView {
    return id === null ? this.engine.catalog : (this.engine.catalog.components.get(id) ?? NO_TABLES);
  }

  /** The schema active in namespace `id` (null: the root's). */
  private spaceSchema(id: string | null): EngineSchema {
    return id === null ? this.engine.schema : this.engine.componentSchema(id);
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

  /**
   * Parse and count: the confirmation message and checkpoints (Convex's `messages_to_confirm_replace`), each table by
   * its component path and name, the changes listed per component.
   */
  private async confirmable(row: ImportRow) {
    try {
      this.failIfTooOld(row);
      const parsed = await this.parse(row);
      const base = basePath(row);
      const entries = new Map<string, { path: string[]; name: string; count: number; missingId: boolean }>();
      const entry = (path: string[], name: string) => {
        const k = tableKey(path, name);
        let e = entries.get(k);
        if (!e) {
          e = { path, name, count: 0, missingId: false };
          entries.set(k, e);
        }
        return e;
      };
      for (const t of parsed.tables) {
        const path = [...base, ...t.componentPath];
        let n = 0;
        if (t.name === "_tables") for await (const e of this.tablesEntries(t)) entry(path, e.name);
        const e = entry(path, t.name);
        for await (const r of t.rows()) {
          n++;
          const o = r.json as Record<string, unknown> | null;
          if (!e.missingId && !(o && typeof o === "object" && !Array.isArray(o) && "_id" in o)) e.missingId = true;
        }
        e.count += n;
      }
      // `--replace-all` empties every namespace that has a component path (Convex's `component_ids_to_paths`).
      if (row.mode === "ReplaceAll")
        for (const [id, path] of await this.engine.query((db) => allComponentPaths(db)))
          for (const t of this.spaceCatalog(id).tables.values()) if (!t.name.startsWith("_")) entry(path, t.name);
      const changes: (TableChange & { path: string[]; missingId: boolean })[] = [];
      for (const e of [...entries.values()].sort(byPathAndName)) {
        const isStorage = e.name === STORAGE_TABLE;
        if (e.name.startsWith("_") && !isStorage) continue;
        const id = await this.componentIdAt(e.path);
        const active = id === undefined ? undefined : this.spaceCatalog(id).tables.get(physicalName(e.name));
        const existing = active ? await this.count(active) : 0;
        let deleted = 0;
        if (row.mode === "Replace" || row.mode === "ReplaceAll") deleted = existing;
        else if (row.mode === "RequireEmpty" && existing > 0)
          throw new ImportError(
            "TableExists",
            `Table ${e.name} already exists. Please choose a new table name or use replace/append modes.`,
          );
        changes.push({
          path: e.path,
          table: e.name,
          added: e.count,
          deleted,
          existing,
          unit: isStorage ? " files" : "",
          missingId: e.missingId,
        });
      }
      const checkpoints: Checkpoint[] = changes.map((c) => ({
        component_path: c.path.length ? formatComponentPath(c.path) : null,
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
          message_to_confirm: confirmationMessage(
            changes.map((c) => ({ ...c, component: formatComponentPath(c.path) })),
          ),
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

  private async progress(
    id: string,
    message: string,
    path: string[],
    table: string,
    written: number,
    checkpoint = false,
  ) {
    const component = path.length ? formatComponentPath(path) : null;
    const update = async (db: Tx) => {
      const row = await this.mustGet(db, id);
      if (row.state.state !== "in_progress") throw new Canceled();
      let noop = false;
      const checkpoints = (row.checkpoints ?? []).map((c) => {
        if (c.display_table_name !== table || (c.component_path ?? null) !== component) return c;
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

  /**
   * One namespace's table numbers (Convex's `assign_table_numbers`): from its `_tables`, then the first `_id`, then
   * the existing table's.
   */
  private async assignNumbers(mode: ImportMode, space: Space): Promise<Map<string, number | undefined>> {
    const toNumber = new Map<string, number | undefined>();
    const numberToName = new Map<number, string>();
    const at = inComponent(space.path);
    const assign = (name: string, n: number) => {
      const other = numberToName.get(n);
      if (other !== undefined)
        throw new ImportError("InvalidId", `conflict between \`${other}\` and \`${name}\` with number ${n}`);
      numberToName.set(n, name);
    };
    for (const t of space.tablesTables)
      for await (const e of this.tablesEntries(t)) {
        if (toNumber.has(e.name))
          throw new ImportError("DuplicateTableName", `\`_tables\` contains duplicate entries for \`${e.name}\`${at}`);
        toNumber.set(e.name, e.number);
        assign(e.name, e.number);
      }
    for (const t of space.tables) {
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
    const catalog = this.spaceCatalog(space.id);
    const assignExisting = (name: string) => {
      if (toNumber.has(name)) return;
      const active = catalog.tables.get(physicalName(name));
      if (active && !numberToName.has(active.number)) {
        numberToName.set(active.number, name);
        toNumber.set(name, active.number);
      } else toNumber.set(name, undefined);
    };
    for (const t of space.tables) assignExisting(t.name);
    if (mode === "ReplaceAll") {
      // The schema's tables the import does not have are replaced by empty ones, in each namespace.
      for (const name of declaredTables(this.spaceSchema(space.id)).keys()) assignExisting(name);
    } else
      for (const t of catalog.tables.values()) {
        const imported = numberToName.get(t.number);
        if (!toNumber.has(importName(t.name)) && imported !== undefined)
          throw tableConflict(imported, t.name, space.path);
      }
    return toNumber;
  }

  /**
   * The namespaces an import writes, each with its tables and files: every component path its tables name (under the
   * import's `componentPath`), the import's own first; with `--replace-all`, every namespace that has a component
   * path, whose tables the import does not have are deleted. Outermost first, as the components are created.
   */
  private async spaces(row: ImportRow, parsed: ParsedImport): Promise<Space[]> {
    const base = basePath(row);
    const byKey = new Map<string, Space>();
    const space = (path: string[]) => {
      const k = formatComponentPath(path);
      let sp = byKey.get(k);
      if (!sp) {
        sp = {
          path,
          id: null,
          tablesTables: [],
          tables: [],
          defs: new Map(),
          skip: new Map(),
          schemaTables: new Map(),
        };
        byKey.set(k, sp);
      }
      return sp;
    };
    space(base);
    for (const t of parsed.tables) {
      const sp = space([...base, ...t.componentPath]);
      (t.name === "_tables" ? sp.tablesTables : sp.tables).push(t);
    }
    for (const f of parsed.storageFiles) space([...base, ...f.componentPath]);
    if (row.mode === "ReplaceAll")
      for (const path of (await this.engine.query((db) => allComponentPaths(db))).values()) space(path);
    const out = [...byKey.values()].sort((a, b) => comparePaths(a.path, b.path));
    for (const sp of out) sp.id = await this.prepareComponent(sp.path);
    return out;
  }

  private async run(row: ImportRow) {
    // The hidden tables to activate; a retried or restarted run resumes into the ones it created before
    // (Convex's checkpoints), skipping the documents already in them.
    const hidden: string[] = [];
    const previous = new Map(
      (row.hidden_tables ?? []).map((h) => [tableKey(h.component ? h.component.split("/") : [], h.name), h.tablet]),
    );
    try {
      this.failIfTooOld(row);
      const parsed = await this.parse(row);
      const mode = row.mode;
      const spaces = await this.spaces(row, parsed);
      const schemasBefore = spaces.map((sp) => JSON.stringify(schemaToJson(this.spaceSchema(sp.id))));
      const deleteNames: { name: string; namespace?: string }[] = [];
      for (const sp of spaces) {
        const numbers = await this.assignNumbers(mode, sp);
        const replacedByAll =
          mode === "ReplaceAll"
            ? [...this.spaceCatalog(sp.id).tables.values()].filter((t) => !t.name.startsWith("_")).map((t) => t.name)
            : [];
        // Prepare every table: a new hidden one, or (appending) the existing one.
        for (const name of [...numbers.keys()].sort(byteOrder)) {
          if (name.startsWith("_") && name !== STORAGE_TABLE)
            throw new ImportError("InvalidTableName", `Invalid table name ${name} starts with metadata prefix '_'`);
          const number = numbers.get(name);
          const active = this.spaceCatalog(sp.id).tables.get(physicalName(name));
          let def: TableDef;
          const resumed = previous.get(tableKey(sp.path, name));
          const kept = resumed === undefined ? undefined : this.spaceCatalog(sp.id).hidden.get(resumed);
          if (kept) {
            // As Convex: an append into a new table cannot resume (nothing records how far it got).
            if (mode === "Append") throw new Error("can't resume append import");
            def = kept;
            hidden.push(def.id);
            sp.skip.set(name, await this.count(def));
          } else if (mode === "Append" && active) def = active;
          else {
            if (mode === "RequireEmpty" && active && (await this.count(active)) > 0)
              throw new ImportError(
                "TableExists",
                `Table ${name} already exists. Please choose a new table name or use replace/append modes.`,
              );
            def = await this.engine
              .createHiddenTable(physicalName(name), {
                ...(number !== undefined ? { number } : {}),
                ...(active ? { copyIndexesOf: physicalName(name) } : {}),
                replacing: replacedByAll,
                ...(sp.id !== null ? { namespace: sp.id } : {}),
              })
              .catch((e) => {
                // Convex's `InvalidImport` (a bad request): the table it replaces is still backfilling an index.
                throw e instanceof ImportBackfillingError ? new ImportError(e.code, e.message) : e;
              });
            hidden.push(def.id);
            const tablet = def.id;
            const component = sp.path.length ? formatComponentPath(sp.path) : null;
            await this.write(async (db) => {
              const cur = await this.mustGet(db, row._id);
              await db.patch(SNAPSHOT_IMPORTS_TABLE, cur._id, {
                hidden_tables: [
                  ...(cur.hidden_tables ?? []).filter((h) => h.name !== name || (h.component ?? null) !== component),
                  { name, tablet, component },
                ],
                checkpoints: (cur.checkpoints ?? []).map((c) =>
                  c.display_table_name === name && (c.component_path ?? null) === component
                    ? { ...c, tablet_id: tablet }
                    : c,
                ),
              });
            });
          }
          if (number !== undefined && number !== def.number)
            throw new ImportError(
              "TableNumberConflict",
              `table ${name}${inComponent(sp.path)} wants table number ${number} but was already assigned ${def.number}`,
            );
          sp.defs.set(name, def);
        }
        this.validatePreparedNumbers(mode, sp);
        // The tables as they will be once activated, for the schema's `v.id` checks.
        const catalog = this.spaceCatalog(sp.id);
        for (const t of catalog.tables.values())
          if (!((mode === "ReplaceAll" && !t.name.startsWith("_")) || numbers.has(importName(t.name))))
            sp.schemaTables.set(t.number, importName(t.name));
        for (const [name, def] of sp.defs) sp.schemaTables.set(def.number, name);
        if (mode === "ReplaceAll")
          for (const n of replacedByAll)
            if (!sp.defs.has(n)) deleteNames.push(sp.id === null ? { name: n } : { name: n, namespace: sp.id });
      }

      let total = 0;
      for (const sp of spaces)
        for (const t of sp.tables) {
          const def = sp.defs.get(t.name)!;
          const skipped = sp.skip.get(t.name) ?? 0;
          if (t.name === STORAGE_TABLE) await this.importStorage(row, sp, t, def, parsed, skipped);
          else total += await this.importTable(row, sp, t, def, skipped);
        }

      const { ts } = await this.engine.activateTables(hidden, deleteNames, async (db) => {
        // Only an import still running is finished (it may have been canceled).
        const cur = await db.asSystem(() => this.mustGet(db, row._id));
        if (cur.state.state === "failed") throw new Canceled();
        if (cur.state.state !== "in_progress") throw new Error("Import is not in progress");
        if (spaces.some((sp, i) => JSON.stringify(schemaToJson(this.spaceSchema(sp.id))) !== schemasBefore[i]))
          throw new ImportError(
            "ImportSchemaChanged",
            "Could not complete import because schema changed. Avoid modifying schema.ts while importing tables",
          );
        // Convex's `snapshot_import` event, in the finishing transaction, as the import's member (none here).
        await insertAuditLogEvents(
          db,
          [
            auditEvents.snapshotImport({
              tables: spaces.flatMap((sp) => [...sp.defs.keys()].map((name) => ({ path: sp.path, name }))),
              deleted: deleteNames.map((d) => ({
                path: spaces.find((sp) => (sp.id ?? undefined) === d.namespace)!.path,
                name: d.name,
              })),
              mode,
              format: row.format as unknown as Value,
            }),
          ],
          SYSTEM_ACTOR,
        );
        // A schema table outside the import that points into it must not see that table's number change
        // (Convex's `ImportSchemaConstraints`), in each namespace.
        for (const sp of spaces)
          for (const [table, declared] of declaredTables(this.spaceSchema(sp.id))) {
            if (sp.defs.has(table)) continue;
            const holder = this.spaceCatalog(sp.id).tables.get(table);
            if (!holder) continue;
            for (const fk of referencedTables(declared.document.json)) {
              const def = sp.defs.get(fk);
              const existing = this.spaceCatalog(sp.id).tables.get(fk);
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
          timestamp: ts,
          num_rows_written: BigInt(total),
        })),
      );
    } catch (e) {
      throw this.userError(e);
    }
  }

  /** Convex's `validate_prepared_table_numbers`: a namespace's numbers can coexist once the import is activated. */
  private validatePreparedNumbers(mode: ImportMode, sp: Space) {
    const prepared = new Map<number, string[]>();
    for (const [name, def] of sp.defs) prepared.set(def.number, [...(prepared.get(def.number) ?? []), name]);
    for (const [number, names] of prepared) {
      names.sort(byteOrder);
      if (names.length > 1)
        throw new ImportError(
          "TableNumberConflict",
          `conflict between \`${names[0]}\` and \`${names[1]}\` with table number ${number}`,
        );
      for (const t of this.spaceCatalog(sp.id).tables.values()) {
        if (
          t.number !== number ||
          sp.defs.has(importName(t.name)) ||
          (mode === "ReplaceAll" && !t.name.startsWith("_"))
        )
          continue;
        throw tableConflict(names[0]!, t.name, sp.path);
      }
    }
  }

  private async insertBatch(sp: Space, def: TableDef, docs: Record<string, Value>[]) {
    if (!docs.length) return;
    const ids = docs.map((d) => d._id).filter((id) => id !== undefined);
    if (new Set(ids).size < ids.length)
      throw new ImportError("DuplicateId", `Objects in table "${def.name}" have duplicate _id fields`);
    // As Convex's `execute_with_overloaded_and_ratelimited_retries` (STUDY-78): an import waits for the write
    // throughput limit, as long as it takes, with backoff from 10 ms to 30 s.
    for (let failures = 0; !this.engine.writeThroughput.allowsNow(); failures++)
      await Bun.sleep(occBackoffMs(failures, 10, 30_000));
    // The table's namespace picks the schema its documents are checked against (a component's own). The tables as
    // they will be name the `v.id`s of the root's; a component's are named by its catalog as it is.
    await this.engine.mutation(
      (db) =>
        db.asSystem(async () => {
          db.schemaTables = (n) => sp.schemaTables.get(n);
          for (const d of docs) await db.importInsert(def, d);
        }),
      "_system/snapshot_import",
    );
  }

  /** One table's rows, in batches (Convex's `import_single_table`); the documents written. */
  private async importTable(row: ImportRow, sp: Space, t: ImportTable, def: TableDef, skip: number) {
    const at = inComponent(sp.path);
    await this.progress(row._id, `Importing "${t.name}"${at}`, sp.path, t.name, 0);
    let n = 0;
    let batch: Record<string, Value>[] = [];
    let size = 0;
    // A CSV's empty cell in a field the active schema has optional is no field (Convex's `remap_empty_string_by_schema`).
    const optional =
      row.format.format === "csv"
        ? optionalTopLevelFields(declaredTables(this.spaceSchema(sp.id)).get(t.name)?.document)
        : null;
    for await (const r of t.rows()) {
      n++;
      // Written by an earlier attempt (batches commit whole and in order, so a count is a prefix).
      if (n <= skip) continue;
      if (optional?.size) dropEmptyOptional(r.json, optional);
      batch.push(rowToDocument(r, t.uniform, n));
      size += r.text?.length ?? JSON.stringify(r.json).length;
      if (size > BATCH_MAX_BYTES || batch.length > BATCH_MAX_DOCUMENTS) {
        await this.insertBatch(sp, def, batch);
        batch = [];
        size = 0;
        await this.progress(row._id, `Importing "${t.name}" (${commas(n - 1)} documents)`, sp.path, t.name, n - 1);
      }
    }
    await this.insertBatch(sp, def, batch);
    await this.progress(row._id, `Imported "${t.name}"${at} (${commas(n)} documents)`, sp.path, t.name, n, true);
    return n;
  }

  /**
   * A namespace's `_storage`: the files' metadata, then each of its files stored again under its id, as a
   * `_file_storage` document (Convex's `import_storage_table`).
   */
  private async importStorage(
    row: ImportRow,
    sp: Space,
    t: ImportTable,
    def: TableDef,
    parsed: ParsedImport,
    skip: number,
  ) {
    await this.progress(row._id, `Importing "_storage"${inComponent(sp.path)}`, sp.path, "_storage", 0);
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
    const relative = sp.path.slice(basePath(row).length).join("/");
    const files = parsed.storageFiles.filter((f) => f.componentPath.join("/") === relative);
    const total = files.length;
    let done = 0;
    for (const file of files) {
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
        await this.insertBatch(sp, def, [
          {
            _id: file.id,
            ...(m._creationTime !== undefined ? { _creationTime: m._creationTime } : {}),
            storageId: m.internalId ?? crypto.randomUUID(),
            storageKey: written.key,
            sha256: written.sha256.slice().buffer as ArrayBuffer,
            size: BigInt(written.size),
            contentType: m.contentType ?? null,
          },
        ]);
      } catch (e) {
        await this.files.delete(written.key).catch(() => {});
        throw e;
      }
      done++;
      await this.progress(
        row._id,
        `Importing "_storage" (${commas(done)}/${commas(total)} files)`,
        sp.path,
        "_storage",
        done,
      );
    }
    await this.progress(
      row._id,
      `Imported "_storage"${inComponent(sp.path)} (${commas(done)} files)`,
      sp.path,
      "_storage",
      done,
      true,
    );
  }
}

/**
 * A namespace an import writes (STUDY-204): its component path from the root (`[]`: the root's), its `_components`
 * id once prepared (null: the root's), its `_tables` and other tables, and what the run prepares in it.
 */
type Space = {
  path: string[];
  id: string | null;
  tablesTables: ImportTable[];
  tables: ImportTable[];
  /** Each table's definition to write into: a hidden table, or (appending) the active one. */
  defs: Map<string, TableDef>;
  /** Documents an earlier attempt wrote, by table. */
  skip: Map<string, number>;
  /** The namespace's tables by number as they will be once activated, for the schema's `v.id` checks. */
  schemaTables: Map<number, string>;
};

/** A namespace's active and hidden tables. */
type CatalogView = Pick<Engine["catalog"], "tables" | "hidden">;
const NO_TABLES: CatalogView = { tables: new Map(), hidden: new Map() };

/** The import's own component path (`--component`), from the root. */
const basePath = (row: ImportRow): string[] => (row.component_path ? row.component_path.split("/") : []);

/** A table's key in an import: its component's path and its name. */
const tableKey = (path: string[], name: string) => `${formatComponentPath(path)}\0${name}`;

/** Convex's `in_component_str`: `""` for the root, ` in '<path>'` otherwise. */
const inComponent = (path: string[]) => (path.length ? ` in '${formatComponentPath(path)}'` : "");

/** Component paths in Convex's order (`ComponentPath`'s, its names compared in turn): the root first. */
function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = byteOrder(a[i]!, b[i]!);
    if (c) return c;
  }
  return a.length - b.length;
}

/** By component path, then by table name, as Convex's `BTreeMap<(ComponentPath, TableName), _>`. */
const byPathAndName = (a: { path: string[]; name: string }, b: { path: string[]; name: string }) =>
  comparePaths(a.path, b.path) || byteOrder(a.name, b.name);

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
function tableConflict(table: string, existing: string, path: string[] = []): ImportError {
  const at = inComponent(path);
  // A system table that backs a virtual one (Convex's `associated_virtual_table_name`).
  const msg =
    SYSTEM_TO_VIRTUAL_TABLE[existing] !== undefined
      ? `New table \`${table}\`${at} has IDs that conflict with existing system table`
      : existing.startsWith("_")
        ? `New table \`${table}\`${at} has IDs that conflict with existing internal table. Consider importing this table without \`_id\` fields or import into a new deployment.`
        : `New table \`${table}\`${at} has IDs that conflict with existing table \`${existing}\`. To delete all existing tables, import with \`bunvex import --replace-all\`.`;
  return new ImportError("TableConflict", msg);
}

/**
 * The top-level fields a document validator has optional, in any member of a union (Convex's
 * `DocumentSchema::optional_top_level_fields`, crates/common/src/schemas/mod.rs). None for `v.any()` or no schema.
 */
function optionalTopLevelFields(document: GenericValidator | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (v: GenericValidator) => {
    if (v.kind === "object")
      for (const [name, field] of Object.entries((v as { fields: Record<string, GenericValidator> }).fields))
        if (field.isOptional === "optional") out.add(name);
    if (v.kind === "union") for (const m of (v as { members: GenericValidator[] }).members) walk(m);
  };
  if (document) walk(document);
  return out;
}

/** A CSV row's `""` cells in `optional` fields, removed (Convex's `remove_empty_string_optional_entries`). */
function dropEmptyOptional(json: unknown, optional: Set<string>) {
  if (!json || typeof json !== "object") return;
  const row = json as Record<string, unknown>;
  for (const name of optional) if (row[name] === "") delete row[name];
}
