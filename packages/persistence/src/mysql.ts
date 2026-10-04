// MySQL: the same two generic tables (documents + indexes). No DISTINCT ON, so the newest version per key
// is chosen client-side while paging an ordered range. Index keys are split into key_prefix / key_suffix /
// key_suffix_hash as Convex does, so a key of any length fits InnoDB's 3072-byte index limit (split.ts). The native driver `mysql2` is an optional peer.
//
// Single writer (PERSIST-01 C7): one row in `bunvex_lease` (epoch, holder, expires_at on the server's clock,
// max_ts). Each flush's FIRST statement updates the lease row only if our epoch is current, and records the
// group's top as the durable prefix; the rest of the group runs only if it matched. MySQL has no data-
// modifying CTE, so the fence costs one statement (a round trip) per flush. A flush is a write batch of whole
// commits (bounded by the committer: DV-62) in one transaction, its rows sent in INSERTs of at most 10 MiB, as
// Convex's `fill_chunks` (MYSQL_MAX_CHUNK_BYTES), to stay under `max_allowed_packet` on a large commit.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): `persistence_globals` ('layout_version') and
// `read_only`, Convex's table names. Open checks both before writing anything and refuses a foreign, future
// or read-only store; a new store's version record is written under the lease.
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by ts (`documents_by_ts`);
// prunes are Convex's v5 deletes, OR'd `ts <= X` clauses per key in chunks of 128 (MYSQL_CHUNK_SIZE), each
// key at its highest ts only; globals are `persistence_globals` rows. Each prune or global write first reads
// the lease row without locking it (a locking read would hold up the next flush) and is refused unless it
// carries our epoch. A takeover in between can let one batch through, which deletes only versions
// superseded below a window the old holder had already published.
// Timeouts (STUDY-25 L3), as Convex's MySQL driver: every database call is bounded on the client side (19 s by
// default, Convex's MYSQL_TIMEOUT_SECONDS), per round trip, including getting a connection from the pool. The
// MySQL protocol cannot cancel a statement, so a timed-out call's connection is destroyed, never reused.
//
// Retries (STUDY-25 L4/L5), as Convex's MySQL driver: an "operational" error (a lost connection, a server
// shutting down, too many connections, a read-only server; `operational` below, after Convex's
// `classify_mysql_error`) destroys its connection; a read, or the bootstrap, then runs once more on another
// connection (MYSQL_MAX_QUERY_RETRIES = 1; never after a timeout, which Convex leaves to the caller as
// backpressure). A flush that fails with an operational error or a timeout is transient (`isTransient`): the
// committer retries it, and this driver keeps the group for that retry. Before re-running a group, the driver
// reads the lease record: a group an earlier attempt did commit is acknowledged without writing (DV-124). One
// that lands after that read hits the primary key: `UnsureCommitError`.
import {
  checkLayoutVersion,
  checkUnversionedTables,
  chunkRows,
  DanglingReferenceError,
  DatabaseTimeoutError,
  type DocLogRow,
  type DocPrune,
  type DocWrite,
  decodeLayoutVersion,
  groupLog,
  type IndexPrune,
  type IndexWrite,
  LAYOUT_VERSION,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  type LogCommit,
  MYSQL_MAX_CHUNK_BYTES,
  type OpenOptions,
  type Persistence,
  ReadOnlyError,
  type ReadOnlyFlag,
  type RetentionStore,
  renewTimeoutMs,
  retriedGroupLanded,
  retryOnce,
  type ScanDocs,
  type SplitRow,
  scanLatest,
  splitKey,
  splitPages,
  UnsureCommitError,
  withTimeout,
} from "@bunvex/core/persistence";
import type * as mysqlDriver from "mysql2/promise";
import { loadPeer } from "./peer.ts";
import { explainTlsError, mysqlTls, type TlsOptions } from "./tls.ts";

type DocRow = [number, string, number, string | null, boolean];
type IdxRow = [number, Buffer, Buffer | null, Buffer, number, boolean, string | null];
/** A row's bytes in the INSERT's SQL text, bounded above: a string character is at most 3 UTF-8 bytes (an
 *  escaped one 2), a buffer is sent as X'hex' (2 per byte), plus the numbers, quotes and separators. */
const docRowBytes = (r: DocRow) => 64 + 3 * r[1].length + (r[3] === null ? 0 : 3 * r[3].length);
const idxRowBytes = (r: IdxRow) =>
  80 + 2 * (r[1].length + (r[2]?.length ?? 0) + r[3].length) + (r[6] === null ? 0 : 3 * r[6].length);
