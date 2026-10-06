// Postgres in Convex's layout (crates/postgres/src/sql.rs, STUDY-133 §1.6): `documents`, `indexes`, `leases`,
// `read_only` and `persistence_globals`, created with Convex's own statements, so a store either system wrote
// opens in the other. Ids, tablets and index ids are their 16 bytes (BYTEA); a document's JSON is its text's
// bytes, and a deleted version stores the bytes `null`. Index keys are split as Convex's: `key_prefix` (the
// first 2500 bytes), `key_suffix` (the rest) and `key_sha256` (the SHA-256 of the whole key), so a key of any
// length fits the btree (split.ts). A flush (a write batch of whole commits, bounded by the committer: DV-62)
// is ONE transaction, its rows sent in statements of at most 1 024 rows each, as Convex's
// `INSERTS_PER_STATEMENT`; a range read and its document fetches are one statement. The native driver
// `postgres` is an optional peer dependency.
//
// Single writer (PERSIST-01 C7), as Convex's lease (DV-413, reversing DV-14 here): one `leases` row whose `ts`
// is its holder's start, in wall-clock nanoseconds. A start takes it at once if its ts is newer (the newest
// process wins); the previous holder fails its next write with `LeaseLostError`. Every flush's last statement
// checks the row still carries our ts, `FOR SHARE`, so a takeover waits for that transaction and then sees its
// rows; the lock is held only from that statement to COMMIT, as Convex takes it at the end.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L7): no layout record (DV-418): the open checks that the
// tables it finds have Convex's columns, before writing anything, and refuses a read-only store.
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by its key's leading `ts`;
// prunes are Convex's `ts <= X` deletes per key, one statement per batch; globals are `persistence_globals`
// rows. A prune or a global write runs only while the lease row carries our ts: the check is in the same
// statement, without locking the row (Convex's advisory check), so a flush or a takeover is never held up by it.
// Timeouts (STUDY-25 L3), as Convex's Postgres driver: every database call is bounded on the client side
// (30 s by default, Convex's POSTGRES_TIMEOUT_SECONDS), per round trip. A timed-out call's connection is never
// reused: postgres.js does not expose its connections, so the whole pool is retired (in-flight calls on it
// may finish; its connections are destroyed after one more timeout) and a fresh one takes the next calls.
//
// Retries (STUDY-25 L4/L5), as Convex's Postgres driver: a read, or the bootstrap, that fails because its
// connection was lost or timed out runs once more on a fresh pool. A flush that times out or loses its
// connection is transient (`isTransient`; a lost connection only since DV-123 — Convex counts only timeouts
// on Postgres): the committer retries it, and this driver keeps the group for that retry; a flush that loses
// its connection before its transaction began is also retried once here, on a fresh pool (Convex's
// `transact`). Before re-running a group, the driver checks that the lease is still ours and whether the
// group's rows are there: a group an earlier attempt did commit is acknowledged without writing (DV-124). One
// that lands after that read hits the primary key: `UnsureCommitError`.
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
  type OpenOptions,
  opaqueToInspect,
  type Persistence,
  POSTGRES_ROWS_PER_STATEMENT,
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
import type postgresDriver from "postgres";
import { loadPeer } from "./peer.ts";
import { explainTlsError, postgresTls, type TlsOptions } from "./tls.ts";

// The rows travel as JSON (postgres.js binds no bytea[] or boolean[] for `unnest`): bytes as hex, ts as a
// decimal string (JSON has no 64-bit integers).
// table, id, ts, json (null: deleted), deleted, prev_ts (or null)
type DocRow = [string, string, string, string | null, boolean, string | null];
// index id, key_prefix, key_suffix (or null), key_sha256, ts, deleted, table id, document id
type IdxRow = [string, string, string | null, string, string, boolean, string | null, string | null];
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
/** An internal id's 16 bytes, as hex (it throws on anything but an internal id). */
const idHex = (id: string) => hex(internalIdBytes(id));
/** A BYTEA id read back: its internal id string. */
const idOf = (b: Uint8Array) => internalIdString(b);
/** A BYTEA parameter. */
const bytes = (id: string) => Buffer.from(internalIdBytes(id));
/** A stored document's JSON: the text of its bytes. */
const jsonOf = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
/** A key as Convex stores it: prefix, suffix and the whole key's SHA-256, as hex. */
function keyColumns(key: Uint8Array): [string, string | null, string] {
  const k = splitKey(key);
  return [hex(k.prefix), k.suffix && hex(k.suffix), hex(keySha256(key))];
}

