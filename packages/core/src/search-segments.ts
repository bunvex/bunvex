// Persisted search segments (STUDY-111; STUDY-79 option E, owner 2026-10-05). Each text and vector index is
// segments in the `search` blob use case plus a memory part (`@bunvex/search`'s `SegmentedIndex`); this module
// keeps their state — which segments, current at which ts — and reads it back at a start.
//
// Every search and vector index of the schema has an `_index` row in Convex's shape (`{table_id, descriptor,
// config}`, its `config` Convex's `IndexConfig::Text` / `IndexConfig::Vector`, every integer an Int64), so `_index`
// holds the rows Convex's does (STUDY-111 §3.7). Convex cannot read bunvex's segments, nor bunvex Convex's, so the
// row's `onDiskState` is always `backfilling` (with its `staged` flag): the Convex binary opening the store builds
// the index itself (STUDY-133 Q5, DV-415). bunvex's own state — the segments, the ts they are current at, a
// backfill's cursor — is in the bunvex-only global `search_index_segments`, by index, with the id of the row it
// belongs to; a state whose row is gone, or is no longer the row bunvex wrote, is not used. The global names only
// blobs already written. A start loads an index's segments and replays the document log since its ts, as Convex's
// bootstrap; a state it cannot trust is not used, and the index is built from its table instead.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredSegment } from "@bunvex/search";
import { encodeId } from "@bunvex/values";
import { internalIdBytes, internalIdOf } from "./internal-id.ts";
import type { DocLogRow, Persistence, RetentionStore, TabletId } from "./persistence/index.ts";
import { readTsGlobal } from "./persistence-globals.ts";
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

/** A row as a comparable string (int64 fields are `bigint`s, which JSON cannot hold). */
const rowKey = (row: unknown) => JSON.stringify(row, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
/** The bunvex-only global holding each search and vector index's state (STUDY-133 Q5, DV-415). */
export const SEGMENTS_GLOBAL = "search_index_segments";
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
  /** The local file a blob is kept in, when the store keeps blobs as files (its segments are mapped from there). */
  localPath?(key: string): string | null;
};

/**
 * Segments read from local files rather than held in memory (STUDY-111 PR 9, DV-371 resolved), as Convex's
 * searcher reads memory-mapped archives from its local cache (`search/src/archive/cache.rs`): a segment's bytes
 * are `Bun.mmap` of the store's own file when it has one, else of a copy written once to `cacheDir` (for a store
 * such as S3). Segments are read in place (§3.1), so a mapped file serves as a loaded one does; the OS pages them
 * in and drops them. Mappings are private (copy-on-write), so nothing can write through to a stored blob. Deletes
 * stay in memory: they are small and rewritten.
 *
 * The cache, as Convex's (a temporary directory per process), starts empty, and holds the segments the indexes
 * use: one no index names any more is removed from it (its mapping, if still read, stays valid until dropped).
 * The store's own files are never removed (DV-370).
 */
