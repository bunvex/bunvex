// A text search segment (STUDY-111 §3.1): an immutable, persisted part of a search index, as Convex's
// `FragmentedTextSegment` is (a tantivy archive, its id tracker, alive bitset and deleted-terms table). bunvex's
// own layout, read in place: the documents sorted by id (an id's rank is its document number), the terms sorted
// by bytes with their posting lists, and a forward index of each document's terms, which gives deletes their
// statistics and `get` its document. A segment never changes; its deletes are a separate, rewritable part.
import { fieldnormToId } from "./bm25.ts";
import {
  Bitset,
  compareBytes,
  NO_FILTER_KEY as NO_KEY,
  SegmentFileError,
  SegmentKind,
  SegmentReader,
  SegmentWriter,
  type StringTable,
  utf8,
} from "./segment-file.ts";
import type { IndexedDoc } from "./text-index.ts";

type TextSegmentMeta = {
  uid: string;
  numDocs: number;
  numTerms: number;
  totalTokens: number;
  indexedBytes: number;
  filterFields: string[];
};

// Section numbers (see `build`).
const S = {
  meta: 0,
  ids: 1, // + offsets 2
  creationTime: 3,
  length: 4,
  fieldnorm: 5,
  bytes: 6,
  terms: 7, // + offsets 8
  postingStart: 9,
  postingDoc: 10,
  postingTf: 11,
  docStart: 12,
  docTerm: 13,
  docTf: 14,
  filters: 15, // per field: keys (+ offsets), then each document's key ordinal
} as const;

export class TextSegment {
  /** A random id, which the segment's deletes name (Convex's segment `id`). */
  readonly uid: string;
  readonly numDocs: number;
  readonly numTerms: number;
  /** The search field's tokens over every document (deleted ones included). */
  readonly totalTokens: number;
  /** The documents' metered bytes (`IndexedDoc.bytes`), deleted ones included. */
  readonly indexedBytes: number;
  readonly filterFields: readonly string[];
  /** The whole segment, as stored. */
  readonly bytes: Uint8Array;

  private readonly ids: StringTable;
  private readonly creationTimes: Float64Array;
  private readonly lengths: Uint32Array;
  private readonly fieldnorms: Uint8Array;
  private readonly docBytes: Uint32Array;
  private readonly terms: StringTable;
  private readonly postingStart: Uint32Array;
  private readonly postingDoc: Uint32Array;
  private readonly postingTf: Uint32Array;
  private readonly docStart: Uint32Array;
  private readonly docTerm: Uint32Array;
  private readonly docTf: Uint32Array;
  private readonly filterKeys: StringTable[] = [];
  private readonly filterOrds: Uint32Array[] = [];

  private constructor(r: SegmentReader) {
    const m = r.json<TextSegmentMeta>(S.meta);
    if (typeof m?.uid !== "string" || !Array.isArray(m.filterFields)) throw new SegmentFileError("bad metadata");
    this.bytes = r.bytes;
    this.uid = m.uid;
    this.numDocs = m.numDocs;
    this.numTerms = m.numTerms;
    this.totalTokens = m.totalTokens;
    this.indexedBytes = m.indexedBytes;
    this.filterFields = m.filterFields;
    const n = m.numDocs;
    const check = <T extends { length: number }>(a: T, len: number, what: string) => {
      if (a.length !== len) throw new SegmentFileError(`${what}: ${a.length} entries, expected ${len}`);
      return a;
    };
    this.ids = r.strings(S.ids, n);
    this.creationTimes = check(r.f64(S.creationTime), n, "creation times");
    this.lengths = check(r.u32(S.length), n, "lengths");
    this.fieldnorms = check(r.u8(S.fieldnorm), n, "fieldnorms");
    this.docBytes = check(r.u32(S.bytes), n, "bytes");
    this.terms = r.strings(S.terms, m.numTerms);
    this.postingStart = check(r.u32(S.postingStart), m.numTerms + 1, "posting starts");
    const postings = this.postingStart[m.numTerms]!;
    this.postingDoc = check(r.u32(S.postingDoc), postings, "posting documents");
    this.postingTf = check(r.u32(S.postingTf), postings, "posting frequencies");
    this.docStart = check(r.u32(S.docStart), n + 1, "document starts");
    this.docTerm = check(r.u32(S.docTerm), postings, "document terms");
    this.docTf = check(r.u32(S.docTf), postings, "document frequencies");
    m.filterFields.forEach((_, f) => {
      const at = S.filters + 3 * f;
      this.filterKeys.push(r.strings(at));
      this.filterOrds.push(check(r.u32(at + 2), n, "filter keys"));
    });
  }

  /** Opens a segment over `bytes` (read in place, not copied when aligned). */
  static open(bytes: Uint8Array): TextSegment {
    return new TextSegment(new SegmentReader(bytes, SegmentKind.Text));
  }

