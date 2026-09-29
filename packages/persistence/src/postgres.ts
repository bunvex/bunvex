// Postgres: the same two generic tables Convex uses (documents + indexes, every row stamped with its
// commit ts). A group of commits is flushed in ONE transaction; a range read and its document fetches are
// fused into ONE statement (scanDocs). The native driver `postgres` is an optional peer dependency.
import type { DocWrite, IndexWrite, Persistence, ScanDocs } from "@bunvex/core/persistence";
import type postgresDriver from "postgres";
import { loadPeer } from "./peer.ts";

type DocRow = [number, string, number, string | null, boolean];
type IdxRow = [number, Buffer, number, boolean, string | null];

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
      create table if not exists indexes (index_id int not null, key bytea not null, ts bigint not null,
        deleted boolean not null, document_id text, primary key (index_id, key, ts));`);
    return new PostgresPersistence(sql);
  }

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
    for (const d of docs) this.docs.push([d.table, d.id, ts, d.json, d.json === null]);
    for (const e of idx) this.idx.push([e.index, Buffer.from(e.key), ts, e.id === null, e.id]);
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
    const idxRows = JSON.stringify(idx.map((r) => [r[0], r[1].toString("hex"), r[2], r[3], r[4]]));
    await this.sql.begin(async (tx) => {
      if (docs.length)
        await tx.unsafe(
          `insert into documents select (r->>0)::int, r->>1, (r->>2)::bigint, r->>3, (r->>4)::boolean
           from jsonb_array_elements($1::text::jsonb) r`,
          [docRows],
        );
      if (idx.length)
        await tx.unsafe(
          `insert into indexes select (r->>0)::int, decode(r->>1, 'hex'), (r->>2)::bigint, (r->>3)::boolean, r->>4
           from jsonb_array_elements($1::text::jsonb) r`,
          [idxRows],
        );
    });
  }

  async scan(index: number, lo: Uint8Array, hi: Uint8Array, ts: number, limit: number, desc: boolean) {
    // DISTINCT ON walks the index in (key, ts desc) order and keeps the newest version of each key.
    const rows = await this.sql.unsafe(
      `select distinct on (key) key, deleted, document_id from indexes
       where index_id = $1 and key >= $2 and key < $3 and ts <= $4
       order by key ${desc ? "desc" : "asc"}, ts desc limit $5`,
      [index, Buffer.from(lo), Buffer.from(hi), ts, limit * 2] as any,
    );
    const out: string[] = [];
    for (const r of rows) if (!r.deleted && out.length < limit) out.push(r.document_id);
    return out;
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
    const dir = desc ? "desc" : "asc";
    const rows = await this.sql.unsafe(
      `with e as (
         select distinct on (key) key, deleted, document_id from indexes
         where index_id = $1 and key >= $2 and key < $3 and ts <= $4
         order by key ${dir}, ts desc limit $5)
       select d.json_value from e
       cross join lateral (select json_value, deleted from documents
                           where table_id = $6 and id = e.document_id and ts <= $4 order by ts desc limit 1) d
       where not e.deleted and not d.deleted order by e.key ${dir} limit $7`,
      [index, Buffer.from(lo), Buffer.from(hi), ts, limit * 2, table, limit] as any,
    );
    return rows.map((r) => r.json_value as string);
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
