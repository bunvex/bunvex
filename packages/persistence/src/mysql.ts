// MySQL: the same two generic tables (documents + indexes). No DISTINCT ON, so the newest version per key
// is chosen client-side from an over-fetched ordered range. The native driver `mysql2` is an optional peer.
import { type DocWrite, type IndexWrite, type Persistence, type ScanDocs, scanLatest } from "@bunvex/core/persistence";
import type * as mysqlDriver from "mysql2/promise";
import { loadPeer } from "./peer.ts";

type DocRow = [number, string, number, string | null, boolean];
type IdxRow = [number, Buffer, number, boolean, string | null];

export class MysqlPersistence implements Persistence, ScanDocs {
  private docs: DocRow[] = [];
  private idx: IdxRow[] = [];
  private constructor(private pool: mysqlDriver.Pool) {}

  static async open(url: string, pool = 16) {
    const mysql = await loadPeer<typeof mysqlDriver>("mysql2/promise", "mysql2");
    const p = mysql.createPool({ uri: url, connectionLimit: pool, multipleStatements: false });
    await p.query(`create table if not exists documents (table_id int not null, id varchar(64) not null,
      ts bigint not null, json_value mediumtext, deleted boolean not null, primary key (table_id, id, ts))`);
    await p.query(`create table if not exists indexes (index_id int not null, \`key\` varbinary(512) not null,
      ts bigint not null, deleted boolean not null, document_id varchar(64), primary key (index_id, \`key\`, ts))`);
    return new MysqlPersistence(p);
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
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
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
    // No DISTINCT ON in MySQL: page through (key, ts desc) order and keep the first row per key.
    const dir = desc ? "desc" : "asc";
    return scanLatest(
      async (p) => {
        const [rows] = (await this.pool.execute(
          `select \`key\`, deleted, document_id from indexes where index_id = ? and \`key\` >= ? and \`key\` < ? and ts <= ?
           order by \`key\` ${dir}, ts desc limit ${Math.floor(p.n)}`,
          [index, Buffer.from(p.lo), Buffer.from(p.hi), ts],
        )) as any;
        return (rows as any[]).map((r) => ({ key: r.key as Uint8Array, deleted: !!r.deleted, id: r.document_id }));
      },
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

  async maxTs() {
    const [rows] = (await this.pool.query(`select coalesce(max(ts), 0) as m from documents`)) as any;
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