const STORE = "this Postgres database";
/** Convex's columns, as information_schema names their types: what an existing store must have (C10). */
const COLUMNS = {
  documents: ["id bytea", "ts bigint", "table_id bytea", "json_value bytea", "deleted boolean", "prev_ts bigint"],
  indexes: [
    "index_id bytea",
    "ts bigint",
    "key_prefix bytea",
    "key_suffix bytea",
    "key_sha256 bytea",
    "deleted boolean",
    "table_id bytea",
    "document_id bytea",
  ],
  leases: ["id bigint", "ts bigint"],
  read_only: ["id bigint"],
  persistence_globals: ["key text", "json_value bytea"],
};

/**
 * Convex's `init_sql` (crates/postgres/src/sql.rs, single-tenant, in the current schema), statement for
 * statement: each object is created only when missing (`to_regclass`), and the lease row with ts 0. Format data.
 */
const LAYOUT_DDL = [
  `DO $$
BEGIN
    IF to_regclass('documents') IS NULL THEN
        CREATE TABLE IF NOT EXISTS documents (
            id BYTEA NOT NULL,
            ts BIGINT NOT NULL,

            table_id BYTEA NOT NULL,

            json_value BYTEA NOT NULL,
            deleted BOOLEAN DEFAULT false,

            prev_ts BIGINT
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('documents_pkey') IS NULL THEN
        ALTER TABLE documents ADD PRIMARY KEY (ts, table_id, id);
    END IF;
    IF to_regclass('documents_by_table_and_id') IS NULL THEN
        CREATE INDEX IF NOT EXISTS documents_by_table_and_id ON documents (
            table_id, id, ts
        );
    END IF;
    IF to_regclass('documents_by_table_ts_and_id') IS NULL THEN
        CREATE INDEX IF NOT EXISTS documents_by_table_ts_and_id ON documents (
            table_id, ts, id
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('indexes') IS NULL THEN
        CREATE TABLE IF NOT EXISTS indexes (
            index_id BYTEA NOT NULL,
            ts BIGINT NOT NULL,
            key_prefix BYTEA NOT NULL,
            key_suffix BYTEA NULL,
            key_sha256 BYTEA NOT NULL,
            deleted BOOLEAN,
            table_id BYTEA NULL,
            document_id BYTEA NULL
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('indexes_pkey') IS NULL THEN
        ALTER TABLE indexes ADD PRIMARY KEY (index_id, key_sha256, ts);
    END IF;
    IF to_regclass('indexes_by_index_id_key_prefix_key_sha256_ts') IS NULL AND to_regclass('indexes_by_index_id_key_prefix_key_sha256') IS NULL THEN
        CREATE INDEX IF NOT EXISTS indexes_by_index_id_key_prefix_key_sha256 ON indexes (
            index_id,
            key_prefix,
            key_sha256
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('leases') IS NULL THEN
        CREATE TABLE IF NOT EXISTS leases (
            id BIGINT NOT NULL,
            ts BIGINT NOT NULL,

            PRIMARY KEY (id)
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('read_only') IS NULL THEN
        CREATE TABLE IF NOT EXISTS read_only (
            id BIGINT NOT NULL,

            PRIMARY KEY (id)
        );
    END IF;
END $$;`,
  `DO $$
BEGIN
    IF to_regclass('persistence_globals') IS NULL THEN
        CREATE TABLE IF NOT EXISTS persistence_globals (
            key TEXT NOT NULL,
            json_value BYTEA NOT NULL,
            PRIMARY KEY (key)
            );
    END IF;
END $$;`,
  `INSERT INTO leases (id, ts) VALUES (1, 0) ON CONFLICT DO NOTHING;`,
];

/** postgres.js and socket codes of a connection that is gone, and the server's codes for "this session is
 *  over": admin_shutdown, crash_shutdown, cannot_connect_now, and the connection_exception class (08xxx). */
const LOST = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "57P01",
  "57P02",
  "57P03",
]);
/** The connection a call ran on is gone (Convex: `tokio_postgres::Error::is_closed`). */
export const connectionLost = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && (LOST.has(code) || code.startsWith("08"));
};

export class PostgresPersistence implements Persistence, Lease, ReadOnlyFlag, RetentionStore {
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
  /** The current pool; replaced when a call times out (see `call`). */
  private sql: postgresDriver.Sql;
  /** Retired pools, still ending (closed with the store). */
  private retired = new Set<Promise<void>>();
  private closed = false;
  private constructor(
    private newPool: () => postgresDriver.Sql,
    /** This instance's connections' application_name: an acquisition held up by a writer paused inside its
     *  flush ends the sessions that block it (see acquireLease). */
    private conn: string,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
  ) {
    this.sql = newPool();
  }

