// The SQLite driver: Convex's SQLite layout (crates/sqlite/src/lib.rs, STUDY-133 §1.5) in bun:sqlite. A flush is
// one SQLite transaction, so a group of commits is durable (and crash-atomic) as a whole. Ships with
// @bunvex/core: bun:sqlite is built into Bun, so this driver has no dependency at all.
//
// The tables are Convex's, created with Convex's own statements: `documents` keyed by `(ts, table_id, id)` with
// `documents_by_table_and_id`, `indexes` keyed by `(index_id, key, ts)`, `persistence_globals`. Ids, tablets and
// index ids are the 16 bytes of their internal ids. A store Convex wrote opens here, and one written here opens
// in Convex.
//
// Two decided divergences (STUDY-133 §8a): the file is in WAL mode (DV-411; Convex keeps the rollback journal and
// opens a WAL file as it is), and the store has bunvex's `.lock` file next to it and a `read_only` table (DV-412;
// Convex ignores both). There is no layout record (DV-418): the open checks that the tables it finds have
// Convex's columns, before the file is changed in any way (even the WAL pragma rewrites its header).
//
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by its key's leading `ts`; prunes
// are Convex's `ts <= X` statements per key; globals are `persistence_globals` rows.
//
// Two connections (STUDY-190 §4.1): this one reads, and every write of the store (a group's rows and its commit,
// index backfills, prunes, globals, the read-only flag) runs on the writer thread's own connection
// (`sqlite-writer.ts`), so a commit's fsync never holds the main thread. WAL lets this connection read while the
// writer writes, and it sees a group once the writer has committed it, which is before its flush resolves. An
// in-memory store has one connection only: its writes run inline, on it.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { resolve } from "node:path";
import { opaqueToInspect } from "../inspect.ts";
import { type KnobEnv, parseKnob } from "../knobs.ts";
import { encodeGlobal } from "./global-json.ts";
import type {
  DocLogRow,
  DocPrune,
  DocVersion,
  DocWrite,
  IndexEntryAt,
  IndexId,
  IndexPrune,
  IndexWrite,
  InternalId,
  Lease,
  LeaseAcquire,
  Persistence,
  RetentionStore,
  StoreReader,
  TabletId,
} from "./index.ts";
import { LeaseLostError } from "./index.ts";
import { checkStoreTables, LayoutError, type OpenOptions, ReadOnlyError, type ReadOnlyFlag } from "./layout.ts";
import { ProcessLock } from "./lock.ts";
import { SqliteReads } from "./sqlite-reads.ts";
import {
  cachedBytes,
  encodeCommit,
  encodeDocumentPrunes,
  encodeEntries,
  encodeGlobalWrite,
  encodeIndexPrunes,
  encodeTabletPurge,
  message,
  SQLITE_BUSY_TIMEOUT_MS,
  SqliteWriter,
  WireWriter,
  WriteOp,
  WriterThread,
} from "./sqlite-writer.ts";

export { SQLITE_BUSY_TIMEOUT_MS, WriterThreadStoppedError } from "./sqlite-writer.ts";

// Bun's per-statement switch (since 1.1.x), missing from its type declarations: integers come back as `bigint`.
declare module "bun:sqlite" {
  interface Statement<ReturnType = unknown, ParamsType extends SQLQueryBindings[] = any[]> {
    safeIntegers(enabled: boolean): this;
  }
}

/**
 * Convex's SQLite DDL (crates/sqlite/src/lib.rs `DOCUMENTS_INIT`, `INDEXES_INIT`, `PERSISTENCE_GLOBALS_INIT`),
 * statement for statement and in its spacing, so that `sqlite_master` reads the same in a store either wrote.
 * Format data, run on every open as Convex runs it.
 */
