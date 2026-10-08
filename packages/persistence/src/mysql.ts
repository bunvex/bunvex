// MySQL in Convex's v5 layout (crates/mysql/src/v5, STUDY-133 §1.7): `documents`, `indexes`, `leases`,
// `read_only` and `persistence_globals`, created with Convex's own statements, so a store either system wrote
// opens in the other. Ids, tablets and index ids are BINARY(16); index keys are split as Convex's: `key_prefix`
// (the first 2500 bytes, which fit InnoDB's 3072-byte key limit), `key_suffix` (the rest) and `key_sha256` (the
// SHA-256 of the whole key), so a key of any length fits (split.ts). A document version is stored as v0 (its JSON) by
// default, or in Convex's v1 encoding (its sort key in an LZ4 block, mysql-documents.ts) with
// MYSQL_DOCUMENT_ENCODING=1 (DV-414); both are read. The native
// driver `mysql2` is an optional peer.
//
// Single writer (PERSIST-01 C7), as Convex's lease (DV-413, reversing DV-14 here): one `leases` row whose `ts`
// is its holder's start, in wall-clock nanoseconds. A start takes it at once if its ts is newer (the newest
// process wins); the previous holder fails its next write with `LeaseLostError`. Every flush ends with Convex's
// `lease_precond`, a `FOR SHARE` read of the row carrying our ts, before COMMIT: a takeover waits for that
// transaction and then sees its rows. A flush is a write batch of whole commits (bounded by the committer:
// DV-62) in one transaction, its rows sent in INSERTs of at most 10 MiB, as Convex's `fill_chunks`
// (MYSQL_MAX_CHUNK_BYTES), to stay under `max_allowed_packet` on a large commit.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L7): no layout record (DV-418): the open checks that the
// tables it finds have Convex's columns, before writing anything, and refuses a read-only store.
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by its key's leading `ts`;
// prunes are Convex's v5 deletes, OR'd `ts <= X` clauses per key in chunks of 128 (MYSQL_SMART_CHUNK_MAX_SIZE), each key
// at its highest ts only; globals are `persistence_globals` rows. Each prune or global write first reads the
// lease row without locking it (a locking read would hold up the next flush) and is refused unless it carries
// our ts. A takeover in between can let one batch through, which deletes only versions superseded below a
// window the old holder had already published.
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
// checks that the lease is still ours and whether the group's rows are there: a group an earlier attempt did
// commit is acknowledged without writing (DV-124). One that lands after that read hits the primary key:
// `UnsureCommitError`.
import {
  checkStoreTables,
  chunkRows,
  DanglingReferenceError,
  DatabaseTimeoutError,
  type DocLogRow,
  type DocPrune,
  type DocVersion,
  type DocWrite,
  decodeGlobal,
  encodeGlobal,
  type IndexEntryAt,
  type IndexedDoc,
  type IndexId,
  type IndexPrune,
  type IndexWrite,
  type InternalId,
  internalIdBytes,
  internalIdString,
  keySha256,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  MAX_KEY_PREFIX_LEN,
  MYSQL_MAX_CHUNK_BYTES,
  type OpenOptions,
  opaqueToInspect,
  type Persistence,
  ReadOnlyError,
  type ReadOnlyFlag,
  type RetentionStore,
  renewTimeoutMs,
  retryOnce,
  type SplitRow,
  scanLatest,
  splitKey,
  splitPages,
  type TabletId,
  UnsureCommitError,
  wallClockNs,
  withTimeout,
} from "@bunvex/core/persistence";
import type * as mysqlDriver from "mysql2/promise";
import { decodeDocument, encodeV0, encodeV1 } from "./mysql-documents.ts";

export { decodeDocument } from "./mysql-documents.ts";

import { loadPeer } from "./peer.ts";
import { explainTlsError, mysqlTls, type TlsOptions } from "./tls.ts";

/**
 * The encoding new document versions are written in, Convex's `MYSQL_DOCUMENT_ENCODING` knob: 0 (v0, the JSON
 * text) or 1 (v1, LZ4 over the sort key). Both are always read. **Decided divergence (owner, 2026-10-07, DV-414):**
 * bunvex's default is 0, Convex's 1. In Rust a sort key decodes as fast as JSON; here it replaces the native
 * `JSON.parse` with a TypeScript decoder, slower even optimized, and v1 saves only storage. Convex reads v0, so
 * stores still cross-open both ways; setting the knob to 1 gives Convex's behaviour.
 */