  /**
   * `idleInTransactionMs`: how long the server keeps one of our transactions open while we are paused (a
   * stopped process, a GC pause) before aborting it and releasing its locks, so another process can take
   * the store over at once (PERSIST-01 C7): a takeover waits for it at most this long, then ends the session.
   *
   * TLS (STUDY-25 L8, as Convex): required and verified by default; `requireSsl: false` connects as the
   * URL's `sslmode` says (TLS when the server offers it, by default). `caFile` adds a trusted CA. Every
   * connection asks for a read-write session (`target_session_attrs=read-write`): never a standby.
   *
   * `timeoutMs` (default 30 000, Convex's `POSTGRES_TIMEOUT_SECONDS`): how long one round trip to the
   * database (a statement, BEGIN, COMMIT, a new connection) may take before the call fails with
   * `DatabaseTimeoutError` and its connection is dropped (STUDY-25 L3). 0 disables it.
   */
  static async open(
    url: string,
    pool = 16,
    opts: { idleInTransactionMs?: number; timeoutMs?: number } & OpenOptions & TlsOptions = {},
  ) {
    const postgres = await loadPeer<typeof postgresDriver>("postgres", "postgres");
    const conn = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // The driver's own parse of the URL (hosts, ports, socket path, PG* environment); it connects nothing.
    const target = postgres(url, { max: 1 }).options as unknown as Parameters<typeof postgresTls>[1];
    const { ssl, target_session_attrs } = await postgresTls(url, target, opts);
    const newPool = () =>
      postgres(url, {
        max: pool,
        onnotice: () => {},
        prepare: true,
        ssl: ssl as postgresDriver.Options<{}>["ssl"],
        target_session_attrs,
        // A connection that cannot be opened within the timeout fails too (postgres.js counts whole seconds).
        ...(timeoutMs > 0 && timeoutMs < Infinity ? { connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) } : {}),
        connection: {
          application_name: conn,
          idle_in_transaction_session_timeout: opts.idleInTransactionMs ?? 2500,
          // As Convex's planner hints (`Set(enable_seqscan OFF)`, `Set(enable_bitmapscan OFF)` on its reads and
          // deletes): Convex's `indexes` index has no ts column, so the planner prices a range's newest versions
          // as a full sort and picks a sequential scan; walking the index with an incremental sort is ~20× faster
          // (1.7 ms against 32 ms for a range of 20 over 160k rows, measured).
          enable_seqscan: "off",
          enable_bitmapscan: "off",
        },
      });
    const store = new PostgresPersistence(newPool, conn, timeoutMs);
    try {
      await store.bootstrap(opts);
    } catch (e) {
      await store.close().catch(() => {});
      throw explainTlsError(e, "Postgres", "PG_CA_FILE");
    }
    return store;
  }

  /**
   * One database call, bounded by the client-side timeout per round trip (`progress()` marks the end of
   * one). On a timeout the pool the call ran on is retired: its connections are never handed out again.
   */
  private call<T>(fn: (sql: postgresDriver.Sql, progress: () => void) => Promise<T>, ms = this.timeoutMs) {
    const sql = this.sql;
    return withTimeout(
      "Postgres",
      ms,
      (progress) => fn(sql, progress),
      () => this.retire(sql),
    );
  }

  /**
   * A read (or an idempotent bootstrap step): one call, run once more on a fresh pool if its connection was
   * lost or it timed out (STUDY-25 L5; Convex's `with_retry` retries a poisoned connection once, on a new
   * connection "in case other pooled connections are also stale").
   */
  private read<T>(fn: (sql: postgresDriver.Sql, progress: () => void) => Promise<T>) {
    const sql = this.sql;
    return retryOnce(
      () => this.call(fn),
      (e) => e instanceof DatabaseTimeoutError || connectionLost(e),
      () => this.retire(sql),
    );
  }

  /** A timeout (as Convex's `is_transient_db_error` on Postgres) or a lost connection (DV-123; STUDY-25 L4). */
  isTransient(e: unknown) {
    return e instanceof DatabaseTimeoutError || connectionLost(e);
  }

  private retire(sql: postgresDriver.Sql) {
    if (this.sql !== sql || this.closed) return; // already retired by another call that timed out
    this.sql = this.newPool();
    // Calls already running on the old pool may finish; whatever still waits after one more timeout is
    // destroyed (postgres.js counts seconds).
    const ending: Promise<void> = sql
      .end({ timeout: this.timeoutMs / 1000 })
      .catch(() => {})
      .finally(() => this.retired.delete(ending));
    this.retired.add(ending);
  }

  /** The store's checks (C10), then Convex's tables, created only when one is missing. */
  private async bootstrap(opts: OpenOptions) {
    // What is there decides what may happen: read-only, never waiting on a lock, before any write.
    const [have] = await this.read(
      (sql) => sql`select to_regclass('documents') is not null as documents,
        to_regclass('indexes') is not null as indexes, to_regclass('leases') is not null as leases,
        to_regclass('persistence_globals') is not null as globals, to_regclass('read_only') is not null as ro,
        to_regclass('documents_by_table_ts_and_id') is not null as doc_idx,
        to_regclass('indexes_by_index_id_key_prefix_key_sha256') is not null as key_idx`,
    );
    await this.checkStore(have, opts);
    // DDL only when something is missing, as Convex's `init_sql` guards each statement: a `create … if not
    // exists` still waits for locks another process holds, so a paused process must not wedge every later open
    // (STUDY-24 S3). Concurrent first opens are serialized by an advisory lock (two concurrent `create table`
    // race on the catalog and one fails). The whole transaction runs again if it fails on a lost or timed-out
    // connection: every statement in it is idempotent, and a failed run left nothing behind.
    if (!Object.values(have).every(Boolean))
      await this.read((sql, progress) =>
        sql.begin(async (tx) => {
          progress();
          await tx.unsafe(`set local lock_timeout = '10s'`);
          progress();
          await tx.unsafe(`select pg_advisory_xact_lock(7236154418350)`); // any fixed key: "bunvex" bootstrap
          progress();
          for (const statement of LAYOUT_DDL) {
            await tx.unsafe(statement);
            progress(); // the next statement, or COMMIT
          }
        }),
      );
    // The lease row, which Convex inserts on every open: a store whose tables exist without it gets it here
    // (only when missing, so an open writes nothing otherwise).
    else
      await this.read(
        (sql) => sql`insert into leases (id, ts) select 1, 0 where not exists (select 1 from leases where id = 1)
          on conflict do nothing`,
      );
  }

  /**
   * PERSIST-01 C10, before anything is written: the tables that exist must have Convex's columns (an older
   * bunvex layout or a stranger's is refused), and a store marked read-only opens only with `allowReadOnly`.
   * Refusing needs no lease: nothing is written.
   */
  private async checkStore(have: Record<string, boolean>, opts: OpenOptions) {
    if (have.documents || have.indexes || have.leases || have.globals || have.ro) {
      const cols = await this.read(
        (sql) => sql`select table_name::text as t, column_name || ' ' || data_type as c
          from information_schema.columns where table_schema = current_schema()
            and table_name in ('documents', 'indexes', 'leases', 'read_only', 'persistence_globals')`,
      );
      const found: Record<string, string[]> = {};
      for (const c of cols) found[c.t] = [...(found[c.t] ?? []), c.c as string];
      checkStoreTables(STORE, found, COLUMNS);
    }
    if (have.ro) {
      const [r] = await this.read((sql) => sql`select exists (select 1 from read_only) as ro`);
      if (r.ro && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
    }
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call((sql) =>
      readOnly ? sql`insert into read_only (id) values (1) on conflict do nothing` : sql`delete from read_only`,
    );
  }

  /**
   * Convex's `Lease::acquire`: the lease row takes our start ts if it is newer than the one there (the newest
   * process wins at once, DV-413); otherwise another process started later, and holds it. There is no TTL.
   *
   * A writer paused inside a flush holds the row (`FOR SHARE`, its last statement) until it commits or the
   * server aborts it; Postgres aborts only an idle transaction (`idle_in_transaction_session_timeout`), not one
   * whose client stopped in the middle of the protocol. After a short wait the sessions that block the update
   * are ended: the paused writer's group rolls back, and it was never acknowledged.
   */
  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    // The engine's renewal period: a check is bounded by a quarter of it (C8), as a renewal was.
    this.ttlMs = opts.ttlMs;
    for (let attempt = 0; ; attempt++) {
      const ts = wallClockNs();
      try {
        const won = await this.call((sql, progress) =>
          sql.begin(async (tx) => {
            progress();
            await tx.unsafe(`set local lock_timeout = '1s'`);
            progress();
            const rows = await tx.unsafe(`update leases set ts = $1 where id = 1 and ts < $1 returning ts`, [
              String(ts),
            ] as any);
            progress(); // COMMIT
            return rows.length === 1;
          }),
        );
        if (!won) {
          const [l] = await this.read((sql) => sql`select ts from leases where id = 1`);
          return { heldBy: `a process that took the lease later (lease ts ${l?.ts ?? "none"})`, expiresInMs: null };
        }
        this.leaseTs = ts;
        return { epoch: ++this.acquired };
      } catch (e) {
        if ((e as { code?: string }).code !== "55P03" || attempt >= 3) throw e; // 55P03: lock_timeout
      }
      await this.call(
        (sql) => sql`select pg_terminate_backend(b) from pg_stat_activity a, unnest(pg_blocking_pids(a.pid)) b
        where a.application_name = ${this.conn}`,
      );
    }
  }

  /** Convex's `advisory_lease_check`, which never blocks a takeover: `LeaseLostError` once another process
   *  took the lease. There is no TTL to extend. */
  async renewLease() {
    const [r] = await this.call(
      (sql) => sql.unsafe(`select 1 as ok from leases where id = 1 and ts = $1`, [String(this.leaseTs)] as any),
      renewTimeoutMs(this.timeoutMs, this.ttlMs),
    );
    if (!r) throw new LeaseLostError();
  }

  /** As Convex: a lease is never handed back; the next process takes it at once. This one stops writing. */
  async releaseLease() {
    this.leaseTs = 0n;
  }

  apply(ts: bigint, docs: DocWrite[], idx: IndexWrite[]) {
    this.top = ts;
    const t = String(ts);
    for (const d of docs)
      this.docs.push([
        idHex(d.table),
        idHex(d.id),
        t,
        d.json,
        d.json === null,
        d.prevTs === null ? null : String(d.prevTs),
      ]);
    for (const e of idx) this.idx.push(indexRow(e, t));
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
      // 23505: the group is there already, so an earlier attempt of it did commit although it failed here.
      if (retry && (e as { code?: string }).code === "23505")
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
    const [r] = await this.call((sql) =>
      sql.unsafe(
        `select exists (select 1 from leases where id = 1 and ts = $1) as ours,
                exists (select 1 from documents where ts = $2) as landed`,
        [String(this.leaseTs), String(top)] as any,
      ),
    );
    if (!r.ours) throw new LeaseLostError();
    return r.landed as boolean;
  }

  private async flushGroup(docs: DocRow[], idx: IdxRow[]) {
    // One jsonb parameter per statement, expanded server-side. At most 1 024 rows per statement, as Convex's
    // `INSERTS_PER_STATEMENT` (DV-62): a large commit is several statements of one transaction.
    const docInsert = `insert into documents (id, ts, table_id, json_value, deleted, prev_ts)
      select decode(r->>1, 'hex'), (r->>2)::bigint, decode(r->>0, 'hex'), convert_to(coalesce(r->>3, 'null'), 'UTF8'),
        (r->>4)::boolean, (r->>5)::bigint
      from jsonb_array_elements($1::text::jsonb) r`;
    const chunks: [string, unknown[][]][] = [
      ...chunkRows(docs, POSTGRES_ROWS_PER_STATEMENT).map((c): [string, unknown[][]] => [docInsert, c]),
      ...chunkRows(idx, POSTGRES_ROWS_PER_STATEMENT).map((c): [string, unknown[][]] => [INDEX_INSERT, c]),
    ];
    // As Convex's `transact`: if the connection is lost before the transaction began, nothing was sent, and
    // the transaction is opened once more, on a fresh pool. Once it began, a lost connection is not retried.
    let began = false;
    const sql0 = this.sql;
    const attempt = () =>
      this.call((sql, progress) =>
        sql.begin(async (tx) => {
          began = true;
          progress();
          const last = chunks.length - 1;
          for (let i = 0; i < last; i++) {
            await tx.unsafe(chunks[i][0], [JSON.stringify(chunks[i][1])]);
            progress();
          }
          // The fence, as Convex's `lease_precond` at the end of the transaction: the last statement writes
          // only if the lease row still carries our ts, and locks it `FOR SHARE` until COMMIT, so a takeover
          // waits for this transaction and then sees its rows. Data-modifying CTEs always run.
          const [statement, rows] = chunks[last];
          const [f] = await tx.unsafe(
            `with l as (select 1 from leases where id = 1 and ts = $2 for share),
              w as (${statement} where exists (select 1 from l))
         select count(*)::int as n from l`,
            [JSON.stringify(rows), String(this.leaseTs)] as any,
          );
          if (f.n !== 1) throw new LeaseLostError();
          progress(); // COMMIT
        }),
      );
    await retryOnce(
      attempt,
      (e) => !began && connectionLost(e),
      () => this.retire(sql0),
    );
  }

  /**
   * The range and its documents in one statement (PERSIST-01 C6), as Convex's `index_scan`: DISTINCT ON walks
   * (key_prefix, key_sha256) and keeps each key's newest version; removed entries are filtered AFTER it and the
   * limit applies to what is left; each entry's document is the one at the entry's own ts (the exact-ts join).
   * That order is the key order unless a key is longer than the prefix, so a result holding such a key (or a
   * bound that long) falls back to the paged, group-sorting scan.
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
      const dir = desc ? "desc" : "asc";
      const rows = await this.read((sql) =>
        sql.unsafe(
          `with e as (
           select distinct on (key_prefix, key_sha256) key_prefix, key_sha256, ts, deleted, table_id, document_id
           from indexes where index_id = $1 and key_prefix >= $2 and key_prefix < $3 and ts <= $4
           order by key_prefix ${dir}, key_sha256 ${dir}, ts desc)
         select e.document_id, e.ts, d.json_value, d.deleted, octet_length(e.key_prefix) >= ${MAX_KEY_PREFIX_LEN} as long
         from e left join documents d on d.ts = e.ts and d.table_id = e.table_id and d.id = e.document_id
         where e.deleted is not true order by e.key_prefix ${dir}, e.key_sha256 ${dir} limit $5`,
          [bytes(index), Buffer.from(lo), Buffer.from(hi), String(ts), limit] as any,
        ),
      );
      if (!rows.some((r) => r.long))
        return rows.map((r): IndexedDoc => {
          // An entry without its document is a corrupt store: raised, never skipped (PERSIST-01 C15).
          const at = BigInt(r.ts);
          const id = idOf(r.document_id);
          if (r.deleted !== false) throw new DanglingReferenceError(index, id, at, r.deleted === true);
          return { id, ts: at, json: jsonOf(r.json_value) };
        });
    }
    // Long keys: the exact scan, then its documents at their entries' timestamps (rare).
    const entries = await scanLatest(splitPages(this.splitSource(index, ts, desc), desc), lo, hi, limit, desc);
    return this.docsAt(table, index, entries);
  }

  /** The documents of index entries at the entries' own timestamps, in their order. */
  private async docsAt(table: TabletId, index: IndexId, entries: { id: string; ts: bigint }[]) {
    if (!entries.length) return [];
    const rows = await this.read((sql) =>
      sql.unsafe(
        `select d.id, d.ts, d.json_value, d.deleted from documents d
         join unnest($2::text[], $3::bigint[]) as e(id, ts) on d.id = decode(e.id, 'hex') and d.ts = e.ts
         where d.table_id = $1`,
        [bytes(table), entries.map((e) => idHex(e.id)), entries.map((e) => String(e.ts))] as any,
      ),
    );
    const byKey = new Map(rows.map((r) => [`${idOf(r.id)}\u0000${r.ts}`, r]));
    return entries.map((e): IndexedDoc => {
      const r = byKey.get(`${e.id}\u0000${e.ts}`);
      if (!r || r.deleted) throw new DanglingReferenceError(index, e.id, e.ts, !!r);
      return { id: e.id, ts: e.ts, json: jsonOf(r.json_value) };
    });
  }

  private splitSource(index: IndexId, ts: bigint, desc: boolean) {
    const dir = desc ? "desc" : "asc";
    const at = String(ts);
    const indexBytes = bytes(index);
    const toRow = (r: any): SplitRow => ({
      prefix: r.key_prefix as Uint8Array, // a Buffer is a Uint8Array: no copy
      suffix: (r.key_suffix as Uint8Array | null) ?? null,
      ts: BigInt(r.ts),
      deleted: r.deleted === true,
      id: r.document_id === null ? null : idOf(r.document_id),
    });
    return {
      page: async (b: { lo: Uint8Array; loStrict: boolean; hi: Uint8Array; hiInclusive: boolean; n: number }) =>
        (
          await this.read((sql) =>
            sql.unsafe(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix ${b.loStrict ? ">" : ">="} $2 and key_prefix ${b.hiInclusive ? "<=" : "<"} $3
               and ts <= $4
             order by key_prefix ${dir}, key_sha256 ${dir}, ts desc limit $5`,
              [indexBytes, Buffer.from(b.lo), Buffer.from(b.hi), at, b.n] as any,
            ),
          )
        ).map(toRow),
      group: async (prefix: Uint8Array) =>
        (
          await this.read((sql) =>
            sql.unsafe(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix = $2 and ts <= $3`,
              [indexBytes, Buffer.from(prefix), at] as any,
            ),
          )
        ).map(toRow),
    };
  }

  async get(table: TabletId, id: InternalId, ts: bigint): Promise<DocVersion> {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `select json_value, deleted, ts from documents where table_id = $1 and id = $2 and ts <= $3
         order by ts desc limit 1`,
        [bytes(table), bytes(id), String(ts)] as any,
      ),
    );
    return r && !r.deleted ? { json: jsonOf(r.json_value), ts: BigInt(r.ts) } : null;
  }

  async getVersions(table: TabletId, ids: string[], ts: bigint) {
    const found = new Map<string, { json: string | null; ts: bigint }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += VERSIONS_CHUNK) {
      const rows = await this.read((sql) =>
        sql.unsafe(
          `select distinct on (id) id, ts, json_value, deleted from documents
           where table_id = $1 and id = any(array(select decode(x, 'hex') from unnest($2::text[]) x)) and ts <= $3
           order by id, ts desc`,
          [bytes(table), unique.slice(i, i + VERSIONS_CHUNK).map(idHex), String(ts)] as any,
        ),
      );
      for (const r of rows) found.set(idOf(r.id), { json: r.deleted ? null : jsonOf(r.json_value), ts: BigInt(r.ts) });
    }
    return versionsInOrder(ids, found);
  }

  /** PERSIST-01 C12, the document log by ts: the primary key's leading column. */
  async readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): Promise<DocLogRow[]> {
    if (limit <= 0) return [];
    const [after, upTo, n] = inlineBounds(afterTs, upToTs, limit);
    // The bounds are inlined, not bound: a prepared statement may switch to a generic plan after five runs,
    // and without the values Postgres estimates a range on ts as a large part of the table and plans
    // sequential scans (36 ms against 0.7 ms at 300k rows, measured with plan_cache_mode =
    // force_generic_plan). Inlined, every call gets the index plan. They are integers, checked here.
    // Commits are found one index probe at a time (a loose index scan): a plain `select distinct ts … order by
    // ts limit n` is planned from statistics, and on a log that just grew they say the range is small, so
    // Postgres hashes the whole range and sorts it (54 ms against 3 ms for 1000 commits at 300k rows). A group
    // is one transaction, so what this reads is always whole, durable commits.
    const rows = await this.read((sql) =>
      sql.unsafe(
        `with recursive
         c(ts, n) as (
           (select ts, 1 from documents where ts > ${after} and ts <= ${upTo} order by ts limit 1)
           union all
           select (select d.ts from documents d where d.ts > c.ts and d.ts <= ${upTo} order by d.ts limit 1), c.n + 1
           from c where c.n < ${n} and c.ts is not null)
       select ts, table_id, id, deleted, prev_ts from documents
       where ts > ${after} and ts <= (select max(ts) from c) order by ts, table_id, id`,
        [],
        { prepare: false },
      ),
    );
    return rows.map((r) => ({
      ts: BigInt(r.ts),
      table: idOf(r.table_id),
      id: idOf(r.id),
      deleted: r.deleted === true,
      prevTs: r.prev_ts === null ? null : BigInt(r.prev_ts),
    }));
  }

  /** PERSIST-01 C13: one statement per batch, behind the lease check (see the header). Convex's
   *  `delete_index`: by `(index_id, key_prefix, key_sha256)`. */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    const rows = entries.map((e) => {
      const [prefix, , sha] = keyColumns(e.key);
      return [idHex(e.index), prefix, sha, String(e.ts)];
    });
    return this.fenced(
      `delete from indexes i using jsonb_array_elements($1::text::jsonb) r
       where i.index_id = decode(r->>0, 'hex') and i.key_prefix = decode(r->>1, 'hex')
         and i.key_sha256 = decode(r->>2, 'hex') and i.ts <= (r->>3)::bigint`,
      rows,
    );
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    return this.fenced(
      `delete from documents d using jsonb_array_elements($1::text::jsonb) r
       where d.table_id = decode(r->>0, 'hex') and d.id = decode(r->>1, 'hex') and d.ts <= (r->>2)::bigint`,
      entries.map((e) => [idHex(e.table), idHex(e.id), String(e.ts)]),
    );
  }

  /**
   * PERSIST-01 C17: index rows at their own ts, replacing a row of the same key and ts (Convex's
   * `insert_overwrite_index`), in statements of at most 1 024 rows behind the lease check. Idempotent.
   */
  async writeIndexEntries(entries: IndexEntryAt[]) {
    for (const chunk of chunkRows(entries, POSTGRES_ROWS_PER_STATEMENT)) {
      const rows = chunk.map((e) => indexRow(e, String(e.ts)));
      const [r] = await this.read((sql) =>
        sql.unsafe(
          `with l as (select 1 from leases where id = 1 and ts = $2),
                w as (${INDEX_INSERT} where exists (select 1 from l)
                      on conflict on constraint indexes_pkey do update
                      set deleted = excluded.deleted, table_id = excluded.table_id, document_id = excluded.document_id
                      returning 1)
           select (select count(*) from l)::int as ok`,
          [JSON.stringify(rows), String(this.leaseTs)] as any,
        ),
      );
      if (r.ok !== 1) throw new LeaseLostError();
    }
  }

  /** A delete that runs only while the lease row carries our ts; how many rows it removed. Idempotent, so a
   *  lost connection runs it once more (a read's retry). */
  private async fenced(del: string, rows: unknown[]) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `with l as (select 1 from leases where id = 1 and ts = $2),
              d as (${del} and exists (select 1 from l) returning 1)
         select (select count(*) from l)::int as ok, (select count(*) from d)::int as n`,
        [JSON.stringify(rows), String(this.leaseTs)] as any,
      ),
    );
    if (r.ok !== 1) throw new LeaseLostError();
    return Number(r.n);
  }

  /** PERSIST-01 C14: Convex's `persistence_globals`, the JSON text's bytes. */
  async getGlobal(key: string): Promise<unknown> {
    const [r] = await this.read((sql) => sql`select json_value from persistence_globals where key = ${key}`);
    return r ? decodeGlobal(jsonOf(r.json_value)) : null;
  }

  async setGlobal(key: string, value: unknown) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `with l as (select 1 from leases where id = 1 and ts = $3),
              u as (insert into persistence_globals (key, json_value) select $1, convert_to($2, 'UTF8')
                    where exists (select 1 from l)
                    on conflict on constraint persistence_globals_pkey do update set json_value = excluded.json_value
                    returning 1)
         select (select count(*) from l)::int as ok`,
        [key, encodeGlobal(value), String(this.leaseTs)] as any,
      ),
    );
    if (r.ok !== 1) throw new LeaseLostError();
  }

  async auditRowCount() {
    const [r] = await this.read(
      (sql) => sql`select (select count(*) from documents)::int as docs, (select count(*) from indexes)::int as idx`,
    );
    return { docs: Number(r.docs), idx: Number(r.idx) };
  }

  /** The durable prefix (PERSIST-01 C5): the newest ts in `documents`, as Convex's `max_ts` (a group is one
   *  transaction, so it is whole). */
  async maxTs() {
    const [r] = await this.read((sql) => sql`select coalesce(max(ts), 0)::bigint as m from documents`);
    return BigInt(r.m);
  }

  async auditLiveDocs(table: TabletId, ts: bigint) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `select count(*)::int as n from (select distinct on (id) deleted from documents
       where table_id = $1 and ts <= $2 order by id, ts desc) v where deleted is not true`,
        [bytes(table), String(ts)] as any,
      ),
    );
    return Number(r.n);
  }

  async auditRowsAt(ts: bigint) {
    const at = String(ts);
    const [r] = await this.read(
      (sql) => sql`select (select count(*) from documents where ts = ${at}::bigint)::int as docs,
      (select count(*) from indexes where ts = ${at}::bigint)::int as idx`,
    );
    return { docs: Number(r.docs), idx: Number(r.idx) };
  }

  /** Ends the pool; on a database that does not answer, gives up waiting after one timeout. */
  async close() {
    this.closed = true;
    const t = this.timeoutMs > 0 && this.timeoutMs < Infinity ? { timeout: this.timeoutMs / 1000 } : {};
    await Promise.all([this.sql.end(t), ...this.retired]);
  }
}

