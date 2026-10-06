// An index as segments plus a memory part (STUDY-111), as Convex's text and vector indexes are: immutable
// segments with their deletes, and the documents changed since the segments were written. A change marks the
// document's segment copy deleted at once (Convex's memory tombstones), so every document lives in exactly one
// place; the text and vector indexes (subclasses) search the parts together.
//
// Flushing writes the memory part as a new segment (`prepareFlush`, then `commitFlush` once it is stored);
// compacting merges segments (`prepareCompaction`, `reconcileCompaction`, `commitCompaction`). Each is prepared
// at one moment and committed later, the changes made meanwhile kept. A compaction's reconcile and commit, and a
// flush from its prepare to its commit, must not interleave (the engine runs them under one lock), as Convex's
// writer serializes its flusher's and compactor's metadata writes.

/** What a segment offers the memory part's bookkeeping. */
export interface Segment<Doc> {
  readonly numDocs: number;
  docOf(id: string): number;
  id(doc: number): string;
  get(doc: number): Doc;
}

/** A segment's deletes, kept in memory and stored as a blob of their own. */
export interface Deletes<Self> {
  readonly count: number;
  readonly live: number;
  has(doc: number): boolean;
  delete(doc: number): boolean;
  clone(): Self;
  encode(): Uint8Array;
}

/** A segment of an index, with its deletes in memory. */
export type SegmentPart<S, D> = {
  segment: S;
  deletes: D;
  /** Counts the deletes made in memory; `persisted` is the count the stored deletes have. */
  version: number;
  persisted: number;
  /** Where the segment and its deletes are stored (the engine's; `deletes` null: none). */
  keys?: { segment: string; deletes: string | null };
};

/** A flush, prepared: the memory part's documents as a new segment, and the older segments' new deletes. */
export type PreparedFlush<S, D> = {
  /** The changes it holds: every one up to this sequence number. */
  seq: number;
  /** The new segment's bytes; null when the memory part has no documents (only deletes). */
  segment: Uint8Array | null;
  /** Each segment whose deletes changed, with the deletes as of the prepare. */
  deletes: { part: SegmentPart<S, D>; version: number; bytes: Uint8Array }[];
};

/**
 * A compaction, prepared: the live documents of `parts` as one segment (null: none left). Reconciled, it carries
 * the deletes its parts got since the prepare, to store with it.
 */
export type PreparedCompaction<S, D> = {
  parts: SegmentPart<S, D>[];
  /** Each part's deletes as of the prepare, then as of the reconcile. */
  captured: D[];
  segment: Uint8Array | null;
  /** Set by `reconcileCompaction`: the new segment (null: none), and its deletes' bytes to store (null: none). */
  merged?: SegmentPart<S, D> | null;
  deletes?: Uint8Array | null;
};

/** A stored segment: its bytes, its deletes' bytes when it has any, and where they are. */
export type StoredSegment = {
  segment: Uint8Array;
  deletes: Uint8Array | null;
  keys?: SegmentPart<never, never>["keys"];
};

export abstract class SegmentedIndex<S extends Segment<Doc>, D extends Deletes<D>, Doc> {
  segments: SegmentPart<S, D>[] = [];
  /** Each changed document (deleted ones included) and the sequence number of its last change. */
  readonly changed = new Map<string, number>();
  /** The memory part's estimated size in bytes (what the flush threshold is compared with). */
  memoryBytes = 0;
  private estimates = new Map<string, number>();
  private seq = 0;
  /** The commit ts of each change that gave one (a backfill step keeps only the changes after its ts). */
  private changedAt = new Map<string, bigint>();

  protected abstract open(bytes: Uint8Array): S;
  protected abstract noDeletes(segment: S): D;
  protected abstract decodeDeletes(segment: S, bytes: Uint8Array): D;
  protected abstract build(docs: [string, Doc][]): Uint8Array;
  /** The memory part: put, read and list the changed documents' current states. */
  protected abstract memorySet(id: string, doc: Doc | null): void;
  protected abstract memoryGet(id: string): Doc | null;
  protected abstract memoryIds(): Iterable<string>;
  protected abstract get memorySize(): number;
  protected abstract estimate(doc: Doc | null): number;

  private part(segment: S, deletes: D, keys?: SegmentPart<S, D>["keys"]): SegmentPart<S, D> {
    return { segment, deletes, version: 0, persisted: 0, ...(keys ? { keys } : {}) };
  }

  /**
   * Segments from storage, all or none: a segment that cannot be read throws before any is added. Changes
   * already made (a commit before the load) delete their stale copies.
   */
  load(parts: StoredSegment[]) {
    const loaded = parts.map((p) => {
      const segment = this.open(p.segment);
      const deletes = p.deletes ? this.decodeDeletes(segment, p.deletes) : this.noDeletes(segment);
      return this.part(segment, deletes, p.keys);
    });
    this.segments.push(...loaded);
    for (const id of this.changed.keys()) this.deleteFromSegments(id);
  }

