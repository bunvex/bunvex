// Persisted search segments (STUDY-111 PR 3; STUDY-79 option E, owner 2026-10-05). Each text and vector index
// is segments in the `search` blob use case plus a memory part (`@bunvex/search`'s `SegmentedIndex`); this module
// keeps their state — which segments, current at which ts — in the store, and reads it back at a start.
//
// Convex keeps an index's segments and ts in its `_index` row (`TextIndexState`, `VectorIndexState`); bunvex has
// no `_index` rows for search indexes, so the state of every index is one persistence global,
// `search_segments`, written after the blobs it names (DV-368). A start loads an index's segments and replays
// the document log since its ts, as Convex's bootstrap; a state it cannot trust is not used, and the index is
// built from its table instead.
import type { StoredSegment } from "@bunvex/search";
import type { DocLogRow, Persistence, RetentionStore } from "./persistence/index.ts";
import type { Doc, SearchIndexDef, VectorIndexDef } from "./schema.ts";

/** The store's global holding every index's segments. */
export const SEARCH_SEGMENTS_GLOBAL = "search_segments";
const FORMAT = 1;
/** Retention's global for the oldest document snapshot it keeps (retention.ts). */
const MIN_DOCUMENT_TS_GLOBAL = "document_min_snapshot_ts";
const LOG_PAGE = 1000;
const VERSIONS_PAGE = 1000;

/**
 * Convex's SEARCH_INDEX_SIZE_SOFT_LIMIT (10 MiB) and VECTOR_INDEX_SIZE_SOFT_LIMIT (30 MiB): a memory part over
 * its limit is flushed into a new segment.
 */
export type SearchSegmentLimits = {
  textSoftLimitBytes: number;
  vectorSoftLimitBytes: number;
  /**
   * Convex's SEARCH_INDEX_SIZE_HARD_LIMIT and VECTOR_INDEX_SIZE_HARD_LIMIT (100 MiB each): a write to a table
   * whose ready index has a memory part this large is refused until a flush brings it down.
   */
  textHardLimitBytes: number;
  vectorHardLimitBytes: number;
};

export function searchSegmentLimitsFromEnv(env: Record<string, string | undefined> = process.env): SearchSegmentLimits {
  const bytes = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    textSoftLimitBytes: bytes("SEARCH_INDEX_SIZE_SOFT_LIMIT", 10 * 2 ** 20),
    vectorSoftLimitBytes: bytes("VECTOR_INDEX_SIZE_SOFT_LIMIT", 30 * 2 ** 20),
    textHardLimitBytes: bytes("SEARCH_INDEX_SIZE_HARD_LIMIT", 100 * 2 ** 20),
    vectorHardLimitBytes: bytes("VECTOR_INDEX_SIZE_HARD_LIMIT", 100 * 2 ** 20),
  };
}

/**
 * Convex's `CompactionConfig::default()` (search_compactor.rs), for text and vector alike: a segment of at most
 * `smallSegmentBytes` (VECTOR_INDEX_SIZE_HARD_LIMIT, 100 MiB) is small; at least `minSegments`
 * (MIN_COMPACTION_SEGMENTS, 3) and at most `maxSegments` (MAX_COMPACTION_SEGMENTS, 10) are merged at a time,
 * their total at most `maxSegmentBytes` (SEGMENT_MAX_SIZE_BYTES); a large segment more than
 * `maxDeletedFraction` (MAX_SEGMENT_DELETED_PERCENTAGE, 0.2) deleted is rewritten alone.
 */
export type SearchCompactionConfig = {
  smallSegmentBytes: number;
  minSegments: number;
  maxSegments: number;
  maxSegmentBytes: number;
  maxDeletedFraction: number;
};

export function searchCompactionFromEnv(env: Record<string, string | undefined> = process.env): SearchCompactionConfig {
  const num = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    smallSegmentBytes: num("VECTOR_INDEX_SIZE_HARD_LIMIT", 100 * 2 ** 20),
    minSegments: num("MIN_COMPACTION_SEGMENTS", 3),
    maxSegments: num("MAX_COMPACTION_SEGMENTS", 10),
    maxSegmentBytes: num("SEGMENT_MAX_SIZE_BYTES", Math.floor((1_100_000 * 2048 * 4) / 3)),
    maxDeletedFraction: num("MAX_SEGMENT_DELETED_PERCENTAGE", 0.2),
  };
}

/** A segment as the compactor weighs it: its size (Convex's `total_size_bytes`) and its documents. */
export type CompactionCandidate = { size: number; docs: number; deleted: number };