export class SegmentFiles {
  constructor(
    private blobs: SearchSegmentStore,
    private cacheDir: string | null,
  ) {
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /** Whether segments can be mapped at all (the store's files, or a cache directory). */
  get enabled(): boolean {
    return typeof this.blobs.localPath === "function" || this.cacheDir !== null;
  }

  /** Segments mapped so far (tests and measurements). */
  mapped = 0;

  /**
   * Segment `key` mapped from a local file (null: not possible, the caller keeps the bytes in memory). `bytes`:
   * the segment, when it was just written (no need to read it back for the cache).
   */
  async map(key: string, bytes?: Uint8Array): Promise<Uint8Array | null> {
    const own = this.blobs.localPath?.(key);
    if (own && existsSync(own)) {
      this.mapped++;
      return Bun.mmap(own, { shared: false });
    }
    if (!this.cacheDir) return null;
    const path = join(this.cacheDir, key);
    if (!existsSync(path)) {
      const data = bytes ?? (await this.blobs.get(key));
      if (!data) return null;
      // Written whole, then renamed: a mapped file is never one being written.
      const tmp = `${path}.${crypto.randomUUID()}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, path);
    }
    this.mapped++;
    return Bun.mmap(path, { shared: false });
  }

  /** Segments no index names any more: their cached copies are removed (never the store's own files). */
  release(keys: Iterable<string>) {
    if (!this.cacheDir) return;
    for (const key of keys) rmSync(join(this.cacheDir, key), { force: true });
  }
}

/** The segment blobs the states name. */
function segmentKeys(states: Map<string, IndexSegmentsState>): Set<string> {
  const keys = new Set<string>();
  for (const s of states.values()) for (const r of s.segments) keys.add(r.segment);
  return keys;
}

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
  tablet: TabletId;
  name: string;
  def: SearchIndexDef | VectorIndexDef;
  /**
   * Every commit up to `ts` is in the segments (with their deletes); while backfilling, for the documents up to
   * the cursor only (Convex's `last_segment_ts`).
   */
  ts: bigint;
  segments: SegmentRef[];
  /** While the index is built from its table: the last document id read (null: none yet). */
  backfill?: { cursor: string | null };
  staged: boolean;
};

export const stateKey = (kind: "text" | "vector", tablet: TabletId, name: string) =>
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

/**
 * An `_index` row of a search or vector index, as stored: Convex's `SerializedTabletIndexMetadata`, `table_id`
 * (the tablet), `descriptor` (the name) and `config` as Convex serializes `IndexConfig`.
 */
export type SearchIndexRow = { _id?: string; table_id: TabletId; descriptor: string; config: Record<string, unknown> };

/** Whether an `_index` row is a search or vector index's (a database index's `config` is of type `database`). */
export const isSearchIndexRow = (row: Record<string, unknown>) => {
  const type = (row.config as { type?: string } | undefined)?.type;
  return type === "search" || type === "vector";
};

/**
 * The `_index` row bunvex writes for a state: Convex's `SerializedIndexConfig::Search` / `::Vector` with
 * `onDiskState` `backfilling` (Convex's empty `Backfilling { staged }`, and the vector one with no segment and no
 * cursor), so the Convex binary builds the index itself; `dimensions` an Int64, as Convex's `i64`.
 */
export function convexRow(s: IndexSegmentsState): SearchIndexRow {
  const filterFields = [...s.def.filterFields].sort();
  if (s.kind === "text")
    return {
      table_id: s.tablet,
      descriptor: s.name,
      config: {
        type: "search",
        searchField: (s.def as SearchIndexDef).searchField,
        filterFields,
        onDiskState: { state: "backfilling", staged: s.staged },
      },
    };
  const def = s.def as VectorIndexDef;
  return {
    table_id: s.tablet,
    descriptor: s.name,
    config: {
      type: "vector",
      dimensions: BigInt(def.dimensions),
      vectorField: def.vectorField,
      filterFields,
      onDiskState: { state: "backfilling", segments: [], table_scan_cursor: null, last_segment_ts: null, staged: s.staged },
    },
  };
}

/** Whether a row is one `convexRow` wrote (so the state saved for it in the global is still its). */
const isOwnRow = (row: Record<string, unknown>) => {
  const o = (row.config as { onDiskState?: Record<string, unknown> } | undefined)?.onDiskState;
  if (!o || o.state !== "backfilling") return false;
  return o.segments === undefined || (Array.isArray(o.segments) && o.segments.length === 0 && o.table_scan_cursor === null);
};

/** The global's JSON: bigints and bytes tagged, so a state reads back as it was. */
const encodeGlobal = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) =>
      typeof x === "bigint"
        ? { $bigint: x.toString() }
        : x instanceof ArrayBuffer
          ? { $bytes: Buffer.from(x).toString("base64") }
          : x,
    ),
  );
const decodeGlobal = (v: unknown) =>
  JSON.parse(JSON.stringify(v), (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? typeof x.$bigint === "string"
        ? BigInt(x.$bigint)
        : typeof x.$bytes === "string"
          ? (Buffer.from(x.$bytes, "base64").buffer as ArrayBuffer)
          : x
      : x,
  );

/** The global's content: each index's state as its full row, by state key, with the id of its `_index` row. */
type SavedStates = { version: 1; indexes: Record<string, { rowId: string; row: SearchIndexRow }> };

/** The states saved in the global, by state key (an absent or unreadable global: none). */
export function readSavedStates(value: unknown): Map<string, { rowId: string; state: IndexSegmentsState }> | null {
  if (value === null || value === undefined) return null;
  const out = new Map<string, { rowId: string; state: IndexSegmentsState }>();
  try {
    const g = decodeGlobal(value) as SavedStates;
    if (g.version !== 1) return out;
    for (const [k, e] of Object.entries(g.indexes)) {
      const state = rowToState(e.row as unknown as Record<string, unknown>);
      if (state && typeof e.rowId === "string") out.set(k, { rowId: e.rowId, state });
    }
  } catch {}
  return out;
}

/**
 * A state as a full row: Convex's `SerializedIndexConfig::Search` / `::Vector` with the segment list. bunvex keeps
 * it in its global (`search_index_segments`), not in `_index` (`convexRow`).
 */
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
    const snapshot = { data: { data_type: "MultiSegment", segments }, ts: s.ts, version: TEXT_SNAPSHOT_VERSION };
    // Built and staged: Convex's `Backfilled2 { snapshot, staged }`; built and enabled: `Snapshotted`.
    if (!building)
      onDiskState = s.staged ? { state: "backfilled2", snapshot, staged: true } : { state: "snapshotted", ...snapshot };
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
      table_id: s.tablet,
      descriptor: s.name,
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
  const snapshot = { data: { data_type: "MultiSegment", segments }, ts: s.ts };
  if (!building)
    onDiskState = s.staged ? { state: "backfilled2", snapshot, staged: true } : { state: "snapshotted", ...snapshot };
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
    table_id: s.tablet,
    descriptor: s.name,
    config: { type: "vector", dimensions: def.dimensions, vectorField: def.vectorField, filterFields, onDiskState },
  };
}

/** A state from its `_index` row; null when the row is not one bunvex can read. */
export function rowToState(row: Record<string, unknown>): IndexSegmentsState | null {
  try {
    const c = row.config as Record<string, unknown>;
    const o = c.onDiskState as Record<string, unknown>;
    const tablet = row.table_id as TabletId;
    const name = row.descriptor as string;
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
      if (o.state === "snapshotted" || o.state === "backfilled2") {
        const snap = (o.state === "snapshotted" ? o : o.snapshot) as {
          data: { segments: unknown };
          ts: bigint;
          version: number;
        };
        if (snap.version !== TEXT_SNAPSHOT_VERSION) return null;
        const staged = o.state === "backfilled2" && !!o.staged;
        return { kind: "text", tablet, name, def, ts: snap.ts, segments: segs(snap.data.segments), staged };
      }
      if (o.state === "backfilling")
        return {
          kind: "text",
          tablet,
          name,
          def,
          ts: 0n,
          segments: [],
          backfill: { cursor: null },
          staged: !!o.staged,
        };
      if (o.state === "backfilling2") {
        const cur = o.cursor as { table_scan_cursor: ArrayBuffer; last_segment_ts: bigint } | null;
        return {
          kind: "text",
          tablet,
          name,
          def,
          ts: cur ? cur.last_segment_ts : 0n,
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
      if (o.state === "snapshotted" || o.state === "backfilled2") {
        const snap = (o.state === "snapshotted" ? o : o.snapshot) as { data: { segments: unknown }; ts: bigint };
        const staged = o.state === "backfilled2" && !!o.staged;
        return { kind: "vector", tablet, name, def, ts: snap.ts, segments: segs(snap.data.segments), staged };
      }
      if (o.state === "backfilling") {
        const cursor = o.table_scan_cursor as ArrayBuffer | null;
        return {
          kind: "vector",
          tablet,
          name,
          def,
          ts: (o.last_segment_ts as bigint | null) ?? 0n,
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

type Store = Persistence & Pick<RetentionStore, "readDocumentLog">;

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
  /** Each index's `_index` row as stored, to write it only when it changes. */
  private stored = new Map<string, string>();
  /** The global as last written. */
  private savedKey: string | null = null;
  /** Each index's fast-forward ts (Convex's `_index_worker_metadata`), by state key, with its row's id. */
  private forwarded = new Map<string, { ts: bigint; _id?: string }>();
  /** Where segments are mapped from, when they are read from disk (STUDY-111 PR 9). */
  files: SegmentFiles | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    /** The store, when it has what segments need (else the rows are kept, and no segment). */
    readonly store: Store | null,
    /** Where segments are kept; null: none (the rows are kept, every index is built from its table). */
    readonly blobs: SearchSegmentStore | null,
    /** Writes `_index` rows in one transaction; returns the ids of the inserted ones, in order. */
    private write: (writes: IndexRowWrite[]) => Promise<string[]>,
  ) {}

  /**
   * The states at a start: each `_index` row's, from the global (`saved`), when the row is still the one bunvex
   * wrote for it. A store from before the global (null) keeps its rows' states, which held the segments; anything
   * else is no state, and the index is built from its table. Every row is rewritten in Convex's shape by the next
   * `update` (`rewriteRows`).
   */
  load(rows: Record<string, unknown>[], saved: Map<string, { rowId: string; state: IndexSegmentsState }> | null = null) {
    for (const r of rows) {
      if (!isSearchIndexRow(r)) continue;
      const kind = (r.config as { type: string }).type === "search" ? "text" : "vector";
      const key = stateKey(kind, r.table_id as TabletId, r.descriptor as string);
      this.ids.set(key, r._id as string);
      const { _id, ...row } = r;
      this.stored.set(key, rowKey(row));
      const entry = saved?.get(key);
      const s = saved === null ? rowToState(r) : entry && entry.rowId === _id && isOwnRow(r) ? entry.state : null;
      if (s) this.states.set(key, s);
    }
  }

  /** Writes every row not yet in Convex's shape, and the global (at a start, after `load`). */
  rewriteRows(): Promise<boolean> {
    return this.update(() => true);
  }

  /**
   * The fast-forward ts of the `_index_worker_metadata` rows, by their `_index` row's internal id (Convex's
   * `InternalId` string; a row from before STUDY-133 §12 M7 holds the document id, read too).
   */
  loadForwarded(rows: Record<string, unknown>[]) {
    const keyOf = new Map<string, string>();
    for (const [k, id] of this.ids) {
      keyOf.set(id, k);
      keyOf.set(internalIdOf(id), k);
    }
    for (const r of rows) {
      const k = keyOf.get(r.index_id as string);
      const meta = r.index_metadata as { metadata?: { fast_forward_ts?: bigint } } | undefined;
      const ts = meta?.metadata?.fast_forward_ts;
      if (k !== undefined && typeof ts === "bigint") this.forwarded.set(k, { ts, _id: r._id as string });
    }
  }

  /**
   * The ts an index's state is current at: its segments' (`ts`), or later when it was fast-forwarded with nothing
   * written since (Convex's `max(snapshot ts, fast_forward_ts)`).
   */
  currentTs(s: IndexSegmentsState): bigint {
    const f = s.backfill ? undefined : this.forwarded.get(stateKey(s.kind, s.tablet, s.name));
    return f && f.ts > s.ts ? f.ts : s.ts;
  }

  /**
   * The `_index_worker_metadata` writes that move these indexes' fast-forward ts to `ts` (their `_index` rows'
   * ids, the rows to insert or patch), and once they are stored, `done` records them.
   */
  forward(keys: string[], ts: bigint) {
    const writes: { _id?: string; index_id: string; metadata_type: string }[] = [];
    for (const k of keys) {
      const indexId = this.ids.get(k);
      const s = this.states.get(k);
      if (!indexId || !s) continue;
      writes.push({
        ...(this.forwarded.get(k)?._id ? { _id: this.forwarded.get(k)!._id } : {}),
        // Convex's `InternalId` string of the `_index` row, not its document id (Convex refuses a longer one).
        index_id: internalIdOf(indexId),
        metadata_type: s.kind === "text" ? "text_search" : "vector_search",
      });
    }
    return {
      writes,
      done: (ids: (string | undefined)[]) => {
        writes.forEach((w, i) => {
          const k = keys.find((x) => this.ids.has(x) && internalIdOf(this.ids.get(x)!) === w.index_id)!;
          this.forwarded.set(k, { ts, _id: w._id ?? ids[i] });
        });
      },
    };
  }

  /** The id of an index's `_index` row, once written. */
  rowId(kind: "text" | "vector", tablet: TabletId, name: string): string | undefined {
    return this.ids.get(stateKey(kind, tablet, name));
  }

  get(kind: "text" | "vector", tablet: TabletId, name: string): IndexSegmentsState | undefined {
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
      const keysBefore = this.files ? segmentKeys(this.states) : null;
      if (change(this.states) === false) return false;
      const writes: IndexRowWrite[] = [];
      const inserted: string[] = [];
      const rows = new Map<string, string>();
      for (const [k, v] of this.states) {
        const row = convexRow(v);
        const key = rowKey(row);
        rows.set(k, key);
        if (this.stored.get(k) === key) continue;
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
        for (const k of removed) {
          this.ids.delete(k);
          this.stored.delete(k);
        }
        for (const [k, key] of rows) this.stored.set(k, key);
      }
      // Then the states, by row (the rows exist by now): what a start restores from.
      if (this.store) {
        const indexes: SavedStates["indexes"] = {};
        for (const [k, v] of this.states) {
          const rowId = this.ids.get(k);
          if (rowId !== undefined) indexes[k] = { rowId, row: stateToRow(v) };
        }
        const value = encodeGlobal({ version: 1, indexes } satisfies SavedStates);
        const key = JSON.stringify(value);
        if (key !== this.savedKey) {
          await this.store.setGlobal(SEGMENTS_GLOBAL, value);
          this.savedKey = key;
        }
      }
      stored?.();
      if (keysBefore) {
        const now = segmentKeys(this.states);
        this.files!.release([...keysBefore].filter((k) => !now.has(k)));
      }
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
    tablet: TabletId,
    name: string,
    def: SearchIndexDef | VectorIndexDef,
    at: bigint,
  ): Promise<IndexSegmentsState | null> {
    const s = this.get(kind, tablet, name);
    if (!this.store || !this.blobs) return null;
    if (!s || !sameSpec(s.def, def) || typeof s.ts !== "bigint" || s.ts < 0n || this.currentTs(s) > at) return null;
    if (this.currentTs(s) < readTsGlobal(await this.store.getGlobal(MIN_DOCUMENT_TS_GLOBAL))) return null;
    return s;
  }

  /** The stored segments of `s` (null when a blob is missing: the index is built from its table). */
  async fetch(s: IndexSegmentsState): Promise<StoredSegment[] | null> {
    const blobs = this.blobs;
    if (!blobs) return null;
    const files = this.files;
    const parts = await Promise.all(
      s.segments.map(async (r) => {
        const segment = (files ? await files.map(r.segment) : null) ?? (await blobs.get(r.segment));
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
  private reads = new Map<
    TabletId,
    { since: bigint; changes: Promise<Map<string, { ts: bigint; doc: Doc | null }>> }
  >();

  constructor(
    private store: Store,
    readonly at: bigint,
    private decode: (json: string) => Doc,
    /** The oldest ts each table's indexes start from (the log is read once from there). */
    private oldest: Map<TabletId, bigint>,
    /** A table's number, for its documents' ids. */
    private numberOf: (tablet: TabletId) => number,
  ) {}

  /** Each document of `tablet` the log changed in `(since, at]`, at its state as of `at`. */
  async since(tablet: TabletId, since: bigint): Promise<[string, Doc | null][]> {
    let r = this.reads.get(tablet);
    if (!r) {
      const oldest = this.oldest.get(tablet) ?? since;
      const from = oldest < since ? oldest : since;
      r = { since: from, changes: this.read(tablet, from) };
      this.reads.set(tablet, r);
    }
    if (since < r.since) throw new Error(`the log of table ${tablet} was read from ${r.since}, not ${since}`);
    const out: [string, Doc | null][] = [];
    for (const [id, c] of await r.changes) if (c.ts > since) out.push([id, c.doc]);
    return out;
  }

  private read(tablet: TabletId, since: bigint) {
    return changedSince(this.store, tablet, this.numberOf(tablet), since, this.at, this.decode);
  }
}

/**
 * Each document of `tablet` the document log changed in `(since, at]`, with the ts of its last change there and
 * its state as of `at` (null: deleted).
 */
export async function changedSince(
  store: Store,
  tablet: TabletId,
  /** The table's number: the log keys documents by internal id, the indexes by document id. */
  tableNumber: number,
  since: bigint,
  at: bigint,
  decode: (json: string) => Doc,
  keep: (id: string) => boolean = () => true,
): Promise<Map<string, { ts: bigint; doc: Doc | null }>> {
  // By internal id: the document's id and the ts of its last change.
  const last = new Map<string, { id: string; ts: bigint }>();
  for (let cursor = since; cursor < at; ) {
    const rows: DocLogRow[] = await store.readDocumentLog(cursor, at, LOG_PAGE);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.table !== tablet) continue;
      const id = encodeId(tableNumber, internalIdBytes(r.id));
      if (keep(id)) last.set(r.id, { id, ts: r.ts });
    }
    cursor = rows[rows.length - 1]!.ts;
  }
  const out = new Map<string, { ts: bigint; doc: Doc | null }>();
  const internals = [...last.keys()];
  for (let i = 0; i < internals.length; i += VERSIONS_PAGE) {
    const page = internals.slice(i, i + VERSIONS_PAGE);
    const versions = await store.getVersions!(tablet, page, at);
    page.forEach((internal, k) => {
      const l = last.get(internal)!;
      out.set(l.id, { ts: l.ts, doc: versions[k] ? decode(versions[k]!.json) : null });
    });
  }
  return out;
}
