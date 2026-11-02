// The SQLite store's reads (STUDY-194 §10.2): every statement that reads the store, on one connection. The main
// thread's `SqlitePersistence` reads through it, and so does an execution worker's `SqliteStoreReader`, each on a
// connection of its own: the same statements and the same answers either way.
//
// No read needs a transaction around it: every row is versioned by its ts, a read names its ts, and a connection
// sees a group only once the writer thread has committed it (WAL), which is before the commit's ts is visible.
import type { Database, Statement } from "bun:sqlite";
import { internalIdBytes, internalIdString } from "../internal-id.ts";
import { decodeGlobal } from "./global-json.ts";
import type { DocLogRow, DocVersion, IndexedDoc, IndexId, InternalId, TabletId } from "./index.ts";
import { DanglingReferenceError } from "./index.ts";
import { scanLatestSync } from "./scan.ts";
import { cachedBytes } from "./sqlite-writer.ts";

const idString = (b: Uint8Array) => internalIdString(b);

/** A live index entry's document id and its document at the entry's ts (null columns: no such version). */
type JoinedEntry = { id: Uint8Array; json: string | null; docDeleted: bigint | null };

/** The reads of a SQLite store, on `db`. */
export class SqliteReads {
  /** The statements prepared here: finalized on close, else the connection outlives `close()`. */
  private statements: Statement[] = [];
  private scanAsc;
  private scanDesc;
  private getDoc;
  private maxDocTs;
  private docLogRows;
  private global;

  constructor(private db: Database) {
    // Newest version per key at or before ts, joined to its document at the entry's own ts, as Convex's
    // `index_scan` (crates/sqlite/src/lib.rs): the key's max ts from the primary key's index alone (it holds
    // every column the grouping reads, so old versions and tombstones cost no row lookup), then that one row
    // and its document. A page is at most `?5` keys; `scanLatestSync` pages on.
    // Timestamps are nanoseconds above 2^53 (STUDY-133 §5.3): the statements that read them return
    // integers as `bigint`.
    const scan = (dir: "asc" | "desc") =>
      this.prepare(`select a.key, a.ts, b.deleted, b.document_id, c.json_value, c.deleted as doc_deleted
        from (select key, max(ts) as ts from indexes where index_id = ?1 and key >= ?2 and key < ?3 and ts <= ?4
              group by key order by key ${dir} limit ?5) a
        join indexes b on b.index_id = ?1 and b.key = a.key and b.ts = a.ts
        left join documents c on c.ts = b.ts and c.table_id = b.table_id and c.id = b.document_id
        order by a.key ${dir}`).safeIntegers(true);
    this.scanAsc = scan("asc");
    this.scanDesc = scan("desc");
    this.getDoc = this.prepare(`select json_value, deleted, ts from documents
        where table_id = ? and id = ? and ts <= ? order by ts desc limit 1`).safeIntegers(true);
    // The newest ts written (the durable prefix, once a flush has committed it): the key's leading column.
    this.maxDocTs = this.prepare(`select max(ts) as m from documents`).safeIntegers(true);
    this.docLogRows = this.prepare(`select ts, table_id, id, deleted, prev_ts from documents
        where ts > ?1 and ts <= (select max(ts) from (select distinct ts from documents
                                 where ts > ?1 and ts <= ?2 order by ts limit ?3))
        order by ts, table_id, id`).safeIntegers(true);
    this.global = this.prepare(`select json_value from persistence_globals where key = ?`);
  }

  private prepare(sql: string): Statement {
    const st = this.db.prepare(sql);
    this.statements.push(st);
    return st;
  }

  scan(index: IndexId, lo: Uint8Array, hi: Uint8Array, ts: bigint, limit: number, desc: boolean): IndexedDoc[] {
    const q = desc ? this.scanDesc : this.scanAsc;
    const indexBytes = cachedBytes(index);
    const entries = scanLatestSync<JoinedEntry>(
      (p) =>
        (q.all(indexBytes, p.lo, p.hi, ts, p.n) as any[]).map((r) => ({
          key: r.key as Uint8Array,
          ts: r.ts as bigint,
          deleted: !!r.deleted,
          id:
            // Stryker disable next-line ConditionalExpression: a row with no document id is a tombstone, already skipped as deleted.
            r.document_id === null
              ? null
              : { id: r.document_id as Uint8Array, json: r.json_value as string | null, docDeleted: r.doc_deleted },
        })),
      lo,
      hi,
      limit,
      desc,
    );
    // Convex's errors: no document at the entry's ts ("Dangling index reference"), or a deleted one.
    return entries.map((e): IndexedDoc => {
      const id = idString(e.id.id);
      // Stryker disable next-line ConditionalExpression: null !== 0n holds too; the first test only says why.
      if (e.id.docDeleted === null || e.id.docDeleted !== 0n)
        throw new DanglingReferenceError(index, id, e.ts, e.id.docDeleted !== null);
      return { id, ts: e.ts, json: e.id.json! };
    });
  }

  get(table: TabletId, id: InternalId, ts: bigint): DocVersion {
    const r = this.getDoc.get(cachedBytes(table), internalIdBytes(id), ts) as any;
    return r && !r.deleted ? { json: r.json_value as string, ts: r.ts as bigint } : null;
  }

  getVersions(table: TabletId, ids: string[], ts: bigint): DocVersion[] {
    // Embedded: one indexed lookup per id is the fastest form (no round trips to save).
    const tableBytes = cachedBytes(table);
    return ids.map((id) => {
      const r = this.getDoc.get(tableBytes, internalIdBytes(id), ts) as any;
      return r && !r.deleted ? { json: r.json_value as string, ts: r.ts as bigint } : null;
    });
  }

  // A flush is one SQLite transaction, so the newest ts in `documents` IS the last durable commit (PERSIST-01
  // C4/C5), as Convex's `max_ts` reads it. Index entries are never above it: a commit writes its documents, and
  // a backfill writes entries at their documents' own ts (C17).
  maxTs(): bigint {
    return (this.maxDocTs.get() as { m: bigint | null }).m ?? 0n;
  }

  /** PERSIST-01 C12. A connection never sees a group before the writer commits it: every row it reads is durable. */
  readDocumentLog(afterTs: bigint, upToTs: bigint, limit: number): DocLogRow[] {
    // Stryker disable next-line EqualityOperator: a limit of 0 reads no row either way.
    if (limit <= 0) return [];
    return (
      this.docLogRows.all(afterTs, upToTs, limit) as {
        ts: bigint;
        table_id: Uint8Array;
        id: Uint8Array;
        deleted: bigint;
        prev_ts: bigint | null;
      }[]
    ).map((r) => ({
      ts: r.ts,
      table: idString(r.table_id),
      id: idString(r.id),
      deleted: !!r.deleted,
      prevTs: r.prev_ts,
    }));
  }

  /** PERSIST-01 C14. */
  getGlobal(key: string): unknown {
    const r = this.global.get(key) as { json_value: string } | null;
    return r ? decodeGlobal(r.json_value) : null;
  }

  /** Finalizes the statements: the connection can then close now (`SqlitePersistence.close`). */
  close() {
    for (const st of this.statements.splice(0)) st.finalize();
  }
}
