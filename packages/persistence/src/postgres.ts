// Postgres: the same two generic tables Convex uses (documents + indexes, every row stamped with its
// commit ts). Index keys are split into key_prefix / key_suffix / key_suffix_hash as Convex does, so a key
// of any length fits the btree (split.ts). A group of commits is flushed in ONE transaction; a range read and its document fetches are
// fused into ONE statement (scanDocs). The native driver `postgres` is an optional peer dependency.
//
// Single writer (PERSIST-01 C7): one row in `bunvex_lease` (epoch, holder, expires_at on the server's clock,
// max_ts). Every flush's first statement is a data-modifying CTE that updates the lease row only if our epoch
// is current AND inserts the group only if it did: the fence costs no extra round trip, and max_ts (the
// durable prefix) is written in the same transaction as the group.
import {
  type DocWrite,
  type IndexWrite,
  type Lease,
  type LeaseAcquire,
  LeaseLostError,
  MAX_KEY_PREFIX_LEN,
  type Persistence,
  type ScanDocs,
  type SplitRow,
  scanLatest,
  splitKey,
  splitPages,
} from "@bunvex/core/persistence";
import type postgresDriver from "postgres";
import { loadPeer } from "./peer.ts";

type DocRow = [number, string, number, string | null, boolean];
// index id, key_prefix, key_suffix (or null), key_suffix_hash, ts, deleted, document id — keys as hex
type IdxRow = [number, string, string | null, string, number, boolean, string | null];
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");

export class PostgresPersistence implements Persistence, ScanDocs, Lease {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  /** The highest ts applied since the last flush (the group's top, written to the lease row as max_ts). */
  private top = 0;
  /** Our lease's epoch, 0 when we hold none. */
  private epoch = 0;
  private ttlMs = 0;
  private constructor(
    private sql: postgresDriver.Sql,
    /** This instance's connections' application_name, recorded in the lease row: a successor that finds us
     *  paused mid-flush after our lease expired ends exactly these sessions (see acquireLease). */
    private conn: string,
  ) {}