type Conn = mysqlDriver.PoolConnection;

/** Destroy a connection: out of the pool, and its socket closed at once (a frozen server never answers a
 *  polite close). */
const drop = (c: Conn) => {
  c.destroy();
  (c as unknown as { connection?: { stream?: { destroy?(): void } } }).connection?.stream?.destroy?.();
};

const STORE = "this MySQL database";
/** bunvex's columns, as information_schema names their types: how an unversioned store is recognised. */
const COLUMNS = {
  documents: ["table_id int", "id varchar", "ts bigint", "json_value mediumtext", "deleted tinyint"],
  indexes: [
    "index_id int",
    "key_prefix varbinary",
    "key_suffix longblob",
    "key_suffix_hash varbinary",
    "ts bigint",
    "deleted tinyint",
    "document_id varchar",
  ],
};
const TABLES = ["documents", "indexes", "bunvex_lease", "persistence_globals", "read_only"];

/** mysql2 and socket codes of a connection that is gone (Convex: `DriverError::ConnectionClosed`,
 *  `PoolDisconnected`, `Error::Io`). */
const LOST = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "POOL_CLOSED",
]);
/** Server errors Convex expects in operation: 1290 read-only, 2013 server lost, 1053 shutdown, 1040 too many
 *  connections. */
const OPERATIONAL_ERRNO = new Set([1290, 2013, 1053, 1040]);

/**
 * An "operational" error, as Convex's `classify_mysql_error` (`crates/mysql/src/connection.rs`): the connection
 * is gone or the server is not serving. Transient: a flush that fails with one is retried, and so is a read,
 * once, on another connection.
 */
export function operational(e: unknown): boolean {
  const x = e as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if (!x || typeof x !== "object") return false;
  if (typeof x.code === "string" && LOST.has(x.code)) return true;
  if (typeof x.errno === "number" && OPERATIONAL_ERRNO.has(x.errno)) return true;
  const message = typeof x.message === "string" ? x.message : "";
  // 1105 ER_UNKNOWN_ERROR with the messages Convex lists (Vitess).
  if (
    x.errno === 1105 &&
    /primary is not serving|for tx killer rollback|connection pool timed out|connection timed out/.test(message)
  )
    return true;
  // A connection mysql2 closed after a fatal error refuses every later command.
  return /connection is in closed state/.test(message);
}

export class MysqlPersistence implements Persistence, ScanDocs, Lease, ReadOnlyFlag, RetentionStore {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  /** The highest ts applied since the last flush: the group's top, recorded as max_ts by the fence. */
  private top = 0;
  /** Our lease's epoch, 0 when we hold none. */
  private epoch = 0;
  private ttlMs = 0;
  /** The store predates PERSIST-01 C11: its ts index is built once we hold the lease. */
  private needsLogIndex = false;
  private needsDocLogIndex = false;
  private constructor(
    private pool: mysqlDriver.Pool,
    /** This instance's connections' `bunvex_conn` connect attribute, recorded in the lease row: a successor
     *  that finds us paused mid-flush after our lease expired kills exactly these connections. */
    private conn: string,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
  ) {}

  /**
   * TLS (STUDY-25 L8, as Convex): required, with the CA and the host name verified, by default;
   * `requireSsl: false` connects as the URL says (plain unless it asks for TLS or `caFile` is set).
   * `caFile` adds a trusted CA.
   *
   * `timeoutMs` (default 19 000, Convex's `MYSQL_TIMEOUT_SECONDS`): how long one round trip to the database
   * (a statement, BEGIN, COMMIT, getting a connection) may take before the call fails with
   * `DatabaseTimeoutError` and its connection is destroyed (STUDY-25 L3). 0 disables it.
   */
  static async open(url: string, pool = 16, opts: OpenOptions & TlsOptions & { timeoutMs?: number } = {}) {
    const mysql = await loadPeer<typeof mysqlDriver>("mysql2/promise", "mysql2");
    const conn = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const { uri, ssl } = mysqlTls(url, opts);
    const timeoutMs = opts.timeoutMs ?? 19_000;
    const p = mysql.createPool({
      uri,
      ...(ssl ? { ssl: ssl as mysqlDriver.SslOptions } : {}),
      connectionLimit: pool,
      multipleStatements: false,
      connectAttributes: { bunvex_conn: conn },
      ...(timeoutMs > 0 && timeoutMs < Infinity ? { connectTimeout: timeoutMs } : {}),
    });
    const store = new MysqlPersistence(p, conn, timeoutMs);
    try {
      await store.bootstrap(opts);
    } catch (e) {
      await store.close().catch(() => {});
      throw explainTlsError(e, "MySQL", "MYSQL_CA_FILE");
    }
    return store;
  }

