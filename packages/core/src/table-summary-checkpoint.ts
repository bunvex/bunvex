// Table summary checkpoints (STUDY-72), as Convex's `TableSummaryWorker` and `bootstrap`
// (crates/application/src/table_summary_worker.rs, crates/database/src/table_summary.rs): the summaries are
// written to the `table_summary_v2` persistence global, and on start loaded from it and brought up to date
// from the document log, instead of read from every document. Convex replays the log commit by commit with
// each change's previous revision; bunvex reads, for every document the log changed since the checkpoint,
// its version at the checkpoint and at the build's snapshot (two batched `getVersions` per table), which sums
// to the same counts and sizes. A checkpoint it cannot use — none, unreadable, ahead of the store, or outside
// document retention — falls back to the scan (DV-318; Convex retries it forever, the summaries unavailable).
import { outsideExecution } from "./determinism.ts";
import type { DocLogRow, Persistence, RetentionStore } from "./persistence/index.ts";
import type { Doc } from "./schema.ts";
import type { SummaryCheckpoint, TableSummaries } from "./table-summaries.ts";

/** Convex's `PersistenceGlobalKey::TableSummary`. */
export const TABLE_SUMMARY_GLOBAL = "table_summary_v2";
/** Retention's global for the oldest document snapshot it keeps (retention.ts). */
const MIN_DOCUMENT_TS_GLOBAL = "document_min_snapshot_ts";
const LOG_PAGE = 1000;
const VERSIONS_PAGE = 1000;

/** Convex's knobs, by its names. */
export type SummaryCheckpointOptions = {
  /** The worker's tick (Convex: a fixed 10 s). */
  intervalMs?: number;
  /** DATABASE_WORKERS_MIN_COMMITS: this many commits since the last checkpoint write one. Default 500. */
  minCommits?: number;
  /** TABLE_SUMMARY_MAX_AGE_WITH_WRITES: a checkpoint this old with any commit since is rewritten. 10 min. */
  maxStalenessMs?: number;
  /** TABLE_SUMMARY_MAX_CHECKPOINT_AGE: a checkpoint is rewritten at least this often. 4 h. */
  maxAgeMs?: number;
  /** TABLE_SUMMARY_AGE_JITTER_SECONDS (in ms): ± this much on the maximum age, at most half of it. 900 s. */
  jitterMs?: number;
  random?: () => number;
};

type Store = Persistence & Pick<RetentionStore, "readDocumentLog" | "getGlobal" | "setGlobal">;

/** Whether the store has what checkpoints need: the document log, versions and globals. */
export function canCheckpoint(p: Persistence): p is Store {
  const s = p as Partial<Store>;
  return (
    typeof s.readDocumentLog === "function" &&
    typeof s.getGlobal === "function" &&
    typeof s.setGlobal === "function" &&
    typeof p.getVersions === "function"
  );
}

/**
 * Load the checkpoint and bring it to `at` (the build's snapshot). False when there is none or it cannot be
 * used; the caller then scans. `decode` turns a stored document's JSON into a document.
 */
export async function restoreSummaries(
  store: Store,
  summaries: TableSummaries,
  at: number,
  tablets: Set<number>,
  decode: (json: string) => Doc,
): Promise<boolean> {
  const raw = (await store.getGlobal(TABLE_SUMMARY_GLOBAL)) as SummaryCheckpoint | null;
  if (raw === null || raw === undefined) return false;
  const from = Number(raw?.ts);
  if (!Number.isSafeInteger(from) || from > at) return false;
  const inRetention = async () => from >= Number((await store.getGlobal(MIN_DOCUMENT_TS_GLOBAL)) ?? 0);
  if (!(await inRetention())) return false;
  try {
    summaries.restore(at, raw, tablets);
  } catch {
    return false;
  }
  // Every document the log changed after the checkpoint, by table.
  const changed = new Map<number, Set<string>>();
  for (let cursor = from; cursor < at; ) {
    const rows: DocLogRow[] = await store.readDocumentLog(cursor, at, LOG_PAGE);
    if (!rows.length) break;
    for (const r of rows) {
      const ids = changed.get(r.table) ?? new Set<string>();
      changed.set(r.table, ids);
      ids.add(r.id);
    }
    cursor = rows[rows.length - 1].ts;
  }
  // Each one's version at the checkpoint out, its version now in.
  for (const [tablet, set] of changed) {
    // A table deleted since is gone from the summaries already.
    if (!tablets.has(tablet)) continue;
    const ids = [...set];
    for (let i = 0; i < ids.length; i += VERSIONS_PAGE) {
      const page = ids.slice(i, i + VERSIONS_PAGE);
      const [before, after] = await Promise.all([
        store.getVersions!(tablet, page, from),
        store.getVersions!(tablet, page, at),
      ]);
      for (let k = 0; k < page.length; k++)
        summaries.replace(tablet, before[k] ? decode(before[k]!.json) : null, after[k] ? decode(after[k]!.json) : null);
    }
  }
  // Retention may have pruned what the checkpoint needed meanwhile: then the result cannot be trusted.
  return inRetention();
}

/**
 * The checkpoint worker (Convex's `TableSummaryWorker`): every tick, it writes a checkpoint when enough
 * commits came since the last (500), when one came and the checkpoint is 10 min old, or when it is 4 h old
 * (± jitter). A lost lease ends it (`setGlobal` refuses); another failure is retried on the next tick.
 */
export class SummaryCheckpointer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  private last: { at: number; commits: number } | null = null;
  private maxAge: number;
  readonly o: Required<SummaryCheckpointOptions>;
  readonly stats = { written: 0, errors: 0 };

  constructor(
    private store: Store,
    private summaries: TableSummaries,
    opts: SummaryCheckpointOptions = {},
  ) {
    this.o = {
      intervalMs: opts.intervalMs ?? 10_000,
      minCommits: opts.minCommits ?? 500,
      maxStalenessMs: opts.maxStalenessMs ?? 600_000,
      maxAgeMs: opts.maxAgeMs ?? 4 * 3600_000,
      jitterMs: opts.jitterMs ?? 900_000,
      random: opts.random ?? Math.random,
    };
    this.maxAge = this.jittered();
  }

  private jittered() {
    const j = Math.min(this.o.jitterMs, this.o.maxAgeMs / 2);
    return this.o.maxAgeMs + j * (this.o.random() * 2 - 1);
  }

  /** Start ticking; the first tick writes a checkpoint (Convex's worker does until it has written one). */
  start() {
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = outsideExecution(() =>
      setTimeout(() => {
        this.running = this.tick().finally(() => {
          this.running = null;
          this.schedule(this.o.intervalMs);
        });
      }, ms),
    );
  }

  /** Write a checkpoint if one is due (or `force`). */
  async tick(force = false) {
    if (this.stopped) return;
    const now = Date.now();
    const commits = this.summaries.commits;
    if (!force && this.last) {
      const fresh = commits - this.last.commits;
      const age = now - this.last.at;
      if (fresh < this.o.minCommits && !(fresh > 0 && age >= this.o.maxStalenessMs) && age < this.maxAge) return;
    }
    try {
      await this.store.setGlobal(TABLE_SUMMARY_GLOBAL, this.summaries.checkpoint());
      this.last = { at: now, commits };
      this.maxAge = this.jittered();
      this.stats.written++;
    } catch (e) {
      this.stats.errors++;
      if ((e as Error).name === "LeaseLostError") this.stop();
      else if (!this.stopped) console.error(`bunvex: table summary checkpoint failed: ${(e as Error).message}`);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
