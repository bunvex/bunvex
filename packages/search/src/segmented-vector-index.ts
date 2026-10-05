// A vector index as segments plus a memory part (STUDY-111): `VectorSegment`s with their deletes, and the
// documents changed since they were written (the bookkeeping is `SegmentedIndex`'s). The search is exact
// (DV-269): every live vector of every part is compared, as one index holding them all would.
import { decodeId } from "@bunvex/values";
import { type PreparedCompaction, type PreparedFlush, SegmentedIndex, type SegmentPart } from "./segmented-index.ts";
import { type VectorDoc, VectorSegment, VectorSegmentDeletes } from "./vector-segment.ts";

export type VectorSegmentPart = SegmentPart<VectorSegment, VectorSegmentDeletes>;
export type PreparedVectorFlush = PreparedFlush<VectorSegment, VectorSegmentDeletes>;
export type PreparedVectorCompaction = PreparedCompaction<VectorSegment, VectorSegmentDeletes>;

/** A filter: per field, the values (their sort keys) any of which matches; fields are ORed, as Convex's. */
export type VectorFilter = ReadonlyMap<string, ReadonlySet<string>>;
export type VectorHit = { id: string; score: number };

/** Two document ids by their internal ids' bytes. */
function compareInternal(a: string, b: string): number {
  return Buffer.compare(Buffer.from(decodeId(a).internalId), Buffer.from(decodeId(b).internalId));
}

/**
 * Convex's order of vector results: by score, descending, a NaN above everything (as `total_cmp`); equal scores
 * by internal id, descending.
 */
export function compareVectorHits(a: VectorHit, b: VectorHit): number {
  const an = Number.isNaN(a.score);
  const bn = Number.isNaN(b.score);
  if (an !== bn) return an ? -1 : 1;
  if (!an && a.score !== b.score) return b.score - a.score;
  return compareInternal(b.id, a.id);
}

/** The f32 dot product of two vectors, accumulated in order (each product and sum rounded to f32). */
function dot(q: Float32Array, v: Float32Array, at: number): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) s = Math.fround(s + Math.fround(q[i]! * v[at + i]!));
  return s;
}

export class SegmentedVectorIndex extends SegmentedIndex<VectorSegment, VectorSegmentDeletes, VectorDoc> {
  /** The memory part: the documents changed since the segments were written that are in the index. */
  readonly memory = new Map<string, VectorDoc>();

  constructor(
    readonly dimensions: number,
    readonly filterFields: readonly string[],
  ) {
    super();
  }

  protected open(bytes: Uint8Array) {
    return VectorSegment.open(bytes);
  }
  protected noDeletes(segment: VectorSegment) {
    return VectorSegmentDeletes.none(segment);
  }
  protected decodeDeletes(segment: VectorSegment, bytes: Uint8Array) {
    return VectorSegmentDeletes.decode(segment, bytes);
  }
  protected build(docs: [string, VectorDoc][]) {
    return VectorSegment.build(docs, this.dimensions, this.filterFields);
  }
  protected merge(parts: VectorSegmentPart[], pause: () => Promise<void>) {
    return VectorSegment.merge(parts, this.dimensions, this.filterFields, pause);
  }
  protected memorySet(id: string, doc: VectorDoc | null) {
    if (doc) this.memory.set(id, doc);
    else this.memory.delete(id);
  }
  protected memoryGet(id: string) {
    return this.memory.get(id) ?? null;
  }
  protected memoryIds() {
    return this.memory.keys();
  }
  protected get memorySize() {
    return this.memory.size;
  }
  /** A changed document's memory: its vector, its filter keys and the map's entry. */
  protected estimate(d: VectorDoc | null): number {
    if (!d) return 64;
    let n = 96 + 4 * d.vector.length;
    for (const k of Object.values(d.filters)) n += 2 * k.length + 16;
    return n;
  }

  /**
   * The `limit` live documents most similar to `query` (normalized, f32) by dot product, best first, in Convex's
   * order (`compareVectorHits`); only those matching `filter`, when there is one.
   */
  search(query: Float32Array, limit: number, filter: VectorFilter | null): VectorHit[] {
    const top = new TopHits(limit);
    for (const [id, d] of this.memory) {
      if (filter && ![...filter].some(([f, keys]) => keys.has(d.filters[f]!))) continue;
      top.offer(dot(query, d.vector, 0), () => id);
    }
    for (const p of this.segments) {
      const seg = p.segment;
      // The filter as this segment's key ordinals, per field.
      let ords: [number, Set<number>][] | null = null;
      if (filter) {
        ords = [];
        for (const [field, keys] of filter) {
          const f = seg.filterFields.indexOf(field);
          if (f < 0) continue;
          const set = new Set<number>();
          for (const k of keys) {
            const o = seg.filterKeyOrd(f, k);
            if (o >= 0) set.add(o);
          }
          if (set.size) ords.push([f, set]);
        }
        if (!ords.length) continue;
      }
      for (let d = 0; d < seg.numDocs; d++) {
        if (p.deletes.has(d)) continue;
        if (ords && !ords.some(([f, set]) => set.has(seg.filterOrd(f, d)))) continue;
        top.offer(dot(query, seg.vectors, d * seg.dimensions), () => seg.id(d));
      }
    }
    return top.hits();
  }
}

/**
 * The best `limit` hits in `compareVectorHits`' order, which is total: the same as sorting every hit and keeping
 * the first `limit`. A hit's id is read only when a tie with a kept hit needs it, or when the hit is kept.
 */
class TopHits {
  private kept: VectorHit[] = [];
  constructor(private limit: number) {}

  offer(score: number, id: () => string) {
    if (this.limit <= 0) return;
    const kept = this.kept;
    if (kept.length === this.limit) {
      // Below the worst kept hit by score alone: no need for its id.
      const worst = kept[kept.length - 1]!;
      const wn = Number.isNaN(worst.score);
      if (!Number.isNaN(score) && (wn || score < worst.score)) return;
    }
    const hit = { id: id(), score };
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareVectorHits(kept[mid]!, hit) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= this.limit) return;
    kept.splice(lo, 0, hit);
    if (kept.length > this.limit) kept.pop();
  }

  hits(): VectorHit[] {
    return this.kept;
  }
}