  /**
   * The segment of `docs` (ids unique), with `filterFields` the index's filter fields: the bytes to store, which
   * `open` reads back.
   */
  static build(docs: Iterable<readonly [string, IndexedDoc]>, filterFields: readonly string[]): Uint8Array {
    const entries = [...docs].map(([id, doc]) => ({ id, key: utf8(id), doc }));
    entries.sort((a, b) => compareBytes(a.key, b.key));
    const n = entries.length;

    // The terms, by bytes, and each document's frequencies.
    const tfs = entries.map(({ doc }) => {
      const tf = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    const termSet = new Set<string>();
    for (const tf of tfs) for (const t of tf.keys()) termSet.add(t);
    const terms = [...termSet].map((t) => ({ t, key: utf8(t) })).sort((a, b) => compareBytes(a.key, b.key));
    const ordOf = new Map(terms.map((x, i) => [x.t, i]));

    // Forward index: each document's terms by ordinal.
    const docStart = new Uint32Array(n + 1);
    let postings = 0;
    tfs.forEach((tf, d) => {
      docStart[d] = postings;
      postings += tf.size;
    });
    docStart[n] = postings;
    const docTerm = new Uint32Array(postings);
    const docTf = new Uint32Array(postings);
    const df = new Uint32Array(terms.length);
    tfs.forEach((tf, d) => {
      const own = [...tf].map(([t, c]) => [ordOf.get(t)!, c] as const).sort((a, b) => a[0] - b[0]);
      own.forEach(([ord, c], k) => {
        docTerm[docStart[d]! + k] = ord;
        docTf[docStart[d]! + k] = c;
        df[ord]!++;
      });
    });

    // Posting lists, documents ascending (filled in document order).
    const postingStart = new Uint32Array(terms.length + 1);
    for (let t = 0; t < terms.length; t++) postingStart[t + 1] = postingStart[t]! + df[t]!;
    const fill = postingStart.slice(0, terms.length);
    const postingDoc = new Uint32Array(postings);
    const postingTf = new Uint32Array(postings);
    for (let d = 0; d < n; d++)
      for (let k = docStart[d]!; k < docStart[d + 1]!; k++) {
        const at = fill[docTerm[k]!]!++;
        postingDoc[at] = d;
        postingTf[at] = docTf[k]!;
      }

    let totalTokens = 0;
    let indexedBytes = 0;
    const creationTime = new Float64Array(n);
    const length = new Uint32Array(n);
    const fieldnorm = new Uint8Array(n);
    const bytes = new Uint32Array(n);
    entries.forEach(({ doc }, d) => {
      creationTime[d] = doc.creationTime;
      length[d] = doc.tokens.length;
      fieldnorm[d] = fieldnormToId(doc.tokens.length);
      bytes[d] = doc.bytes ?? 0;
      totalTokens += doc.tokens.length;
      indexedBytes += doc.bytes ?? 0;
    });

    const w = new SegmentWriter(SegmentKind.Text);
    w.json({
      uid: crypto.randomUUID(),
      numDocs: n,
      numTerms: terms.length,
      totalTokens,
      indexedBytes,
      filterFields: [...filterFields],
    } satisfies TextSegmentMeta);
    w.strings(entries.map((e) => e.key));
    w.f64(creationTime);
    w.u32(length);
    w.bytes(fieldnorm);
    w.u32(bytes);
    w.strings(terms.map((t) => t.key));
    w.u32(postingStart);
    w.u32(postingDoc);
    w.u32(postingTf);
    w.u32(docStart);
    w.u32(docTerm);
    w.u32(docTf);
    for (const field of filterFields) {
      const keys = [...new Set(entries.map((e) => e.doc.filters[field]).filter((k) => k !== undefined))]
        .map((k) => ({ k, key: utf8(k) }))
        .sort((a, b) => compareBytes(a.key, b.key));
      const ord = new Map(keys.map((x, i) => [x.k, i]));
      w.strings(keys.map((x) => x.key));
      w.u32(Uint32Array.from(entries, (e) => ord.get(e.doc.filters[field]!) ?? NO_KEY));
    }
    return w.finish();
  }

  /** The document number of `id`, or -1. */
  docOf(id: string): number {
    return this.ids.find(utf8(id));
  }
  id(doc: number): string {
    return this.ids.at(doc);
  }
  creationTime(doc: number): number {
    return this.creationTimes[doc]!;
  }
  /** The document's token count. */
  length(doc: number): number {
    return this.lengths[doc]!;
  }
  /** tantivy's fieldnorm code of the document's length. */
  fieldnormId(doc: number): number {
    return this.fieldnorms[doc]!;
  }
  docBytesOf(doc: number): number {
    return this.docBytes[doc]!;
  }

  /** The ordinal of `term`, or -1. */
  termOrd(term: string): number {
    return this.terms.find(utf8(term));
  }
  term(ord: number): string {
    return this.terms.at(ord);
  }
  /** The ordinals `[from, to)` of the terms starting with `prefix`. */
  termsWithPrefix(prefix: string): [number, number] {
    return this.terms.prefixRange(utf8(prefix));
  }
  /** How many documents have the term (deleted ones included). */
  df(ord: number): number {
    return this.postingStart[ord + 1]! - this.postingStart[ord]!;
  }
  /** The term's documents, ascending, and their frequencies. */
  postings(ord: number): { docs: Uint32Array; tf: Uint32Array } {
    const from = this.postingStart[ord]!;
    const to = this.postingStart[ord + 1]!;
    return { docs: this.postingDoc.subarray(from, to), tf: this.postingTf.subarray(from, to) };
  }
  /** The document's terms (ordinals, ascending) and their frequencies. */
  docTerms(doc: number): { terms: Uint32Array; tf: Uint32Array } {
    const from = this.docStart[doc]!;
    const to = this.docStart[doc + 1]!;
    return { terms: this.docTerm.subarray(from, to), tf: this.docTf.subarray(from, to) };
  }

  /** The ordinal of filter key `key` of filter field number `field`, or -1 (no document has it). */
  filterKeyOrd(field: number, key: string): number {
    return this.filterKeys[field]!.find(utf8(key));
  }
  /** The document's key ordinal for filter field number `field` (`NO_KEY` when it has none). */
  filterOrd(field: number, doc: number): number {
    return this.filterOrds[field]![doc]!;
  }

  /** The document as it was indexed (its tokens in term order, as frequencies do not keep their order). */
  get(doc: number): IndexedDoc {
    const tokens: string[] = [];
    const { terms, tf } = this.docTerms(doc);
    for (let k = 0; k < terms.length; k++) {
      const t = this.term(terms[k]!);
      for (let c = 0; c < tf[k]!; c++) tokens.push(t);
    }
    const filters: Record<string, string> = {};
    this.filterFields.forEach((field, f) => {
      const ord = this.filterOrds[f]![doc]!;
      if (ord !== NO_KEY) filters[field] = this.filterKeys[f]!.at(ord);
    });
    return { tokens, filters, creationTime: this.creationTimes[doc]!, bytes: this.docBytes[doc]! };
  }
}

type TextDeletesMeta = { segment: string; count: number; tokens: number; bytes: number };

/**
 * The deleted documents of a text segment and what they took from its statistics: their count, tokens and
 * metered bytes, and per term how many of them had it (Convex's alive bitset and deleted-terms table). Mutable
 * in memory; stored as a blob of its own.
 */
export class TextSegmentDeletes {
  private constructor(
    readonly segment: TextSegment,
    private readonly bits: Bitset,
    /** Per term ordinal: deleted documents having it. */
    private readonly terms: Map<number, number>,
    public count: number,
    public tokens: number,
    public bytes: number,
  ) {}

  static none(segment: TextSegment): TextSegmentDeletes {
    return new TextSegmentDeletes(segment, Bitset.empty(segment.numDocs), new Map(), 0, 0, 0);
  }

  static decode(segment: TextSegment, data: Uint8Array): TextSegmentDeletes {
    const r = new SegmentReader(data, SegmentKind.TextDeletes);
    const m = r.json<TextDeletesMeta>(0);
    if (m?.segment !== segment.uid) throw new SegmentFileError("deletes of another segment");
    const bits = r.u8(1);
    if (bits.length !== (segment.numDocs + 7) >> 3) throw new SegmentFileError("deleted bitset size");
    const ords = r.u32(2);
    const counts = r.u32(3);
    if (ords.length !== counts.length) throw new SegmentFileError("deleted terms");
    const terms = new Map<number, number>();
    ords.forEach((ord, i) => {
      terms.set(ord, counts[i]!);
    });
    return new TextSegmentDeletes(segment, new Bitset(bits.slice()), terms, m.count, m.tokens, m.bytes);
  }

  encode(): Uint8Array {
    const w = new SegmentWriter(SegmentKind.TextDeletes);
    w.json({
      segment: this.segment.uid,
      count: this.count,
      tokens: this.tokens,
      bytes: this.bytes,
    } satisfies TextDeletesMeta);
    w.bytes(this.bits.bits);
    const ords = [...this.terms.keys()].sort((a, b) => a - b);
    w.u32(Uint32Array.from(ords));
    w.u32(Uint32Array.from(ords, (o) => this.terms.get(o)!));
    return w.finish();
  }

  clone(): TextSegmentDeletes {
    return new TextSegmentDeletes(
      this.segment,
      this.bits.clone(),
      new Map(this.terms),
      this.count,
      this.tokens,
      this.bytes,
    );
  }

  has(doc: number): boolean {
    return this.bits.has(doc);
  }

  /** Deletes a document; false if it already was. */
  delete(doc: number): boolean {
    if (!this.bits.add(doc)) return false;
    const s = this.segment;
    this.count++;
    this.tokens += s.length(doc);
    this.bytes += s.docBytesOf(doc);
    for (const ord of s.docTerms(doc).terms) this.terms.set(ord, (this.terms.get(ord) ?? 0) + 1);
    return true;
  }

  /** How many deleted documents have the term. */
  df(ord: number): number {
    return this.terms.get(ord) ?? 0;
  }

  /** The documents left. */
  get live(): number {
    return this.segment.numDocs - this.count;
  }
}
