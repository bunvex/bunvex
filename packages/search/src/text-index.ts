// One search index in memory (STUDY-45 S1): every document of the table — its search field's tokens, its
// filter fields' keys, its `_creationTime` — an inverted index over the tokens, and the corpus statistics BM25
// needs. A search runs against the index as it is plus an overlay (documents whose state differs for the
// caller: commits after its snapshot undone, its own pending writes applied), statistics included, as Convex's
// memory index and transaction overlay do.
import { decodeId } from "@bunvex/values";
import { Bm25Weight, fieldnormToId } from "./bm25.ts";

/** Convex's MAX_QUERY_TERMS, MAX_UNIQUE_QUERY_TERMS and MAX_CANDIDATE_REVISIONS (crates/search/src/constants.rs). */
export const MAX_QUERY_TERMS = 16;
export const MAX_UNIQUE_QUERY_TERMS = 64;
export const MAX_CANDIDATE_REVISIONS = 1024;

/** A document as the index sees it: its search tokens (duplicates kept), filter keys by field, creation time. */
/**
 * A document as an index holds it. `bytes`: its metered size (Convex's `estimate_size`: the search field's
 * UTF-8 bytes plus each filter value's stored bytes), which a search is charged for (STUDY-71, DV-317).
 */
export type IndexedDoc = { tokens: string[]; filters: Record<string, string>; creationTime: number; bytes?: number };

/**
 * A search: the query's tokens (at most MAX_QUERY_TERMS are used), whether the last one also matches as a
 * prefix, and the `eq` filters as (field, key) pairs.
 */
export type TextQuery = { tokens: string[]; prefixLast: boolean; filters: [string, string][] };

export type TextHit = { id: string; score: number; creationTime: number };

/** A query term chosen for the search (Convex's step 1: exact matches first, then prefix expansions). */
export type QueryTerm = { term: string; prefix: boolean; ord: number };

/** A document as an index keeps it: its terms' frequencies rather than its tokens. */
export type Stored = {
  tf: Map<string, number>;
  length: number;
  filters: Record<string, string>;
  creationTime: number;
  bytes: number;
};

export const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function store(d: IndexedDoc): Stored {
  const tf = new Map<string, number>();
  for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, length: d.tokens.length, filters: d.filters, creationTime: d.creationTime, bytes: d.bytes ?? 0 };
}

export class TextIndex {
  private docs = new Map<string, Stored>();
  private postings = new Map<string, Set<string>>();
  private totalTokens = 0;
  /** The indexed documents' metered bytes (`IndexedDoc.bytes`), what each search is charged (DV-317). */
  indexedBytes = 0;
  private sorted: string[] | null = null;

  get size(): number {
    return this.docs.size;
  }

  /** Put a document's current state (null: deleted). */
  set(id: string, doc: IndexedDoc | null) {
    const old = this.docs.get(id);
    if (old) {
      this.totalTokens -= old.length;
      this.indexedBytes -= old.bytes;
      for (const t of old.tf.keys()) {
        const p = this.postings.get(t)!;
        p.delete(id);
        if (!p.size) {
          this.postings.delete(t);
          this.sorted = null;
        }
      }
      this.docs.delete(id);
    }
    if (!doc) return;
    const s = store(doc);
    this.docs.set(id, s);
    this.totalTokens += s.length;
    this.indexedBytes += s.bytes;
    for (const t of s.tf.keys()) {
      let p = this.postings.get(t);
      if (!p) {
        p = new Set();
        this.postings.set(t, p);
        this.sorted = null;
      }
      p.add(id);
    }
  }

  /** A document as stored (the segmented index's merged search reads it). */
  stored(id: string): Stored | undefined {
    return this.docs.get(id);
  }

  /** The documents having `term`. */
  docsWith(term: string): ReadonlySet<string> | undefined {
    return this.postings.get(term);
  }

  /** The search field's tokens over every document. */
  get tokenCount(): number {
    return this.totalTokens;
  }

  /** Every indexed document's id (a snapshot of the index, STUDY-96). */
  ids(): IterableIterator<string> {
    return this.docs.keys();
  }

  /** The indexed state of a document, for an overlay's undo. */
  get(id: string): IndexedDoc | null {
    const s = this.docs.get(id);
    if (!s) return null;
    const tokens: string[] = [];
    for (const [t, n] of s.tf) for (let i = 0; i < n; i++) tokens.push(t);
    return { tokens, filters: s.filters, creationTime: s.creationTime, bytes: s.bytes };
  }

