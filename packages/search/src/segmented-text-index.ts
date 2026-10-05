// A text search index as segments plus a memory part (STUDY-111), as Convex's: `TextSegment`s with their deletes,
// and the documents changed since they were written in a `TextIndex` (the bookkeeping is `SegmentedIndex`'s). A
// search merges the parts with the statistics of the whole index — documents, tokens and each term's document
// frequency summed over the live documents of every part, as Convex's `Bm25StatisticsDiff` — so it answers
// exactly what one index holding every document would (`TextIndex.search`), the overlay included.
import { Bm25Weight, fieldnormToId } from "./bm25.ts";
import { type PreparedCompaction, type PreparedFlush, SegmentedIndex, type SegmentPart } from "./segmented-index.ts";
import {
  byteOrder,
  compareIdsDesc,
  type IndexedDoc,
  MAX_CANDIDATE_REVISIONS,
  MAX_QUERY_TERMS,
  MAX_UNIQUE_QUERY_TERMS,
  type QueryTerm,
  type Stored,
  store,
  type TextHit,
  TextIndex,
  type TextQuery,
} from "./text-index.ts";
import { type CountedDoc, TextSegment, TextSegmentDeletes } from "./text-segment.ts";

export type TextSegmentPart = SegmentPart<TextSegment, TextSegmentDeletes>;
export type PreparedTextFlush = PreparedFlush<TextSegment, TextSegmentDeletes>;
export type PreparedTextCompaction = PreparedCompaction<TextSegment, TextSegmentDeletes>;

export class SegmentedTextIndex extends SegmentedIndex<TextSegment, TextSegmentDeletes, IndexedDoc> {
  /** The memory part: the documents changed since the segments were written, in their latest state. */
  readonly memory = new TextIndex();

  constructor(readonly filterFields: readonly string[]) {
    super();
  }

  protected open(bytes: Uint8Array) {
    return TextSegment.open(bytes);
  }
  protected noDeletes(segment: TextSegment) {
    return TextSegmentDeletes.none(segment);
  }
  protected decodeDeletes(segment: TextSegment, bytes: Uint8Array) {
    return TextSegmentDeletes.decode(segment, bytes);
  }
  protected build(docs: [string, IndexedDoc][]) {
    return TextSegment.build(docs, this.filterFields);
  }
  /** From the memory part's counted terms, not its documents' tokens. */
  protected override buildMemory() {
    const docs: [string, CountedDoc][] = [];
    for (const id of this.memory.ids()) docs.push([id, this.memory.stored(id)!]);
    return docs.length ? TextSegment.buildCounted(docs, this.filterFields) : null;
  }
  /** From the segments' forward indexes. */
  protected override buildLive(parts: TextSegmentPart[]) {
    const docs: [string, CountedDoc][] = [];
    for (const p of parts)
      for (let d = 0; d < p.segment.numDocs; d++)
        if (!p.deletes.has(d)) docs.push([p.segment.id(d), p.segment.counted(d)]);
    return docs.length ? TextSegment.buildCounted(docs, this.filterFields) : null;
  }
  protected memorySet(id: string, doc: IndexedDoc | null) {
    this.memory.set(id, doc);
  }
  protected memoryGet(id: string) {
    return this.memory.get(id);
  }
  protected memoryIds() {
    return this.memory.ids();
  }
  protected get memorySize() {
    return this.memory.size;
  }
  /** A rough estimate of a changed document's memory: its terms, frequencies and filter keys. */
  protected estimate(d: IndexedDoc | null): number {
    if (!d) return 64;
    let n = 96;
    for (const t of d.tokens) n += 2 * t.length + 24;
    for (const k in d.filters) n += 2 * d.filters[k]!.length + 16;
    return n;
  }

  /** The live documents' metered bytes (what a search is charged, DV-317). */
  get indexedBytes(): number {
    let n = this.memory.indexedBytes;
    for (const p of this.segments) n += p.segment.indexedBytes - p.deletes.bytes;
    return n;
  }

  /** A live document as stored, for the overlay's statistics. */
  private stored(id: string): Stored | undefined {
    if (this.changed.has(id)) return this.memory.stored(id);
    const at = this.locate(id);
    return at ? store(at.part.segment.get(at.doc)) : undefined;
  }

