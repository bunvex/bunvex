// Persisted search segments (STUDY-111; STUDY-79 option E, owner 2026-10-05). Each text and vector index is
// segments in the `search` blob use case plus a memory part (`@bunvex/search`'s `SegmentedIndex`); this module
// keeps their state — which segments, current at which ts — and reads it back at a start.
//
// As Convex's, the state is each index's `_index` row: `{tablet, name, config}`, its `config` Convex's
// `IndexConfig::Text` / `IndexConfig::Vector` as Convex serializes it (`type` "search" or "vector", the spec's
// fields, `onDiskState` `backfilling` / `backfilling2` / `snapshotted` with the segment list). Every search and
// vector index of the schema has one, so `_index` holds the rows Convex's does (STUDY-111 §3.7). A row names only
// blobs already written. A start loads an index's segments and replays the document log since its ts, as Convex's
// bootstrap; a state it cannot trust is not used, and the index is built from its table instead.
import type { StoredSegment } from "@bunvex/search";
import type { DocLogRow, Persistence, RetentionStore } from "./persistence/index.ts";
import type { Doc, SearchIndexDef, VectorIndexDef } from "./schema.ts";

/**
 * Convex's DATABASE_WORKERS_POLL_INTERVAL (20 s), DATABASE_WORKERS_MIN_COMMITS (500) and
 * SEARCH_WORKERS_MAX_CHECKPOINT_AGE (1 h): how often the workers look, how many commits or how long before an
 * idle index is fast-forwarded again, and how old a non-empty memory part's ts may get before it is flushed.
 */
export type SearchWorkerOptions = { pollIntervalMs: number; minCommits: number; maxCheckpointAgeMs: number };

export function searchWorkersFromEnv(env: Record<string, string | undefined> = process.env): SearchWorkerOptions {
  const num = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    pollIntervalMs: num("DATABASE_WORKERS_POLL_INTERVAL", 20) * 1000,
    minCommits: num("DATABASE_WORKERS_MIN_COMMITS", 500),
    maxCheckpointAgeMs: num("SEARCH_WORKERS_MAX_CHECKPOINT_AGE", 3600) * 1000,
  };
}

/** Retention's global for the oldest document snapshot it keeps (retention.ts). */
const MIN_DOCUMENT_TS_GLOBAL = "document_min_snapshot_ts";
/** Convex's `TextSnapshotVersion::current()` (V2UseStringIds): the version a text snapshot is written with. */
const TEXT_SNAPSHOT_VERSION = 2;
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

/**
 * A stored segment: its blob and its deletes' blob, its documents (deleted ones included) and deleted ones, its
 * bytes and its random id (Convex's `FragmentedTextSegment` / `FragmentedVectorSegment`).
 */
export type SegmentRef = { segment: string; deletes: string; docs: number; deleted: number; bytes: number; id: string };