export const SQLITE_LAYOUT = `
CREATE TABLE IF NOT EXISTS documents (
    id BLOB NOT NULL,
    ts INTEGER NOT NULL,

    table_id BLOB NOT NULL,

    json_value TEXT NULL,
    deleted INTEGER NOT NULL,

    prev_ts INTEGER,

    PRIMARY KEY (ts, table_id, id)
);
CREATE INDEX IF NOT EXISTS documents_by_table_and_id ON documents (table_id, id, ts);

CREATE TABLE IF NOT EXISTS indexes (
    index_id BLOB NOT NULL,
    ts INTEGER NOT NULL,

    key BLOB NOT NULL,

    deleted INTEGER NOT NULL,

    table_id BLOB NULL,
    document_id BLOB NULL,

    PRIMARY KEY (index_id, key, ts)
);

CREATE TABLE IF NOT EXISTS persistence_globals (
    key TEXT NOT NULL,
    json_value TEXT NOT NULL,

    PRIMARY KEY (key)
);
`;

/** The layout's columns, as `pragma table_info` declares them: what an existing store must have. */
const COLUMNS = {
  documents: ["id blob", "ts integer", "table_id blob", "json_value text", "deleted integer", "prev_ts integer"],
  indexes: ["index_id blob", "ts integer", "key blob", "deleted integer", "table_id blob", "document_id blob"],
  persistence_globals: ["key text", "json_value text"],
};

/** The page cache's default (DV-550): 256 MiB. Convex sets no `cache_size`, so it runs with SQLite's 2 000 KiB. */
export const SQLITE_CACHE_DEFAULT_BYTES = 256 * 1024 * 1024;
/** The largest cache SQLite takes: `cache_size` is a 32-bit count of KiB. */
export const SQLITE_CACHE_MAX_BYTES = (2 ** 31 - 1) * 1024;
/** The writer connection's page cache, at most (the prototype's, STUDY-190 §4.1): it inserts and deletes rows, and
 *  the main connection's cache serves the reads. */
const SQLITE_WRITER_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * BUNVEX_SQLITE_CACHE_SIZE (AD-46): the SQLite page cache in bytes, the default when unset or empty. It parses as
 * INDEX_CACHE_SIZE does (an unsigned integer, `knob`), but it is bunvex's own setting, so a value that does not
 * parse fails the start, as BUNVEX_FUNCTION_SANDBOX does, instead of falling back. 0 is refused (owner, 2026-10-21): SQLite has no
 * "off" (`cache_size = 0` keeps its minimum, a few pages, the slowest setting; STUDY-174 §4.8), and "SQLite's
 * default" differs by platform (2 000 KiB on Linux, 2 000 pages on macOS). SQLite's 2 000 KiB is 2048000.
 */
export function sqliteCacheBytes(env: KnobEnv = process.env): number {
  const raw = env.BUNVEX_SQLITE_CACHE_SIZE;
  if (raw === undefined || raw === "") return SQLITE_CACHE_DEFAULT_BYTES;
  const n = parseKnob(raw, "positive");
  if (n === undefined || n > SQLITE_CACHE_MAX_BYTES)
    throw new Error(
      `invalid value '${raw}' for the SQLite page cache (BUNVEX_SQLITE_CACHE_SIZE): a size in bytes, from 1 to ` +
        `${SQLITE_CACHE_MAX_BYTES}; the default is ${SQLITE_CACHE_DEFAULT_BYTES} (256 MiB)`,
    );
  return n;
}

