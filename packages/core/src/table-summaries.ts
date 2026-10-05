// Table summaries (STUDY-52 PR 2), as Convex's `TableSummary` (crates/database/src/table_summary.rs): per
// table, its number of documents, their total size and their counted shape. Kept up to date by every commit
// as it becomes visible (each written document's old version removed, its new one added), so counts, sizes
// and shapes are those of the latest visible state. As Convex, they are checkpointed into a persistence global
// and restored on start from it and the document log (STUDY-72, table-summary-checkpoint.ts), else rebuilt
// from the documents at one snapshot; the commits meanwhile applied once that is done. Counts and sizes move with each commit; shapes are folded in when
// asked or in the background, so a commit costs little more than Convex's.
import { rawValueSize, type Value } from "@bunvex/values";
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

export type TableSummary = { count: number; size: number; shape: Shape };

/**
 * A checkpoint of every table's summary at one ts (STUDY-72), as Convex's `TableSummarySnapshot` JSON in the
 * `table_summary_v2` persistence global: per tablet its total size (a decimal string, as Convex's
 * `JsonInteger`) and its counted shape, whose count is the table's; and the ts.
 */
export type SummaryCheckpoint = {
  ts: string;
  tables: Record<string, { totalSize: string; inferredTypeWithOptionalFields: ShapeJson }>;
};

/** Asked for before the summaries are built (Convex's `TableSummariesUnavailable`, a 503: retry). */
export class TableSummariesUnavailableError extends Error {
  readonly code = "TableSummariesUnavailable";
  constructor() {
    super("Table summary unavailable (still bootstrapping)");
    this.name = "TableSummariesUnavailableError";
  }
}

type Write = { tablet: number; old: Doc | null; next: Doc | null };

/** Shape changes waiting to be folded in: past this many, they are folded in the background. */
const FOLD_AFTER = 1000;

export class TableSummaries {
  private tables = new Map<number, { count: number; size: number; shape: Shape }>();
  /**
   * Each commit's documents, not yet in the shapes: counts and sizes are kept at once, shapes when asked
   * (or in the background), so a commit pays no more than Convex's (whose shapes only move at checkpoints).
   */
  private pendingShapes: Write[] = [];
  private folding = false;
  /** Commits that became visible while the summaries were being built, with their ts. */
  private queued: { ts: number; writes: Write[] }[] | null = [];
  /** The snapshot the build read (commits at or before it are in the scan). */
  private builtAt: number | null = null;
  /** The ts the summaries are at: the last commit applied, or the build's snapshot. */
  private at = 0;
  /** Commits applied since the build (Convex's `write_commits_since_load`), for checkpoint pacing. */
  commits = 0;

  get ready() {
    return this.queued === null;
  }

  /** One table's summary (an empty one for a table with no documents). */
  get(tablet: number): TableSummary {
    if (!this.ready) throw new TableSummariesUnavailableError();
    this.fold();
    return this.tables.get(tablet) ?? { count: 0, size: 0, shape: NEVER };
  }

  /** One table's count, without folding the shapes in (the commit path's cost). */
  count(tablet: number): number {
    if (!this.ready) throw new TableSummariesUnavailableError();
    return this.tables.get(tablet)?.count ?? 0;
  }

  /** A commit's writes, as it becomes visible. */
  apply(ts: number, writes: Write[]) {
    if (this.queued) {
      this.queued.push({ ts, writes });
      return;
    }
    for (const w of writes) this.applyOne(w);
    this.at = ts;
    this.commits++;
    if (this.pendingShapes.length >= FOLD_AFTER && !this.folding) {
      this.folding = true;
      setImmediate(() => {
        this.folding = false;
        this.fold();
      });
    }
  }

  private applyOne(w: Write) {
    const s = this.tables.get(w.tablet) ?? { count: 0, size: 0, shape: NEVER };
    if (w.old) {
      s.count--;
      s.size -= rawValueSize(w.old as Value);
    }
    if (w.next) {
      s.count++;
      s.size += rawValueSize(w.next as Value);
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
  restore(at: number, checkpoint: SummaryCheckpoint, tablets: Set<number>) {
    const tables = new Map<number, { count: number; size: number; shape: Shape }>();
    for (const [key, t] of Object.entries(checkpoint.tables)) {
      const tablet = Number(key);
      const size = Number(t.totalSize);
      const shape = shapeFromJson(t.inferredTypeWithOptionalFields);
      if (!Number.isSafeInteger(tablet) || !Number.isSafeInteger(size)) throw new Error("not a summary checkpoint");
      if (tablets.has(tablet) && shape.n > 0) tables.set(tablet, { count: shape.n, size, shape });
    }
    this.tables = tables;
    this.builtAt = at;
    this.at = at;
  }

  /** A document's version at the checkpoint (`old`) replaced by its version at the build's snapshot. */
  replace(tablet: number, old: Doc | null, next: Doc | null) {
    if (old || next) this.applyOne({ tablet, old, next });
  }

  /** Forget a failed restore's summaries before a scan. */
  reset() {
    this.tables = new Map();
    this.pendingShapes = [];
  }

  /** A checkpoint of the summaries as they are now (their shapes folded in). */
  checkpoint(): SummaryCheckpoint {
    if (!this.ready) throw new TableSummariesUnavailableError();
    this.fold();
    const tables: SummaryCheckpoint["tables"] = {};
    for (const [tablet, t] of this.tables)
      tables[tablet] = { totalSize: String(t.size), inferredTypeWithOptionalFields: shapeToJson(t.shape) };
    return { ts: String(this.at), tables };
  }

  /** The build: every document of a tablet as of the build's snapshot `at`. */
  build(at: number, tablet: number, docs: Iterable<Doc>) {
    this.builtAt = at;
    this.at = at;
    for (const d of docs) this.applyOne({ tablet, old: null, next: d });
    this.fold();
  }

  /** The build is done: the commits after its snapshot are applied, and from now on each as it comes. */
  finish() {
    const queued = this.queued ?? [];
    this.queued = null;
    for (const c of queued)
      if (this.builtAt === null || c.ts > this.builtAt) {
        for (const w of c.writes) this.applyOne(w);
        this.at = c.ts;
        this.commits++;
      }
  }
}
