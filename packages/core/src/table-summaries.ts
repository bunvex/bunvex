// Table summaries (STUDY-52 PR 2), as Convex's `TableSummary` (crates/database/src/table_summary.rs): per
// table, its number of documents, their total size and their counted shape. Kept up to date by every commit
// as it becomes visible (each written document's old version removed, its new one added), so counts, sizes
// and shapes are those of the latest visible state. As Convex, they are checkpointed into a persistence global
// and restored on start from it and the document log (STUDY-72, table-summary-checkpoint.ts), else rebuilt
// from the documents at one snapshot; the commits meanwhile applied once that is done. Counts and sizes move with each commit; shapes are folded in when
// asked or in the background, so a commit costs little more than Convex's.

import type { Value } from "@bunvex/values";
import { IndexesUnavailableError } from "./catalog.ts";
import { OutOfRetentionError } from "./committer.ts";
import { internalIdBytes } from "./internal-id.ts";
import type { TabletId } from "./persistence/index.ts";
import { fromJsonInteger, jsonInteger } from "./persistence-globals.ts";
import type { Doc } from "./schema.ts";
import {
  NEVER,
  removeValue,
  type Shape,
  type ShapeJson,
  ShapeRemovalError,
  shapeFromJson,
  shapeOf,
  shapeToJson,
  union,
} from "./shapes.ts";
import { sizeOfVersion } from "./staged-size.ts";

export type TableSummary = { count: number; size: number; shape: Shape };

/**
 * A checkpoint of every table's summary at one ts (STUDY-72), as Convex's `TableSummarySnapshot` JSON in the
 * `table_summary_v2` persistence global (STUDY-134): per table its total size (a `JsonInteger`: base64 of the
 * int64's little-endian bytes) and its counted shape, whose count is the table's; and the ts, a `JsonInteger`
 * of nanoseconds. Tables are keyed by bunvex's tablet number (Convex: its tablet id; DV-428, STUDY-133).
 */
export type SummaryCheckpoint = {
  ts: string;
  tables: Record<string, { totalSize: string; inferredTypeWithOptionalFields: ShapeJson }>;
};

/**
 * Asked for before the summaries are built (Convex's `TableSummariesUnavailable`, a 503: retry). Like the
 * indexes' (STUDY-79), a system error: a function that hits it cannot catch it, and a sync query is retried.
 */
export class TableSummariesUnavailableError extends IndexesUnavailableError {
  declare readonly code: "TableSummariesUnavailable";
  constructor(message = "Table summary unavailable (still bootstrapping)") {
    super("TableSummariesUnavailable", message);
    this.name = "TableSummariesUnavailableError";
  }
}

/** Convex's message for `count()` while the summaries bootstrap (`async_syscall.rs`, `count`). */
const COUNT_UNAVAILABLE = "Table count unavailable while bootstrapping";

type Write = { tablet: TabletId; old: Doc | null; next: Doc | null };

/** Shape changes waiting to be folded in: past this many, they are folded in the background. */
const FOLD_AFTER = 1000;

/** No transaction pins a snapshot: the largest int64, above every ts. */
const NO_PIN = (1n << 63n) - 1n;

export class TableSummaries {
  private tables = new Map<TabletId, { count: number; size: number; shape: Shape }>();
  /**
   * Each commit's documents, not yet in the shapes: counts and sizes are kept at once, shapes when asked
   * (or in the background), so a commit pays no more than Convex's (whose shapes only move at checkpoints).
   */
  private pendingShapes: Write[] = [];
  private folding = false;
  /** Commits that became visible while the summaries were being built, with their ts. */
  private queued: { ts: bigint; writes: Write[] }[] | null = [];
  /** The snapshot the build read (commits at or before it are in the scan). */
  private builtAt: bigint | null = null;
  /** The ts the summaries are at: the last commit applied, or the build's snapshot. */
  private at = 0n;
  /** Commits applied since the build (Convex's `write_commits_since_load`), for checkpoint pacing. */
  commits = 0;
  /**
   * The recent commits' count changes (STUDY-107), oldest first from `deltaHead`: a transaction counts at its
   * snapshot, as Convex's (whose count is its snapshot's summary), not at the latest commit.
   */
  private deltas: { ts: bigint; tablet: TabletId; d: number }[] = [];
  private deltaHead = 0;
  /** The build's snapshot: no count is known before it. */
  private builtFloor = 0n;
  /** The last change dropped: counts are known at every snapshot from it on. */
  private droppedTs = 0n;
  /**
   * Changes at or before this ts are dropped: the engine's write log start (`Committer.logStartTs`), so they
   * are kept as long as the commits themselves. A snapshot older than that is out of retention already.
   */
  retainedAfter: () => bigint = () => -1n;
  /**
   * The snapshots of the transactions running now, with how many hold each: their changes are kept for as long
   * as they run, however old, as Convex's transaction holds its count snapshot for its whole life.
   */
  private pins = new Map<bigint, number>();
  /** The oldest pinned snapshot (the largest int64 with none). */
  private oldestPin = NO_PIN;

