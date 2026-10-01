// MySQL: the same two generic tables (documents + indexes). No DISTINCT ON, so the newest version per key
// is chosen client-side while paging an ordered range. Index keys are split into key_prefix / key_suffix /
// key_suffix_hash as Convex does, so a key of any length fits InnoDB's 3072-byte index limit (split.ts). The native driver `mysql2` is an optional peer.
//
// Single writer (PERSIST-01 C7): one row in `bunvex_lease` (epoch, holder, expires_at on the server's clock,
// max_ts). Each flush's FIRST statement updates the lease row only if our epoch is current, and records the
// group's top as the durable prefix; the rest of the group runs only if it matched. MySQL has no data-
// modifying CTE, so the fence costs one statement (a round trip) per flush.
import {
  type DocWrite,
  type IndexWrite,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  type Persistence,
  type ScanDocs,
  type SplitRow,
  scanLatest,
  splitKey,
  splitPages,
} from "@bunvex/core/persistence";
import type * as mysqlDriver from "mysql2/promise";
import { loadPeer } from "./peer.ts";
import { explainTlsError, mysqlTls, type TlsOptions } from "./tls.ts";

type DocRow = [number, string, number, string | null, boolean];
type IdxRow = [number, Buffer, Buffer | null, Buffer, number, boolean, string | null];

export class MysqlPersistence implements Persistence, ScanDocs, Lease {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  /** The highest ts applied since the last flush: the group's top, recorded as max_ts by the fence. */
  private top = 0;
  /** Our lease's epoch, 0 when we hold none. */
  private epoch = 0;
  private ttlMs = 0;
  private constructor(
    private pool: mysqlDriver.Pool,
    /** This instance's connections' `bunvex_conn` connect attribute, recorded in the lease row: a successor
     *  that finds us paused mid-flush after our lease expired kills exactly these connections. */
    private conn: string,
  ) {}

  /**
   * TLS (STUDY-25 L8, as Convex): required, with the CA and the host name verified, by default;
   * `requireSsl: false` connects as the URL says (plain unless it asks for TLS or `caFile` is set).
   * `caFile` adds a trusted CA.
   */
  static async open(url: string, pool = 16, opts: TlsOptions = {}) {
    const mysql = await loadPeer<typeof mysqlDriver>("mysql2/promise", "mysql2");
    const conn = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const { uri, ssl } = mysqlTls(url, opts);
    const p = mysql.createPool({
      uri,
      ...(ssl ? { ssl: ssl as mysqlDriver.SslOptions } : {}),
      connectionLimit: pool,
      multipleStatements: false,
      connectAttributes: { bunvex_conn: conn },
    });
    try {
      await MysqlPersistence.bootstrap(p);
    } catch (e) {
      await p.end().catch(() => {});
      throw explainTlsError(e, "MySQL", "MYSQL_CA_FILE");
    }
    return new MysqlPersistence(p, conn);
  }

