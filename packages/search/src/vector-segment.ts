// A vector search segment (STUDY-111 §3.1): an immutable, persisted part of a vector index, as Convex's
// `FragmentedVectorSegment` is (a qdrant segment, its id tracker and deleted bitset). bunvex's vector search is
// exact (DV-269), so a segment is the documents sorted by id with their normalized f32 vectors back to back and
// their filter keys, read in place; its deletes are a separate, rewritable bitset.
import {
  Bitset,
  mergeTables,
  NO_FILTER_KEY as NO_KEY,
  SegmentFileError,
  SegmentKind,
  SegmentReader,
  SegmentWriter,
  type StringTable,
  sortUtf8,
  utf8,
} from "./segment-file.ts";

/** A document as a vector index holds it: its normalized vector and its filter values' sort keys. */
export type VectorDoc = { vector: Float32Array; filters: Record<string, string> };

type VectorSegmentMeta = { uid: string; numDocs: number; dimensions: number; filterFields: string[] };

export class VectorSegment {
  /** A random id, which the segment's deletes name. */
  readonly uid: string;
  readonly numDocs: number;
  readonly dimensions: number;
  readonly filterFields: readonly string[];
  /** The whole segment, as stored. */
  readonly bytes: Uint8Array;
  /** Every document's vector, back to back (document `d` at `d * dimensions`). */
  readonly vectors: Float32Array;
  private readonly ids: StringTable;
  private readonly filterKeys: StringTable[] = [];
  private readonly filterOrds: Uint32Array[] = [];

  private constructor(r: SegmentReader) {
    const m = r.json<VectorSegmentMeta>(0);
    if (typeof m?.uid !== "string" || !Array.isArray(m.filterFields)) throw new SegmentFileError("bad metadata");
    this.bytes = r.bytes;
    this.uid = m.uid;
    this.numDocs = m.numDocs;
    this.dimensions = m.dimensions;
    this.filterFields = m.filterFields;
    this.ids = r.strings(1, m.numDocs);
    this.vectors = r.f32(3);
    if (this.vectors.length !== m.numDocs * m.dimensions) throw new SegmentFileError("vectors");
    m.filterFields.forEach((_, f) => {
      this.filterKeys.push(r.strings(4 + 3 * f));
      const ords = r.u32(6 + 3 * f);
      if (ords.length !== m.numDocs) throw new SegmentFileError("filter keys");
      this.filterOrds.push(ords);
    });
  }

  static open(bytes: Uint8Array): VectorSegment {
    return new VectorSegment(new SegmentReader(bytes, SegmentKind.Vector));
  }

  /** The segment of `docs` (ids unique; vectors of `dimensions` already normalized): the bytes to store. */
  static build(
    docs: Iterable<readonly [string, VectorDoc]>,
    dimensions: number,
    filterFields: readonly string[],
  ): Uint8Array {
    const entries = [...docs].map(([id, doc]) => ({ id, key: utf8(id), doc }));
    sortUtf8(entries, (e) => e.id);
    const vectors = new Float32Array(entries.length * dimensions);
    entries.forEach(({ doc }, d) => {
      if (doc.vector.length !== dimensions) throw new Error(`a vector of ${doc.vector.length} dimensions`);
      vectors.set(doc.vector, d * dimensions);
    });
    const w = new SegmentWriter(SegmentKind.Vector);
    w.json({
      uid: crypto.randomUUID(),
      numDocs: entries.length,
      dimensions,
      filterFields: [...filterFields],
    } satisfies VectorSegmentMeta);
    w.strings(entries.map((e) => e.key));
    w.f32(vectors);
    for (const field of filterFields) {
      const present = [...new Set(entries.map((e) => e.doc.filters[field]).filter((k) => k !== undefined))];
      const keys = sortUtf8(present, (k) => k).map((k) => ({ k, key: utf8(k) }));
      const ord = new Map(keys.map((x, i) => [x.k, i]));
      w.strings(keys.map((x) => x.key));
      w.u32(Uint32Array.from(entries, (e) => ord.get(e.doc.filters[field]!) ?? NO_KEY));
    }
    return w.finish();
  }