export function documentEncodingFromEnv(raw = process.env.MYSQL_DOCUMENT_ENCODING): 0 | 1 {
  if (raw === undefined || raw === "") return 0;
  if (raw === "0" || raw === "1") return Number(raw) as 0 | 1;
  throw new Error(`Unknown encoding version ${raw}: MYSQL_DOCUMENT_ENCODING is 0 (JSON) or 1 (LZ4)`);
}

// id, ts, table_id, json_value, deleted, prev_ts — Convex's column order.
type DocRow = [Buffer, bigint, Buffer, Buffer, boolean, bigint | null];
// index_id, ts, key_prefix, key_suffix, key_sha256, deleted, table_id, document_id — Convex's column order.
type IdxRow = [Buffer, bigint, Buffer, Buffer | null, Buffer, boolean, Buffer | null, Buffer | null];
/** A row's bytes in the INSERT's SQL text, bounded above: a buffer is sent as X'hex' (2 per byte), plus the
 *  numbers, quotes and separators. */
const docRowBytes = (r: DocRow) => 96 + 2 * (r[0].length + r[2].length + r[3].length);
const idxRowBytes = (r: IdxRow) =>
  128 + 2 * (r[0].length + r[2].length + (r[3]?.length ?? 0) + r[4].length + (r[6]?.length ?? 0) + 16);
type Conn = mysqlDriver.PoolConnection;

/** An internal id's 16 bytes, as a BINARY(16) parameter (it throws on anything but an internal id). */
const bin = (id: string) => Buffer.from(internalIdBytes(id));
/** A BINARY(16) id read back: its internal id string. */
const idOf = (b: Uint8Array) => internalIdString(b);
const encodeDoc = (json: string | null, encoding: 0 | 1) =>
  Buffer.from(encoding === 1 ? encodeV1(json) : encodeV0(json));
const docOf = (b: Uint8Array) => decodeDocument(b);

/** Destroy a connection: out of the pool, and its socket closed at once (a frozen server never answers a
 *  polite close). */
const drop = (c: Conn) => {
  c.destroy();
  (c as unknown as { connection?: { stream?: { destroy?(): void } } }).connection?.stream?.destroy?.();
};

const STORE = "this MySQL database";
/** Convex's columns, as information_schema names their types: what an existing store must have (C10). */
const COLUMNS = {
  documents: ["id binary", "ts bigint", "table_id binary", "json_value longblob", "deleted tinyint", "prev_ts bigint"],
  indexes: [
    "index_id binary",
    "ts bigint",
    "key_prefix varbinary",
    "key_suffix longblob",
    "key_sha256 binary",
    "deleted tinyint",
    "table_id binary",
    "document_id binary",
  ],
  leases: ["id bigint", "ts bigint"],
  read_only: ["id bigint"],
  persistence_globals: ["key varchar", "json_value longblob"],
};
const TABLES = Object.keys(COLUMNS);

/**
 * Convex's v5 `init_sql` (crates/mysql/src/v5/mod.rs, single-tenant, in the URL's database), statement for
 * statement, run when a table is missing; then its `init_lease`. Format data.
 */
const LAYOUT_DDL = [
  `CREATE TABLE IF NOT EXISTS documents (
            id BINARY(16) NOT NULL,
            ts BIGINT NOT NULL,

            table_id BINARY(16) NOT NULL,

            json_value LONGBLOB NOT NULL,
            deleted BOOLEAN DEFAULT false,

            prev_ts BIGINT,

            PRIMARY KEY (ts, table_id, id),
            INDEX documents_by_table_and_id (table_id, id, ts)
        ) ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS indexes (
            index_id BINARY(16) NOT NULL,
            ts BIGINT NOT NULL,

            key_prefix VARBINARY(2500) NOT NULL,
            key_suffix LONGBLOB NULL,

            key_sha256 BINARY(32) NOT NULL,

            deleted BOOLEAN,
            table_id BINARY(16) NULL,
            document_id BINARY(16) NULL,

            PRIMARY KEY (index_id, key_prefix, key_sha256, ts)
        ) ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS leases (
            id BIGINT NOT NULL,
            ts BIGINT NOT NULL,

            PRIMARY KEY (id)
        ) ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS read_only (
            id BIGINT NOT NULL,

            PRIMARY KEY (id)
        ) ROW_FORMAT=DYNAMIC`,
  `CREATE TABLE IF NOT EXISTS persistence_globals (
            \`key\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
            json_value LONGBLOB NOT NULL,

            PRIMARY KEY (\`key\`)
        ) ROW_FORMAT=DYNAMIC`,
];
/** Convex's `init_lease`: the lease row with ts 0, a no-op when it exists. */
const INIT_LEASE = "INSERT INTO leases (id, ts) VALUES (1, 0) ON DUPLICATE KEY UPDATE id = id";

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

