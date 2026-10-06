// The engine's vector indexes (STUDY-51): one index per vector index of an active table, exact (every vector
// compared — Convex's memory index is exact too; its disk segments are approximate HNSW), as the owner chose.
// Each is segments plus a memory part (`SegmentedVectorIndex`, STUDY-111). Built by a backfill at one snapshot,
// then kept up to date by every commit as it becomes visible. A search sees the latest visible state, as
// Convex's (`now_ts_for_reads`): vector search runs in actions, outside any transaction.
import { SegmentedVectorIndex, type VectorDoc } from "@bunvex/search";
import { type Doc, fieldValue, type TableDef, type VectorIndexDef } from "./schema.ts";
import { filterKey } from "./search-indexes.ts";

/** Convex's DEFAULT_VECTOR_LIMIT, MAX_VECTOR_RESULTS and MAX_FILTER_LENGTH. */
export const DEFAULT_VECTOR_LIMIT = 10;
export const MAX_VECTOR_RESULTS = 256;
export const MAX_VECTOR_FILTER_CONDITIONS = 64;

/** A document as an index holds it: its vector (f32, L2-normalized) and its filter values' sort keys. */
export type Entry = VectorDoc;

export type VectorIndexEntry = {
  table: string;
  tablet: number;
  name: string;
  def: VectorIndexDef;
  staged: boolean;
  ready: boolean;
  /** Being rebuilt after the process started (STUDY-79): a search meanwhile is `VectorIndexesUnavailable`. */
  bootstrapping: boolean;
  /** The index: its segments and memory part. */
  index: SegmentedVectorIndex;
  /** Documents a commit set while the backfill ran: the backfill's older copy must not replace them. */
  touched: Set<string> | null;
};

/**
 * Convex's (qdrant's) cosine preprocessing: the vector as f32, divided by its norm (computed in f32); left
 * as it is when its norm is below f32's epsilon.
 */
export function normalized(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sq = 0;
  for (const x of out) sq = Math.fround(sq + Math.fround(x * x));
  const norm = Math.fround(Math.sqrt(sq));
  if (norm < 1.1920929e-7) return out;
  for (let i = 0; i < out.length; i++) out[i] = Math.fround(out[i]! / norm);
  return out;
}

/**
 * A document's entry, or null when the index leaves it out — the field missing, or not an array of
 * `dimensions` float64s (an int64 element excludes it too) — as Convex's `QdrantSchema::index`: such a
 * document is written all the same.
 */
export function vectorEntry(def: VectorIndexDef, doc: Doc): Entry | null {
  if (!inVectorIndex(def, doc)) return null;
  const v = fieldValue(doc, def.vectorField) as number[];
  const filters: Record<string, string> = {};
  for (const f of def.filterFields) filters[f] = filterKey(fieldValue(doc, f));
  return { vector: normalized(v as number[]), filters };
}

/** Whether `vectorEntry` keeps the document: its field an array of `dimensions` float64s. */
export function inVectorIndex(def: VectorIndexDef, doc: Doc): boolean {
  const v = fieldValue(doc, def.vectorField) as unknown;
  return Array.isArray(v) && v.length === def.dimensions && v.every((x) => typeof x === "number");
}

/** A filter: per field, the values (their sort keys) any of which matches; fields are ORed, as Convex's. */
export type VectorFilter = Map<string, Set<string>>;

const NONE: readonly VectorIndexEntry[] = [];

export class VectorIndexes {
  private entries = new Map<string, VectorIndexEntry>();

  /** Every index (a snapshot of them, STUDY-96). */
  all(): VectorIndexEntry[] {
    return [...this.entries.values()];
  }
  private static key = (tablet: number, name: string) => `${tablet}\u0000${name}`;

  get(t: TableDef, name: string): VectorIndexEntry | undefined {
    return this.entries.get(VectorIndexes.key(t.id, name));
  }

  /**
   * The indexes of one table. Every write asks (the usage meter, the commit's index maintenance), so they are
   * grouped when the set changes, not filtered on each call; a table without any shares one empty list.
   */
  forTablet(tablet: number): readonly VectorIndexEntry[] {
    return this.byTablet.get(tablet) ?? NONE;
  }
  private byTablet = new Map<number, VectorIndexEntry[]>();

  /** Make the set of indexes the declared ones of the active tables; returns the new ones, to backfill. */
  reconcile(
    wanted: { table: TableDef; name: string; def: VectorIndexDef; staged: boolean }[],
    /** The first reconcile after the process started: every index is rebuilt, not new (STUDY-79). */
    bootstrapping = false,
  ) {
    const next = new Map<string, VectorIndexEntry>();
    const added: VectorIndexEntry[] = [];
    for (const w of wanted) {
      const k = VectorIndexes.key(w.table.id, w.name);
      const old = this.entries.get(k);
      // The same definition keeps its index, staged or not: un-staging a built index enables it at once, as
      // Convex's `Backfilled { staged }` (STUDY-111 PR 8).
      if (old && JSON.stringify(old.def) === JSON.stringify(w.def)) {
        old.staged = w.staged;
        next.set(k, old);
        continue;
      }
      const e: VectorIndexEntry = {
        table: w.table.name,
        tablet: w.table.id,
        name: w.name,
        def: w.def,
        staged: w.staged,
        ready: false,
        bootstrapping,
        index: new SegmentedVectorIndex(w.def.dimensions, w.def.filterFields),
        touched: new Set(),
      };
      next.set(k, e);
      // A staged index is built too (Convex's `Backfilling { staged }`, then `Backfilled { staged }`).
      added.push(e);
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

  /** A commit, as it becomes visible: each written document of an indexed table, in its new state. */
  apply(ts: number, writes: Iterable<{ table: TableDef; id: string; next: Doc | null }>) {
    for (const w of writes)
      for (const e of this.forTablet(w.table.id)) {
        e.index.set(w.id, w.next ? vectorEntry(e.def, w.next) : null, ts);
        e.touched?.add(w.id);
      }
  }

  /** A document's entry from a snapshot, or its removal (unless a commit already set it; STUDY-96). */
  restore(e: VectorIndexEntry, id: string, entry: Entry | null) {
    if (e.touched?.has(id)) return;
    e.index.set(id, entry);
  }

  /** A document the backfill read at its snapshot (ignored if a later commit already set it). */
  backfill(e: VectorIndexEntry, doc: Doc) {
    const id = doc._id as string;
    if (e.touched?.has(id)) return;
    const entry = vectorEntry(e.def, doc);
    if (entry) e.index.set(id, entry);
  }

  done(e: VectorIndexEntry) {
    e.ready = true;
    e.touched = null;
  }

  /**
   * The `limit` documents most similar to `query` by cosine similarity (f32), best first; equal scores by
   * descending internal id, as Convex's ordering. Only documents matching `filter`, when there is one.
   */
  search(e: VectorIndexEntry, query: ArrayLike<number>, limit: number, filter: VectorFilter | null) {
    return e.index.search(normalized(query), limit, filter);
  }
}