  /** The live documents of `parts` as one segment (Convex's compaction), their vectors copied in id order. */
  static async merge(
    parts: readonly { segment: VectorSegment; deletes: VectorSegmentDeletes }[],
    dimensions: number,
    filterFields: readonly string[],
    pause: () => Promise<void> = async () => {},
  ): Promise<Uint8Array> {
    const segs = parts.map((p) => p.segment);
    for (const s of segs)
      if (s.dimensions !== dimensions || JSON.stringify(s.filterFields) !== JSON.stringify(filterFields))
        throw new Error("segments of another definition");
    const ids = mergeTables(
      segs.map((s) => s.ids),
      (k, d) => !parts[k]!.deletes.has(d),
    );
    const n = ids.strings.length;
    const source = new Uint32Array(n);
    const local = new Uint32Array(n);
    ids.remap.forEach((r, k) => {
      for (let d = 0; d < r.length; d++)
        if (r[d]! >= 0) {
          source[r[d]!] = k;
          local[r[d]!] = d;
        }
    });
    const vectors = new Float32Array(n * dimensions);
    for (let i = 0; i < n; i++) {
      vectors.set(segs[source[i]!]!.vector(local[i]!), i * dimensions);
      if (i % 8192 === 8191) await pause();
    }
    const w = new SegmentWriter(SegmentKind.Vector);
    w.json({
      uid: crypto.randomUUID(),
      numDocs: n,
      dimensions,
      filterFields: [...filterFields],
    } satisfies VectorSegmentMeta);
    w.strings(ids.strings);
    w.f32(vectors);
    filterFields.forEach((_, f) => {
      const keys = mergeTables(segs.map((s) => s.filterKeys[f]!));
      w.strings(keys.strings);
      w.u32(
        Uint32Array.from({ length: n }, (_, i) => {
          const ord = segs[source[i]!]!.filterOrds[f]![local[i]!]!;
          return ord === NO_KEY ? NO_KEY : keys.remap[source[i]!]![ord]!;
        }),
      );
    });
    return w.finish();
  }

  /** The document number of `id`, or -1. */
  docOf(id: string): number {
    return this.ids.find(utf8(id));
  }
  id(doc: number): string {
    return this.ids.at(doc);
  }
  /** The document's vector (a view over the segment). */
  vector(doc: number): Float32Array {
    return this.vectors.subarray(doc * this.dimensions, (doc + 1) * this.dimensions);
  }
  /** The ordinal of filter key `key` of filter field number `field`, or -1. */
  filterKeyOrd(field: number, key: string): number {
    return this.filterKeys[field]!.find(utf8(key));
  }
  filterOrd(field: number, doc: number): number {
    return this.filterOrds[field]![doc]!;
  }
  get(doc: number): VectorDoc {
    const filters: Record<string, string> = {};
    this.filterFields.forEach((field, f) => {
      const ord = this.filterOrds[f]![doc]!;
      if (ord !== NO_KEY) filters[field] = this.filterKeys[f]!.at(ord);
    });
    return { vector: this.vector(doc), filters };
  }
}

type VectorDeletesMeta = { segment: string; count: number };

/** The deleted documents of a vector segment (Convex's deleted bitset). Mutable in memory; stored on its own. */
export class VectorSegmentDeletes {
  private constructor(
    readonly segment: VectorSegment,
    private readonly bits: Bitset,
    public count: number,
  ) {}

  static none(segment: VectorSegment): VectorSegmentDeletes {
    return new VectorSegmentDeletes(segment, Bitset.empty(segment.numDocs), 0);
  }

  static decode(segment: VectorSegment, data: Uint8Array): VectorSegmentDeletes {
    const r = new SegmentReader(data, SegmentKind.VectorDeletes);
    const m = r.json<VectorDeletesMeta>(0);
    if (m?.segment !== segment.uid) throw new SegmentFileError("deletes of another segment");
    const bits = r.u8(1);
    if (bits.length !== (segment.numDocs + 7) >> 3) throw new SegmentFileError("deleted bitset size");
    return new VectorSegmentDeletes(segment, new Bitset(bits.slice()), m.count);
  }

  encode(): Uint8Array {
    const w = new SegmentWriter(SegmentKind.VectorDeletes);
    w.json({ segment: this.segment.uid, count: this.count } satisfies VectorDeletesMeta);
    w.bytes(this.bits.bits);
    return w.finish();
  }

  clone(): VectorSegmentDeletes {
    return new VectorSegmentDeletes(this.segment, this.bits.clone(), this.count);
  }

  has(doc: number): boolean {
    return this.bits.has(doc);
  }

  delete(doc: number): boolean {
    if (!this.bits.add(doc)) return false;
    this.count++;
    return true;
  }

  get live(): number {
    return this.segment.numDocs - this.count;
  }
}