  private static async bootstrap(p: mysqlDriver.Pool) {
    // A writable server only, as Convex's `require_leader` (crates/mysql/src/connection.rs:670-690), the
    // counterpart of Postgres's target_session_attrs=read-write. Convex repeats it on every new connection;
    // bunvex checks at open (a replica that becomes read-only later fails its writes).
    const [ro] = (await p.query(`select (@@global.innodb_read_only or @@global.read_only) as ro`)) as any;
    if (Number(ro[0].ro))
      throw new Error("MySQL is read-only (read_only or innodb_read_only is on): bunvex needs the writable primary");
    // DDL only when a table is missing, as Convex's v5 driver does (a `create table if not exists` still
    // takes metadata locks: MySQL bug 63144); concurrent first opens are serialized by a named lock.
    const [have] = (await p.query(
      `select count(*) as n from information_schema.tables
       where table_schema = database() and table_name in ('documents', 'indexes', 'bunvex_lease')`,
    )) as any;
    if (Number(have[0].n) < 3) {
      const c = await p.getConnection();
      try {
        await c.query(`select get_lock('bunvex_bootstrap', 10)`);
        await c.query(`create table if not exists documents (table_id int not null, id varchar(64) not null,
          ts bigint not null, json_value mediumtext, deleted boolean not null, primary key (table_id, id, ts))`);
        await c.query(`create table if not exists indexes (index_id int not null, key_prefix varbinary(2500) not null,
          key_suffix longblob, key_suffix_hash varbinary(32) not null, ts bigint not null, deleted boolean not null,
          document_id varchar(64), primary key (index_id, key_prefix, key_suffix_hash, ts desc))`);
        await c.query(`create table if not exists bunvex_lease (id int primary key, epoch bigint not null,
          holder varchar(255), holder_conn varchar(64), expires_at datetime(6) not null, max_ts bigint not null)`);
      } finally {
        await c.query(`select release_lock('bunvex_bootstrap')`).catch(() => {});
        c.release();
      }
    }
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.tryAcquire(opts);
      } catch (e) {
        if ((e as { errno?: number }).errno !== 1205 || attempt >= 3) throw e; // 1205: lock wait timeout
      }
      // The lease row is locked: its holder is inside a flush. A live holder is just writing: busy. An
      // expired one that still holds the row is paused mid-flush (a stopped or frozen process): end its
      // connections, so its uncommitted group rolls back (it was never acknowledged).
      const [rows] = (await this.pool.query(
        `select holder, holder_conn, expires_at <= now(6) as expired,
           greatest(0, timestampdiff(microsecond, now(6), expires_at)) / 1000 as ms
         from bunvex_lease where id = 1`,
      )) as any;
      const s = rows[0];
      if (!Number(s.expired)) return { heldBy: s.holder as string, expiresInMs: Number(s.ms) };
      const [stale] = (await this.pool.query(
        `select processlist_id as id from performance_schema.session_connect_attrs
         where attr_name = 'bunvex_conn' and attr_value = ? and processlist_id <> connection_id()`,
        [s.holder_conn],
      )) as any;
      for (const r of stale) await this.pool.query(`kill ${Number(r.id)}`).catch(() => {});
    }
  }

  private async tryAcquire(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    const c = await this.pool.getConnection();
    try {
      // A holder paused inside a flush holds the row lock: give up after 1 s and look (acquireLease).
      await c.query(`set session innodb_lock_wait_timeout = 1`);
      await c.beginTransaction();
      const [n] = (await c.query(`select count(*) as n from bunvex_lease`)) as any;
      if (!Number(n[0].n))
        // A store written before the lease existed: its durable prefix is the newest row of either table.
        await c.query(`insert ignore into bunvex_lease (id, epoch, holder, holder_conn, expires_at, max_ts)
          select 1, 0, null, null, '1970-01-01', greatest((select coalesce(max(ts), 0) from documents),
                                                          (select coalesce(max(ts), 0) from indexes))`);
      const [won] = (await c.query(
        `update bunvex_lease set epoch = epoch + 1, holder = ?, holder_conn = ?,
           expires_at = now(6) + interval ? microsecond
         where id = 1 and (holder is null or expires_at <= now(6))`,
        [opts.holder, this.conn, opts.ttlMs * 1000],
      )) as any;
      if (won.affectedRows === 1) {
        const [e] = (await c.query(`select epoch from bunvex_lease where id = 1`)) as any;
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
      await c.commit();
      return { heldBy: held[0].holder as string, expiresInMs: Number(held[0].ms) };
    } catch (e) {
      await c.rollback().catch(() => {});
      throw e;
    } finally {
      await c.query(`set session innodb_lock_wait_timeout = default`).catch(() => {});
      c.release();
    }
  }

  async renewLease() {
    const [r] = (await this.pool.query(
      `update bunvex_lease set expires_at = now(6) + interval ? microsecond where id = 1 and epoch = ?`,
      [this.ttlMs * 1000, this.epoch],
    )) as any;
    if (r.affectedRows !== 1) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.pool.query(`update bunvex_lease set holder = null where id = 1 and epoch = ?`, [this.epoch]);
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
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      // The fence: nothing of the group is written unless the lease row still carries our epoch. The row
      // lock is held to COMMIT, so a takeover waits for this transaction and then sees max_ts.
      const [f] = (await c.query(`update bunvex_lease set max_ts = ? where id = 1 and epoch = ?`, [
        top,
        this.epoch,
      ])) as any;
      if (f.affectedRows !== 1) throw new LeaseLostError();
      // `values ?` with a nested array expands to a multi-row insert. Chunked to stay under
      // max_allowed_packet on big groups (the seed).
      for (let i = 0; i < docs.length; i += 2000)
        await c.query(`insert into documents values ?`, [docs.slice(i, i + 2000)]);
      for (let i = 0; i < idx.length; i += 2000)
        await c.query(`insert into indexes values ?`, [idx.slice(i, i + 2000)]);
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
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
            const [rows] = (await this.pool.execute(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
               where index_id = ? and key_prefix ${b.loStrict ? ">" : ">="} ? and key_prefix ${b.hiInclusive ? "<=" : "<"} ?
                 and ts <= ?
               order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc limit ${Math.floor(b.n)}`,
              [index, Buffer.from(b.lo), Buffer.from(b.hi), ts],
            )) as any;
            return (rows as any[]).map(toRow);
          },
          group: async (prefix) => {
            const [rows] = (await this.pool.execute(
              `select key_prefix, key_suffix, ts, deleted, document_id from indexes
               where index_id = ? and key_prefix = ? and ts <= ?`,
              [index, Buffer.from(prefix), ts],
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
    const [rows] = (await this.pool.execute(
      `select json_value, deleted from documents where table_id = ? and id = ? and ts <= ? order by ts desc limit 1`,
      [table, id, ts],
    )) as any;
    const r = rows[0];
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
    const ids = await this.latestEntries(index, lo, hi, ts, limit, desc);
    if (!ids.length) return [];
    // One round trip for every document: the newest version <= ts of each id.
    const [rows] = (await this.pool.query(
      `select d.id, d.json_value, d.deleted from documents d
       join (select id, max(ts) ts from documents where table_id = ? and id in (?) and ts <= ? group by id) v
         on d.table_id = ? and d.id = v.id and d.ts = v.ts`,
      [table, ids, ts, table],
    )) as any;
    const byId = new Map<string, any>(rows.map((r: any) => [r.id, r]));
    const out: string[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r && !r.deleted) out.push(r.json_value);
    }
    return out;
  }

  /** The durable prefix (PERSIST-01 C5/C7): the lease row's max_ts, which every fenced flush sets. A store
   *  never leased has no row yet: the newest row of either table. */
  async maxTs() {
    const [rows] = (await this.pool.query(
      `select coalesce((select max_ts from bunvex_lease where id = 1),
         greatest((select coalesce(max(ts), 0) from documents), (select coalesce(max(ts), 0) from indexes))) as m`,
    )) as any;
    return Number(rows[0].m);
  }

  async auditLiveDocs(table: number, ts: number) {
    const [rows] = (await this.pool.query(
      `select count(*) as n from (select json_value, row_number() over (partition by id order by ts desc) rn
       from documents where table_id = ? and ts <= ?) v where rn = 1 and json_value is not null`,
      [table, ts],
    )) as any;
    return Number(rows[0].n);
  }

  async close() {
    await this.pool.end();
  }
}
