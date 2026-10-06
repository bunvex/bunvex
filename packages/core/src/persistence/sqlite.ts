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
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { opaqueToInspect } from "../inspect.ts";
import { internalIdBytes, internalIdString } from "../internal-id.ts";
import { decodeGlobal, encodeGlobal } from "./global-json.ts";
import type {
  DocLogRow,
  DocPrune,
  DocVersion,
  DocWrite,
  IndexEntryAt,
  IndexedDoc,
  IndexId,
  IndexPrune,
  IndexWrite,
  InternalId,
  Lease,
  LeaseAcquire,
  Persistence,
  RetentionStore,
  TabletId,
} from "./index.ts";
import { DanglingReferenceError, LeaseLostError } from "./index.ts";
import { checkStoreTables, LayoutError, type OpenOptions, ReadOnlyError, type ReadOnlyFlag } from "./layout.ts";
import { ProcessLock } from "./lock.ts";
import { scanLatestSync } from "./scan.ts";

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

/** A tablet's or an index's bytes, by id: few distinct ones, bound on every statement. */
const idBytesCache = new Map<string, Uint8Array>();
function cachedBytes(id: string): Uint8Array {
  let b = idBytesCache.get(id);
  if (b === undefined) {
    b = internalIdBytes(id);
    if (idBytesCache.size > 4096) idBytesCache.clear();
    idBytesCache.set(id, b);
  }
  return b;
}
const idString = (b: Uint8Array) => internalIdString(b);
/** A live index entry's document id and its document at the entry's ts (null columns: no such version). */
type JoinedEntry = { id: Uint8Array; json: string | null; docDeleted: bigint | null };

