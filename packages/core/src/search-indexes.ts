// The engine's search indexes (STUDY-45 PR 2): one index per search index of an active table — segments plus a
// memory part (`SegmentedTextIndex`, STUDY-111) — built by a backfill (the index answers `IndexBackfillingError`
// meanwhile) and kept up to date by every commit as it becomes visible. A transaction searches the index as it was at its snapshot — the commits
// after it undone from a short log — with its own pending writes on top, as Convex's memory index and
// transaction overlay do.
import { type IndexedDoc, SegmentedTextIndex, type TextHit, type TextQuery, tokenize } from "@bunvex/search";
import { keyBytesLength, type Value } from "@bunvex/values";
import { OutOfRetentionError, type SearchDoc } from "./committer.ts";
import { encodeKey, prefixEnd } from "./keyenc.ts";
import { type Doc, fieldValue, type SearchIndexDef, type TableDef } from "./schema.ts";

/** How long the log of recent changes is kept: transactions older than this cannot search (5 minutes). */
export const SEARCH_LOG_RETENTION_US = 5 * 60 * 1_000_000;

/** An `eq` value as the index compares it: its sort key (so int64 ≠ float64; a missing field is `undefined`). */
export const filterKey = (v: unknown): string => Buffer.from(encodeKey([v as never])).toString("hex");

/**
 * The read-set keys of a search (STUDY-45 PR 3): a query's terms and filters as intervals of a synthetic
 * index (one per search index), and a write's tokens and filters as keys of it, so the query cache and
 * subscriptions invalidate on Convex's subscription rule — a written version with ANY of the terms or ANY of
 * the filters (`QueryReads::overlaps_search_index_key_value`).
 */
const encoder = new TextEncoder();
const termKey = (t: string) => Uint8Array.of(1, ...encoder.encode(t));
const filterReadKey = (field: string, key: string) =>
  Uint8Array.of(2, ...encoder.encode(field), 0, ...encoder.encode(key));
/** The interval holding exactly `k` (no key lies between `k` and `k ⧺ 0x00`). */
const point = (k: Uint8Array) => ({ lo: k, hi: Uint8Array.of(...k, 0) });

export function searchReadIntervals(
  index: number,
  terms: { term: string; prefix: boolean }[],
  filters: [string, string][],
) {
  const out: { index: number; lo: Uint8Array; hi: Uint8Array }[] = [];
  for (const t of terms) {
    const k = termKey(t.term);
    out.push(t.prefix ? { index, lo: k, hi: prefixEnd(k) } : { index, ...point(k) });
  }
  for (const [field, key] of filters) out.push({ index, ...point(filterReadKey(field, key)) });
  return out;
}

export type SearchIndexEntry = {
  /** The synthetic index id of its read-set keys (negative: never a real index). */
  readIndex: number;
  table: string;
  tablet: number;
  name: string;
  def: SearchIndexDef;
  staged: boolean;
  ready: boolean;
  /**
   * Being rebuilt after the process started (STUDY-79): it existed before, so a search meanwhile is Convex's
   * `SearchIndexesUnavailable`, not a new index's `IndexBackfillingError`.
   */
  bootstrapping: boolean;
  /** The index: its segments and memory part (STUDY-111). */
  index: SegmentedTextIndex;
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
  let bytes = typeof text === "string" ? Buffer.byteLength(text) : 0;
  for (const f of def.filterFields) {
    filters[f] = filterKey(fieldValue(doc, f));
    bytes += filterValueBytes(filters[f]);
  }
  return {
    tokens: typeof text === "string" ? tokenize(text) : [],
    filters,
    creationTime: doc._creationTime as number,
    bytes,
  };
}

/** `indexedDoc(def, doc).bytes` without tokenizing or encoding (a write's text index bytes, STUDY-71). */
export function indexedDocBytes(def: SearchIndexDef, doc: Doc): number {
  const text = fieldValue(doc, def.searchField);
  let bytes = typeof text === "string" ? Buffer.byteLength(text) : 0;
  for (const f of def.filterFields) bytes += Math.min(keyBytesLength([fieldValue(doc, f) as Value | undefined]), 32);
  return bytes;
}

/** A filter value's stored bytes, as Convex's `FilterValue`: its sort key, or a 32-byte hash from 32 bytes on. */
export const filterValueBytes = (key: string) => Math.min(key.length / 2, 32);

const NONE: readonly SearchIndexEntry[] = [];

export class SearchIndexes {
  private entries = new Map<string, SearchIndexEntry>();

  /** Every index (a snapshot of them, STUDY-96). */
  all(): SearchIndexEntry[] {
    return [...this.entries.values()];
  }
  /** One synthetic id per (tablet, index), kept across rebuilds, so read-sets taken before still match. */
  private readIds = new Map<string, number>();

