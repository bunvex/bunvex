// Postgres: the same two generic tables Convex uses (documents + indexes, every row stamped with its
// commit ts). Index keys are split into key_prefix / key_suffix / key_suffix_hash as Convex does, so a key
// of any length fits the btree (split.ts). A group of commits is flushed in ONE transaction; a range read and its document fetches are
// fused into ONE statement (scanDocs). The native driver `postgres` is an optional peer dependency.
import {
  type DocWrite,
  type IndexWrite,
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

export class PostgresPersistence implements Persistence, ScanDocs {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  private constructor(private sql: postgresDriver.Sql) {}

  static async open(url: string, pool = 16) {
    const postgres = await loadPeer<typeof postgresDriver>("postgres", "postgres");
    const sql = postgres(url, { max: pool, onnotice: () => {}, prepare: true });
    await sql.unsafe(`
      create table if not exists documents (table_id int not null, id text not null, ts bigint not null,
        json_value text, deleted boolean not null, primary key (table_id, id, ts));
      create table if not exists indexes (index_id int not null, key_prefix bytea not null, key_suffix bytea,
        key_suffix_hash bytea not null, ts bigint not null, deleted boolean not null, document_id text);
      -- (key, ts desc): an ascending scan reads each key's newest version first, straight off the index.
      create unique index if not exists indexes_by_key on indexes (index_id, key_prefix, key_suffix_hash, ts desc);`);
    return new PostgresPersistence(sql);
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    for (const d of docs) this.docs.push([d.table, d.id, ts, d.json, d.json === null]);
    for (const e of idx) {
      const k = splitKey(e.key);
      this.idx.push([e.index, hex(k.prefix), k.suffix && hex(k.suffix), hex(k.suffixHash), ts, e.id === null, e.id]);
    }
  }

  async flush() {
    if (!this.docs.length && !this.idx.length) return;
    const docs = this.docs;
    const idx = this.idx;
    this.docs = [];
    this.idx = [];
    // One jsonb parameter per table, expanded server-side: one statement per table whatever the group
    // size (postgres.js does not bind boolean[]/bytea[] arrays for unnest). Keys travel as hex.
    const docRows = JSON.stringify(docs);
    const idxRows = JSON.stringify(idx);
    await this.sql.begin(async (tx) => {
      if (docs.length)
        await tx.unsafe(
          `insert into documents select (r->>0)::int, r->>1, (r->>2)::bigint, r->>3, (r->>4)::boolean
           from jsonb_array_elements($1::text::jsonb) r`,
          [docRows],
        );
      if (idx.length)
        await tx.unsafe(
          `insert into indexes select (r->>0)::int, decode(r->>1, 'hex'), decode(r->>2, 'hex'), decode(r->>3, 'hex'),
             (r->>4)::bigint, (r->>5)::boolean, r->>6
           from jsonb_array_elements($1::text::jsonb) r`,
          [idxRows],
        );
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

  async maxTs() {
    const [r] = await this.sql`select coalesce(max(ts), 0)::bigint as m from documents`;
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