export class SqlitePersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
  /** PERSIST-01 C7 as an OS lock on the file, held for the process's life (STUDY-25 L9). */
  readonly leaseScope = "process";
  /** The store's single-writer lock: taken at open when free, else by acquireLease once it is. */
  private lock: ProcessLock | null = null;
  private db: Database;
  private insDoc;
  private insIdx;
  private putIdx;
  private scanAsc;
  private scanDesc;
  private getDoc;
  private maxDocTs;
  private docLogRows;
  private pruneIdx;
  private pruneDoc;
  private inTx = false;
  /** The highest ts applied since the last flush. */
  private top = 0n;
  /** The highest durable ts, once this handle writes: the document log's bound while a group sits
   *  uncommitted in this connection's open transaction (PERSIST-01 C12). Only the lock holder writes, so it stays exact. */
  private durableTs: bigint | null = null;

  constructor(
    private path: string,
    opts: { durable: boolean } & OpenOptions,
  ) {
    if (!this.inMemory) this.lock = ProcessLock.tryTake(path);
    this.db = new Database(path, { create: true });
    try {
      this.checkStore(opts);
    } catch (e) {
      this.db.close();
      this.lock?.release();
      throw e;
    }
    this.db.exec(`pragma journal_mode = wal; pragma synchronous = ${opts.durable ? "full" : "off"};
      pragma temp_store = memory; pragma cache_size = -262144;`);
    this.db.exec(SQLITE_LAYOUT);
    this.db.exec(`create table if not exists read_only (id integer primary key);`);
    this.insDoc = this.db.prepare(
      `insert into documents (id, ts, table_id, json_value, deleted, prev_ts) values (?, ?, ?, ?, ?, ?)`,
    );
    this.insIdx = this.db.prepare(`insert into indexes values (?, ?, ?, ?, ?, ?)`);
    this.putIdx = this.db.prepare(`insert or replace into indexes values (?, ?, ?, ?, ?, ?)`);
    // Newest version per key at or before ts, joined to its document at the entry's own ts, as Convex's
    // `index_scan` (crates/sqlite/src/lib.rs): the key's max ts from the primary key's index alone (it holds
    // every column the grouping reads, so old versions and tombstones cost no row lookup), then that one row
    // and its document. A page is at most `?5` keys; `scanLatestSync` pages on.
    // Timestamps are nanoseconds above 2^53 (STUDY-133 §5.3): the statements that read them return
    // integers as `bigint`.
    const scan = (dir: "asc" | "desc") =>
      this.db
        .prepare(`select a.key, a.ts, b.deleted, b.document_id, c.json_value, c.deleted as doc_deleted
        from (select key, max(ts) as ts from indexes where index_id = ?1 and key >= ?2 and key < ?3 and ts <= ?4
              group by key order by key ${dir} limit ?5) a
        join indexes b on b.index_id = ?1 and b.key = a.key and b.ts = a.ts
        left join documents c on c.ts = b.ts and c.table_id = b.table_id and c.id = b.document_id
        order by a.key ${dir}`)
        .safeIntegers(true);
    this.scanAsc = scan("asc");
    this.scanDesc = scan("desc");
    this.getDoc = this.db
      .prepare(`select json_value, deleted, ts from documents
        where table_id = ? and id = ? and ts <= ? order by ts desc limit 1`)
      .safeIntegers(true);
    // The newest ts written (the durable prefix, once a flush has committed it): the key's leading column.
    this.maxDocTs = this.db.prepare(`select max(ts) as m from documents`).safeIntegers(true);
    this.docLogRows = this.db
      .prepare(`select ts, table_id, id, deleted, prev_ts from documents
        where ts > ?1 and ts <= (select max(ts) from (select distinct ts from documents
                                 where ts > ?1 and ts <= ?2 order by ts limit ?3))
        order by ts, table_id, id`)
      .safeIntegers(true);
    // Convex's `DELETE_INDEX` and `DELETE_DOCUMENT`.
    this.pruneIdx = this.db.prepare(`delete from indexes where index_id = ? and ts <= ? and key = ?`);
    this.pruneDoc = this.db.prepare(`delete from documents where table_id = ? and id = ? and ts <= ?`);
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
    if (readOnly) this.db.run(`insert or ignore into read_only (id) values (1)`);
    else this.db.run(`delete from read_only`);
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    if (this.inMemory) return { epoch: 1 }; // nothing another process could share
    this.lock ??= ProcessLock.tryTake(this.path);
    if (!this.lock) return { heldBy: ProcessLock.holderOf(this.path), expiresInMs: null };
    this.lock.recordHolder(opts.holder);
    return { epoch: this.lock.epoch };
  }

  async renewLease() {} // the OS holds the lock for as long as this process lives

  async releaseLease() {
    this.lock?.release();
    this.lock = null;
  }

  /** Writing needs the store's lock: another process holds it otherwise. */
  private assertWriter() {
    if (!this.inMemory && !this.lock) throw new LeaseLostError("another process holds this SQLite store");
  }

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.assertWriter();
    if (!this.inTx) {
      this.durableTs ??= (this.maxDocTs.get() as { m: bigint | null }).m ?? 0n;
      this.db.exec("begin");
      this.inTx = true;
    }
    this.top = ts;
    for (const d of docs)
      this.insDoc.run(internalIdBytes(d.id), ts, cachedBytes(d.table), d.json, d.json === null ? 1 : 0, d.prevTs);
    for (const e of idx) this.writeEntry(this.insIdx, e, ts);
  }

  /** One `indexes` row, as Convex's `write`: a tombstone has NULL `table_id` and `document_id`. */
  private writeEntry(stmt: Statement, e: IndexWrite, ts: bigint) {
    if (e.id === null) stmt.run(cachedBytes(e.index), ts, e.key, 1, null, null);
    else stmt.run(cachedBytes(e.index), ts, e.key, 0, cachedBytes(e.table!), internalIdBytes(e.id));
  }

  /** PERSIST-01 C17: Convex's `INSERT OR REPLACE` of index rows at their own ts. */
  writeIndexEntries(entries: IndexEntryAt[]) {
    this.assertWriter();
    if (!entries.length) return;
    const write = () => {
      for (const e of entries) this.writeEntry(this.putIdx, e, e.ts);
    };
    // Inside a group being applied, the rows join its transaction; else they are one of their own.
    if (this.inTx) write();
    else this.db.transaction(write)();
  }

  flush() {
    if (this.inTx) {
      this.db.exec("commit");
      this.inTx = false;
      this.durableTs = this.top;
    }
  }

  /** PERSIST-01 C12. Rows of a group applied but not yet flushed are visible to this connection only; the
   *  bound leaves them out. */
  readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): DocLogRow[] {
    if (limit <= 0) return [];
    const hi = this.inTx ? minTs(upToTs, this.durableTs ?? 0n) : upToTs;
    return (
      this.docLogRows.all(afterTs, hi, limit) as {
        ts: bigint;
        table_id: Uint8Array;
        id: Uint8Array;
        deleted: bigint;
        prev_ts: bigint | null;
      }[]
    ).map((r) => ({
      ts: r.ts,
      table: idString(r.table_id),
      id: idString(r.id),
      deleted: !!r.deleted,
      prevTs: r.prev_ts,
    }));
  }

  /** PERSIST-01 C13. Inside a group still being applied, the deletes join its transaction. */
  pruneIndexes(entries: IndexPrune[]) {
    this.assertWriter();
    return this.db.transaction(() => {
      let n = 0;
      for (const e of entries) n += this.pruneIdx.run(cachedBytes(e.index), e.ts, e.key).changes;
      return n;
    })();
  }

  pruneDocuments(entries: DocPrune[]) {
    this.assertWriter();
    return this.db.transaction(() => {
      let n = 0;
      for (const e of entries) n += this.pruneDoc.run(cachedBytes(e.table), internalIdBytes(e.id), e.ts).changes;
      return n;
    })();
  }

  /** PERSIST-01 C14. */
  getGlobal(key: string): unknown {
    const r = this.db.query(`select json_value from persistence_globals where key = ?`).get(key) as {
      json_value: string;
    } | null;
    return r ? decodeGlobal(r.json_value) : null;
  }

  /** Convex's `WRITE_PERSISTENCE_GLOBAL`. */
  setGlobal(key: string, value: unknown) {
    this.assertWriter();
    this.db.run(`insert or replace into persistence_globals values (?, ?)`, [key, encodeGlobal(value)]);
  }

  auditRowCount() {
    const r = this.db
      .query(`select (select count(*) from documents) as docs, (select count(*) from indexes) as idx`)
      .get() as { docs: number; idx: number };
    return { docs: Number(r.docs), idx: Number(r.idx) };
  }

  scan(table: TabletId, index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    const q = desc ? this.scanDesc : this.scanAsc;
    const indexBytes = cachedBytes(index);
    const entries = scanLatestSync<JoinedEntry>(
      (p) =>
        (q.all(indexBytes, p.lo, p.hi, ts, p.n) as any[]).map((r) => ({
          key: r.key as Uint8Array,
          ts: r.ts as bigint,
          deleted: !!r.deleted,
          id:
            r.document_id === null
              ? null
              : { id: r.document_id as Uint8Array, json: r.json_value as string | null, docDeleted: r.doc_deleted },
        })),
      lo,
      hi,
      limit,
      desc,
    );
    // Convex's errors: no document at the entry's ts ("Dangling index reference"), or a deleted one.
    return entries.map((e): IndexedDoc => {
      const id = idString(e.id.id);
      if (e.id.docDeleted === null || e.id.docDeleted !== 0n)
        throw new DanglingReferenceError(index, id, e.ts, e.id.docDeleted !== null);
      return { id, ts: e.ts, json: e.id.json! };
    });
  }

  get(table: TabletId, id: InternalId, ts: bigint): DocVersion {
    const r = this.getDoc.get(cachedBytes(table), internalIdBytes(id), ts) as any;
    return r && !r.deleted ? { json: r.json_value as string, ts: r.ts as bigint } : null;
  }

  getVersions(table: TabletId, ids: string[], ts: bigint) {
    // Embedded: one indexed lookup per id is the fastest form (no round trips to save).
    const tableBytes = cachedBytes(table);
    return ids.map((id) => {
      const r = this.getDoc.get(tableBytes, internalIdBytes(id), ts) as any;
      return r && !r.deleted ? { json: r.json_value as string, ts: r.ts as bigint } : null;
    });
  }

  auditLiveDocs(table: TabletId, ts: bigint) {
    const r = this.db
      .query(`select count(*) as n from (select json_value, row_number() over (partition by id order by ts desc) rn
              from documents where table_id = ? and ts <= ?) where rn = 1 and json_value is not null`)
      .get(cachedBytes(table), ts) as { n: number };
    return Number(r.n);
  }

  // A flush is one SQLite transaction, so the newest ts in `documents` IS the last durable commit (PERSIST-01
  // C4/C5), as Convex's `max_ts` reads it. Index entries are never above it: a commit writes its documents, and
  // a backfill writes entries at their documents' own ts (C17).
  maxTs(): bigint {
    return (this.maxDocTs.get() as { m: bigint | null }).m ?? 0n;
  }

  close() {
    this.db.close();
    this.lock?.release();
    this.lock = null;
  }
}

const minTs = (a: bigint, b: bigint) => (a < b ? a : b);

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(SqlitePersistence);