  /**
   * One database call on one pooled connection, bounded by the client-side timeout per round trip
   * (`progress()` marks the end of one; getting the connection is the first). On a timeout the connection is
   * destroyed; otherwise it goes back to the pool.
   */
  private call<T>(fn: (c: Conn, progress: () => void) => Promise<T>, ms = this.timeoutMs): Promise<T> {
    let c: Conn | null = null;
    let timedOut = false;
    return withTimeout(
      "MySQL",
      ms,
      async (progress) => {
        const got = await this.pool.getConnection();
        if (timedOut) {
          got.release(); // the call has failed already; this connection did nothing wrong
          throw new Error("timed out");
        }
        c = got;
        progress();
        let lost = false;
        try {
          return await fn(got, progress);
        } catch (e) {
          lost = operational(e);
          throw e;
        } finally {
          // A connection an operational error came from is not reused (Convex discards it too).
          if (!timedOut) lost ? drop(got) : got.release();
        }
      },
      () => {
        timedOut = true;
        if (c) drop(c);
      },
    );
  }

  /**
   * A read (or an idempotent bootstrap step): one call, run once more on another connection after an
   * operational error (STUDY-25 L5; Convex's MYSQL_MAX_QUERY_RETRIES = 1). Not after a timeout: Convex returns
   * that one to the caller.
   */
  private read<T>(fn: (c: Conn, progress: () => void) => Promise<T>): Promise<T> {
    return retryOnce(() => this.call(fn), operational);
  }

  /** As Convex's `is_transient_db_error`: a timeout or an operational error (STUDY-25 L4). */
  isTransient(e: unknown) {
    return e instanceof DatabaseTimeoutError || operational(e);
  }

  /** The server and store checks (C10), then the tables, created only when one is missing. */
  private async bootstrap(opts: OpenOptions) {
    // A writable server only, as Convex's `require_leader` (crates/mysql/src/connection.rs:670-690), the
    // counterpart of Postgres's target_session_attrs=read-write. Convex repeats it on every new connection;
    // bunvex checks at open (a replica that becomes read-only later fails its writes).
    const [ro] = (await this.call((c) =>
      c.query(`select (@@global.innodb_read_only or @@global.read_only) as ro`),
    )) as any;
    if (Number(ro[0].ro))
      throw new Error("MySQL is read-only (read_only or innodb_read_only is on): bunvex needs the writable primary");
    // What is there decides what may happen: read-only, before any write.
    const [rows] = (await this.read((c) =>
      c.query(
        `select table_name as t from information_schema.tables
         where table_schema = database() and table_name in (?)`,
        [TABLES],
      ),
    )) as any;
    const have = new Set<string>(rows.map((r: any) => r.t as string));
    await this.checkStore(have, opts);
    // A store written before C11 (its indexes table lacks the ts index): building it waits for the lease, as
    // an upgrade would. A new `indexes` table is created with it.
    if (have.has("indexes")) {
      const [byTs] = (await this.read((c) =>
        c.query(
          `select count(*) as n from information_schema.statistics
           where table_schema = database() and table_name = 'indexes' and index_name = 'indexes_by_ts'`,
        ),
      )) as any;
      this.needsLogIndex = Number(byTs[0].n) === 0;
    }
    if (have.has("documents")) {
      const [byTs] = (await this.read((c) =>
        c.query(
          `select count(*) as n from information_schema.statistics
           where table_schema = database() and table_name = 'documents' and index_name = 'documents_by_ts'`,
        ),
      )) as any;
      this.needsDocLogIndex = Number(byTs[0].n) === 0;
    }
    // DDL only when a table is missing, as Convex's v5 driver does (a `create table if not exists` still
    // takes metadata locks: MySQL bug 63144); concurrent first opens are serialized by a named lock.
    if (have.size >= TABLES.length) return;
    // Every statement is idempotent: the whole step runs again after an operational error.
    await this.read(async (c, progress) => {
      try {
        await c.query(`select get_lock('bunvex_bootstrap', 10)`);
        progress();
        await c.query(`create table if not exists documents (table_id int not null, id varchar(64) not null,
          ts bigint not null, json_value mediumtext, deleted boolean not null, primary key (table_id, id, ts),
          key documents_by_ts (ts))`); // the document log (PERSIST-01 C12)
        progress();
        await c.query(`create table if not exists indexes (index_id int not null, key_prefix varbinary(2500) not null,
          key_suffix longblob, key_suffix_hash varbinary(32) not null, ts bigint not null, deleted boolean not null,
          document_id varchar(64), primary key (index_id, key_prefix, key_suffix_hash, ts desc),
          key indexes_by_ts (ts))`); // the ts index: the log by ts (PERSIST-01 C11)
        progress();
        await c.query(`create table if not exists bunvex_lease (id int primary key, epoch bigint not null,
          holder varchar(255), holder_conn varchar(64), expires_at datetime(6) not null, max_ts bigint not null)`);
        progress();
        await c.query(`create table if not exists persistence_globals (\`key\` varchar(255) primary key,
          json_value text not null)`);
        progress();
        await c.query(`create table if not exists read_only (id bigint primary key)`);
        progress();
      } finally {
        await c.query(`select release_lock('bunvex_bootstrap')`).catch(() => {});
      }
    });
  }