/** Convex's `insert_index` from one jsonb array of `IdxRow`s. */
const INDEX_INSERT = `insert into indexes (index_id, ts, key_prefix, key_suffix, key_sha256, deleted, table_id, document_id)
      select decode(r->>0, 'hex'), (r->>4)::bigint, decode(r->>1, 'hex'), decode(r->>2, 'hex'), decode(r->>3, 'hex'),
        (r->>5)::boolean, decode(r->>6, 'hex'), decode(r->>7, 'hex')
      from jsonb_array_elements($1::text::jsonb) r`;

/** One `indexes` row: a tombstone has NULL `table_id` and `document_id`, as Convex writes it. */
function indexRow(e: IndexWrite, ts: string): IdxRow {
  const [prefix, suffix, sha] = keyColumns(e.key);
  return [
    idHex(e.index),
    prefix,
    suffix,
    sha,
    ts,
    e.id === null,
    e.id === null ? null : idHex(e.table!),
    e.id === null ? null : idHex(e.id),
  ];
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(PostgresPersistence);

/** PERSIST-01 C16's answer in the ids' order (duplicates included), from the rows found per id. */
function versionsInOrder(ids: string[], found: Map<string, { json: string | null; ts: bigint }>) {
  return ids.map((id) => {
    const v = found.get(id);
    return v && v.json !== null ? { json: v.json, ts: v.ts } : null;
  });
}

/** Ids per `getVersions` statement: one round trip each, within every store's parameter limits. */
const VERSIONS_CHUNK = 1000;

/** The largest int64: a ts bound above every commit. */
const MAX_I64 = (1n << 63n) - 1n;

/** A log read's bounds, to inline in SQL: integers, checked (the upper one capped at the largest int64). */
function inlineBounds(afterTs: bigint, upToTs: bigint, limit: number): [string, string, number] {
  if (typeof afterTs !== "bigint" || typeof upToTs !== "bigint" || !Number.isSafeInteger(limit))
    throw new Error(`a log read's bounds must be integers: ${afterTs}, ${upToTs}, ${limit}`);
  return [String(afterTs), String(upToTs < MAX_I64 ? upToTs : MAX_I64), limit];
}
