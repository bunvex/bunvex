// A table's documents as of a past snapshot, read after the index window has passed it (Convex's `TableIterator`,
// crates/table_iteration/src/table_iterator.rs, STUDY-205). A read at a snapshot fails once the index window
// (4 minutes) passes it, and an export of a large deployment takes longer than that. As Convex's, the iterator:
//
//   1. reads each page of the table's `by_id` index at a recent ts, always inside the window, and keeps the
//      documents no commit since the snapshot touched: their version there is the snapshot's;
//   2. reads the document log from the snapshot to that ts, and notes each id of the table it finds;
//   3. reads each noted id's version at the snapshot from the document store, which keeps every version the
//      document window (14 days) still holds, and puts it in the page its key falls in (a document deleted or
//      inserted since is in the snapshot or not as it was then).
//
// Why it is complete: a document of the snapshot either changed since (2 finds it) or did not (1 finds it). The log
// is not filtered by table, so it is read once for all the tables registered, each keeping the ids past its walk.
// Convex notes each id's first `prev_ts` and reads that revision; bunvex's store reads an id's version at a ts
// (PERSIST-01 C16), so the snapshot itself is enough.

import { encodeId } from "@bunvex/values";
import type { Committer } from "./committer.ts";
import { internalIdBytes } from "./internal-id.ts";
import { compareKeys, encodeKey, prefixEnd } from "./keyenc.ts";
import { hasRetention, type InternalId, type Persistence, type TabletId } from "./persistence/index.ts";
import type { Retention } from "./retention.ts";
import type { Doc, TableDef } from "./schema.ts";
import { decodeDoc } from "./tx.ts";

const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
/** Commits read from the document log per round trip. */
const LOG_PAGE = 256;

/** What the iterator reads: an engine has all three. */
export type TableIteratorSource = {
  readonly persistence: Persistence;
  readonly committer: Pick<Committer, "visibleTs">;
  readonly retention: Pick<Retention, "check" | "checkDocuments"> | null;
};

/** The ids of one table noted in the log, not walked yet. */
type Changed = {
  /** Every id noted and not yet returned: the index walk leaves these out. */
  ids: Set<InternalId>;
  /** The same, sorted by key, then those noted since the last sort. */
  sorted: { id: InternalId; key: Uint8Array }[];
  fresh: { id: InternalId; key: Uint8Array }[];
  /** The walk's position: an id at or below it was returned already, and is not noted again. */
  cursor: Uint8Array | null;
  number: number;
};

/**
 * Reads tables as they were at `snapshot`, after the index retention window has passed it, for as long as the
 * document window holds it. Register every table to be read when creating it: the document log is read once for
 * all of them.
 */
export class TableIterator {
  private readonly changed = new Map<TabletId, Changed>();
  /** How far the document log has been read. */
  private logTs: bigint;
  /** A store without a document log keeps every version: its snapshot is read directly. */
  private readonly direct: boolean;

  constructor(
    private readonly src: TableIteratorSource,
    readonly snapshot: bigint,
    tables: Pick<TableDef, "id" | "number">[],
    private readonly pageSize = 1000,
  ) {
    this.logTs = snapshot;
    this.direct = !hasRetention(src.persistence) || src.retention === null;
    for (const t of tables)
      this.changed.set(t.id, { ids: new Set(), sorted: [], fresh: [], cursor: null, number: t.number });
  }

  /** Every document of `table` at the snapshot, in `by_id` order, a page at a time. */
  async *pages(table: Pick<TableDef, "id" | "byId">): AsyncGenerator<Doc[]> {
    const c = this.changed.get(table.id);
    if (!c) throw new Error(`table ${table.id} was not registered with this iterator`);
    const p = this.src.persistence;
    let lo: Uint8Array = FULL_LO;
    for (;;) {
      const ts = this.direct ? this.snapshot : this.src.committer.visibleTs;
      this.src.retention?.checkDocuments(this.snapshot);
      await this.readLog(ts);
      const rows = await p.scan(table.id, table.byId.id, lo, FULL_HI, ts, this.pageSize, false);
      this.src.retention?.check(ts);
      const last = rows.length === this.pageSize ? decodeDoc(rows[rows.length - 1]!.json) : null;
      // The last key this page covers; past the end of the table when it is the last page.
      const end = last ? encodeKey([last._id]) : null;
      const page: { key: Uint8Array; doc: Doc }[] = [];
      for (const r of rows) {
        if (c.ids.has(r.id)) continue;
        const doc = decodeDoc(r.json);
        page.push({ key: encodeKey([doc._id]), doc });
      }
      // The changed ids this page covers, at their version then.
      const due = this.takeDue(c, end);
      if (due.length) {
        const ids = due.map((d) => d.id);
        const versions = p.getVersions
          ? await p.getVersions(table.id, ids, this.snapshot)
          : await Promise.all(ids.map((id) => p.get(table.id, id, this.snapshot)));
        this.src.retention?.checkDocuments(this.snapshot);
        for (let i = 0; i < due.length; i++) {
          const v = versions[i];
          if (v) page.push({ key: due[i]!.key, doc: decodeDoc(v.json) });
        }
        page.sort((a, b) => compareKeys(a.key, b.key));
      }
      if (page.length) yield page.map((e) => e.doc);
      if (!end) break;
      c.cursor = end;
      lo = prefixEnd(end);
    }
    this.changed.delete(table.id);
  }

  /** Stop noting the changes of a table that will not be read. */
  unregister(table: TabletId) {
    this.changed.delete(table);
  }

  /** The noted ids at or below `end` (all of them when null), taken out. */
  private takeDue(c: Changed, end: Uint8Array | null) {
    if (c.fresh.length) {
      c.sorted.push(...c.fresh);
      c.fresh = [];
      c.sorted.sort((a, b) => compareKeys(a.key, b.key));
    }
    let n = 0;
    while (n < c.sorted.length && (end === null || compareKeys(c.sorted[n]!.key, end) <= 0)) n++;
    const due = c.sorted.splice(0, n);
    for (const d of due) c.ids.delete(d.id);
    return due;
  }

  /** Note each id of a registered table the log has in `(logTs, upTo]`. */
  private async readLog(upTo: bigint) {
    if (this.direct || !hasRetention(this.src.persistence)) return;
    const store = this.src.persistence;
    while (this.logTs < upTo) {
      const rows = await store.readDocumentLog(this.logTs, upTo, LOG_PAGE);
      if (!rows.length) break;
      for (const r of rows) {
        const c = this.changed.get(r.table);
        if (!c || c.ids.has(r.id)) continue;
        const key = encodeKey([encodeId(c.number, internalIdBytes(r.id))]);
        if (c.cursor && compareKeys(key, c.cursor) <= 0) continue;
        c.ids.add(r.id);
        c.fresh.push({ id: r.id, key });
      }
      this.logTs = rows[rows.length - 1]!.ts;
    }
    this.logTs = upTo;
  }
}