  /** Keep the changes after `snapshot` until the returned function is called (once the transaction ends). */
  pin(snapshot: bigint): () => void {
    this.pins.set(snapshot, (this.pins.get(snapshot) ?? 0) + 1);
    if (snapshot < this.oldestPin) this.oldestPin = snapshot;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.pins.get(snapshot)! - 1;
      if (n > 0) {
        this.pins.set(snapshot, n);
        return;
      }
      this.pins.delete(snapshot);
      if (snapshot === this.oldestPin) {
        let oldest = NO_PIN;
        for (const s of this.pins.keys()) if (s < oldest) oldest = s;
        this.oldestPin = oldest;
      }
    };
  }

  get ready() {
    return this.queued === null;
  }

  /** One table's summary (an empty one for a table with no documents). */
  get(tablet: TabletId): TableSummary {
    if (!this.ready) throw new TableSummariesUnavailableError();
    this.fold();
    return this.tables.get(tablet) ?? { count: 0, size: 0, shape: NEVER };
  }

  /** One table's count, without folding the shapes in (the commit path's cost). */
  count(tablet: TabletId): number {
    if (!this.ready) throw new TableSummariesUnavailableError();
    return this.tables.get(tablet)?.count ?? 0;
  }

  /**
   * `tablet`'s count at `snapshot` (at most the latest commit's ts): the latest, less the changes committed
   * since. Before the build, Convex's bootstrapping error. A snapshot no running transaction pinned and older
   * than the write log keeps is out of retention (a transaction begun there, as Convex refuses one).
   */
  countAt(tablet: TabletId, snapshot: bigint): number {
    if (!this.ready || snapshot < this.builtFloor) throw new TableSummariesUnavailableError(COUNT_UNAVAILABLE);
    if (snapshot < this.droppedTs) throw new OutOfRetentionError(snapshot, this.droppedTs);
    let n = this.tables.get(tablet)?.count ?? 0;
    for (let i = this.deltas.length - 1; i >= this.deltaHead && this.deltas[i].ts > snapshot; i--)
      if (this.deltas[i].tablet === tablet) n -= this.deltas[i].d;
    return n;
  }

  /** A commit's writes, as it becomes visible. */
  apply(ts: bigint, writes: Write[]) {
    if (this.queued) {
      this.queued.push({ ts, writes });
      return;
    }
    this.applyCommit(ts, writes);
    this.commits++;
    if (this.pendingShapes.length >= FOLD_AFTER && !this.folding) {
      this.folding = true;
      setImmediate(() => {
        this.folding = false;
        this.fold();
      });
    }
  }

  /** A commit's writes, with its count changes kept for `countAt`; the changes past retention are dropped. */
  private applyCommit(ts: bigint, writes: Write[]) {
    const deltas = this.deltas;
    for (const w of writes) {
      this.applyOne(w);
      const d = (w.next ? 1 : 0) - (w.old ? 1 : 0);
      if (d === 0) continue;
      const last = deltas.length > this.deltaHead ? deltas[deltas.length - 1] : undefined;
      if (last && last.ts === ts && last.tablet === w.tablet) last.d += d;
      else deltas.push({ ts, tablet: w.tablet, d });
    }
    this.at = ts;
    // Dropped once both the write log and every running transaction are past them.
    const retained = this.retainedAfter();
    const horizon = retained < this.oldestPin ? retained : this.oldestPin;
    while (this.deltaHead < deltas.length && deltas[this.deltaHead].ts <= horizon)
      this.droppedTs = deltas[this.deltaHead++].ts;
    // Compact once the dropped prefix is the larger part: amortized O(1) per commit.
    if (this.deltaHead > 1024 && this.deltaHead * 2 > deltas.length) {
      this.deltas = deltas.slice(this.deltaHead);
      this.deltaHead = 0;
    }
  }

  private applyOne(w: Write) {
    const s = this.tables.get(w.tablet) ?? { count: 0, size: 0, shape: NEVER };
    if (w.old) {
      s.count--;
      s.size -= sizeOfVersion(w.old);
    }
    if (w.next) {
      s.count++;
      s.size += sizeOfVersion(w.next);
    }
    this.tables.set(w.tablet, s);
    this.pendingShapes.push(w);
  }

  /** Fold the waiting changes into the shapes, in commit order. */
  private fold() {
    const pending = this.pendingShapes;
    if (!pending.length) return;
    this.pendingShapes = [];
    for (const w of pending) {
      const s = this.tables.get(w.tablet);
      if (!s) continue;
      if (w.old) {
        try {
          s.shape = removeValue(s.shape, w.old as Value);
        } catch (e) {
          // The summary lost track of a document: what remains is `Unknown`, as Convex resets a table's
          // shape it cannot maintain.
          if (!(e instanceof ShapeRemovalError)) throw e;
          s.shape = { n: Math.max(0, s.shape.n - 1), v: { kind: "Unknown" } };
          if (s.shape.n === 0) s.shape = NEVER;
        }
      }
      if (w.next) s.shape = union([s.shape, shapeOf(w.next as Value)]);
    }
    for (const [tablet, s] of this.tables) if (s.count === 0) this.tables.delete(tablet);
  }

  /**
   * The build from a checkpoint (STUDY-72): its summaries for the tablets that still exist, as of the build's
   * snapshot `at`; `replace` then moves each document the log changed since the checkpoint.
   */
  restore(at: bigint, checkpoint: SummaryCheckpoint, tablets: Set<TabletId>) {
    const tables = new Map<TabletId, { count: number; size: number; shape: Shape }>();
    for (const [key, t] of Object.entries(checkpoint.tables)) {
      // Keyed by tablet, as Convex prints a `TabletId`.
      const tablet: TabletId = key;
      internalIdBytes(tablet);
      const size = Number(fromJsonInteger(t.totalSize));
      const shape = shapeFromJson(t.inferredTypeWithOptionalFields);
      if (!Number.isSafeInteger(size)) throw new Error("not a summary checkpoint");
      if (tablets.has(tablet) && shape.n > 0) tables.set(tablet, { count: shape.n, size, shape });
    }
    this.tables = tables;
    this.builtAt = at;
    this.at = at;
    this.builtFloor = at;
  }

  /** A document's version at the checkpoint (`old`) replaced by its version at the build's snapshot. */
  replace(tablet: TabletId, old: Doc | null, next: Doc | null) {
    if (old || next) this.applyOne({ tablet, old, next });
  }

  /** Forget a failed restore's summaries before a scan. */
  reset() {
    this.tables = new Map();
    this.pendingShapes = [];
  }

  /**
   * A checkpoint of the summaries as they are now (their shapes folded in). As Convex's, it has an entry for
   * every table that exists (`tablets`), an empty table's with size 0 and shape `Never`: Convex fails to count
   * a write to a table its loaded checkpoint has no entry for ("Updating non-existent table", STUDY-133 §12 M3).
   */
  checkpoint(tablets: Iterable<TabletId> = []): SummaryCheckpoint {
    if (!this.ready) throw new TableSummariesUnavailableError();
    this.fold();
    const tables: SummaryCheckpoint["tables"] = {};
    for (const tablet of tablets)
      tables[tablet] = { totalSize: jsonInteger(0n), inferredTypeWithOptionalFields: shapeToJson(NEVER) };
    for (const [tablet, t] of this.tables)
      tables[tablet] = {
        totalSize: jsonInteger(BigInt(t.size)),
        inferredTypeWithOptionalFields: shapeToJson(t.shape),
      };
    return { tables, ts: jsonInteger(this.at) };
  }

  /** The build: every document of a tablet as of the build's snapshot `at`. */
  build(at: bigint, tablet: TabletId, docs: Iterable<Doc>) {
    this.builtAt = at;
    this.at = at;
    this.builtFloor = at;
    for (const d of docs) this.applyOne({ tablet, old: null, next: d });
    this.fold();
  }

  /** The build is done: the commits after its snapshot are applied, and from now on each as it comes. */
  finish() {
    const queued = this.queued ?? [];
    this.queued = null;
    for (const c of queued)
      if (this.builtAt === null || c.ts > this.builtAt) {
        this.applyCommit(c.ts, c.writes);
        this.commits++;
      }
  }
}