  /** Live documents. */
  get size(): number {
    let n = this.memorySize;
    for (const p of this.segments) n += p.deletes.live;
    return n;
  }

  private deleteFromSegments(id: string) {
    for (const p of this.segments) {
      const d = p.segment.docOf(id);
      if (d >= 0 && p.deletes.delete(d)) p.version++;
    }
  }

  /** Put a document's current state (null: deleted), as of commit `ts` when there is one. */
  set(id: string, doc: Doc | null, ts?: bigint) {
    if (!this.changed.has(id)) this.deleteFromSegments(id);
    this.changed.set(id, ++this.seq);
    if (ts === undefined) this.changedAt.delete(id);
    else this.changedAt.set(id, ts);
    this.memorySet(id, doc);
    const size = this.estimate(doc);
    this.memoryBytes += size - (this.estimates.get(id) ?? 0);
    this.estimates.set(id, size);
  }

  /** A live document's segment and number, when it is in a segment (not changed since). */
  protected locate(id: string): { part: SegmentPart<S, D>; doc: number } | null {
    if (this.changed.has(id)) return null;
    for (const part of this.segments) {
      const doc = part.segment.docOf(id);
      if (doc >= 0 && !part.deletes.has(doc)) return { part, doc };
    }
    return null;
  }

  /** A document's indexed state, or null. */
  get(id: string): Doc | null {
    if (this.changed.has(id)) return this.memoryGet(id);
    const at = this.locate(id);
    return at ? at.part.segment.get(at.doc) : null;
  }

  /** Every live document's id. */
  *ids(): IterableIterator<string> {
    yield* this.memoryIds();
    for (const p of this.segments)
      for (let d = 0; d < p.segment.numDocs; d++) if (!p.deletes.has(d)) yield p.segment.id(d);
  }

  /** The memory part's documents as a segment (null: none). */
  protected buildMemory(): Uint8Array | null {
    const docs: [string, Doc][] = [];
    for (const id of this.memoryIds()) docs.push([id, this.memoryGet(id)!]);
    return docs.length ? this.build(docs) : null;
  }

  /**
   * The live documents of `parts` merged into one segment. Which documents are live is read before the first
   * `pause`: the deletes made after it are not in it.
   */
  protected abstract merge(parts: SegmentPart<S, D>[], pause: () => Promise<void>): Promise<Uint8Array>;

  /** Prepares a flush of the memory part (see `PreparedFlush`). */
  prepareFlush(): PreparedFlush<S, D> {
    return {
      seq: this.seq,
      segment: this.buildMemory(),
      deletes: this.segments
        .filter((p) => p.version !== p.persisted)
        .map((p) => ({ part: p, version: p.version, bytes: p.deletes.encode() })),
    };
  }

  /**
   * The flush is stored: its segment joins the index, its deletes are the stored ones, and the memory part keeps
   * only the changes made since the prepare (their copies in the new segment deleted). Returns the new segment.
   */
  commitFlush(f: PreparedFlush<S, D>, keys?: SegmentPart<S, D>["keys"]): SegmentPart<S, D> | null {
    for (const d of f.deletes) {
      if (!this.segments.includes(d.part)) throw new Error("a flushed segment was replaced before the flush committed");
      d.part.persisted = d.version;
    }
    let part: SegmentPart<S, D> | null = null;
    if (f.segment) {
      const segment = this.open(f.segment);
      part = this.part(segment, this.noDeletes(segment), keys);
    }
    for (const [id, seq] of this.changed) {
      if (seq <= f.seq) this.forget(id);
      else if (part) {
        const d = part.segment.docOf(id);
        if (d >= 0 && part.deletes.delete(d)) part.version++;
      }
    }
    if (part) this.segments.push(part);
    return part;
  }

  /** Drops a change from the memory part (what it held is in the segments now). */
  private forget(id: string) {
    this.memorySet(id, null);
    this.changed.delete(id);
    this.changedAt.delete(id);
    this.memoryBytes -= this.estimates.get(id) ?? 0;
    this.estimates.delete(id);
  }

  /** A built segment as it is stored with no deletes: its documents, id, and its empty deletes' bytes. */
  describe(segment: Uint8Array): { segment: S; deletes: Uint8Array } {
    const opened = this.open(segment);
    return { segment: opened, deletes: this.noDeletes(opened).encode() };
  }

  /** `docs` as a segment of this index (null: none). */
  buildSegment(docs: [string, Doc][]): Uint8Array | null {
    return docs.length ? this.build(docs) : null;
  }