  /**
   * `idleInTransactionMs`: how long the server keeps one of our transactions open while we are paused (a
   * stopped process, a GC pause) before aborting it and releasing its locks, so another process can take
   * the store over (PERSIST-01 C7). It must stay well under the lease TTL.
   */
  static async open(url: string, pool = 16, opts: { idleInTransactionMs?: number } = {}) {
    const postgres = await loadPeer<typeof postgresDriver>("postgres", "postgres");
    const conn = `bunvex-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
    const sql = postgres(url, {
      max: pool,
      onnotice: () => {},
      prepare: true,
      connection: {
        application_name: conn,
        idle_in_transaction_session_timeout: opts.idleInTransactionMs ?? 2500,
      },
    });
    // DDL only when a table is missing: a `create … if not exists` still waits for locks another process
    // holds, so a paused process must not wedge every later open (STUDY-24 S3). Concurrent first opens are
    // serialized by an advisory lock (two concurrent `create table` race on the catalog and one fails).
    const [have] = await sql`select to_regclass('documents') is not null and to_regclass('indexes') is not null
      and to_regclass('bunvex_lease') is not null as ok`;
    if (!have.ok)
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = '10s'`);
        await tx.unsafe(`select pg_advisory_xact_lock(7236154418350)`); // any fixed key: "bunvex" bootstrap
        await tx.unsafe(`
          create table if not exists documents (table_id int not null, id text not null, ts bigint not null,
            json_value text, deleted boolean not null, primary key (table_id, id, ts));
          create table if not exists indexes (index_id int not null, key_prefix bytea not null, key_suffix bytea,
            key_suffix_hash bytea not null, ts bigint not null, deleted boolean not null, document_id text);
          -- (key, ts desc): an ascending scan reads each key's newest version first, straight off the index.
          create unique index if not exists indexes_by_key on indexes (index_id, key_prefix, key_suffix_hash, ts desc);
          create table if not exists bunvex_lease (id int primary key check (id = 1), epoch bigint not null,
            holder text, holder_conn text, expires_at timestamptz not null, max_ts bigint not null);`);
      });
    return new PostgresPersistence(sql, conn);
  }

  async acquireLease(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
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
      const [s] = await this.sql`select holder, holder_conn, expires_at <= clock_timestamp() as expired,
        greatest(0, extract(epoch from expires_at - clock_timestamp()) * 1000)::float8 as ms
        from bunvex_lease where id = 1`;
      if (!s.expired) return { heldBy: s.holder as string, expiresInMs: Number(s.ms) };
      await this.sql`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${s.holder_conn as string} and application_name <> ${this.conn}`;
    }
  }

  private tryAcquire(opts: { holder: string; ttlMs: number }): Promise<LeaseAcquire> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = '1s'`);
      // A store written before the lease existed: its durable prefix is the newest row of either table.
      await tx.unsafe(`insert into bunvex_lease (id, epoch, holder, expires_at, max_ts)
        select 1, 0, null, '-infinity', greatest((select coalesce(max(ts), 0) from documents),
                                                 (select coalesce(max(ts), 0) from indexes))
        where not exists (select 1 from bunvex_lease)
        on conflict (id) do nothing`);
      const [won] = await tx.unsafe(
        `update bunvex_lease set epoch = epoch + 1, holder = $1, holder_conn = $3,
           expires_at = clock_timestamp() + $2 * interval '1 millisecond'
         where id = 1 and (holder is null or expires_at <= clock_timestamp()) returning epoch`,
        [opts.holder, opts.ttlMs, this.conn] as any,
      );
      if (won) {
        this.epoch = Number(won.epoch);
        this.ttlMs = opts.ttlMs;
        return { epoch: this.epoch };
      }
      const [held] = await tx.unsafe(
        `select holder, greatest(0, extract(epoch from expires_at - clock_timestamp()) * 1000)::float8 as ms
         from bunvex_lease where id = 1`,
      );
      return { heldBy: held.holder as string, expiresInMs: Number(held.ms) };
    });
  }

  async renewLease() {
    const [r] = await this.sql.unsafe(
      `update bunvex_lease set expires_at = clock_timestamp() + $2 * interval '1 millisecond'
       where id = 1 and epoch = $1 returning 1 as ok`,
      [this.epoch, this.ttlMs] as any,
    );
    if (!r) throw new LeaseLostError();
  }

  async releaseLease() {
    if (!this.epoch) return;
    await this.sql.unsafe(`update bunvex_lease set holder = null where id = 1 and epoch = $1`, [this.epoch] as any);
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
    // One jsonb parameter per table, expanded server-side: one statement per table whatever the group
    // size (postgres.js does not bind boolean[]/bytea[] arrays for unnest). Keys travel as hex.
    const docInsert = `insert into documents select (r->>0)::int, r->>1, (r->>2)::bigint, r->>3, (r->>4)::boolean
      from jsonb_array_elements($1::text::jsonb) r`;
    const idxInsert = `insert into indexes select (r->>0)::int, decode(r->>1, 'hex'), decode(r->>2, 'hex'),
      decode(r->>3, 'hex'), (r->>4)::bigint, (r->>5)::boolean, r->>6
      from jsonb_array_elements($1::text::jsonb) r`;
    await this.sql.begin(async (tx) => {
      // The fence: the first insert happens only if the lease row still carries our epoch, and that update
      // also records the group's top as the durable prefix. Data-modifying CTEs always run, and their row
      // lock is held to COMMIT, so a takeover waits for this transaction and then sees max_ts.
      const [first, rows, rest] = docs.length
        ? [docInsert, docs, idx.length ? idxInsert : null]
        : [idxInsert, idx, null];
      const [f] = await tx.unsafe(
        `with l as (update bunvex_lease set max_ts = $2 where id = 1 and epoch = $3 returning 1),
              w as (${first} where exists (select 1 from l))
         select count(*)::int as n from l`,
        [JSON.stringify(rows), top, this.epoch] as any,
      );
      if (f.n !== 1) throw new LeaseLostError();
      if (rest) await tx.unsafe(rest, [JSON.stringify(idx)]);
    });
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
      const rows = await this.sql.unsafe(
        `select document_id, octet_length(key_prefix) >= ${MAX_KEY_PREFIX_LEN} as long from (
           select distinct on (key_prefix, key_suffix_hash) key_prefix, key_suffix_hash, deleted, document_id
           from indexes where index_id = $1 and key_prefix >= $2 and key_prefix < $3 and ts <= $4
           order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc) e
         where not e.deleted order by e.key_prefix ${dir}, e.key_suffix_hash ${dir} limit $5`,
        [index, Buffer.from(lo), Buffer.from(hi), ts, limit] as any,
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
          await this.sql.unsafe(
            `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix ${b.loStrict ? ">" : ">="} $2 and key_prefix ${b.hiInclusive ? "<=" : "<"} $3
               and ts <= $4
             order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc limit $5`,
            [index, Buffer.from(b.lo), Buffer.from(b.hi), ts, b.n] as any,
          )
        ).map(toRow),
      group: async (prefix: Uint8Array) =>
        (
          await this.sql.unsafe(
            `select key_prefix, key_suffix, ts, deleted, document_id from indexes
             where index_id = $1 and key_prefix = $2 and ts <= $3`,
            [index, Buffer.from(prefix), ts] as any,
          )
        ).map(toRow),
    };
  }

  async get(table: number, id: string, ts: number) {
    const [r] = await this.sql.unsafe(
      `select json_value, deleted from documents where table_id = $1 and id = $2 and ts <= $3 order by ts desc limit 1`,
      [table, id, ts] as any,
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
      const rows = await this.sql.unsafe(
        `with e as (
           select distinct on (key_prefix, key_suffix_hash) key_prefix, key_suffix_hash, deleted, document_id
           from indexes where index_id = $1 and key_prefix >= $2 and key_prefix < $3 and ts <= $4
           order by key_prefix ${dir}, key_suffix_hash ${dir}, ts desc)
         select d.json_value, octet_length(e.key_prefix) >= ${MAX_KEY_PREFIX_LEN} as long from e
         cross join lateral (select json_value, deleted from documents
                             where table_id = $5 and id = e.document_id and ts <= $4 order by ts desc limit 1) d
         where not e.deleted and not d.deleted order by e.key_prefix ${dir}, e.key_suffix_hash ${dir} limit $6`,
        [index, Buffer.from(lo), Buffer.from(hi), ts, table, limit] as any,
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

  /** The durable prefix (PERSIST-01 C5/C7): the lease row's max_ts, which every fenced flush sets. A store
   *  never leased (written before C7) has no row yet: the newest row of either table. */
  async maxTs() {
    const [r] = await this.sql`select coalesce((select max_ts from bunvex_lease where id = 1),
      greatest((select coalesce(max(ts), 0) from documents), (select coalesce(max(ts), 0) from indexes)))::bigint as m`;
    return Number(r.m);
  }

  async auditLiveDocs(table: number, ts: number) {
    const [r] = await this.sql.unsafe(
      `select count(*)::int as n from (select distinct on (id) json_value from documents
       where table_id = $1 and ts <= $2 order by id, ts desc) v where json_value is not null`,
      [table, ts] as any,
    );
    return Number(r.n);
  }

  async close() {
    await this.sql.end();
  }
}