  /**
   * The ranked hits of `q`, as `TextIndex.search` over one index holding every live document, with `overlay`
   * (documents whose state differs for the caller; null: deleted) on top.
   */
  search(q: TextQuery, overlay: ReadonlyMap<string, IndexedDoc | null> = new Map()): TextHit[] {
    const tokens = q.tokens.slice(0, MAX_QUERY_TERMS);
    if (!tokens.length) return [];
    const over = new Map<string, Stored | null>();
    const base = new Map<string, Stored>();
    for (const [id, d] of overlay) {
      over.set(id, d ? store(d) : null);
      const b = this.stored(id);
      if (b) base.set(id, b);
    }
    // A term's document frequency over the live documents (`indexed`: the index's, without the overlay), the
    // overlay in place of the index's copies.
    const indexedDf = (term: string) => {
      let n = this.memory.docsWith(term)?.size ?? 0;
      for (const p of this.segments) {
        const ord = p.segment.termOrd(term);
        if (ord >= 0) n += p.segment.df(ord) - p.deletes.df(ord);
      }
      return n;
    };
    const withOverlay = (term: string, n: number) => {
      for (const [id, s] of over) {
        if (base.get(id)?.tf.has(term)) n--;
        if (s?.tf.has(term)) n++;
      }
      return n;
    };
    const frequencies = new Map<string, number>();
    const exists = (term: string) => {
      let n = frequencies.get(term);
      if (n === undefined) {
        n = withOverlay(term, indexedDf(term));
        frequencies.set(term, n);
      }
      return n > 0;
    };

    // Step 1: the terms, as `TextIndex.search` chooses them.
    const candidates: QueryTerm[] = [];
    tokens.forEach((t, ord) => {
      if (exists(t)) candidates.push({ term: t, prefix: false, ord });
      if (q.prefixLast && ord === tokens.length - 1) {
        // Every term the prefix expands to, with its document frequency summed while the ranges are read.
        const expansions = new Map<string, number>();
        for (const term of this.memory.termsWithPrefix(t)) expansions.set(term, this.memory.docsWith(term)!.size);
        for (const p of this.segments) {
          const [from, to] = p.segment.termsWithPrefix(t);
          for (let o = from; o < to; o++) {
            const term = p.segment.term(o);
            expansions.set(term, (expansions.get(term) ?? 0) + p.segment.df(o) - p.deletes.df(o));
          }
        }
        for (const s of over.values())
          if (s)
            for (const term of s.tf.keys()) if (term.startsWith(t) && !expansions.has(term)) expansions.set(term, 0);
        for (const [term, n] of expansions) {
          if (term === t) continue;
          if (!frequencies.has(term)) frequencies.set(term, withOverlay(term, n));
          if (frequencies.get(term)! > 0) candidates.push({ term, prefix: true, ord });
        }
      }
    });
    candidates.sort((a, b) => Number(a.prefix) - Number(b.prefix) || byteOrder(a.term, b.term) || a.ord - b.ord);
    const terms = new Map<string, QueryTerm>();
    for (const c of candidates) {
      if (terms.size >= MAX_UNIQUE_QUERY_TERMS - q.filters.length) break;
      if (!terms.has(c.term)) terms.set(c.term, c);
    }
    if (!terms.size) return [];

    // Step 3: the statistics of the whole index.
    let numDocs = this.memory.size;
    let totalTokens = this.memory.tokenCount;
    for (const p of this.segments) {
      numDocs += p.deletes.live;
      totalTokens += p.segment.totalTokens - p.deletes.tokens;
    }
    for (const [id, s] of over) {
      const b = base.get(id);
      if (b) {
        numDocs--;
        totalTokens -= b.length;
      }
      if (s) {
        numDocs++;
        totalTokens += s.length;
      }
    }
    const docCount = Math.max(numDocs, 1);
    const average = Math.fround(Math.fround(totalTokens) / Math.fround(docCount));
    const weights = [...terms.values()]
      .sort((a, b) => byteOrder(a.term, b.term))
      .map((t) => ({
        term: t.term,
        weight: new Bm25Weight(frequencies.get(t.term)!, docCount, average, t.prefix ? 0.5 : 1),
      }));

    // Steps 5–6: every live document with a query term and all the filters, scored over the weights in order.
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
    for (const { term } of weights)
      for (const id of this.memory.docsWith(term) ?? []) {
        if (seen.has(id) || over.has(id)) continue;
        seen.add(id);
        score(id, this.memory.stored(id)!);
      }
    for (const p of this.segments) this.scoreSegment(p, q, weights, over, hits);
    for (const [id, s] of over) if (s) score(id, s);
    hits.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime || compareIdsDesc(a.id, b.id));
    return hits.slice(0, MAX_CANDIDATE_REVISIONS);
  }

  /** A segment's matching live documents, term at a time: each document's score summed in the weights' order. */
  private scoreSegment(
    p: TextSegmentPart,
    q: TextQuery,
    weights: { term: string; weight: Bm25Weight }[],
    over: ReadonlyMap<string, unknown>,
    hits: TextHit[],
  ) {
    const seg = p.segment;
    // The filters as this segment's key ordinals; a key no document here has matches nothing here.
    const filters: [number, number][] = [];
    for (const [field, key] of q.filters) {
      const f = seg.filterFields.indexOf(field);
      const ord = f < 0 ? -1 : seg.filterKeyOrd(f, key);
      if (ord < 0) return;
      filters.push([f, ord]);
    }
    const skip = new Set<number>();
    for (const id of over.keys()) {
      const d = seg.docOf(id);
      if (d >= 0) skip.add(d);
    }
    const scores = new Map<number, number>();
    const rejected = new Set<number>();
    for (const { term, weight } of weights) {
      const ord = seg.termOrd(term);
      if (ord < 0) continue;
      const { docs, tf } = seg.postings(ord);
      for (let k = 0; k < docs.length; k++) {
        const d = docs[k]!;
        if (p.deletes.has(d) || skip.has(d) || rejected.has(d)) continue;
        let total = scores.get(d);
        if (total === undefined) {
          if (filters.some(([f, o]) => seg.filterOrd(f, d) !== o)) {
            rejected.add(d);
            continue;
          }
          total = 0;
        }
        scores.set(d, Math.fround(total + weight.score(seg.fieldnormId(d), tf[k]!)));
      }
    }
    for (const [d, total] of scores) hits.push({ id: seg.id(d), score: total, creationTime: seg.creationTime(d) });
  }
}
