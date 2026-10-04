// The engine's vector indexes (STUDY-51): one in-memory index per vector index of an active table, exact
// (every vector compared — Convex's memory index is exact too; its disk segments are approximate HNSW), as
// the owner chose. Built by a backfill at one snapshot, then kept up to date by every commit as it becomes
// visible. A search sees the latest visible state, as Convex's (`now_ts_for_reads`): vector search runs in
// actions, outside any transaction.
import { decodeId } from "@bunvex/values";
import { type Doc, fieldValue, type TableDef, type VectorIndexDef } from "./schema.ts";
import { filterKey } from "./search-indexes.ts";

/** Convex's DEFAULT_VECTOR_LIMIT, MAX_VECTOR_RESULTS and MAX_FILTER_LENGTH. */
export const DEFAULT_VECTOR_LIMIT = 10;
export const MAX_VECTOR_RESULTS = 256;
export const MAX_VECTOR_FILTER_CONDITIONS = 64;

/** A document as an index holds it: its vector (f32, L2-normalized) and its filter values' sort keys. */
type Entry = { vector: Float32Array; filters: Record<string, string> };

export type VectorIndexEntry = {
  table: string;
  tablet: number;
  name: string;
  def: VectorIndexDef;
  staged: boolean;
  ready: boolean;
  docs: Map<string, Entry>;
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

/** Two document ids by their internal ids' bytes (Convex breaks score ties on them, descending). */
function compareInternal(a: string, b: string): number {
  const x = decodeId(a).internalId;
  const y = decodeId(b).internalId;
  return Buffer.compare(Buffer.from(x), Buffer.from(y));
}

export class VectorIndexes {
  private entries = new Map<string, VectorIndexEntry>();
  private static key = (tablet: number, name: string) => `${tablet}\u0000${name}`;

  get(t: TableDef, name: string): VectorIndexEntry | undefined {
    return this.entries.get(VectorIndexes.key(t.id, name));
  }

  forTablet(tablet: number): VectorIndexEntry[] {
    return [...this.entries.values()].filter((e) => e.tablet === tablet);
  }

  /** Make the set of indexes the declared ones of the active tables; returns the new ones, to backfill. */
  reconcile(wanted: { table: TableDef; name: string; def: VectorIndexDef; staged: boolean }[]) {
    const next = new Map<string, VectorIndexEntry>();
    const added: VectorIndexEntry[] = [];
    for (const w of wanted) {
      const k = VectorIndexes.key(w.table.id, w.name);
      const old = this.entries.get(k);
      if (old && JSON.stringify(old.def) === JSON.stringify(w.def) && old.staged === w.staged) {
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
        docs: new Map(),
        touched: new Set(),
      };
      next.set(k, e);
      if (!w.staged) added.push(e);
    }
    this.entries = next;
    return added;
  }

  /** A commit, as it becomes visible: each written document of an indexed table, in its new state. */
  apply(writes: Iterable<{ table: TableDef; id: string; next: Doc | null }>) {
    for (const w of writes)
      for (const e of this.forTablet(w.table.id)) {
        if (e.staged) continue;
        const entry = w.next ? vectorEntry(e.def, w.next) : null;
        if (entry) e.docs.set(w.id, entry);
        else e.docs.delete(w.id);
        e.touched?.add(w.id);
      }
  }

  /** A document the backfill read at its snapshot (ignored if a later commit already set it). */
  backfill(e: VectorIndexEntry, doc: Doc) {
    const id = doc._id as string;
    if (e.touched?.has(id)) return;
    const entry = vectorEntry(e.def, doc);
    if (entry) e.docs.set(id, entry);
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
    const q = normalized(query);
    const hits: { id: string; score: number }[] = [];
    for (const [id, d] of e.docs) {
      if (filter && ![...filter].some(([f, keys]) => keys.has(d.filters[f]!))) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot = Math.fround(dot + Math.fround(q[i]! * d.vector[i]!));
      hits.push({ id, score: dot });
    }
    // Descending by score (NaN above everything, as `total_cmp`), then by internal id, descending.
    const key = (s: number) => (Number.isNaN(s) ? Number.POSITIVE_INFINITY : s);
    hits.sort((a, b) => key(b.score) - key(a.score) || (a.score === b.score ? compareInternal(b.id, a.id) : 0));
    return hits.slice(0, limit);
  }
}