  private static key = (tablet: number, name: string) => `${tablet}\u0000${name}`;

  get(t: TableDef, name: string): SearchIndexEntry | undefined {
    return this.entries.get(SearchIndexes.key(t.id, name));
  }

  /**
   * The indexes of one table. Every write asks (the usage meter, the commit's index maintenance), so they are
   * grouped when the set changes, not filtered on each call; a table without any shares one empty list.
   */
  forTablet(tablet: number): readonly SearchIndexEntry[] {
    return this.byTablet.get(tablet) ?? NONE;
  }
  private byTablet = new Map<number, SearchIndexEntry[]>();

  /**
   * Make the set of indexes the declared ones of the active tables; returns the new ones, to backfill.
   * An index keeps its contents while its table, field and filters stay the same.
   */
  reconcile(
    wanted: { table: TableDef; name: string; def: SearchIndexDef; staged: boolean }[],
    visibleTs: number,
    /** The first reconcile after the process started: every index is rebuilt, not new (STUDY-79). */
    bootstrapping = false,
  ) {
    const next = new Map<string, SearchIndexEntry>();
    const added: SearchIndexEntry[] = [];
    for (const w of wanted) {
      const k = SearchIndexes.key(w.table.id, w.name);
      const old = this.entries.get(k);
      if (old && JSON.stringify(old.def) === JSON.stringify(w.def) && old.staged === w.staged) {
        next.set(k, old);
        continue;
      }
      let readIndex = this.readIds.get(k);
      if (readIndex === undefined) {
        readIndex = -(this.readIds.size + 1);
        this.readIds.set(k, readIndex);
      }
      const e: SearchIndexEntry = {
        readIndex,
        table: w.table.name,
        tablet: w.table.id,
        name: w.name,
        def: w.def,
        staged: w.staged,
        ready: false,
        bootstrapping,
        index: new SegmentedTextIndex(w.def.filterFields),
        log: [],
        retainedFrom: visibleTs,
        touched: new Set(),
      };
      next.set(k, e);
      if (!w.staged) added.push(e);
    }
    this.entries = next;
    this.byTablet = new Map();
    for (const e of next.values()) {
      const list = this.byTablet.get(e.tablet);
      if (list) list.push(e);
      else this.byTablet.set(e.tablet, [e]);
    }
    return added;
  }

  /**
   * A commit, as it becomes visible: each written document of an indexed table, in its new state (`indexed`:
   * the new states `commitWrites` already computed, by index).
   */
  apply(
    ts: number,
    writes: Iterable<{ table: TableDef; id: string; next: Doc | null }>,
    indexed?: Map<SearchIndexEntry, Map<string, IndexedDoc>>,
  ) {
    for (const w of writes)
      for (const e of this.forTablet(w.table.id)) {
        if (e.staged) continue;
        e.log.push({ ts, id: w.id, before: e.index.get(w.id) });
        e.index.set(w.id, w.next ? (indexed?.get(e)?.get(w.id) ?? indexedDoc(e.def, w.next)) : null);
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

  /**
   * What a commit's writes mean to the search read-sets: each written version (old and new) of a document of
   * an indexed table, as OCC compares it (`docs`), and its keys for the query cache and subscriptions (`keys`).
   */
  commitWrites(writes: Iterable<{ table: TableDef; id: string; old: Doc | null; next: Doc | null }>) {
    const docs: SearchDoc[] = [];
    const keys: { index: number; key: Uint8Array; id: string | null }[] = [];
    const indexed = new Map<SearchIndexEntry, Map<string, IndexedDoc>>();
    for (const w of writes)
      for (const e of this.forTablet(w.table.id)) {
        if (e.staged) continue;
        for (const version of [w.old, w.next]) {
          if (!version) continue;
          const d = indexedDoc(e.def, version);
          if (version === w.next) {
            let m = indexed.get(e);
            if (!m) {
              m = new Map();
              indexed.set(e, m);
            }
            m.set(w.id, d);
          }
          const tokens = new Set(d.tokens);
          docs.push({ index: e.readIndex, id: w.id, tokens, filters: d.filters });
          for (const t of tokens) keys.push({ index: e.readIndex, key: termKey(t), id: w.id });
          for (const [field, key] of Object.entries(d.filters))
            keys.push({ index: e.readIndex, key: filterReadKey(field, key), id: w.id });
        }
      }
    return { docs, keys, indexed };
  }

  /** A backfilled document (unless a commit already set it). */
  /** A document's indexed state from a snapshot, or its removal (unless a commit already set it; STUDY-96). */
  restore(e: SearchIndexEntry, id: string, d: IndexedDoc | null) {
    if (!e.touched?.has(id)) e.index.set(id, d);
  }

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
