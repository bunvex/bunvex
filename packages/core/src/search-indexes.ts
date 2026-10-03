// The engine's search indexes (STUDY-45 PR 2): one in-memory `TextIndex` per search index of an active table
// (S1), built by a backfill (the index answers `IndexBackfillingError` meanwhile) and kept up to date by every
// commit as it becomes visible. A transaction searches the index as it was at its snapshot — the commits
// after it undone from a short log — with its own pending writes on top, as Convex's memory index and
// transaction overlay do.
import { type IndexedDoc, type TextHit, TextIndex, type TextQuery, tokenize } from "@bunvex/search";
import { OutOfRetentionError } from "./committer.ts";
import { encodeKey } from "./keyenc.ts";
import { type Doc, fieldValue, type SearchIndexDef, type TableDef } from "./schema.ts";

/** How long the log of recent changes is kept: transactions older than this cannot search (5 minutes). */
export const SEARCH_LOG_RETENTION_US = 5 * 60 * 1_000_000;

/** An `eq` value as the index compares it: its sort key (so int64 ≠ float64; a missing field is `undefined`). */
export const filterKey = (v: unknown): string => Buffer.from(encodeKey([v as never])).toString("hex");

export type SearchIndexEntry = {
  table: string;
  tablet: number;
  name: string;
  def: SearchIndexDef;
  staged: boolean;
  ready: boolean;
  index: TextIndex;
  /** Changes applied after the backfill began, oldest first: what each document was before. */
  log: { ts: number; id: string; before: IndexedDoc | null }[];
  /** Commits at or before this ts can no longer be undone from `log`. */
  retainedFrom: number;
  /** Documents a commit set while the backfill ran: the backfill's older copy must not replace them. */
  touched: Set<string> | null;
};

/** A document as `def` indexes it (Convex's `index_into_terms`): a non-string search field has no tokens. */
export function indexedDoc(def: SearchIndexDef, doc: Doc): IndexedDoc {
  const text = fieldValue(doc, def.searchField);
  const filters: Record<string, string> = {};
  for (const f of def.filterFields) filters[f] = filterKey(fieldValue(doc, f));
  return {
    tokens: typeof text === "string" ? tokenize(text) : [],
    filters,
    creationTime: doc._creationTime as number,
  };
}

export class SearchIndexes {
  private entries = new Map<string, SearchIndexEntry>();

  private static key = (tablet: number, name: string) => `${tablet}\u0000${name}`;

  get(t: TableDef, name: string): SearchIndexEntry | undefined {
    return this.entries.get(SearchIndexes.key(t.id, name));
  }

  forTablet(tablet: number): SearchIndexEntry[] {
    return [...this.entries.values()].filter((e) => e.tablet === tablet);
  }

  /**
   * Make the set of indexes the declared ones of the active tables; returns the new ones, to backfill.
   * An index keeps its contents while its table, field and filters stay the same.
   */
  reconcile(wanted: { table: TableDef; name: string; def: SearchIndexDef; staged: boolean }[], visibleTs: number) {
    const next = new Map<string, SearchIndexEntry>();
    const added: SearchIndexEntry[] = [];
    for (const w of wanted) {
      const k = SearchIndexes.key(w.table.id, w.name);
      const old = this.entries.get(k);
      if (old && JSON.stringify(old.def) === JSON.stringify(w.def) && old.staged === w.staged) {
        next.set(k, old);
        continue;
      }
      const e: SearchIndexEntry = {
        table: w.table.name,
        tablet: w.table.id,
        name: w.name,
        def: w.def,
        staged: w.staged,
        ready: false,
        index: new TextIndex(),
        log: [],
        retainedFrom: visibleTs,
        touched: new Set(),
      };
      next.set(k, e);
      if (!w.staged) added.push(e);
    }
    this.entries = next;
    return added;
  }

  /** A commit, as it becomes visible: each written document of an indexed table, in its new state. */
  apply(ts: number, writes: Iterable<{ table: TableDef; id: string; next: Doc | null }>) {
    for (const w of writes)
      for (const e of this.forTablet(w.table.id)) {
        if (e.staged) continue;
        e.log.push({ ts, id: w.id, before: e.index.get(w.id) });
        e.index.set(w.id, w.next ? indexedDoc(e.def, w.next) : null);
        e.touched?.add(w.id);
      }
    // Keep the log to the retention window.
    for (const e of this.entries.values()) {
      let drop = 0;
      while (drop < e.log.length && e.log[drop]!.ts < ts - SEARCH_LOG_RETENTION_US) drop++;
      if (drop) {
        e.retainedFrom = e.log[drop - 1]!.ts;
        e.log.splice(0, drop);
      }
    }
  }

  /** A backfilled document (unless a commit already set it). */
  backfill(e: SearchIndexEntry, doc: Doc) {
    const id = doc._id as string;
    if (!e.touched?.has(id)) e.index.set(id, indexedDoc(e.def, doc));
  }

  done(e: SearchIndexEntry) {
    e.ready = true;
    e.touched = null;
  }

  /**
   * Search `e` as of `snapshot`, with a transaction's pending writes (`null`: deleted) on top. The changes
   * committed after the snapshot are undone first.
   */
  search(e: SearchIndexEntry, q: TextQuery, snapshot: number, pending: Map<string, Doc | null>): TextHit[] {
    if (snapshot < e.retainedFrom) throw new OutOfRetentionError(snapshot, e.retainedFrom);
    const overlay = new Map<string, IndexedDoc | null>();
    for (const c of e.log) if (c.ts > snapshot && !overlay.has(c.id)) overlay.set(c.id, c.before);
    for (const [id, d] of pending) overlay.set(id, d ? indexedDoc(e.def, d) : null);
    return e.index.search(q, overlay);
  }
}
