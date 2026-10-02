// Postgres: the same two generic tables Convex uses (documents + indexes, every row stamped with its
// commit ts). Index keys are split into key_prefix / key_suffix / key_suffix_hash as Convex does, so a key
// of any length fits the btree (split.ts). A flush (a write batch of whole commits, bounded by the committer:
// DV-62) is ONE transaction, its rows sent in statements of at most 1 024 rows each, as Convex's
// `INSERTS_PER_STATEMENT`; a range read and its document fetches are fused into ONE statement (scanDocs). The native driver `postgres` is an optional peer dependency.
//
// Single writer (PERSIST-01 C7): one row in `bunvex_lease` (epoch, holder, expires_at on the server's clock,
// max_ts). Every flush's first statement is a data-modifying CTE that updates the lease row only if our epoch
// is current AND inserts the group only if it did: the fence costs no extra round trip, and max_ts (the
// durable prefix) is written in the same transaction as the group.
//
// Layout and read-only flag (PERSIST-01 C10, STUDY-25 L6/L7): `persistence_globals` ('layout_version') and
// `read_only`, Convex's table names. Open checks both before writing anything and refuses a foreign, future
// or read-only store; a new store's version record is written under the lease.
// Retention (PERSIST-01 C12–C14, STUDY-33): the document log reads `documents` by ts (`documents_by_ts`);
// prunes are Convex's `ts <= X` deletes per key, one statement per batch; globals are `persistence_globals`
// rows. A prune or a global write runs only while the lease row carries our epoch: the check is in the same
// statement, without locking the row (a flush or a takeover is never held up by it). A takeover between that
// check and the commit can let one batch through; it only deletes versions superseded below a window the
// old holder had already published, which the new holder reads no lower than either.
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
// `transact`). Before re-running a group, the driver reads the lease record: a group an earlier attempt did
// commit is acknowledged without writing (DV-124). One that lands after that read hits the primary key:
// `UnsureCommitError`.
import {
  checkLayoutVersion,
  checkUnversionedTables,
  chunkRows,
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
  MAX_KEY_PREFIX_LEN,
  type OpenOptions,
  type Persistence,
  POSTGRES_ROWS_PER_STATEMENT,
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
import type postgresDriver from "postgres";
import { loadPeer } from "./peer.ts";
import { explainTlsError, postgresTls, type TlsOptions } from "./tls.ts";

type DocRow = [number, string, number, string | null, boolean];
// index id, key_prefix, key_suffix (or null), key_suffix_hash, ts, deleted, document id — keys as hex
type IdxRow = [number, string, string | null, string, number, boolean, string | null];
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");

const STORE = "this Postgres database";
/** bunvex's columns, as information_schema names their types: how an unversioned store is recognised. */
const COLUMNS = {
  documents: ["table_id integer", "id text", "ts bigint", "json_value text", "deleted boolean"],
  indexes: [
    "index_id integer",
    "key_prefix bytea",
    "key_suffix bytea",
    "key_suffix_hash bytea",
    "ts bigint",
    "deleted boolean",
    "document_id text",
  ],
};

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

export class PostgresPersistence implements Persistence, ScanDocs, Lease, ReadOnlyFlag, RetentionStore {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  /** The highest ts applied since the last flush (the group's top, written to the lease row as max_ts). */
  private top = 0;
  /** Our lease's epoch, 0 when we hold none. */
  private epoch = 0;
  private ttlMs = 0;
  /** The current pool; replaced when a call times out (see `call`). */
  private sql: postgresDriver.Sql;
  /** Retired pools, still ending (closed with the store). */
  private retired = new Set<Promise<void>>();
  private closed = false;
  /** The store predates PERSIST-01 C11 / C12: its ts indexes are built once we hold the lease. */
  private needsLogIndex = false;
  private needsDocLogIndex = false;
  private constructor(
    private newPool: () => postgresDriver.Sql,
    /** This instance's connections' application_name, recorded in the lease row: a successor that finds us
     *  paused mid-flush after our lease expired ends exactly these sessions (see acquireLease). */
    private conn: string,
    /** The client-side timeout of one round trip (STUDY-25 L3). */
    private timeoutMs: number,
  ) {
    this.sql = newPool();
  }

  /**
   * `idleInTransactionMs`: how long the server keeps one of our transactions open while we are paused (a
   * stopped process, a GC pause) before aborting it and releasing its locks, so another process can take
   * the store over (PERSIST-01 C7). It must stay well under the lease TTL.
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

  /** The store's checks (C10), then the tables, created only when one is missing. */
  private async bootstrap(opts: OpenOptions) {
    // What is there decides what may happen: read-only, never waiting on a lock, before any write.
    const [have] = await this.read(
      (sql) => sql`select to_regclass('documents') is not null as documents,
        to_regclass('indexes') is not null as indexes, to_regclass('bunvex_lease') is not null as lease,
        to_regclass('persistence_globals') is not null as globals, to_regclass('read_only') is not null as ro,
        to_regclass('indexes_by_ts') is not null as by_ts, to_regclass('documents_by_ts') is not null as doc_by_ts`,
    );
    await this.checkStore(have, opts);
    // DDL only when a table is missing: a `create … if not exists` still waits for locks another process
    // holds, so a paused process must not wedge every later open (STUDY-24 S3). Concurrent first opens are
    // serialized by an advisory lock (two concurrent `create table` race on the catalog and one fails).
    // The whole transaction runs again if it fails on a lost or timed-out connection: every statement in it
    // is idempotent, and a failed run left nothing behind. The ts index (PERSIST-01 C11) is created with the
    // `indexes` table; a store whose table predates C11 gets it under the lease (see acquireLease).
    if (!(have.documents && have.indexes && have.lease && have.globals && have.ro))
      await this.read((sql, progress) =>
        sql.begin(async (tx) => {
          progress();
          await tx.unsafe(`set local lock_timeout = '10s'`);
          progress();
          await tx.unsafe(`select pg_advisory_xact_lock(7236154418350)`); // any fixed key: "bunvex" bootstrap
          progress();
          await tx.unsafe(`
          create table if not exists documents (table_id int not null, id text not null, ts bigint not null,
            json_value text, deleted boolean not null, primary key (table_id, id, ts));
          ${have.documents ? "" : "create index if not exists documents_by_ts on documents (ts); -- the document log (PERSIST-01 C12)"}
          create table if not exists indexes (index_id int not null, key_prefix bytea not null, key_suffix bytea,
            key_suffix_hash bytea not null, ts bigint not null, deleted boolean not null, document_id text);
          -- (key, ts desc): an ascending scan reads each key's newest version first, straight off the index.
          create unique index if not exists indexes_by_key on indexes (index_id, key_prefix, key_suffix_hash, ts desc);
          ${have.indexes ? "" : "create index if not exists indexes_by_ts on indexes (ts); -- the log by ts (PERSIST-01 C11)"}
          create table if not exists bunvex_lease (id int primary key check (id = 1), epoch bigint not null,
            holder text, holder_conn text, expires_at timestamptz not null, max_ts bigint not null);
          create table if not exists persistence_globals (key text primary key, json_value text not null);
          create table if not exists read_only (id bigint primary key);`);
          progress(); // COMMIT
        }),
      );
    // A store written before C11 (its `indexes` table exists without the ts index): building the index blocks
    // writes, so it waits for the lease, as an upgrade would.
    this.needsLogIndex = have.indexes && !have.by_ts;
    this.needsDocLogIndex = have.documents && !have.doc_by_ts;
  }

  /**
   * PERSIST-01 C10, before anything is written: the recorded layout version must be this bunvex's; a store
   * without one must have bunvex's columns (written before C10: the same layout) or no tables at all; and a
   * store marked read-only opens only with `allowReadOnly`. Refusing needs no lease: nothing is written.
   */
  private async checkStore(have: Record<string, boolean>, opts: OpenOptions) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `select ${have.globals ? "(select json_value::text from persistence_globals where key = 'layout_version')" : "null"} as v,
         ${have.ro ? "exists (select 1 from read_only)" : "false"} as ro`,
      ),
    );
    const version = decodeLayoutVersion(r.v);
    if (version !== null) checkLayoutVersion(version, STORE);
    else if (have.documents || have.indexes) {
      const cols = await this.read(
        (sql) => sql`select table_name::text as t, column_name || ' ' || data_type as c
          from information_schema.columns where table_schema = current_schema() and table_name in ('documents', 'indexes')`,
      );
      const found: Record<string, string[]> = {};
      for (const c of cols) found[c.t] = [...(found[c.t] ?? []), c.c as string];
      checkUnversionedTables(STORE, found, COLUMNS);
    }
    if (r.ro && !opts.allowReadOnly) throw new ReadOnlyError(STORE);
  }

  /** Convex's `set_read_only`: no lease needed; the next open for writing is refused while it is set. */
  async setReadOnly(readOnly: boolean) {
    await this.call((sql) =>
      readOnly ? sql`insert into read_only (id) values (1) on conflict do nothing` : sql`delete from read_only`,
    );
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    const r = await this.acquireOnce(opts);
    if ("epoch" in r && this.needsLogIndex) {
      // One timed call (STUDY-25 L3), not retried: a build that timed out is not run twice.
      await this.call((sql) => sql`create index if not exists indexes_by_ts on indexes (ts)`);
      this.needsLogIndex = false;
    }
    if ("epoch" in r && this.needsDocLogIndex) {
      await this.call((sql) => sql`create index if not exists documents_by_ts on documents (ts)`);
      this.needsDocLogIndex = false;
    }
    return r;
  }

  private async acquireOnce(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.tryAcquire(opts);
      } catch (e) {
        if ((e as { code?: string }).code !== "55P03" || attempt >= 3) throw e; // 55P03: lock_timeout
      }
      // The lease row is locked: its holder is inside a flush. A live holder is just writing: busy. An
      // expired one that still holds the row is paused mid-flush (a stopped or frozen process). The server
      // does not abort a transaction that waits on its client in the middle of the protocol (the
      // idle-in-transaction timeout covers only the idle state), so end that process's sessions: the
      // uncommitted group rolls back, and it was never acknowledged.
      const [s] = await this.call(
        (sql) => sql`select holder, holder_conn, expires_at <= clock_timestamp() as expired,
        greatest(0, extract(epoch from expires_at - clock_timestamp()) * 1000)::float8 as ms
        from bunvex_lease where id = 1`,
      );
      if (!s.expired) return { heldBy: s.holder as string, expiresInMs: Number(s.ms) };
      await this.call(
        (sql) => sql`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${s.holder_conn as string} and application_name <> ${this.conn}`,
      );
    }
  }

  private tryAcquire(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    return this.call((sql, progress) => this.tryAcquireIn(sql, progress, opts));
  }

  private tryAcquireIn(sql: postgresDriver.Sql, progress: () => void, opts: { holder: string; ttlMs: number }) {
    return sql.begin(async (tx) => {
      progress();
      await tx.unsafe(`set local lock_timeout = '1s'`);
      progress();
      // A store written before the lease existed: its durable prefix is the newest row of either table.
      await tx.unsafe(`insert into bunvex_lease (id, epoch, holder, expires_at, max_ts)
        select 1, 0, null, '-infinity', greatest((select coalesce(max(ts), 0) from documents),
                                                 (select coalesce(max(ts), 0) from indexes))
        where not exists (select 1 from bunvex_lease)
        on conflict (id) do nothing`);
      progress();
      const [won] = await tx.unsafe(
        `update bunvex_lease set epoch = epoch + 1, holder = $1, holder_conn = $3,
           expires_at = clock_timestamp() + $2 * interval '1 millisecond'
         where id = 1 and (holder is null or expires_at <= clock_timestamp()) returning epoch`,
        [opts.holder, opts.ttlMs, this.conn] as any,
      );
      progress();
      if (won) {
        // PERSIST-01 C10: a new (or pre-C10) store gets its layout version now, under the lease, in the same
        // transaction; one stamped in the meantime by another bunvex is checked again (a mismatch rolls the
        // acquisition back).
        const [v] = await tx.unsafe(
          `with ins as (insert into persistence_globals (key, json_value) values ('layout_version', $1)
             on conflict (key) do nothing returning json_value)
           select coalesce((select json_value from ins),
                           (select json_value::text from persistence_globals where key = 'layout_version')) as v`,
          [JSON.stringify(LAYOUT_VERSION)],
        );
        progress();
        checkLayoutVersion(decodeLayoutVersion(v.v), STORE);
        this.epoch = Number(won.epoch);
        this.ttlMs = opts.ttlMs;
        return { epoch: this.epoch };
      }
      const [held] = await tx.unsafe(
        `select holder, greatest(0, extract(epoch from expires_at - clock_timestamp()) * 1000)::float8 as ms
         from bunvex_lease where id = 1`,
      );
      progress(); // COMMIT
      return { heldBy: held.holder as string, expiresInMs: Number(held.ms) };
    });
  }

  /** Bounded by a quarter of the TTL (`renewTimeoutMs`, STUDY-25 L3). */
  async renewLease() {
    const [r] = await this.call(
      (sql) =>
        sql.unsafe(
          `update bunvex_lease set expires_at = clock_timestamp() + $2 * interval '1 millisecond'
       where id = 1 and epoch = $1 returning 1 as ok`,
          [this.epoch, this.ttlMs] as any,
        ),
      renewTimeoutMs(this.timeoutMs, this.ttlMs),
    );
    if (!r) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.call((sql) =>
      sql.unsafe(`update bunvex_lease set holder = null where id = 1 and epoch = $1`, [this.epoch] as any),
    );
    this.epoch = 0;
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    this.top = ts;
    for (const d of docs) this.docs.push([d.table, d.id, ts, d.json, d.json === null]);
    for (const e of idx) {
      const k = splitKey(e.key);
      this.idx.push([e.index, hex(k.prefix), k.suffix && hex(k.suffix), hex(k.suffixHash), ts, e.id === null, e.id]);
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

  /** Whether the group up to `top` committed, from the lease record (`retriedGroupLanded`, PERSIST-01 C9). */
  private async landed(top: number) {
    const [l] = await this.call((sql) => sql`select epoch, max_ts from bunvex_lease where id = 1`);
    return retriedGroupLanded(l && { epoch: Number(l.epoch), maxTs: Number(l.max_ts) }, this.epoch, top);
  }

  private async flushGroup(docs: DocRow[], idx: IdxRow[], top: number) {
    // One jsonb parameter per statement, expanded server-side (postgres.js does not bind boolean[]/bytea[]
    // arrays for unnest). Keys travel as hex. At most 1 024 rows per statement, as Convex's
    // `INSERTS_PER_STATEMENT` (DV-62): a large commit is several statements of one transaction.
    const docInsert = `insert into documents select (r->>0)::int, r->>1, (r->>2)::bigint, r->>3, (r->>4)::boolean
      from jsonb_array_elements($1::text::jsonb) r`;
    const idxInsert = `insert into indexes select (r->>0)::int, decode(r->>1, 'hex'), decode(r->>2, 'hex'),
      decode(r->>3, 'hex'), (r->>4)::bigint, (r->>5)::boolean, r->>6
      from jsonb_array_elements($1::text::jsonb) r`;
    // As Convex's `transact`: if the connection is lost before the transaction began, nothing was sent, and
    // the transaction is opened once more, on a fresh pool. Once it began, a lost connection is not retried.
    let began = false;
    const sql0 = this.sql;
    const attempt = () =>
      this.call((sql, progress) =>
        sql.begin(async (tx) => {
          began = true;
          progress();
          // The fence: the first insert happens only if the lease row still carries our epoch, and that update
          // also records the group's top as the durable prefix. Data-modifying CTEs always run, and their row
          // lock is held to COMMIT, so a takeover waits for this transaction and then sees max_ts.
          const statements: [string, unknown[][]][] = [
            ...chunkRows(docs, POSTGRES_ROWS_PER_STATEMENT).map((c): [string, unknown[][]] => [docInsert, c]),
            ...chunkRows(idx, POSTGRES_ROWS_PER_STATEMENT).map((c): [string, unknown[][]] => [idxInsert, c]),
          ];
          const [[first, rows], ...rest] = statements;
          const [f] = await tx.unsafe(
            `with l as (update bunvex_lease set max_ts = $2 where id = 1 and epoch = $3 returning 1),
              w as (${first} where exists (select 1 from l))
         select count(*)::int as n from l`,
            [JSON.stringify(rows), top, this.epoch] as any,
          );
          if (f.n !== 1) throw new LeaseLostError();
          progress();
          for (const [statement, chunk] of rest) {
            await tx.unsafe(statement, [JSON.stringify(chunk)]);
            progress(); // the next statement, or COMMIT
          }
        }),
      );
    await retryOnce(
      attempt,
      (e) => !began && connectionLost(e),
      () => this.retire(sql0),
    );
  }

  /**
   * Fast path: DISTINCT ON walks the index in (key_prefix, key_suffix_hash, ts desc) order and keeps the
   * newest version of each key; removed entries are filtered AFTER it and the limit applies to what is
   * left. That order is the key order unless a key is longer than the prefix, so a result holding such a
   * key (or a bound that long) falls back to the paged, group-sorting scan.
   */
  async scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    if (limit <= 0) return [];
    if (lo.length <= MAX_KEY_PREFIX_LEN && hi.length <= MAX_KEY_PREFIX_LEN) {
      const dir = desc ? "desc" : "asc";
      const rows = await this.read((sql) =>
        sql.unsafe(
          `select document_id, octet_length(key_prefix) >= ${MAX_KEY_PREFIX_LEN} as long from (
           select distinct on (key_prefix, key_suffix_hash) key_prefix, key_suffix_hash, deleted, document_id
           from indexes where index_id = $1 and key_prefix >= $2 and key_prefix < $3 and ts <= $4
           order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc) e
         where not e.deleted order by e.key_prefix ${dir}, e.key_suffix_hash ${dir} limit $5`,
          [index, Buffer.from(lo), Buffer.from(hi), ts, limit] as any,
        ),
      );
      if (!rows.some((r) => r.long)) return rows.map((r) => r.document_id as string);
    }
    return scanLatest(splitPages(this.splitSource(index, ts, desc), desc), lo, hi, limit, desc);
  }

  private splitSource(index: number, ts: number, desc: boolean) {
    const dir = desc ? "desc" : "asc";
    const toRow = (r: any): SplitRow => ({
      prefix: r.key_prefix as Uint8Array, // a Buffer is a Uint8Array: no copy
      suffix: (r.key_suffix as Uint8Array | null) ?? null,
      ts: Number(r.ts),
      deleted: r.deleted,
      id: r.document_id,
    });
    return {
      page: async (b: { lo: Uint8Array; loStrict: boolean; hi: Uint8Array; hiInclusive: boolean; n: number }) =>
        (
          await this.read((sql) =>
            sql.unsafe(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix ${b.loStrict ? ">" : ">="} $2 and key_prefix ${b.hiInclusive ? "<=" : "<"} $3
               and ts <= $4
             order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc limit $5`,
              [index, Buffer.from(b.lo), Buffer.from(b.hi), ts, b.n] as any,
            ),
          )
        ).map(toRow),
      group: async (prefix: Uint8Array) =>
        (
          await this.read((sql) =>
            sql.unsafe(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix = $2 and ts <= $3`,
              [index, Buffer.from(prefix), ts] as any,
            ),
          )
        ).map(toRow),
    };
  }

  async get(table: number, id: string, ts: number) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `select json_value, deleted from documents where table_id = $1 and id = $2 and ts <= $3 order by ts desc limit 1`,
        [table, id, ts] as any,
      ),
    );
    return r && !r.deleted ? (r.json_value as string) : null;
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
    if (limit <= 0) return [];
    if (lo.length <= MAX_KEY_PREFIX_LEN && hi.length <= MAX_KEY_PREFIX_LEN) {
      const dir = desc ? "desc" : "asc";
      const rows = await this.read((sql) =>
        sql.unsafe(
          `with e as (
           select distinct on (key_prefix, key_suffix_hash) key_prefix, key_suffix_hash, deleted, document_id
           from indexes where index_id = $1 and key_prefix >= $2 and key_prefix < $3 and ts <= $4
           order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc)
         select d.json_value, octet_length(e.key_prefix) >= ${MAX_KEY_PREFIX_LEN} as long from e
         cross join lateral (select json_value, deleted from documents
                             where table_id = $5 and id = e.document_id and ts <= $4 order by ts desc limit 1) d
         where not e.deleted and not d.deleted order by e.key_prefix ${dir}, e.key_suffix_hash ${dir} limit $6`,
          [index, Buffer.from(lo), Buffer.from(hi), ts, table, limit] as any,
        ),
      );
      if (!rows.some((r) => r.long)) return rows.map((r) => r.json_value as string);
    }
    // Long keys: the exact scan, then one fetch per document (rare).
    const out: string[] = [];
    for (const id of await this.scan(index, lo, hi, ts, limit, desc)) {
      const j = await this.get(table, id, ts);
      if (j !== null) out.push(j);
    }
    return out;
  }

  /**
   * PERSIST-01 C11, one statement (one snapshot): the bound is the lease row's max_ts (the durable prefix,
   * written in the same transaction as each group), `c` walks the ts index to the last of the first
   * `limit` commits, and the rows up to it come back in ts order with the newest ts at or before `afterTs`
   * (one more index probe).
   */
  async readLog(afterTs: number, upToTs: number, limit: number): Promise<LogCommit[]> {
    if (limit <= 0) return [];
    // The bounds are inlined, not bound: a prepared statement may switch to a generic plan after five runs,
    // and without the values Postgres estimates a range on ts as a large part of the table and plans
    // sequential scans (36 ms against 0.7 ms at 300k rows, measured with plan_cache_mode =
    // force_generic_plan). Inlined, every call gets the index plan. They are integers, checked here.
    const [after, upTo, n] = [afterTs, Math.min(upToTs, Number.MAX_SAFE_INTEGER), limit].map((x) => {
      if (!Number.isSafeInteger(x)) throw new Error(`readLog: ${x} is not an integer timestamp or limit`);
      return x;
    });
    // `c` finds the first `limit` commit timestamps one index probe at a time (a loose index scan): a plain
    // `select distinct ts … order by ts limit n` is planned from statistics, and on a log that just grew
    // they say the range is small, so Postgres hashes the whole range and sorts it (54 ms against 3 ms for
    // 1000 commits at 300k rows, measured); `order by ts limit 1` walks the index whatever they say.
    // One statement, so a read (STUDY-25 L3/L5): bounded by the call timeout, run once more on a fresh pool
    // if its connection was lost or it timed out.
    const rows = await this.read((sql) =>
      sql.unsafe(
        `with recursive
         b as (select least(${upTo}, coalesce((select max_ts from bunvex_lease where id = 1), ${upTo})) as hi),
         c(ts, n) as (
           (select ts, 1 from indexes, b where ts > ${after} and ts <= b.hi order by ts limit 1)
           union all
           select (select i.ts from indexes i, b where i.ts > c.ts and i.ts <= b.hi order by i.ts limit 1), c.n + 1
           from c where c.n < ${n} and c.ts is not null)
       select ts, index_id, key_prefix, key_suffix, document_id,
              (select max(ts) from indexes where ts <= ${after}) as prev
       from indexes where ts > ${after} and ts <= (select max(ts) from c) order by ts`,
        [],
        { prepare: false },
      ),
    );
    if (!rows.length) return [];
    return groupLog(
      rows.map((r) => ({
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
    const [after, upTo, n] = [afterTs, Math.min(upToTs, Number.MAX_SAFE_INTEGER), limit].map((x) => {
      if (!Number.isSafeInteger(x)) throw new Error(`readDocumentLog: ${x} is not an integer timestamp or limit`);
      return x;
    });
    // Bounds inlined and commits found one index probe at a time, for readLog's reasons.
    const rows = await this.read((sql) =>
      sql.unsafe(
        `with recursive
         b as (select least(${upTo}, coalesce((select max_ts from bunvex_lease where id = 1), ${upTo})) as hi),
         c(ts, n) as (
           (select ts, 1 from documents, b where ts > ${after} and ts <= b.hi order by ts limit 1)
           union all
           select (select d.ts from documents d, b where d.ts > c.ts and d.ts <= b.hi order by d.ts limit 1), c.n + 1
           from c where c.n < ${n} and c.ts is not null)
       select ts, table_id, id, deleted from documents
       where ts > ${after} and ts <= (select max(ts) from c) order by ts`,
        [],
        { prepare: false },
      ),
    );
    return rows.map((r) => ({ ts: Number(r.ts), table: r.table_id as number, id: r.id as string, deleted: r.deleted }));
  }

  /** PERSIST-01 C13: one statement per batch, behind the epoch check (see the header). */
  async pruneIndexes(entries: IndexPrune[]) {
    if (!entries.length) return 0;
    const rows = entries.map((e) => {
      const k = splitKey(e.key);
      return [e.index, hex(k.prefix), hex(k.suffixHash), e.ts];
    });
    return this.fenced(
      `delete from indexes i using jsonb_array_elements($1::text::jsonb) r
       where i.index_id = (r->>0)::int and i.key_prefix = decode(r->>1, 'hex')
         and i.key_suffix_hash = decode(r->>2, 'hex') and i.ts <= (r->>3)::bigint`,
      rows,
    );
  }

  async pruneDocuments(entries: DocPrune[]) {
    if (!entries.length) return 0;
    return this.fenced(
      `delete from documents d using jsonb_array_elements($1::text::jsonb) r
       where d.table_id = (r->>0)::int and d.id = r->>1 and d.ts <= (r->>2)::bigint`,
      entries.map((e) => [e.table, e.id, e.ts]),
    );
  }

  /** A delete that runs only while the lease row carries our epoch; how many rows it removed. Idempotent,
   *  so a lost connection runs it once more (a read's retry). */
  private async fenced(del: string, rows: unknown[]) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `with l as (select 1 from bunvex_lease where id = 1 and epoch = $2),
              d as (${del} and exists (select 1 from l) returning 1)
         select (select count(*) from l)::int as ok, (select count(*) from d)::int as n`,
        [JSON.stringify(rows), this.epoch] as any,
      ),
    );
    if (r.ok !== 1) throw new LeaseLostError();
    return Number(r.n);
  }

  /** PERSIST-01 C14. */
  async getGlobal(key: string): Promise<unknown> {
    const [r] = await this.read((sql) => sql`select json_value::text as v from persistence_globals where key = ${key}`);
    return r ? JSON.parse(r.v as string) : null;
  }

  async setGlobal(key: string, value: unknown) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `with l as (select 1 from bunvex_lease where id = 1 and epoch = $3),
              u as (insert into persistence_globals (key, json_value) select $1, $2 where exists (select 1 from l)
                    on conflict (key) do update set json_value = excluded.json_value returning 1)
         select (select count(*) from l)::int as ok`,
        [key, JSON.stringify(value), this.epoch] as any,
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

  /** The durable prefix (PERSIST-01 C5/C7): the lease row's max_ts, which every fenced flush sets. A store
   *  never leased (written before C7) has no row yet: the newest row of either table. */
  async maxTs() {
    const [r] = await this.read(
      (sql) => sql`select coalesce((select max_ts from bunvex_lease where id = 1),
      greatest((select coalesce(max(ts), 0) from documents), (select coalesce(max(ts), 0) from indexes)))::bigint as m`,
    );
    return Number(r.m);
  }

  async auditLiveDocs(table: number, ts: number) {
    const [r] = await this.read((sql) =>
      sql.unsafe(
        `select count(*)::int as n from (select distinct on (id) json_value from documents
       where table_id = $1 and ts <= $2 order by id, ts desc) v where json_value is not null`,
        [table, ts] as any,
      ),
    );
    return Number(r.n);
  }

  async auditRowsAt(ts: number) {
    const [r] = await this.read(
      (sql) => sql`select (select count(*) from documents where ts = ${ts})::int as docs,
      (select count(*) from indexes where ts = ${ts})::int as idx`,
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
