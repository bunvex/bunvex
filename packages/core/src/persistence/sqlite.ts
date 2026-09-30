// The SQLite driver: Convex's two generic tables in bun:sqlite (WAL mode). A flush is one SQLite
// transaction, so a group of commits is durable (and crash-atomic) as a whole. Ships with @bunvex/core:
// bun:sqlite is built into Bun, so this driver has no dependency at all.
import { Database } from "bun:sqlite";
import type { DocWrite, IndexWrite, Persistence } from "./index.ts";
import { scanLatestSync } from "./scan.ts";

export class SqlitePersistence implements Persistence {
  private db: Database;
  private insDoc;
  private insIdx;
  private scanAsc;
  private scanDesc;
  private getDoc;
  private inTx = false;

  constructor(path: string, opts: { durable: boolean }) {
    this.db = new Database(path, { create: true });
    this.db.exec(`pragma journal_mode = wal; pragma synchronous = ${opts.durable ? "full" : "off"};
      pragma temp_store = memory; pragma cache_size = -262144;`);
    this.db.exec(`
      create table if not exists documents (table_id integer not null, id text not null, ts integer not null,
        json_value text, deleted integer not null, primary key (table_id, id, ts)) without rowid;
      create table if not exists indexes (index_id integer not null, key blob not null, ts integer not null,
        deleted integer not null, document_id text, primary key (index_id, key, ts)) without rowid;`);
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

  apply(ts: number, docs: DocWrite[], idx: IndexWrite[]) {
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

  // Every commit writes at least one document version, and a flush is one SQLite transaction: the
  // newest document ts IS the last durable commit (PERSIST-01 C4/C5).
  maxTs() {
    const r = this.db.query(`select coalesce(max(ts), 0) as m from documents`).get() as { m: number };
    return Number(r.m);
  }

  close() {
    this.db.close();
  }
}