  /** Terms starting with `prefix`, in byte order. */
  termsWithPrefix(prefix: string): string[] {
    this.sorted ??= [...this.postings.keys()].sort(byteOrder);
    const out: string[] = [];
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byteOrder(this.sorted[mid]!, prefix) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.sorted.length && this.sorted[i]!.startsWith(prefix); i++) out.push(this.sorted[i]!);
    return out;
  }

  /**
   * The ranked hits of `q` (Convex's `TantivySearchIndexSchema::search`): documents with every filter and at
   * least one query term, scored by BM25 over the matched terms (a prefix expansion weighs half), ordered by
   * score, then `_creationTime`, then id, all descending; at most MAX_CANDIDATE_REVISIONS.
   */
  search(q: TextQuery, overlay: ReadonlyMap<string, IndexedDoc | null> = new Map()): TextHit[] {
    const tokens = q.tokens.slice(0, MAX_QUERY_TERMS);
    if (!tokens.length) return [];
    const over = new Map<string, Stored | null>();
    for (const [id, d] of overlay) over.set(id, d ? store(d) : null);
    const exists = (term: string) =>
      [...(this.postings.get(term) ?? [])].some((id) => !over.has(id)) ||
      [...over.values()].some((s) => s?.tf.has(term));

    // Step 1: the terms. Each token matches itself; the last one, with prefix matching, also every term it
    // starts. Ranked (exact first, then by bytes, then token order), at most MAX_UNIQUE_QUERY_TERMS in all
    // (the filters count as terms too).
    const candidates: QueryTerm[] = [];
    tokens.forEach((t, ord) => {
      if (exists(t)) candidates.push({ term: t, prefix: false, ord });
      if (q.prefixLast && ord === tokens.length - 1) {
        const expansions = new Set(this.termsWithPrefix(t));
        for (const s of over.values())
          if (s) for (const term of s.tf.keys()) if (term.startsWith(t)) expansions.add(term);
        for (const term of expansions) if (term !== t && exists(term)) candidates.push({ term, prefix: true, ord });
      }
    });
    candidates.sort((a, b) => Number(a.prefix) - Number(b.prefix) || byteOrder(a.term, b.term) || a.ord - b.ord);
    const terms = new Map<string, QueryTerm>();
    for (const c of candidates) {
      if (terms.size >= MAX_UNIQUE_QUERY_TERMS - q.filters.length) break;
      if (!terms.has(c.term)) terms.set(c.term, c);
    }
    if (!terms.size) return [];

    // Step 3: the corpus statistics, with the overlay's documents in place of the index's.
    let numDocs = this.docs.size;
    let totalTokens = this.totalTokens;
    const df = new Map<string, number>();
    for (const t of terms.keys()) df.set(t, this.postings.get(t)?.size ?? 0);
    for (const [id, s] of over) {
      const base = this.docs.get(id);
      if (base) {
        numDocs--;
        totalTokens -= base.length;
        for (const t of terms.keys()) if (base.tf.has(t)) df.set(t, df.get(t)! - 1);
      }
      if (s) {
        numDocs++;
        totalTokens += s.length;
        for (const t of terms.keys()) if (s.tf.has(t)) df.set(t, df.get(t)! + 1);
      }
    }
    // tantivy guards the division with at least one document.
    const docCount = Math.max(numDocs, 1);
    const average = Math.fround(Math.fround(totalTokens) / Math.fround(docCount));
    // Summed in byte order of the terms (tantivy sums in its term order; only exact near-ties can differ).
    const weights = [...terms.values()]
      .sort((a, b) => byteOrder(a.term, b.term))
      .map((t) => ({ term: t.term, weight: new Bm25Weight(df.get(t.term)!, docCount, average, t.prefix ? 0.5 : 1) }));

    // Steps 5–6: every document with a query term and all the filters, scored.
    const hits: TextHit[] = [];
    const score = (id: string, s: Stored) => {
      for (const [field, key] of q.filters) if (s.filters[field] !== key) return;
      let total = 0;
      let any = false;
      const fieldnormId = fieldnormToId(s.length);
      for (const { term, weight } of weights) {
        const n = s.tf.get(term);
        if (!n) continue;
        any = true;
        total = Math.fround(total + weight.score(fieldnormId, n));
      }
      if (any) hits.push({ id, score: total, creationTime: s.creationTime });
    };
    const seen = new Set<string>();
    for (const t of terms.keys())
      for (const id of this.postings.get(t) ?? []) {
        if (seen.has(id) || over.has(id)) continue;
        seen.add(id);
        score(id, this.docs.get(id)!);
      }
    for (const [id, s] of over) if (s) score(id, s);
    hits.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime || compareIdsDesc(a.id, b.id));
    return hits.slice(0, MAX_CANDIDATE_REVISIONS);
  }
}

/** Descending by the ids' internal bytes (Convex's tie-break after `_creationTime`). */
export function compareIdsDesc(a: string, b: string): number {
  return Buffer.compare(Buffer.from(decodeId(b).internalId), Buffer.from(decodeId(a).internalId));
}