export class SqlitePersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
  readonly driver = "sqlite";
  /** PERSIST-01 C7 as an OS lock on the file, held for the process's life (STUDY-25 L9). */
  readonly leaseScope = "process";
  /** The store's single-writer lock: taken at open when free, else by acquireLease once it is. */
  private lock: ProcessLock | null = null;
  private db: Database;
  /** Every read of the store, on this connection (`sqlite-reads.ts`, which a worker's reader shares). */
  private reads: SqliteReads;
  /** Where the writes run: the writer thread (a file), or this connection (in memory). */
  private thread: WriterThread | null = null;
  private inline: SqliteWriter | null = null;
  /** The commits applied since the last flush, as the writer's message. */
  private group = new WireWriter();
  /** Opened with `allowReadOnly`: the lock is taken even while the store is marked read-only. */
  private allowReadOnly: boolean;

  constructor(
    private path: string,
    opts: {
      durable: boolean;
      /** The page cache, in bytes; BUNVEX_SQLITE_CACHE_SIZE by default. */
      cacheBytes?: number;
    } & OpenOptions,
  ) {
    // Checked before the file is touched: a bad setting fails the start and leaves the store as it was.
    const cacheKiB = Math.ceil((opts.cacheBytes ?? sqliteCacheBytes()) / 1024);
    this.allowReadOnly = !!opts.allowReadOnly;
    if (!this.inMemory) this.lock = ProcessLock.tryTake(path);
    // Everything after the lock gives it back if it throws: a path SQLite cannot open, a store that is not one, or
    // one that cannot be written (STUDY-174 S7). Otherwise this process keeps the store locked until it exits.
    let db: Database | null = null;
    try {
      db = new Database(path, { create: true });
      this.db = db;
      // A connection setting: the file is not changed (checkStore reads it first).
      db.exec(`pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      this.checkStore(opts);
      // The page cache always set, never left to the build: Bun's SQLite defaults to 2 000 KiB on Linux, 2 000 pages
      // on macOS (AD-46).
      db.exec(`pragma journal_mode = wal; pragma synchronous = ${opts.durable ? "full" : "off"};
        pragma temp_store = memory; pragma cache_size = -${cacheKiB};`);
      db.exec(SQLITE_LAYOUT);
      db.exec(`create table if not exists read_only (id integer primary key);`);
    } catch (e) {
      // Stryker disable next-line OptionalChaining,CallExpression: a refused handle's connection; left open it only leaks.
      db?.close();
      this.lock?.release();
      this.lock = null;
      throw e;
    }
    if (this.inMemory) this.inline = new SqliteWriter(this.db);
    else
      this.thread = new WriterThread({
        path: resolve(path),
        durable: opts.durable,
        cacheKiB: Math.min(cacheKiB, SQLITE_WRITER_CACHE_MAX_BYTES / 1024),
      });
    this.reads = new SqliteReads(this.db);
  }

  private get inMemory() {
    return this.path === ":memory:" || this.path === "";
  }

  /** PERSIST-01 C10, reading only: the tables have the layout's columns; and the read-only flag. Refusing needs
   *  no lock: nothing is written. */
  private checkStore(opts: OpenOptions) {
    const store = `the SQLite store ${this.path}`;
    let tables: Set<string>;
    try {
      tables = new Set(
        (this.db.query(`select name from sqlite_master where type = 'table'`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_NOTADB")
        throw new LayoutError(`${store} is not a bunvex store: the file is not a SQLite database`);
      throw e;
    }
    const found: Record<string, string[]> = {};
    for (const t of Object.keys(COLUMNS))
      if (tables.has(t))
        found[t] = (this.db.query(`pragma table_info(${t})`).all() as { name: string; type: string }[]).map(
          (c) => `${c.name} ${c.type.toLowerCase()}`,
        );
    checkStoreTables(store, found, COLUMNS);
    if (tables.has("read_only") && this.db.query(`select 1 from read_only limit 1`).get() && !opts.allowReadOnly)
      throw new ReadOnlyError(store);
  }

  /** Convex's `set_read_only`: no lock needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.write(WriteOp.ReadOnly, readOnly ? "1:" : "0:");
  }

  /** One call to the writer: on its thread (answered once its transaction has committed), or inline. */
  private write(op: WriteOp, payload: string): number | undefined | Promise<number | undefined> {
    if (this.thread) return this.thread.call(op, payload);
    return this.inline!.run(message(op, 0, payload));
  }

  /**
   * The store's lock, if no other process holds it. Without `allowReadOnly`, a store marked read-only since the
   * open's check is refused here, under the lock, with `ReadOnlyError`, and the lock let go (as Convex 403c3e8
   * checks the flag in its SQL drivers' lease statement; Convex's SQLite store has no lease).
   */
  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    if (this.inMemory) return { epoch: 1 }; // nothing another process could share
    this.lock ??= ProcessLock.tryTake(this.path);
    if (!this.lock) return { heldBy: ProcessLock.holderOf(this.path), expiresInMs: null };
    if (!this.allowReadOnly && this.db.query(`select 1 from read_only limit 1`).get()) {
      await this.releaseLease();
      throw new ReadOnlyError(`the SQLite store ${this.path}`);
    }
    this.lock.recordHolder(opts.holder);
    return { epoch: this.lock.epoch };
  }

  async renewLease() {} // the OS holds the lock for as long as this process lives

  async releaseLease() {
    // The writes posted under the lock are done before it goes: none lands while another process holds it.
    await this.thread?.drain();
    this.lock?.release();
    this.lock = null;
  }

  /** Writing needs the store's lock: another process holds it otherwise. */
  private assertWriter() {
    if (!this.inMemory && !this.lock) throw new LeaseLostError("another process holds this SQLite store");
  }

  /** One commit of the group: written by the next `flush`, with the group's other commits, in one transaction. */
  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.assertWriter();
    encodeCommit(this.group, ts, docs, idx);
  }

  /** PERSIST-01 C17: Convex's `INSERT OR REPLACE` of index rows at their own ts, in a transaction of their own. */
  writeIndexEntries(entries: IndexEntryAt[]): void | Promise<void> {
    this.assertWriter();
    // Stryker disable next-line ConditionalExpression: a transaction of no writes writes nothing.
    if (!entries.length) return;
    return done(this.write(WriteOp.Entries, encodeEntries(entries)));
  }

  /** The group in one transaction: resolved once the writer has committed it (with its fsync, on a durable store).
   *  A failure rejects it, and the committer stops (no SQLite error is transient). */
  flush(): void | Promise<void> {
    if (this.group.empty) return;
    return done(this.write(WriteOp.Group, this.group.take()));
  }

  /** PERSIST-01 C12. This connection never sees a group before the writer commits it: every row it reads is durable. */
  readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): DocLogRow[] {
    return this.reads.readDocumentLog(afterTs, upToTs, limit);
  }

  /** PERSIST-01 C13, Convex's `DELETE_INDEX`: one transaction. */
  pruneIndexes(entries: IndexPrune[]): number | Promise<number> {
    this.assertWriter();
    return this.write(WriteOp.PruneIndexes, encodeIndexPrunes(entries)) as number | Promise<number>;
  }

  /** PERSIST-01 C13, Convex's `DELETE_DOCUMENT`: one transaction. */
  pruneDocuments(entries: DocPrune[]): number | Promise<number> {
    this.assertWriter();
    return this.write(WriteOp.PruneDocuments, encodeDocumentPrunes(entries)) as number | Promise<number>;
  }

  /** PERSIST-01 C18, Convex's `DELETE_TABLE_DOCUMENTS` (and the tablet's index rows first): one transaction. */
  purgeTablet(table: TabletId, indexes: IndexId[], limit: number): number | Promise<number> {
    this.assertWriter();
    return this.write(WriteOp.PurgeTablet, encodeTabletPurge(table, indexes, limit)) as number | Promise<number>;
  }

  /** PERSIST-01 C14. */
  getGlobal(key: string): unknown {
    return this.reads.getGlobal(key);
  }

  /** Convex's `WRITE_PERSISTENCE_GLOBAL`. */
  setGlobal(key: string, value: unknown): void | Promise<void> {
    this.assertWriter();
    return done(this.write(WriteOp.Global, encodeGlobalWrite(key, encodeGlobal(value))));
  }

  auditRowCount() {
    const r = this.db
      .query(`select (select count(*) from documents) as docs, (select count(*) from indexes) as idx`)
      .get() as { docs: number; idx: number };
    return { docs: Number(r.docs), idx: Number(r.idx) };
  }

  scan(_table: TabletId, index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    return this.reads.scan(index, lo, hi, ts, limit, desc);
  }

  get(table: TabletId, id: InternalId, ts: bigint): DocVersion {
    return this.reads.get(table, id, ts);
  }

  getVersions(table: TabletId, ids: string[], ts: bigint) {
    return this.reads.getVersions(table, ids, ts);
  }

  auditLiveDocs(table: TabletId, ts: bigint) {
    const r = this.db
      .query(`select count(*) as n from (select json_value, row_number() over (partition by id order by ts desc) rn
              from documents where table_id = ? and ts <= ?) where rn = 1 and json_value is not null`)
      .get(cachedBytes(table), ts) as { n: number };
    return Number(r.n);
  }

  // AD-46, STUDY-194 Q9.
  /** @internal This connection's page cache, in bytes: the store's share when execution workers read it too. */
  setCacheBytes(bytes: number) {
    this.db.exec(`pragma cache_size = -${Math.max(1, Math.ceil(bytes / 1024))};`);
  }

  /** How another thread opens this store to read it: a file's path; none for a store in memory. */
  reader(): StoreReader | undefined {
    return this.inMemory ? undefined : { driver: "sqlite", path: resolve(this.path) };
  }

  /** The last durable commit (`SqliteReads.maxTs`). */
  maxTs(): bigint {
    return this.reads.maxTs();
  }

  /** Closes the connection now. bun:sqlite's `close()` closes a connection with live prepared statements only
   *  once they are garbage-collected (sqlite3_close_v2): until then it keeps the file open, and its real close —
   *  the last connection's checkpoint, under an exclusive lock — lands at a random later moment, on another
   *  process opening the store. */
  close() {
    // The writer first: it runs what was posted, then closes its connection, so this one is the last to close.
    this.thread?.close();
    this.inline?.close();
    this.reads.close();
    this.db.close();
    this.lock?.release();
    this.lock = null;
  }
}

/** A write's answer as a write's `void`: a promise when the writer thread runs it. */
function done(r: unknown): void | Promise<void> {
  if (r instanceof Promise) return r.then(() => {});
}

/** Every write of a reader fails with this: it has no writer. */
const readerWrite = (..._: unknown[]): never => {
  throw new Error("this SQLite connection only reads: the store's writer is another thread's");
};

// STUDY-194 §10.2: an execution worker's connection to the store the main thread writes.
/**
 * A SQLite store opened only to read it, from another thread than the one that writes it (`Persistence.reader`):
 * a read-only connection with a page cache of its own, answering every read as the writer's own connection does
 * (`SqliteReads`). It takes no lock, changes nothing in the file, and starts no writer; the store must exist. A
 * write throws.
 */
export class SqliteStoreReader implements Persistence {
  readonly driver = "sqlite";
  private db: Database;
  private reads: SqliteReads;

  constructor(path: string, opts: { cacheBytes: number }) {
    const db = new Database(path, { readonly: true });
    try {
      db.exec(`pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        pragma cache_size = -${Math.max(1, Math.ceil(opts.cacheBytes / 1024))};`);
      this.reads = new SqliteReads(db);
    } catch (e) {
      db.close();
      throw e;
    }
    this.db = db;
  }

  scan(_table: TabletId, index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    return this.reads.scan(index, lo, hi, ts, limit, desc);
  }

  get(table: TabletId, id: InternalId, ts: bigint): DocVersion {
    return this.reads.get(table, id, ts);
  }

  getVersions(table: TabletId, ids: string[], ts: bigint) {
    return this.reads.getVersions(table, ids, ts);
  }

  maxTs(): bigint {
    return this.reads.maxTs();
  }

  getGlobal(key: string): unknown {
    return this.reads.getGlobal(key);
  }

  apply = readerWrite;
  flush = readerWrite;
  writeIndexEntries = readerWrite;
  setGlobal = readerWrite;

  close() {
    this.reads.close();
    this.db.close();
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(SqlitePersistence);
opaqueToInspect(SqliteStoreReader);