/**
 * Convex's `find_segments_to_compact`: the positions of the segments to merge, or null. Small segments first
 * (the smallest that fit in `maxSegmentBytes`, if there are `minSegments` of them), then large ones the same
 * way, then one large segment with too many deletes. At most `maxSegments`, chosen among the candidates at
 * random (`shuffle`) as Convex's.
 */
export function segmentsToCompact(
  segments: readonly CompactionCandidate[],
  c: SearchCompactionConfig,
  shuffle: <T>(xs: T[]) => T[] = (xs) => xs,
): number[] | null {
  const indexed = segments.map((s, i) => ({ ...s, i }));
  const fitting = (group: typeof indexed) => {
    let total = 0;
    const out: number[] = [];
    for (const s of [...group].sort((a, b) => a.size - b.size)) {
      total += s.size;
      if (total > c.maxSegmentBytes) break;
      out.push(s.i);
    }
    return out.length >= c.minSegments ? shuffle(out).slice(0, c.maxSegments) : null;
  };
  const small = indexed.filter((s) => s.size <= c.smallSegmentBytes);
  const large = indexed.filter((s) => s.size > c.smallSegmentBytes);
  const merge = fitting(small) ?? fitting(large);
  if (merge) return merge;
  const deleted = large.find((s) => s.docs > 0 && s.deleted / s.docs > c.maxDeletedFraction);
  return deleted ? [deleted.i] : null;
}