/**
 * One index's state: Convex's `SnapshottedAt { ts, segments }`, or, while it is built (or staged, never built),
 * its `Backfilling { cursor: { table_scan_cursor, last_segment_ts }, segments, staged }`.
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
  staged: boolean;
};

export const stateKey = (kind: "text" | "vector", tablet: number, name: string) =>
  `${kind}\u0000${tablet}\u0000${name}`;

/** Two definitions of one kind are the same index: Convex's spec, whose filter fields are a set. */
export function sameSpec(a: SearchIndexDef | VectorIndexDef, b: SearchIndexDef | VectorIndexDef): boolean {
  const norm = (d: SearchIndexDef | VectorIndexDef) => {
    const o: Record<string, unknown> = { ...d, filterFields: [...d.filterFields].sort() };
    return JSON.stringify(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    );
  };
  return norm(a) === norm(b);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cursorBytes = (cursor: string) => encoder.encode(cursor).buffer as ArrayBuffer;

/** An `_index` row of a search or vector index, as stored: `config` as Convex serializes `IndexConfig`. */
export type SearchIndexRow = { _id?: string; tablet: number; name: string; config: Record<string, unknown> };

/** Whether an `_index` row is a search or vector index's (a database index's has no `config`). */
export const isSearchIndexRow = (row: Record<string, unknown>) => row.config !== undefined;

/** A state as its `_index` row: Convex's `SerializedIndexConfig::Search` / `::Vector`. */
export function stateToRow(s: IndexSegmentsState): SearchIndexRow {
  const filterFields = [...s.def.filterFields].sort();
  const building = s.backfill !== undefined;
  let onDiskState: Record<string, unknown>;
  if (s.kind === "text") {
    const segments = s.segments.map((r) => ({
      segment_key: r.segment,
      // bunvex keeps the id tracker in the segment, and the alive bitset with the deleted terms (DV-367).
      id_tracker_key: r.segment,
      deleted_terms_table_key: r.deletes,
      alive_bitset_key: r.deletes,
      num_indexed_documents: r.docs,
      num_deleted_documents: r.deleted,
      size_bytes_total: r.bytes,
      id: r.id,
    }));
    if (!building)
      onDiskState = {
        state: "snapshotted",
        data: { data_type: "MultiSegment", segments },
        ts: s.ts,
        version: TEXT_SNAPSHOT_VERSION,
      };
    else if (!segments.length && s.backfill!.cursor === null) onDiskState = { state: "backfilling", staged: s.staged };
    else
      onDiskState = {
        state: "backfilling2",
        segments,
        cursor:
          s.backfill!.cursor === null
            ? null
            : { table_scan_cursor: cursorBytes(s.backfill!.cursor), last_segment_ts: s.ts },
        staged: s.staged,
      };
    const def = s.def as SearchIndexDef;
    return {
      tablet: s.tablet,
      name: s.name,
      config: { type: "search", searchField: def.searchField, filterFields, onDiskState },
    };
  }
  const segments = s.segments.map((r) => ({
    segment_key: r.segment,
    id_tracker_key: r.segment,
    deleted_bitset_key: r.deletes,
    num_vectors: r.docs,
    num_deleted: r.deleted,
    id: r.id,
  }));
  if (!building) onDiskState = { state: "snapshotted", data: { data_type: "MultiSegment", segments }, ts: s.ts };
  else
    onDiskState = {
      state: "backfilling",
      segments,
      table_scan_cursor: s.backfill!.cursor === null ? null : cursorBytes(s.backfill!.cursor),
      last_segment_ts: s.backfill!.cursor === null ? null : s.ts,
      staged: s.staged,
    };
  const def = s.def as VectorIndexDef;
  return {
    tablet: s.tablet,
    name: s.name,
    config: { type: "vector", dimensions: def.dimensions, vectorField: def.vectorField, filterFields, onDiskState },
  };
}

/** A state from its `_index` row; null when the row is not one bunvex can read. */
export function rowToState(row: Record<string, unknown>): IndexSegmentsState | null {
  try {
    const c = row.config as Record<string, unknown>;
    const o = c.onDiskState as Record<string, unknown>;
    const tablet = row.tablet as number;
    const name = row.name as string;
    const filterFields = c.filterFields as string[];
    if (c.type === "search") {
      const def = { searchField: c.searchField as string, filterFields } as SearchIndexDef;
      const segs = (list: unknown) =>
        ((list ?? []) as Record<string, unknown>[]).map((g) => ({
          segment: g.segment_key as string,
          deletes: g.alive_bitset_key as string,
          docs: g.num_indexed_documents as number,
          deleted: g.num_deleted_documents as number,
          bytes: g.size_bytes_total as number,
          id: g.id as string,
        }));
      if (o.state === "snapshotted") {
        if (o.version !== TEXT_SNAPSHOT_VERSION) return null;
        const data = o.data as { segments: unknown };
        return { kind: "text", tablet, name, def, ts: o.ts as number, segments: segs(data.segments), staged: false };
      }
      if (o.state === "backfilling")
        return { kind: "text", tablet, name, def, ts: 0, segments: [], backfill: { cursor: null }, staged: !!o.staged };
      if (o.state === "backfilling2") {
        const cur = o.cursor as { table_scan_cursor: ArrayBuffer; last_segment_ts: number } | null;
        return {
          kind: "text",
          tablet,
          name,
          def,
          ts: cur ? cur.last_segment_ts : 0,
          segments: segs(o.segments),
          backfill: { cursor: cur ? decoder.decode(cur.table_scan_cursor) : null },
          staged: !!o.staged,
        };
      }
      return null;
    }
    if (c.type === "vector") {
      const def = {
        vectorField: c.vectorField as string,
        dimensions: c.dimensions as number,
        filterFields,
      } as VectorIndexDef;
      const segs = (list: unknown) =>
        ((list ?? []) as Record<string, unknown>[]).map((g) => ({
          segment: g.segment_key as string,
          deletes: g.deleted_bitset_key as string,
          docs: g.num_vectors as number,
          deleted: g.num_deleted as number,
          bytes: (g.num_vectors as number) * def.dimensions * 4,
          id: g.id as string,
        }));
      if (o.state === "snapshotted") {
        const data = o.data as { segments: unknown };
        return { kind: "vector", tablet, name, def, ts: o.ts as number, segments: segs(data.segments), staged: false };
      }
      if (o.state === "backfilling") {
        const cursor = o.table_scan_cursor as ArrayBuffer | null;
        return {
          kind: "vector",
          tablet,
          name,
          def,
          ts: (o.last_segment_ts as number | null) ?? 0,
          segments: segs(o.segments),
          backfill: { cursor: cursor ? decoder.decode(cursor) : null },
          staged: !!o.staged,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

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

/** A write of `_index` rows: insert (no `_id`), replace (`_id` and row), or delete (`_id`, no row). */
export type IndexRowWrite = { _id?: string; row?: SearchIndexRow };

/**
 * The indexes' states as their `_index` rows hold them, and the one writer of them: every change goes through
 * `update`, in order, so a flush, a compaction and the removal of a dropped index never overwrite each other (as
 * Convex's `SearchIndexMetadataWriter` serializes its workers' writes).
 */
export class SearchSegmentsState {
  private states = new Map<string, IndexSegmentsState>();
  private ids = new Map<string, string>();
  /** Each index's fast-forward ts (Convex's `_index_worker_metadata`), by state key, with its row's id. */
  private forwarded = new Map<string, { ts: number; _id?: string }>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    /** The store, when it has what segments need (else the rows are kept, and no segment). */
    readonly store: Store | null,
    /** Where segments are kept; null: none (the rows are kept, every index is built from its table). */
    readonly blobs: SearchSegmentStore | null,
    /** Writes `_index` rows in one transaction; returns the ids of the inserted ones, in order. */
    private write: (writes: IndexRowWrite[]) => Promise<string[]>,
  ) {}

  /** The states of the rows read at a start (a row bunvex cannot read is no state: rewritten as backfilling). */
  load(rows: Record<string, unknown>[]) {
    for (const r of rows) {
      if (!isSearchIndexRow(r)) continue;
      const s = rowToState(r);
      const kind = (r.config as { type: string }).type === "search" ? "text" : "vector";
      const key = stateKey(kind, r.tablet as number, r.name as string);
      this.ids.set(key, r._id as string);
      if (s) this.states.set(key, s);
    }
  }

  /** The fast-forward ts of the `_index_worker_metadata` rows, by their `_index` row's id. */
  loadForwarded(rows: Record<string, unknown>[]) {
    const keyOf = new Map([...this.ids].map(([k, id]) => [id, k]));
    for (const r of rows) {
      const k = keyOf.get(r.index_id as string);
      const meta = r.index_metadata as { metadata?: { fast_forward_ts?: number } } | undefined;
      const ts = meta?.metadata?.fast_forward_ts;
      if (k !== undefined && typeof ts === "number") this.forwarded.set(k, { ts, _id: r._id as string });
    }
  }

  /**
   * The ts an index's state is current at: its segments' (`ts`), or later when it was fast-forwarded with nothing
   * written since (Convex's `max(snapshot ts, fast_forward_ts)`).
   */
  currentTs(s: IndexSegmentsState): number {
    const f = s.backfill ? undefined : this.forwarded.get(stateKey(s.kind, s.tablet, s.name));
    return Math.max(s.ts, f?.ts ?? 0);
  }

  /**
   * The `_index_worker_metadata` writes that move these indexes' fast-forward ts to `ts` (their `_index` rows'
   * ids, the rows to insert or patch), and once they are stored, `done` records them.
   */
  forward(keys: string[], ts: number) {
    const writes: { _id?: string; index_id: string; metadata_type: string }[] = [];
    for (const k of keys) {
      const indexId = this.ids.get(k);
      const s = this.states.get(k);
      if (!indexId || !s) continue;
      writes.push({
        ...(this.forwarded.get(k)?._id ? { _id: this.forwarded.get(k)!._id } : {}),
        index_id: indexId,
        metadata_type: s.kind === "text" ? "text_search" : "vector_search",
      });
    }
    return {
      writes,
      done: (ids: (string | undefined)[]) => {
        writes.forEach((w, i) => {
          const k = keys.find((x) => this.ids.get(x) === w.index_id)!;
          this.forwarded.set(k, { ts, _id: w._id ?? ids[i] });
        });
      },
    };
  }

  get(kind: "text" | "vector", tablet: number, name: string): IndexSegmentsState | undefined {
    return this.states.get(stateKey(kind, tablet, name));
  }

  all(): IndexSegmentsState[] {
    return [...this.states.values()];
  }

  /**
   * Runs `change` on the states once the writes before it are done, then writes the rows it changed and runs
   * `stored` (unless `change` returns false: nothing to write). Resolves with whether it wrote; the next change
   * waits for it, so what `stored` does in memory is ordered with the rows' writes.
   */
  update(
    change: (states: Map<string, IndexSegmentsState>) => boolean | undefined,
    stored?: () => void,
  ): Promise<boolean> {
    const run = this.writes.then(async () => {
      const before = new Map([...this.states].map(([k, v]) => [k, JSON.stringify(stateToRow(v))]));
      if (change(this.states) === false) return false;
      const writes: IndexRowWrite[] = [];
      const inserted: string[] = [];
      for (const [k, v] of this.states) {
        const row = stateToRow(v);
        if (before.get(k) === JSON.stringify(row)) continue;
        const _id = this.ids.get(k);
        if (_id === undefined) inserted.push(k);
        writes.push(_id === undefined ? { row } : { _id, row });
      }
      const removed = [...this.ids.keys()].filter((k) => !this.states.has(k));
      for (const k of removed) writes.push({ _id: this.ids.get(k)! });
      if (writes.length) {
        const ids = await this.write(writes);
        inserted.forEach((k, i) => {
          this.ids.set(k, ids[i]!);
        });
        for (const k of removed) this.ids.delete(k);
      }
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
    if (!this.store || !this.blobs) return null;
    if (!s || !sameSpec(s.def, def) || !Number.isSafeInteger(s.ts) || this.currentTs(s) > at) return null;
    if (this.currentTs(s) < Number((await this.store.getGlobal(MIN_DOCUMENT_TS_GLOBAL)) ?? 0)) return null;
    return s;
  }

  /** The stored segments of `s` (null when a blob is missing: the index is built from its table). */
  async fetch(s: IndexSegmentsState): Promise<StoredSegment[] | null> {
    const blobs = this.blobs;
    if (!blobs) return null;
    const parts = await Promise.all(
      s.segments.map(async (r) => {
        const segment = await blobs.get(r.segment);
        const deletes = await blobs.get(r.deletes);
        if (!segment || !deletes) return null;
        return { segment, deletes, keys: { segment: r.segment, deletes: r.deletes } };
      }),
    );
    return parts.every((p) => p !== null) ? (parts as StoredSegment[]) : null;
  }
}

/** An index's segments as stored, from its parts in memory (each with its stored keys). */
export function segmentRefs(
  parts: readonly {
    segment: { numDocs: number; uid: string };
    deletes: { count: number };
    keys?: { segment: string; deletes: string | null };
  }[],
  size: (segment: { numDocs: number; uid: string }) => number,
): SegmentRef[] {
  return parts.map((p) => {
    if (!p.keys?.deletes) throw new Error("a segment that is not stored");
    return {
      segment: p.keys.segment,
      deletes: p.keys.deletes,
      docs: p.segment.numDocs,
      deleted: p.deletes.count,
      bytes: size(p.segment),
      id: p.segment.uid,
    };
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