  /** Marks these documents' copies deleted in every segment (a backfill step's updates to earlier pages). */
  deleteFromAll(ids: Iterable<string>) {
    for (const id of ids) this.deleteFromSegments(id);
  }

  /** The deletes of every segment whose deletes changed since they were stored, encoded now. */
  changedDeletes(): PreparedFlush<S, D>["deletes"] {
    return this.segments
      .filter((p) => p.version !== p.persisted)
      .map((p) => ({ part: p, version: p.version, bytes: p.deletes.encode() }));
  }

  /**
   * A backfill step is stored (Convex's incremental backfill): its segment — the table read at `ts` from its
   * cursor, and the earlier pages' documents changed since the last step — joins the index with the stored
   * deletes, and the memory part keeps only the changes committed after `ts` (their copies in the new segment
   * deleted), as Convex truncates its memory index to the step's ts.
   */
  commitBackfill(
    segment: Uint8Array | null,
    deletes: PreparedFlush<S, D>["deletes"],
    ts: bigint,
    keys?: SegmentPart<S, D>["keys"],
  ): SegmentPart<S, D> | null {
    for (const d of deletes) {
      if (!this.segments.includes(d.part))
        throw new Error("a backfilled segment was replaced before the step committed");
      d.part.persisted = d.version;
    }
    let part: SegmentPart<S, D> | null = null;
    if (segment) {
      const opened = this.open(segment);
      part = this.part(opened, this.noDeletes(opened), keys);
    }
    for (const id of [...this.changed.keys()]) {
      const at = this.changedAt.get(id);
      if (at !== undefined && at <= ts) this.forget(id);
      else if (part) {
        const d = part.segment.docOf(id);
        if (d >= 0 && part.deletes.delete(d)) part.version++;
      }
    }
    if (part) this.segments.push(part);
    return part;
  }

  /** Prepares merging `parts` (segments of this index) into one segment of their live documents. */
  async prepareCompaction(
    parts: SegmentPart<S, D>[],
    pause: () => Promise<void> = async () => {},
  ): Promise<PreparedCompaction<S, D>> {
    // The deletes as the merge reads them: both at once, before it first pauses.
    const captured = parts.map((p) => p.deletes.clone());
    const live = parts.some((p) => p.deletes.live > 0);
    const merged = live ? this.merge(parts, pause) : null;
    return { parts, captured, segment: merged && (await merged) };
  }

  /** The deletes `c`'s parts got since `c.captured`, applied to `part`; `c.captured` brought up to date. */
  private carryDeletes(c: PreparedCompaction<S, D>, part: SegmentPart<S, D>) {
    c.parts.forEach((p, i) => {
      const before = c.captured[i]!;
      if (before.count === p.deletes.count) return;
      for (let d = 0; d < p.segment.numDocs; d++)
        if (p.deletes.has(d) && !before.has(d)) {
          const m = part.segment.docOf(p.segment.id(d));
          if (m >= 0 && part.deletes.delete(m)) part.version++;
        }
      c.captured[i] = p.deletes.clone();
    });
  }

  private checkParts(c: PreparedCompaction<S, D>) {
    for (const p of c.parts)
      if (!this.segments.includes(p))
        throw new Error("a compacted segment was replaced before the compaction committed");
  }

  /**
   * Brings a compaction up to date with the deletes made since its prepare, flushes' included, and returns its
   * new segment's deletes, to store with it (null: none).
   */
  reconcileCompaction(c: PreparedCompaction<S, D>): Uint8Array | null {
    this.checkParts(c);
    c.merged = null;
    c.deletes = null;
    if (c.segment) {
      const segment = this.open(c.segment);
      const part = this.part(segment, this.noDeletes(segment));
      this.carryDeletes(c, part);
      part.persisted = part.version;
      c.merged = part;
      if (part.deletes.count) c.deletes = part.deletes.encode();
    }
    return c.deletes;
  }

  /**
   * The compaction is stored (its segment, and the deletes `reconcileCompaction` gave): the segment replaces its
   * parts, with the deletes they got since. Returns it (null when none of their documents were left).
   */
  commitCompaction(c: PreparedCompaction<S, D>, keys?: SegmentPart<S, D>["keys"]): SegmentPart<S, D> | null {
    if (c.merged === undefined) throw new Error("a compaction committed before it was reconciled");
    this.checkParts(c);
    const part = c.merged;
    if (part) {
      this.carryDeletes(c, part);
      if (keys) part.keys = keys;
    }
    const first = this.segments.indexOf(c.parts[0]!);
    this.segments = this.segments.filter((p) => !c.parts.includes(p));
    if (part) this.segments.splice(Math.min(first, this.segments.length), 0, part);
    return part;
  }
}