  /**
   * PERSIST-01 C10, before anything is written: the recorded layout version must be this bunvex's; a store
   * without one must have bunvex's columns (written before C10: the same layout) or no tables at all; and a
   * store marked read-only opens only with `allowReadOnly`. Refusing needs no lease: nothing is written.
   */
  private async checkStore(have: Set<string>, opts: OpenOptions) {
    const [rows] = (await this.read((c) =>
      c.query(
        `select ${have.has("persistence_globals") ? "(select json_value from persistence_globals where `key` = 'layout_version')" : "null"} as v,
         ${have.has("read_only") ? "exists (select 1 from read_only)" : "0"} as ro`,
      ),
    )) as any;
    const version = decodeLayoutVersion(rows[0].v);
    if (version !== null) checkLayoutVersion(version, STORE);
    else if (have.has("documents") || have.has("indexes")) {
      const [cols] = (await this.read((c) =>
        c.query(
          `select table_name as t, concat(column_name, ' ', data_type) as c from information_schema.columns
           where table_schema = database() and table_name in ('documents', 'indexes')`,
        ),
      )) as any;
      const found: Record<string, string[]> = {};
      for (const c of cols) found[c.t] = [...(found[c.t] ?? []), String(c.c).toLowerCase()];
      checkUnversionedTables(STORE, found, COLUMNS);
    }
    if (Number(rows[0].ro) && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call((c) =>
      c.query(readOnly ? `insert ignore into read_only (id) values (1)` : `delete from read_only`),
    );
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    const r = await this.acquireOnce(opts);
    if ("epoch" in r && this.needsLogIndex) {
      // One timed call (STUDY-25 L3), not retried: a build that timed out is not run twice.
      await this.call((c) => c.query(`alter table indexes add index indexes_by_ts (ts)`)).catch((e) => {
        if ((e as { errno?: number }).errno !== 1061) throw e; // 1061: it exists already
      });
      this.needsLogIndex = false;
    }
    if ("epoch" in r && this.needsDocLogIndex) {
      await this.call((c) => c.query(`alter table documents add index documents_by_ts (ts)`)).catch((e) => {
        if ((e as { errno?: number }).errno !== 1061) throw e;
      });
      this.needsDocLogIndex = false;
    }
    return r;
  }

  private async acquireOnce(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.tryAcquire(opts);
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1205 || attempt >= 3) throw e; // 1205: lock wait timeout
      }
      // The lease row is locked: its holder is inside a flush. A live holder is just writing: busy. An
      // expired one that still holds the row is paused mid-flush (a stopped or frozen process): end its
      // connections, so its uncommitted group rolls back (it was never acknowledged).
      const [rows] = (await this.call((c) =>
        c.query(
          `select holder, holder_conn, expires_at <= now(6) as expired,
           greatest(0, timestampdiff(microsecond, now(6), expires_at)) / 1000 as ms
         from bunvex_lease where id = 1`,
        ),
      )) as any;
      const s = rows[0];
      if (!Number(s.expired)) return { heldBy: s.holder as string, expiresInMs: Number(s.ms) };
      const [stale] = (await this.call((c) =>
        c.query(
          `select processlist_id as id from performance_schema.session_connect_attrs
         where attr_name = 'bunvex_conn' and attr_value = ? and processlist_id <> connection_id()`,
          [s.holder_conn],
        ),
      )) as any;
      for (const r of stale) await this.call((c) => c.query(`kill ${Number(r.id)}`)).catch(() => {});
    }
  }

  private tryAcquire(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    return this.call((c, progress) => this.tryAcquireOn(c, progress, opts));
  }

  private async tryAcquireOn(c: Conn, progress: () => void, opts: { holder: string; ttlMs: number }) {
    try {
      // A holder paused inside a flush holds the row lock: give up after 1 s and look (acquireLease).
      await c.query(`set session innodb_lock_wait_timeout = 1`);
      progress();
      await c.beginTransaction();
      progress();
      const [n] = (await c.query(`select count(*) as n from bunvex_lease`)) as any;
      progress();
      if (!Number(n[0].n))
        // A store written before the lease existed: its durable prefix is the newest row of either table.
        await c.query(`insert ignore into bunvex_lease (id, epoch, holder, holder_conn, expires_at, max_ts)
          select 1, 0, null, null, '1970-01-01', greatest((select coalesce(max(ts), 0) from documents),
                                                          (select coalesce(max(ts), 0) from indexes))`);
      progress();
      const [won] = (await c.query(
        `update bunvex_lease set epoch = epoch + 1, holder = ?, holder_conn = ?,
           expires_at = now(6) + interval ? microsecond
         where id = 1 and (holder is null or expires_at <= now(6))`,
        [opts.holder, this.conn, opts.ttlMs * 1000],
      )) as any;
      progress();
      if (won.affectedRows === 1) {
        const [e] = (await c.query(`select epoch from bunvex_lease where id = 1`)) as any;
        progress();
        // PERSIST-01 C10: a new (or pre-C10) store gets its layout version now, under the lease, in the same
        // transaction; one stamped in the meantime by another bunvex is checked again (a mismatch rolls the
        // acquisition back).
        await c.query(`insert ignore into persistence_globals (\`key\`, json_value) values ('layout_version', ?)`, [
          JSON.stringify(LAYOUT_VERSION),
        ]);
        progress();
        const [v] = (await c.query(
          `select json_value from persistence_globals where \`key\` = 'layout_version' for share`,
        )) as any;
        checkLayoutVersion(decodeLayoutVersion(v[0]?.json_value), STORE);
        progress();
        await c.commit();
        this.epoch = Number(e[0].epoch);
        this.ttlMs = opts.ttlMs;
        return { epoch: this.epoch };
      }
      // A current read (`for share`), not this transaction's snapshot: under REPEATABLE READ the snapshot was
      // taken before a concurrent first boot created the row.
      const [held] = (await c.query(
        `select holder, greatest(0, timestampdiff(microsecond, now(6), expires_at)) / 1000 as ms
         from bunvex_lease where id = 1 for share`,
      )) as any;
      progress();
      await c.commit();
      return { heldBy: held[0].holder as string, expiresInMs: Number(held[0].ms) };
    } catch (e) {
      await c.rollback().catch(() => {});
      throw e;
    } finally {
      await c.query(`set session innodb_lock_wait_timeout = default`).catch(() => {});
    }
  }

  /** Bounded by a quarter of the TTL (`renewTimeoutMs`, STUDY-25 L3). */
  async renewLease() {
    const [r] = (await this.call(
      (c) =>
        c.query(`update bunvex_lease set expires_at = now(6) + interval ? microsecond where id = 1 and epoch = ?`, [
          this.ttlMs * 1000,
          this.epoch,
        ]),
      renewTimeoutMs(this.timeoutMs, this.ttlMs),
    )) as any;
    if (r.affectedRows !== 1) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.call((c) => c.query(`update bunvex_lease set holder = null where id = 1 and epoch = ?`, [this.epoch]));
    this.epoch = 0;
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    this.top = ts;
    for (const d of docs) this.docs.push([d.table, d.id, ts, d.json, d.json === null]);
    for (const e of idx) {
      const k = splitKey(e.key);
      this.idx.push([
        e.index,
        Buffer.from(k.prefix),
        k.suffix && Buffer.from(k.suffix),
        Buffer.from(k.suffixHash),
        ts,
        e.id === null,
        e.id,
      ]);
    }
  }

  async flush() {
    if (!this.docs.length && !this.idx.length) return;
    if (!this.epoch) throw new Error("flush without the store's lease (PERSIST-01 C7): acquireLease first");
    const docs = this.docs;
    const idx = this.idx;
    const top = this.top;
    this.docs = [];
    this.idx = [];
    const retry = this.retrying;
    try {
      // A retry: the group may have landed although its attempt failed here (its answer was lost). Then it
      // is there exactly once, and acknowledged without writing (DV-124).
      if (!(retry && (await this.landed(top)))) await this.flushGroup(docs, idx, top);
      this.retrying = false;
    } catch (e) {
      // Keep the group: the committer retries a transient failure with the same rows at the same timestamps.
      this.docs = docs.concat(this.docs);
      this.idx = idx.concat(this.idx);
      this.retrying = true;
      // 1062 ER_DUP_ENTRY: the group is there already, so an earlier attempt of it did commit although it
      // failed here.
      if (retry && (e as { errno?: number }).errno === 1062)
        throw new UnsureCommitError(
          `a retried flush (ts ≤ ${top}) found its rows already written by an earlier attempt`,
          { cause: e },
        );
      throw e;
    }
  }

  /** Set once a flush failed and kept its group: the next flush is a retry of it. */
  private retrying = false;

  /** Whether the group up to `top` committed, from the lease record (`retriedGroupLanded`, PERSIST-01 C9). */
  private async landed(top: number) {
    const [rows] = (await this.call((c) => c.query(`select epoch, max_ts from bunvex_lease where id = 1`))) as any;
    const l = rows[0];
    return retriedGroupLanded(l && { epoch: Number(l.epoch), maxTs: Number(l.max_ts) }, this.epoch, top);
  }

  private async flushGroup(docs: DocRow[], idx: IdxRow[], top: number) {
    await this.call(async (c, progress) => {
      try {
        await c.beginTransaction();
        progress();
        // The fence: nothing of the group is written unless the lease row still carries our epoch. The row
        // lock is held to COMMIT, so a takeover waits for this transaction and then sees max_ts.
        const [f] = (await c.query(`update bunvex_lease set max_ts = ? where id = 1 and epoch = ?`, [
          top,
          this.epoch,
        ])) as any;
        if (f.affectedRows !== 1) throw new LeaseLostError();
        progress();
        // `values ?` with a nested array expands to a multi-row insert. Filled up to 10 MiB of SQL each, as
        // Convex's `fill_chunks`, to stay under max_allowed_packet whatever the commit's size (DV-62).
        for (const chunk of chunkRows(docs, Infinity, MYSQL_MAX_CHUNK_BYTES, docRowBytes)) {
          await c.query(`insert into documents values ?`, [chunk]);
          progress();
        }
        for (const chunk of chunkRows(idx, Infinity, MYSQL_MAX_CHUNK_BYTES, idxRowBytes)) {
          await c.query(`insert into indexes values ?`, [chunk]);
          progress();
        }
        await c.commit();
      } catch (e) {
        // On a lost connection the rollback fails too (the server rolls back on its own): keep the first error.
        if (!operational(e)) await c.rollback().catch(() => {});
        throw e;
      }
    });
  }

  private latestEntries(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    const dir = desc ? "desc" : "asc";
    const toRow = (r: any): SplitRow => ({
      prefix: r.key_prefix as Uint8Array, // a Buffer is a Uint8Array: no copy
      suffix: (r.key_suffix as Uint8Array | null) ?? null,
      ts: Number(r.ts),
      deleted: !!r.deleted,
      id: r.document_id,
    });
    return scanLatest(
      splitPages(
        {
          page: async (b) => {
            const [rows] = (await this.read((c) =>
              c.execute(
                `select key_prefix, key_suffix, ts, deleted, document_id from indexes
               where index_id = ? and key_prefix ${b.loStrict ? ">" : ">="} ? and key_prefix ${b.hiInclusive ? "<=" : "<"} ?
                 and ts <= ?
               order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc limit ${Math.floor(b.n)}`,
                [index, Buffer.from(b.lo), Buffer.from(b.hi), ts],
              ),
            )) as any;
            return (rows as any[]).map(toRow);
          },
          group: async (prefix) => {
            const [rows] = (await this.read((c) =>
              c.execute(
                `select key_prefix, key_suffix, ts, deleted, document_id from indexes
               where index_id = ? and key_prefix = ? and ts <= ?`,
                [index, Buffer.from(prefix), ts],
              ),
            )) as any;
            return (rows as any[]).map(toRow);
          },
        },
        desc,
      ),
      lo,
      hi,
      limit,
      desc,
    );
  }

  scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    return this.latestEntries(index, lo, hi, ts, limit, desc);
  }

  async get(table: number, id: string, ts: number) {
    const [rows] = (await this.read((c) =>
      c.execute(
        `select json_value, deleted from documents where table_id = ? and id = ? and ts <= ? order by ts desc limit 1`,
        [table, id, ts],
      ),
    )) as any;
    const r = rows[0];
    return r && !r.deleted ? (r.json_value as string) : null;
  }

  async getVersions(table: number, ids: string[], ts: number) {
    const found = new Map<string, { json: string | null; ts: number }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
      const chunk = unique.slice(i, i + VERSIONS_CHUNK);
      const [rows] = (await this.read((c) =>
        c.execute(
          `select id, ts, json_value, deleted from (
             select id, ts, json_value, deleted, row_number() over (partition by id order by ts desc) rn
             from documents where table_id = ? and id in (${chunk.map(() => "?").join(",")}) and ts <= ?) v
           where rn = 1`,
          [table, ...chunk, ts],
        ),
      )) as any;
      for (const r of rows) found.set(r.id, { json: r.deleted ? null : (r.json_value as string), ts: Number(r.ts) });
    }
    return versionsInOrder(ids, found);
  }

  async scanDocs(
    table: number,
    index: number,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: number,
    limit: number,
    desc: boolean,
  ) {
    const ids = await this.latestEntries(index, lo, hi, ts, limit, desc);
    if (!ids.length) return [];
    // One round trip for every document: the newest version <= ts of each id.
    const [rows] = (await this.read((c) =>
      c.query(
        `select d.id, d.json_value, d.deleted from documents d
       join (select id, max(ts) ts from documents where table_id = ? and id in (?) and ts <= ? group by id) v
         on d.table_id = ? and d.id = v.id and d.ts = v.ts`,
        [table, ids, ts, table],
      ),
    )) as any;
    const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
    const out: string[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      // An entry without a live document is a corrupt store: raised, never skipped (PERSIST-01 C15).
      if (!r || r.deleted) throw new DanglingReferenceError(index, id, ts, !!r);
      out.push(r.json_value);
    }
    return out;
  }

  /**
   * PERSIST-01 C11, one statement (one consistent read): the bound is the lease row's max_ts (the durable
   * prefix, written in the same transaction as each group); the derived table walks the ts index to the
   * last of the first `limit` commits, and the rows up to it come back in ts order, with the newest ts at
   * or before `afterTs`.
   */
  async readLog(afterTs: number, upToTs: number, limit: number): Promise<LogCommit[]> {
    if (limit <= 0) return [];
    // One statement, so a read (STUDY-25 L3/L5): bounded by the call timeout, run once more on another
    // connection after an operational error.
    const [rows] = (await this.read((c) =>
      c.query(
        `select i.ts, i.index_id, i.key_prefix, i.key_suffix, i.document_id,
              (select max(ts) from indexes where ts <= ?) as prev
       from indexes i
       where i.ts > ? and i.ts <= (select max(c.ts) from (select distinct ts from indexes
         where ts > ? and ts <= least(?, coalesce((select max_ts from bunvex_lease where id = 1), ?))
         order by ts limit ${Math.floor(limit)}) c)
       order by i.ts`,
        [afterTs, afterTs, afterTs, upToTs, upToTs],
      ),
    )) as any;
    if (!rows.length) return [];
    return groupLog(
      (rows as any[]).map((r) => ({
        ts: Number(r.ts),
        index: r.index_id as number,
        key: r.key_suffix ? Buffer.concat([r.key_prefix, r.key_suffix]) : (r.key_prefix as Uint8Array),
        id: r.document_id as string | null,
      })),
      Number(rows[0].prev ?? 0),
    );
  }

  /** PERSIST-01 C12: as readLog, over `documents`. */
  async readDocumentLog(afterTs: number, upToTs: number, limit: number): Promise<DocLogRow[]> {
    if (limit <= 0) return [];
    const [rows] = (await this.read((c) =>
      c.query(
        `select d.ts, d.table_id, d.id, d.deleted from documents d
       where d.ts > ? and d.ts <= (select max(c.ts) from (select distinct ts from documents
         where ts > ? and ts <= least(?, coalesce((select max_ts from bunvex_lease where id = 1), ?))
         order by ts limit ${Math.floor(limit)}) c)
       order by d.ts`,
        [afterTs, afterTs, upToTs, upToTs],
      ),
    )) as any;
    return (rows as any[]).map((r) => ({
      ts: Number(r.ts),
      table: r.table_id as number,
      id: r.id as string,
      deleted: !!r.deleted,
    }));
  }

  /** Refused unless the lease row carries our epoch (a plain read: see the header). */
  private async assertEpoch() {
    const [rows] = (await this.read((c) => c.query(`select epoch from bunvex_lease where id = 1`))) as any;
    if (!this.epoch || !rows.length || Number(rows[0].epoch) !== this.epoch) throw new LeaseLostError();
  }

  /** PERSIST-01 C13. */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    await this.assertEpoch();
    // We implicitly delete everything below each ts, so only the highest per key matters (Convex's v5).
    const top = new Map<string, { index: number; prefix: Buffer; hash: Buffer; ts: number }>();
    for (const e of entries) {
      const k = splitKey(e.key);
      const prefix = Buffer.from(k.prefix);
      const hash = Buffer.from(k.suffixHash);
      const id = `${e.index}:${prefix.toString("hex")}:${hash.toString("hex")}`;
      const cur = top.get(id);
      if (!cur || cur.ts < e.ts) top.set(id, { index: e.index, prefix, hash, ts: e.ts });
    }
    return this.deleteChunks(
      [...top.values()],
      "indexes",
      "(index_id = ? and key_prefix = ? and key_suffix_hash = ? and ts <= ?)",
      (r) => [r.index, r.prefix, r.hash, r.ts],
    );
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    await this.assertEpoch();
    const top = new Map<string, DocPrune>();
    for (const e of entries) {
      const id = `${e.table}:${e.id}`;
      const cur = top.get(id);
      if (!cur || cur.ts < e.ts) top.set(id, e);
    }
    return this.deleteChunks([...top.values()], "documents", "(table_id = ? and id = ? and ts <= ?)", (r) => [
      r.table,
      r.id,
      r.ts,
    ]);
  }

  private async deleteChunks<T>(rows: T[], table: string, clause: string, params: (r: T) => unknown[]) {
    let n = 0;
    for (let i = 0; i < rows.length; i += 128) {
      const chunk = rows.slice(i, i + 128);
      const [r] = (await this.read((c) =>
        c.query(`delete from ${table} where ${chunk.map(() => clause).join(" or ")}`, chunk.flatMap(params)),
      )) as any;
      n += Number(r.affectedRows);
    }
    return n;
  }

  /** PERSIST-01 C14. */
  async getGlobal(key: string): Promise<unknown> {
    const [rows] = (await this.read((c) =>
      c.query("select json_value from persistence_globals where `key` = ?", [key]),
    )) as any;
    return rows.length ? JSON.parse(String(rows[0].json_value)) : null;
  }

  async setGlobal(key: string, value: unknown) {
    await this.assertEpoch();
    await this.read((c) =>
      c.query(
        "insert into persistence_globals (`key`, json_value) values (?, ?) on duplicate key update json_value = values(json_value)",
        [key, JSON.stringify(value)],
      ),
    );
  }

  async auditRowCount() {
    const [rows] = (await this.read((c) =>
      c.query(`select (select count(*) from documents) as docs, (select count(*) from indexes) as idx`),
    )) as any;
    return { docs: Number(rows[0].docs), idx: Number(rows[0].idx) };
  }

  /** The durable prefix (PERSIST-01 C5/C7): the lease row's max_ts, which every fenced flush sets. A store
   *  never leased has no row yet: the newest row of either table. */
  async maxTs() {
    const [rows] = (await this.read((c) =>
      c.query(
        `select coalesce((select max_ts from bunvex_lease where id = 1),
         greatest((select coalesce(max(ts), 0) from documents), (select coalesce(max(ts), 0) from indexes))) as m`,
      ),
    )) as any;
    return Number(rows[0].m);
  }

  async auditLiveDocs(table: number, ts: number) {
    const [rows] = (await this.read((c) =>
      c.query(
        `select count(*) as n from (select json_value, row_number() over (partition by id order by ts desc) rn
       from documents where table_id = ? and ts <= ?) v where rn = 1 and json_value is not null`,
        [table, ts],
      ),
    )) as any;
    return Number(rows[0].n);
  }

  async auditRowsAt(ts: number) {
    const [rows] = (await this.read((c) =>
      c.query(
        `select (select count(*) from documents where ts = ?) as docs, (select count(*) from indexes where ts = ?) as idx`,
        [ts, ts],
      ),
    )) as any;
    return { docs: Number(rows[0].docs), idx: Number(rows[0].idx) };
  }

  /** Ends the pool; on a database that does not answer, gives up after one timeout. */
  async close() {
    await withTimeout("MySQL", this.timeoutMs, () => this.pool.end());
  }
}

/** PERSIST-01 C16's answer in the ids' order (duplicates included), from the rows found per id. */
function versionsInOrder(ids: string[], found: Map<string, { json: string | null; ts: number }>) {
  return ids.map((id) => {
    const v = found.get(id);
    return v && v.json !== null ? { json: v.json, ts: v.ts } : null;
  });
}

/** Ids per `getVersions` statement: one round trip each, within every store's parameter limits. */
const VERSIONS_CHUNK = 1000;
