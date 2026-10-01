// The SQLite driver: Convex's two generic tables in bun:sqlite (WAL mode). A flush is one SQLite
// transaction, so a group of commits is durable (and crash-atomic) as a whole. Ships with @bunvex/core:
// bun:sqlite is built into Bun, so this driver has no dependency at all.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): `persistence_globals` ('layout_version', as
// Convex's SQLite store names its globals table) and `read_only` (Convex's name; its SQLite store has none).
// They are checked before the file is changed in any way (even the WAL pragma rewrites its header).
import { Database } from "bun:sqlite";
import type { DocWrite, IndexWrite, Lease, LeaseAcquire, Persistence } from "./index.ts";
import { LeaseLostError } from "./index.ts";
import {
  checkLayoutVersion,
  checkUnversionedTables,
  decodeLayoutVersion,
  LAYOUT_VERSION,
  LayoutError,
  type OpenOptions,
  ReadOnlyError,
  type ReadOnlyFlag,
} from "./layout.ts";
import { ProcessLock } from "./lock.ts";
import { scanLatestSync } from "./scan.ts";

/** bunvex's columns, as `pragma table_info` declares them: how an unversioned store is recognised. */
const COLUMNS = {
  documents: ["table_id integer", "id text", "ts integer", "json_value text", "deleted integer"],
  indexes: ["index_id integer", "key blob", "ts integer", "deleted integer", "document_id text"],
};

export class SqlitePersistence implements Persistence, Lease, ReadOnlyFlag {
  /** PERSIST-01 C7 as an OS lock on the file, held for the process's life (STUDY-25 L9). */
  readonly leaseScope = "process";
  /** The store's single-writer lock: taken at open when free, else by acquireLease once it is. */
  private lock: ProcessLock | null = null;
  private db: Database;
  private insDoc;
  private insIdx;
  private scanAsc;
  private scanDesc;
  private getDoc;
  private inTx = false;

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
    this.db.exec(`
      create table if not exists documents (table_id integer not null, id text not null, ts integer not null,
        json_value text, deleted integer not null, primary key (table_id, id, ts)) without rowid;
      create table if not exists indexes (index_id integer not null, key blob not null, ts integer not null,
        deleted integer not null, document_id text, primary key (index_id, key, ts)) without rowid;
      create table if not exists persistence_globals (key text primary key, json_value text not null);
      create table if not exists read_only (id integer primary key);`);
    this.insDoc = this.db.prepare(`insert into documents values (?, ?, ?, ?, ?)`);
    this.insIdx = this.db.prepare(`insert into indexes values (?, ?, ?, ?, ?)`);
    // Newest version per key at or before ts: order by key, ts desc and keep the first row of each key.
    const scan = (dir: "asc" | "desc") =>
      this.db.prepare(`select key, ts, deleted, document_id from indexes
        where index_id = ?1 and key >= ?2 and key < ?3 and ts <= ?4 order by key ${dir}, ts desc limit ?5`);
    this.scanAsc = scan("asc");
    this.scanDesc = scan("desc");
    this.getDoc = this.db.prepare(`select json_value, deleted from documents
        where table_id = ? and id = ? and ts <= ? order by ts desc limit 1`);
  }

  private get inMemory() {
    return this.path === ":memory:" || this.path === "";
  }

  /** PERSIST-01 C10, reading only: the layout version, or bunvex's columns on a store without one; and the
   *  read-only flag. Refusing needs no lock: nothing is written. */
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
    const v = tables.has("persistence_globals")
      ? (this.db.query(`select json_value from persistence_globals where key = 'layout_version'`).get() as {
          json_value: string;
        } | null)
      : null;
    if (v) checkLayoutVersion(decodeLayoutVersion(v.json_value), store);
    else {
      const found: Record<string, string[]> = {};
      for (const t of ["documents", "indexes"])
        if (tables.has(t))
          found[t] = (this.db.query(`pragma table_info(${t})`).all() as { name: string; type: string }[]).map(
            (c) => `${c.name} ${c.type.toLowerCase()}`,
          );
      checkUnversionedTables(store, found, COLUMNS);
    }
    if (tables.has("read_only") && this.db.query(`select 1 from read_only limit 1`).get() && !opts.allowReadOnly)
      throw new ReadOnlyError(store);
  }

  /** Convex's `set_read_only`: no lock needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    if (readOnly) this.db.run(`insert or ignore into read_only (id) values (1)`);
    else this.db.run(`delete from read_only`);
  }

  /** PERSIST-01 C10 under the lease: a new (or pre-C10) store records its layout version; one recorded in the
   *  meantime by another bunvex is checked again. */
  private stampLayout() {
    this.db.run(`insert or ignore into persistence_globals (key, json_value) values ('layout_version', ?)`, [
      JSON.stringify(LAYOUT_VERSION),
    ]);
    const v = this.db.query(`select json_value from persistence_globals where key = 'layout_version'`).get() as {
      json_value: string;
    };
    checkLayoutVersion(decodeLayoutVersion(v.json_value), `the SQLite store ${this.path}`);
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    if (this.inMemory) {
      this.stampLayout();
      return { epoch: 1 }; // nothing another process could share
    }
    this.lock ??= ProcessLock.tryTake(this.path);
    if (!this.lock) return { heldBy: ProcessLock.holderOf(this.path), expiresInMs: null };
    try {
      this.stampLayout();
    } catch (e) {
      await this.releaseLease();
      throw e;
    }
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

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    this.assertWriter();
    if (!this.inTx) {
      this.db.exec("begin");
      this.inTx = true;
    }
    for (const d of docs) this.insDoc.run(d.table, d.id, ts, d.json, d.json === null ? 1 : 0);
    for (const e of idx) this.insIdx.run(e.index, e.key, ts, e.id === null ? 1 : 0, e.id);
  }

  flush() {
    if (this.inTx) {
      this.db.exec("commit");
      this.inTx = false;
    }
  }

  scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    const q = desc ? this.scanDesc : this.scanAsc;
    return scanLatestSync(
      (p) =>
        (q.all(index, p.lo, p.hi, ts, p.n) as any[]).map((r) => ({
          key: r.key as Uint8Array,
          deleted: !!r.deleted,
          id: r.document_id as string | null,
        })),
      lo,
      hi,
      limit,
      desc,
    );
  }

  get(table: number, id: string, ts: number) {
    const r = this.getDoc.get(table, id, ts) as any;
    return r && !r.deleted ? (r.json_value as string) : null;
  }

  auditLiveDocs(table: number, ts: number) {
    const r = this.db
      .query(`select count(*) as n from (select json_value, row_number() over (partition by id order by ts desc) rn
              from documents where table_id = ? and ts <= ?) where rn = 1 and json_value is not null`)
      .get(table, ts) as { n: number };
    return Number(r.n);
  }

  // A flush is one SQLite transaction, so the newest ts of either table IS the last durable commit
  // (PERSIST-01 C4/C5). Both tables: a backfill commit writes index entries only (STUDY-24 S2).
  maxTs() {
    const r = this.db
      .query(
        `select max(coalesce((select max(ts) from documents), 0), coalesce((select max(ts) from indexes), 0)) as m`,
      )
      .get() as { m: number };
    return Number(r.m);
  }

  close() {
    this.db.close();
    this.lock?.release();
    this.lock = null;
  }
}