/** A live index entry's document id and its document at the entry's ts (`found` false: no such version). */
type JoinedEntry = { id: Buffer; json: Buffer | null; found: boolean; deleted: boolean };

export class MysqlPersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
  /** PERSIST-01 C7 as Convex's lease: the newest process wins (DV-413). */
  readonly leaseScope = "newest";
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  /** The highest ts applied since the last flush (the group's top). */
  private top = 0n;
  /** Our lease's ts (Convex's `lease_ts`: our start, in wall-clock nanoseconds), 0n when we hold none. */
  private leaseTs = 0n;
  /** The TTL the engine renews by (TTL/3): a lease check is bounded by a quarter of it (C8). */
  private ttlMs = 5000;
  /** Leases taken by this handle, for `LeaseAcquire.epoch`. */
  private acquired = 0;
  private constructor(
    private pool: mysqlDriver.Pool,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
    /** The encoding new document versions are written in (`documentEncodingFromEnv`). */
    readonly documentEncoding: 0 | 1,
  ) {}

  /**
   * TLS (STUDY-25 L8, as Convex): required, with the CA and the host name verified, by default;
   * `requireSsl: false` connects as the URL says (plain unless it asks for TLS or `caFile` is set).
   * `caFile` adds a trusted CA.
   *
   * `timeoutMs` (default 19 000, Convex's `MYSQL_TIMEOUT_SECONDS`): how long one round trip to the database
   * (a statement, BEGIN, COMMIT, getting a connection) may take before the call fails with
   * `DatabaseTimeoutError` and its connection is destroyed (STUDY-25 L3). 0 disables it.
   *
   * `documentEncoding`: the encoding new document versions are written in; by default `MYSQL_DOCUMENT_ENCODING`,
   * else 0 (DV-414).
   */
  static async open(
    url: string,
    pool = 16,
    opts: OpenOptions & TlsOptions & { timeoutMs?: number; documentEncoding?: 0 | 1 } = {},
  ) {
    const documentEncoding = opts.documentEncoding ?? documentEncodingFromEnv();
    const mysql = await loadPeer<typeof mysqlDriver>("mysql2/promise", "mysql2");
    const { uri, ssl } = mysqlTls(url, opts);
    const timeoutMs = opts.timeoutMs ?? 19_000;
    const p = mysql.createPool({
      uri,
      ...(ssl ? { ssl: ssl as mysqlDriver.SslOptions } : {}),
      connectionLimit: pool,
      multipleStatements: false,
      // BIGINT columns (timestamps: nanoseconds, above 2^53) come back exact, as decimal strings.
      supportBigNumbers: true,
      bigNumberStrings: true,
      ...(timeoutMs > 0 && timeoutMs < Infinity ? { connectTimeout: timeoutMs } : {}),
    });
    const store = new MysqlPersistence(p, timeoutMs, documentEncoding);
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

  /** The server and store checks (C10), then Convex's tables, created only when one is missing. */
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
    // DDL only when a table is missing, as Convex's v5 driver does (a `create table if not exists` still
    // takes metadata locks: MySQL bug 63144); concurrent first opens are serialized by a named lock. Every
    // statement is idempotent: the whole step runs again after an operational error.
    if (have.size < TABLES.length)
      await this.read(async (c, progress) => {
        try {
          await c.query(`select get_lock('bunvex_bootstrap', 10)`);
          progress();
          for (const statement of LAYOUT_DDL) {
            await c.query(statement);
            progress();
          }
        } finally {
          await c.query(`select release_lock('bunvex_bootstrap')`).catch(() => {});
        }
      });
    // The lease row, which Convex inserts on every open (`init_lease`); here only when missing, so an open
    // writes nothing otherwise.
    const [lease] = (await this.read((c) => c.query(`select 1 from leases where id = 1`))) as any;
    if (!lease.length) await this.read((c) => c.query(INIT_LEASE));
  }

  /**
   * PERSIST-01 C10, before anything is written: the tables that exist must have Convex's columns (an older
   * bunvex layout or a stranger's is refused), and a store marked read-only opens only with `allowReadOnly`.
   * Refusing needs no lease: nothing is written.
   */
  private async checkStore(have: Set<string>, opts: OpenOptions) {
    if (have.size) {
      const [cols] = (await this.read((c) =>
        c.query(
          `select table_name as t, concat(column_name, ' ', data_type) as c from information_schema.columns
           where table_schema = database() and table_name in (?)`,
          [TABLES],
        ),
      )) as any;
      const found: Record<string, string[]> = {};
      for (const c of cols) found[c.t] = [...(found[c.t] ?? []), String(c.c).toLowerCase()];
      checkStoreTables(STORE, found, COLUMNS);
    }
    if (have.has("read_only")) {
      const [r] = (await this.read((c) => c.query(`select exists (select 1 from read_only) as ro`))) as any;
      if (Number(r[0].ro) && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
    }
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call((c) =>
      c.query(readOnly ? `insert ignore into read_only (id) values (1)` : `delete from read_only`),
    );
  }

  /**
   * Convex's `Lease::acquire` (`lease_acquire`): the lease row takes our start ts if it is newer than the one
   * there (the newest process wins at once, DV-413); otherwise another process started later, and holds it.
   * There is no TTL.
   *
   * A writer paused inside a flush holds the row (`FOR SHARE`, its last read) until it commits or its
   * connection ends. After a second's wait the sessions holding locks on `leases` are ended: the paused
   * writer's group rolls back, and it was never acknowledged.
   */
  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    // The engine's renewal period: a check is bounded by a quarter of it (C8), as a renewal was.
    this.ttlMs = opts.ttlMs;
    for (let attempt = 0; ; attempt++) {
      const ts = wallClockNs();
      try {
        const won = await this.call(async (c, progress) => {
          try {
            await c.query(`set session innodb_lock_wait_timeout = 1`);
            progress();
            const [r] = (await c.query(`update leases set ts = ? where ts < ? and id = 1`, [ts, ts])) as any;
            progress();
            return r.affectedRows === 1;
          } finally {
            await c.query(`set session innodb_lock_wait_timeout = default`).catch(() => {});
          }
        });
        if (!won) {
          const [l] = (await this.read((c) => c.query(`select ts from leases where id = 1`))) as any;
          return { heldBy: `a process that took the lease later (lease ts ${l[0]?.ts ?? "none"})`, expiresInMs: null };
        }
        this.leaseTs = ts;
        return { epoch: ++this.acquired };
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1205 || attempt >= 3) throw e; // 1205: lock wait timeout
      }
      const [blockers] = (await this.call((c) =>
        c.query(
          `select distinct t.processlist_id as id from performance_schema.data_locks l
           join performance_schema.threads t on t.thread_id = l.thread_id
           where l.object_schema = database() and l.object_name = 'leases' and t.processlist_id <> connection_id()`,
        ),
      )) as any;
      for (const r of blockers) await this.call((c) => c.query(`kill ${Number(r.id)}`)).catch(() => {});
    }
  }

  /** Convex's lease check, which never blocks a takeover: `LeaseLostError` once another process took the
   *  lease. There is no TTL to extend. */
  async renewLease() {
    const [rows] = (await this.call(
      (c) => c.query(`select 1 as ok from leases where id = 1 and ts = ?`, [this.leaseTs]),
      renewTimeoutMs(this.timeoutMs, this.ttlMs),
    )) as any;
    if (!rows.length) throw new LeaseLostError();
  }

  /** As Convex: a lease is never handed back; the next process takes it at once. This one stops writing. */
  async releaseLease() {
    this.leaseTs = 0n;
  }

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.top = ts;
    for (const d of docs)
      this.docs.push([
        bin(d.id),
        ts,
        bin(d.table),
        encodeDoc(d.json, this.documentEncoding),
        d.json === null,
        d.prevTs,
      ]);
    for (const e of idx) this.idx.push(indexRow(e, ts));
  }

  async flush() {
    if (!this.docs.length && !this.idx.length) return;
    if (!this.leaseTs) throw new Error("flush without the store's lease (PERSIST-01 C7): acquireLease first");
    const docs = this.docs;
    const idx = this.idx;
    const top = this.top;
    this.docs = [];
    this.idx = [];
    const retry = this.retrying;
    try {
      // A retry: the group may have landed although its attempt failed here (its answer was lost). Then it
      // is there exactly once, and acknowledged without writing (DV-124).
      if (!(retry && (await this.landed(top)))) await this.flushGroup(docs, idx);
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

  /**
   * Whether the group up to `top` committed (PERSIST-01 C9, DV-124): a group is one transaction, so its rows
   * at `top` are there exactly when it did. Only while the lease is still ours: otherwise `LeaseLostError`.
   */
  private async landed(top: bigint) {
    const [rows] = (await this.call((c) =>
      c.query(
        `select exists (select 1 from leases where id = 1 and ts = ?) as ours,
                exists (select 1 from documents where ts = ?) as landed`,
        [this.leaseTs, top],
      ),
    )) as any;
    if (!Number(rows[0].ours)) throw new LeaseLostError();
    return !!Number(rows[0].landed);
  }

  private async flushGroup(docs: DocRow[], idx: IdxRow[]) {
    await this.call(async (c, progress) => {
      try {
        await c.beginTransaction();
        progress();
        // `values ?` with a nested array expands to a multi-row insert. Filled up to 10 MiB of SQL each, as
        // Convex's `fill_chunks`, to stay under max_allowed_packet whatever the commit's size (DV-62).
        for (const chunk of chunkRows(docs, Infinity, MYSQL_MAX_CHUNK_BYTES, docRowBytes)) {
          await c.query(`insert into documents (id, ts, table_id, json_value, deleted, prev_ts) values ?`, [chunk]);
          progress();
        }
        for (const chunk of chunkRows(idx, Infinity, MYSQL_MAX_CHUNK_BYTES, idxRowBytes)) {
          await c.query(
            `insert into indexes (index_id, ts, key_prefix, key_suffix, key_sha256, deleted, table_id, document_id)
             values ?`,
            [chunk],
          );
          progress();
        }
        // The fence, as Convex's `lease_precond` at the end of the transaction: the row still carries our ts,
        // locked `FOR SHARE` until COMMIT, so a takeover waits for this transaction and then sees its rows.
        const [f] = (await c.query(`select 1 from leases force index (primary) where ts = ? and id = 1 for share`, [
          this.leaseTs,
        ])) as any;
        if (f.length !== 1) throw new LeaseLostError();
        progress();
        await c.commit();
      } catch (e) {
        // On a lost connection the rollback fails too (the server rolls back on its own): keep the first error.
        if (!operational(e)) await c.rollback().catch(() => {});
        throw e;
      }
    });
  }

  /**
   * The range's entries (each key's newest version at `ts`) and their documents at the entries' own ts, a page
   * of keys at a time, in key order, as Convex's v5 `index_scan`: the page's keys and their newest ts from the
   * primary key alone (a grouped walk that reads no row), then those rows and their documents. Removed entries
   * come back as such and `scanLatest` pages past them. Keys up to the prefix's length only: a page that
   * reaches a longer key says so (`long`). (A form keeping each row whose ts is its key's newest, by a lookup
   * per row, read every old version and its lookup: ~1 s a statement on a store with many versions.)
   */
  private async joinedScan(index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean) {
    const dir = desc ? "desc" : "asc";
    const indexBytes = bin(index);
    let long = false;
    const entries = await scanLatest<JoinedEntry>(
      async (p) => {
        const [rows] = (await this.read((c) =>
          c.query(
            `select i.key_prefix, i.ts, i.deleted, i.document_id, d.json_value, d.deleted as doc_deleted,
                    d.ts is not null as found
             from (select key_prefix, key_sha256, max(ts) as ts from indexes force index (primary)
                   where index_id = ? and key_prefix >= ? and key_prefix < ? and ts <= ?
                   group by index_id, key_prefix, key_sha256
                   order by index_id ${dir}, key_prefix ${dir}, key_sha256 ${dir}
                   limit ${Math.floor(p.n)}) a
             join indexes i force index (primary)
               on i.index_id = ? and i.key_prefix = a.key_prefix and i.key_sha256 = a.key_sha256 and i.ts = a.ts
             left join documents d force index for join (primary)
               on d.ts = i.ts and d.table_id = i.table_id and d.id = i.document_id
             order by i.key_prefix ${dir}, i.key_sha256 ${dir}`,
            [indexBytes, Buffer.from(p.lo), Buffer.from(p.hi), ts, indexBytes],
          ),
        )) as any;
        return (rows as any[]).map((r) => {
          if ((r.key_prefix as Buffer).length >= MAX_KEY_PREFIX_LEN) long = true;
          return {
            key: r.key_prefix as Uint8Array,
            ts: BigInt(r.ts),
            deleted: !!Number(r.deleted),
            id:
              r.document_id === null
                ? null
                : {
                    id: r.document_id as Buffer,
                    json: r.json_value as Buffer | null,
                    found: !!Number(r.found),
                    deleted: !!Number(r.doc_deleted),
                  },
          };
        });
      },
      lo,
      hi,
      limit,
      desc,
    );
    return { entries, long };
  }

  private splitSource(index: IndexId, ts: bigint, desc: boolean) {
    const dir = desc ? "desc" : "asc";
    const indexBytes = bin(index);
    const toRow = (r: any): SplitRow => ({
      prefix: r.key_prefix as Uint8Array, // a Buffer is a Uint8Array: no copy
      suffix: (r.key_suffix as Uint8Array | null) ?? null,
      ts: BigInt(r.ts),
      deleted: !!Number(r.deleted),
      id: r.document_id === null ? null : idOf(r.document_id),
    });
    return {
      page: async (b: { lo: Uint8Array; loStrict: boolean; hi: Uint8Array; hiInclusive: boolean; n: number }) => {
        const [rows] = (await this.read((c) =>
          c.execute(
            `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = ? and key_prefix ${b.loStrict ? ">" : ">="} ? and key_prefix ${b.hiInclusive ? "<=" : "<"} ?
               and ts <= ?
             order by key_prefix ${dir}, key_sha256 ${dir}, ts desc limit ${Math.floor(b.n)}`,
            [indexBytes, Buffer.from(b.lo), Buffer.from(b.hi), ts],
          ),
        )) as any;
        return (rows as any[]).map(toRow);
      },
      group: async (prefix: Uint8Array) => {
        const [rows] = (await this.read((c) =>
          c.execute(
            `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = ? and key_prefix = ? and ts <= ?`,
            [indexBytes, Buffer.from(prefix), ts],
          ),
        )) as any;
        return (rows as any[]).map(toRow);
      },
    };
  }

  /**
   * The range's newest entry per key at `ts` with its document at the entry's own ts (Convex's exact-ts join,
   * DV-67 reversed). A missing one rejects (PERSIST-01 C15). Keys longer than the prefix take the paged,
   * group-sorting scan, then their documents in one round trip.
   */
  async scan(
    table: TabletId,
    index: IndexId,
    lo: Uint8Array,
    hi: Uint8Array,
    ts: bigint,
    limit: number,
    desc: boolean,
  ) {
    if (limit <= 0) return [];
    if (lo.length <= MAX_KEY_PREFIX_LEN && hi.length <= MAX_KEY_PREFIX_LEN) {
      const { entries, long } = await this.joinedScan(index, lo, hi, ts, limit, desc);
      if (!long)
        return entries.map((e): IndexedDoc => {
          const id = idOf(e.id.id);
          const json = e.id.found && !e.id.deleted ? docOf(e.id.json!) : null;
          if (json === null) throw new DanglingReferenceError(index, id, e.ts, e.id.found);
          return { id, ts: e.ts, json };
        });
    }
    const entries = await scanLatest(splitPages(this.splitSource(index, ts, desc), desc), lo, hi, limit, desc);
    if (!entries.length) return [];
    const [rows] = (await this.read((c) =>
      c.query(`select id, ts, json_value, deleted from documents where table_id = ? and (id, ts) in (?)`, [
        bin(table),
        entries.map((e) => [bin(e.id), e.ts]),
      ]),
    )) as any;
    const byKey = new Map<string, any>((rows as any[]).map((r) => [`${idOf(r.id)}\u0000${r.ts}`, r]));
    return entries.map((e): IndexedDoc => {
      const r = byKey.get(`${e.id}\u0000${e.ts}`);
      const json = r && !Number(r.deleted) ? docOf(r.json_value) : null;
      if (json === null) throw new DanglingReferenceError(index, e.id, e.ts, !!r);
      return { id: e.id, ts: e.ts, json };
    });
  }

  async get(table: TabletId, id: InternalId, ts: bigint): Promise<DocVersion> {
    const [rows] = (await this.read((c) =>
      c.execute(
        `select json_value, deleted, ts from documents where table_id = ? and id = ? and ts <= ?
         order by ts desc limit 1`,
        [bin(table), bin(id), ts],
      ),
    )) as any;
    const r = rows[0];
    if (!r || Number(r.deleted)) return null;
    const json = docOf(r.json_value);
    return json === null ? null : { json, ts: BigInt(r.ts) };
  }

  async getVersions(table: TabletId, ids: string[], ts: bigint) {
    const found = new Map<string, { json: string | null; ts: bigint }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
      const chunk = unique.slice(i, i + VERSIONS_CHUNK);
      const [rows] = (await this.read((c) =>
        c.execute(
          `select id, ts, json_value, deleted from (
             select id, ts, json_value, deleted, row_number() over (partition by id order by ts desc) rn
             from documents where table_id = ? and id in (${chunk.map(() => "?").join(",")}) and ts <= ?) v
           where rn = 1`,
          [bin(table), ...chunk.map(bin), ts],
        ),
      )) as any;
      for (const r of rows)
        found.set(idOf(r.id), { json: Number(r.deleted) ? null : docOf(r.json_value), ts: BigInt(r.ts) });
    }
    return versionsInOrder(ids, found);
  }

  /** PERSIST-01 C12, the document log by ts: the primary key's leading column. A group is one transaction, so
   *  what this reads is always whole, durable commits. */
  async readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): Promise<DocLogRow[]> {
    if (limit <= 0) return [];
    const [rows] = (await this.read((c) =>
      c.query(
        `select d.ts, d.table_id, d.id, d.deleted, d.prev_ts from documents d
       where d.ts > ? and d.ts <= (select max(c.ts) from (select distinct ts from documents
         where ts > ? and ts <= ? order by ts limit ${Math.floor(limit)}) c)
       order by d.ts, d.table_id, d.id`,
        [afterTs, afterTs, upToTs],
      ),
    )) as any;
    return (rows as any[]).map((r) => ({
      ts: BigInt(r.ts),
      table: idOf(r.table_id),
      id: idOf(r.id),
      deleted: !!Number(r.deleted),
      prevTs: r.prev_ts === null ? null : BigInt(r.prev_ts),
    }));
  }

  /** Refused unless the lease row carries our ts (a plain read: see the header). */
  private async assertLease() {
    const [rows] = (await this.read((c) =>
      c.query(`select 1 from leases where id = 1 and ts = ?`, [this.leaseTs]),
    )) as any;
    if (!this.leaseTs || !rows.length) throw new LeaseLostError();
  }

  /**
   * PERSIST-01 C17: index rows at their own ts, replacing a row of the same key and ts (Convex's
   * `insert_overwrite_index_chunk`), behind the lease check, in chunks of at most 10 MiB.
   */
  async writeIndexEntries(entries: IndexEntryAt[]) {
    if (!entries.length) return;
    await this.assertLease();
    const rows: IdxRow[] = entries.map((e) => indexRow(e, e.ts));
    for (const chunk of chunkRows(rows, Infinity, MYSQL_MAX_CHUNK_BYTES, idxRowBytes))
      await this.read((c) =>
        c.query(
          `insert into indexes (index_id, ts, key_prefix, key_suffix, key_sha256, deleted, table_id, document_id)
           values ? as v on duplicate key update deleted = v.deleted, table_id = v.table_id,
             document_id = v.document_id`,
          [chunk],
        ),
      );
  }

  /** PERSIST-01 C13: Convex's v5 `delete_index_chunk`, by `(index_id, key_prefix, key_sha256)`. */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    await this.assertLease();
    // We implicitly delete everything below each ts, so only the highest per key matters (Convex's v5).
    const top = new Map<string, { index: Buffer; prefix: Buffer; sha: Buffer; ts: bigint }>();
    for (const e of entries) {
      const prefix = Buffer.from(splitKey(e.key).prefix);
      const sha = Buffer.from(keySha256(e.key));
      const id = `${e.index}:${sha.toString("hex")}`;
      const cur = top.get(id);
      if (!cur || cur.ts < e.ts) top.set(id, { index: bin(e.index), prefix, sha, ts: e.ts });
    }
    return this.deleteChunks(
      [...top.values()],
      "indexes",
      "(index_id = ? and key_prefix = ? and key_sha256 = ? and ts <= ?)",
      (r) => [r.index, r.prefix, r.sha, r.ts],
    );
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    await this.assertLease();
    const top = new Map<string, DocPrune>();
    for (const e of entries) {
      const id = `${e.table}:${e.id}`;
      const cur = top.get(id);
      if (!cur || cur.ts < e.ts) top.set(id, e);
    }
    return this.deleteChunks([...top.values()], "documents", "(table_id = ? and id = ? and ts <= ?)", (r) => [
      bin(r.table),
      bin(r.id),
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

  /** PERSIST-01 C14: Convex's `persistence_globals`, the JSON text's bytes. */
  async getGlobal(key: string): Promise<unknown> {
    const [rows] = (await this.read((c) =>
      c.query("select json_value from persistence_globals force index (primary) where `key` = ?", [key]),
    )) as any;
    return rows.length ? decodeGlobal(Buffer.from(rows[0].json_value).toString("utf8")) : null;
  }

  async setGlobal(key: string, value: unknown) {
    await this.assertLease();
    await this.read((c) =>
      c.query(
        "insert into persistence_globals (`key`, json_value) values (?, ?) on duplicate key update json_value = values(json_value)",
        [key, Buffer.from(encodeGlobal(value), "utf8")],
      ),
    );
  }

  async auditRowCount() {
    const [rows] = (await this.read((c) =>
      c.query(`select (select count(*) from documents) as docs, (select count(*) from indexes) as idx`),
    )) as any;
    return { docs: Number(rows[0].docs), idx: Number(rows[0].idx) };
  }

  /** The durable prefix (PERSIST-01 C5): the newest ts in `documents`, as Convex's `max_ts` (a group is one
   *  transaction, so it is whole). */
  async maxTs() {
    const [rows] = (await this.read((c) => c.query(`select coalesce(max(ts), 0) as m from documents`))) as any;
    return BigInt(rows[0].m);
  }

  async auditLiveDocs(table: TabletId, ts: bigint) {
    const [rows] = (await this.read((c) =>
      c.query(
        `select count(*) as n from (select deleted, row_number() over (partition by id order by ts desc) rn
       from documents where table_id = ? and ts <= ?) v where rn = 1 and not deleted`,
        [bin(table), ts],
      ),
    )) as any;
    return Number(rows[0].n);
  }

  async auditRowsAt(ts: bigint) {
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

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(MysqlPersistence);

/** One `indexes` row: a tombstone has NULL `table_id` and `document_id`, as Convex writes it. */
function indexRow(e: IndexWrite, ts: bigint): IdxRow {
  const k = splitKey(e.key);
  return [
    bin(e.index),
    ts,
    Buffer.from(k.prefix),
    k.suffix && Buffer.from(k.suffix),
    Buffer.from(keySha256(e.key)),
    e.id === null,
    e.id === null ? null : bin(e.table!),
    e.id === null ? null : bin(e.id),
  ];
}

/** PERSIST-01 C16's answer in the ids' order (duplicates included), from the rows found per id. */
function versionsInOrder(ids: string[], found: Map<string, { json: string | null; ts: bigint }>) {
  return ids.map((id) => {
    const v = found.get(id);
    return v && v.json !== null ? { json: v.json, ts: v.ts } : null;
  });
}

/** Ids per `getVersions` statement: one round trip each, within every store's parameter limits. */
const VERSIONS_CHUNK = 1000;