/** Where segments are kept (the server's `search` blob use case): blobs by the key `put` gives them. */
export type SearchSegmentStore = {
  put(data: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

/** A stored segment: its blob, its deletes' blob (null: none), and counts for the compactor and the logs. */
export type SegmentRef = { segment: string; deletes: string | null; docs: number; deleted: number };

/**
 * One index's stored state: Convex's `SnapshottedAt { ts, segments }`, or, while it is built, its
 * `Backfilling { cursor: { table_scan_cursor, last_segment_ts }, segments }`.
 */
export type IndexSegmentsState = {
  kind: "text" | "vector";
  tablet: number;
  name: string;
  def: SearchIndexDef | VectorIndexDef;
  /**
   * Every commit up to `ts` is in the segments (with their deletes); while backfilling, for the documents up to
   * the cursor only (Convex's `last_segment_ts`).
   */
  ts: number;
  segments: SegmentRef[];
  /** While the index is built from its table: the last document id read (null: none yet). */
  backfill?: { cursor: string | null };
};

type SegmentsGlobal = { format: number; indexes: IndexSegmentsState[] };

export const stateKey = (kind: "text" | "vector", tablet: number, name: string) =>
  `${kind}\u0000${tablet}\u0000${name}`;
const sameDef = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Store = Persistence & Pick<RetentionStore, "readDocumentLog" | "getGlobal" | "setGlobal">;

/** Whether the store has what segments need: the document log, versions and globals. */
export function canPersistSegments(p: Persistence): p is Store {
  const s = p as Partial<Store>;
  return (
    typeof s.readDocumentLog === "function" &&
    typeof s.getGlobal === "function" &&
    typeof s.setGlobal === "function" &&
    typeof p.getVersions === "function"
  );
}

/**
 * The indexes' stored state, as the store has it, and the one writer of it: every change goes through
 * `update`, in order, so a flush, a compaction and the removal of a dropped index never overwrite each other.
 */
export class SearchSegmentsState {
  private states = new Map<string, IndexSegmentsState>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly store: Store,
    readonly blobs: SearchSegmentStore,
  ) {}

  /** Reads the global (a missing or unreadable one is no state: every index is built from its table). */
  async load() {
    const g = (await this.store.getGlobal(SEARCH_SEGMENTS_GLOBAL)) as Partial<SegmentsGlobal> | null;
    if (g?.format !== FORMAT || !Array.isArray(g.indexes)) return;
    for (const s of g.indexes) this.states.set(stateKey(s.kind, s.tablet, s.name), s);
  }

  get(kind: "text" | "vector", tablet: number, name: string): IndexSegmentsState | undefined {
    return this.states.get(stateKey(kind, tablet, name));
  }

  all(): IndexSegmentsState[] {
    return [...this.states.values()];
  }

  /**
   * Runs `change` on the states once the writes before it are done, then stores them and runs `stored` (unless
   * `change` returns false: nothing to store). Resolves with whether it stored; the next change waits for it, so
   * what `stored` does in memory is ordered with the store's writes.
   */
  update(
    change: (states: Map<string, IndexSegmentsState>) => boolean | undefined,
    stored?: () => void,
  ): Promise<boolean> {
    const run = this.writes.then(async () => {
      if (change(this.states) === false) return false;
      await this.store.setGlobal(SEARCH_SEGMENTS_GLOBAL, {
        format: FORMAT,
        indexes: [...this.states.values()],
      } satisfies SegmentsGlobal);
      stored?.();
      return true;
    });
    this.writes = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * The state to start `kind` index `name` of `tablet` from, when it can be trusted at `at`: the same definition,
   * a ts not ahead of the store and within document retention (so the log since is complete); null otherwise.
   */
  async usable(
    kind: "text" | "vector",
    tablet: number,
    name: string,
    def: SearchIndexDef | VectorIndexDef,
    at: number,
  ): Promise<IndexSegmentsState | null> {
    const s = this.get(kind, tablet, name);
    if (!s || !sameDef(s.def, def) || !Number.isSafeInteger(s.ts) || s.ts > at) return null;
    if (s.ts < Number((await this.store.getGlobal(MIN_DOCUMENT_TS_GLOBAL)) ?? 0)) return null;
    return s;
  }

  /** The stored segments of `s` (null when a blob is missing: the index is built from its table). */
  async fetch(s: IndexSegmentsState): Promise<StoredSegment[] | null> {
    const parts = await Promise.all(
      s.segments.map(async (r) => {
        const segment = await this.blobs.get(r.segment);
        const deletes = r.deletes ? await this.blobs.get(r.deletes) : null;
        if (!segment || (r.deletes && !deletes)) return null;
        return { segment, deletes, keys: { segment: r.segment, deletes: r.deletes } };
      }),
    );
    return parts.every((p) => p !== null) ? (parts as StoredSegment[]) : null;
  }
}

/** An index's segments as stored, from its parts in memory (each with its stored keys). */
export function segmentRefs(
  parts: readonly {
    segment: { numDocs: number };
    deletes: { count: number };
    keys?: { segment: string; deletes: string | null };
  }[],
): SegmentRef[] {
  return parts.map((p) => {
    if (!p.keys) throw new Error("a segment that is not stored");
    return { segment: p.keys.segment, deletes: p.keys.deletes, docs: p.segment.numDocs, deleted: p.deletes.count };
  });
}

/**
 * The documents the log changed after `since` up to `at`, per table, at their state as of `at` (null: deleted).
 * The log is read once per table from the oldest ts any of its indexes asks for.
 */
export class SegmentReplay {
  private reads = new Map<number, { since: number; changes: Promise<Map<string, { ts: number; doc: Doc | null }>> }>();

  constructor(
    private store: Store,
    readonly at: number,
    private decode: (json: string) => Doc,
    /** The oldest ts each table's indexes start from (the log is read once from there). */
    private oldest: Map<number, number>,
  ) {}

  /** Each document of `tablet` the log changed in `(since, at]`, at its state as of `at`. */
  async since(tablet: number, since: number): Promise<[string, Doc | null][]> {
    let r = this.reads.get(tablet);
    if (!r) {
      const from = Math.min(this.oldest.get(tablet) ?? since, since);
      r = { since: from, changes: this.read(tablet, from) };
      this.reads.set(tablet, r);
    }
    if (since < r.since) throw new Error(`the log of table ${tablet} was read from ${r.since}, not ${since}`);
    const out: [string, Doc | null][] = [];
    for (const [id, c] of await r.changes) if (c.ts > since) out.push([id, c.doc]);
    return out;
  }

  private read(tablet: number, since: number) {
    return changedSince(this.store, tablet, since, this.at, this.decode);
  }
}

/**
 * Each document of `tablet` the document log changed in `(since, at]`, with the ts of its last change there and
 * its state as of `at` (null: deleted).
 */
export async function changedSince(
  store: Store,
  tablet: number,
  since: number,
  at: number,
  decode: (json: string) => Doc,
  keep: (id: string) => boolean = () => true,
): Promise<Map<string, { ts: number; doc: Doc | null }>> {
  const last = new Map<string, number>();
  for (let cursor = since; cursor < at; ) {
    const rows: DocLogRow[] = await store.readDocumentLog(cursor, at, LOG_PAGE);
    if (!rows.length) break;
    for (const r of rows) if (r.table === tablet && keep(r.id)) last.set(r.id, r.ts);
    cursor = rows[rows.length - 1]!.ts;
  }
  const out = new Map<string, { ts: number; doc: Doc | null }>();
  const ids = [...last.keys()];
  for (let i = 0; i < ids.length; i += VERSIONS_PAGE) {
    const page = ids.slice(i, i + VERSIONS_PAGE);
    const versions = await store.getVersions!(tablet, page, at);
    page.forEach((id, k) => {
      out.set(id, { ts: last.get(id)!, doc: versions[k] ? decode(versions[k]!.json) : null });
    });
  }
  return out;
}
