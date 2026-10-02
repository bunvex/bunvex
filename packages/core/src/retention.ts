// Retention: garbage collection of old versions (STUDY-33; Convex's crates/database/src/retention.rs).
//
// Two windows, as Convex's. The index window `minIndexTs` trails the newest commit by INDEX_RETENTION_DELAY
// (4 min): every snapshot at or above it reads index rows intact, and a read below it fails with
// `OutOfRetentionError` (the transaction checks before and after each read). The document window
// `minDocumentTs` trails by DOCUMENT_RETENTION_DELAY (14 days, DV-157), never above the index window.
//
// Both advance every 30 s (with jitter), only forward, and each new bound is written to a persistence global
// before it is used (Convex's `min_snapshot_ts` / `document_min_snapshot_ts`), so a restart never reads
// below what was deleted. Then two deleters work through the logs (PERSIST-01 C11/C12) from their cursors
// (`confirmed_deleted_ts` / `document_confirmed_deleted_ts`, checkpointed at most every 5 min):
//
//   index rows (R1, DV-154): for each row of the index log at or below the window, a live row deletes the
//     versions of its key below it, a tombstone deletes itself too: chunks of 512, at most 10 000 a pass;
//   document versions (R2, DV-155): the same over the document log, chunks of 256, at most 10 000 scanned a
//     pass, 256 a second, a pass a minute.
//
// It runs only in the process that holds the store's lease (Convex's leader), started by the engine.
import { type Committer, OutOfRetentionError } from "./committer.ts";
import type { DocPrune, IndexPrune, Persistence, RetentionStore } from "./persistence/index.ts";
import { LeaseLostError } from "./persistence/index.ts";

/** Convex's knobs (crates/common/src/knobs.rs), as milliseconds and counts. */
export type RetentionOptions = {
  /** INDEX_RETENTION_DELAY: how far the index window trails the newest commit. Default 240 s. */
  indexDelayMs?: number;
  /** DOCUMENT_RETENTION_DELAY: how far the document window trails it. Default 14 days. */
  documentDelayMs?: number;
  /** ADVANCE_RETENTION_TS_FREQUENCY: how often the windows move. Default 30 s (with jitter). */
  advanceEveryMs?: number;
  /** INDEX_RETENTION_DELETE_CHUNK. Default 512. */
  indexChunk?: number;
  /** DOCUMENT_RETENTION_DELETE_CHUNK. Default 256. */
  documentChunk?: number;
  /** RETENTION_DELETE_BATCH (index entries) and DOCUMENT_RETENTION_MAX_SCANNED_DOCUMENTS per pass. 10 000. */
  maxPerPass?: number;
  /** DOCUMENT_RETENTION_RATE_LIMIT: document versions deleted per second. Default 256. */
  documentRatePerSec?: number;
  /** DOCUMENT_RETENTION_BATCH_INTERVAL_SECONDS: how often the document deleter runs. Default 60 s. */
  documentEveryMs?: number;
  /** RETENTION_CHECKPOINT_PERIOD_SECS: how often a cursor is persisted. Default 300 s. */
  checkpointEveryMs?: number;
  /** MAX_RETENTION_DELAY_SECONDS: the longest backoff after an error. Default 60 s (from 50 ms). */
  maxBackoffMs?: number;
  /** Run the three loops (default). Tests that drive `advance` and the passes themselves turn it off. */
  background?: boolean;
};

const seconds = (name: string) => {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of seconds, got ${JSON.stringify(v)}`);
  return n * 1000;
};

/** Convex's global names (crates/common/src/persistence/mod.rs `PersistenceGlobalKey`). */
export const RETENTION_GLOBALS = {
  minIndexTs: "min_snapshot_ts",
  minDocumentTs: "document_min_snapshot_ts",
  indexCursor: "confirmed_deleted_ts",
  documentCursor: "document_confirmed_deleted_ts",
} as const;

/** Commits read from a log per round trip. */
const LOG_PAGE = 256;

export class Retention {
  readonly opts: Required<RetentionOptions>;
  /** The index window: snapshots below it fail. Starts at what the store recorded. */
  minIndexTs = 0;
  minDocumentTs = 0;
  /** Everything at or below these has been pruned. */
  indexCursor = 0;
  documentCursor = 0;
  readonly stats = { indexRowsDeleted: 0, documentRowsDeleted: 0, advances: 0, errors: 0 };
  private stopped = false;
  /** Sleeps in progress: their timer, and how to end them early (on stop). */
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private running = new Set<Promise<unknown>>();
  private lastCheckpoint = { index: 0, document: 0 };
  private wake: { index: (() => void) | null; document: (() => void) | null } = { index: null, document: null };

  constructor(
    private store: Persistence & RetentionStore,
    private committer: Committer,
    opts: RetentionOptions = {},
  ) {
    this.opts = {
      indexDelayMs: opts.indexDelayMs ?? seconds("INDEX_RETENTION_DELAY") ?? 240_000,
      documentDelayMs: opts.documentDelayMs ?? seconds("DOCUMENT_RETENTION_DELAY") ?? 14 * 86_400_000,
      advanceEveryMs: opts.advanceEveryMs ?? 30_000,
      indexChunk: opts.indexChunk ?? 512,
      documentChunk: opts.documentChunk ?? 256,
      maxPerPass: opts.maxPerPass ?? 10_000,
      documentRatePerSec: opts.documentRatePerSec ?? 256,
      documentEveryMs: opts.documentEveryMs ?? 60_000,
      checkpointEveryMs: opts.checkpointEveryMs ?? 300_000,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
      background: opts.background ?? true,
    };
  }

  /** Read the recorded windows and cursors (Convex's startup), then start the three loops. */
  async start() {
    const num = async (k: string) => {
      const v = await this.store.getGlobal(k);
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    this.minIndexTs = await num(RETENTION_GLOBALS.minIndexTs);
    this.minDocumentTs = Math.min(await num(RETENTION_GLOBALS.minDocumentTs), this.minIndexTs);
    this.indexCursor = Math.min(await num(RETENTION_GLOBALS.indexCursor), this.minIndexTs);
    this.documentCursor = Math.min(await num(RETENTION_GLOBALS.documentCursor), this.minDocumentTs);
    if (!this.opts.background) return;
    this.loop(
      "advance",
      () => this.jitter(this.opts.advanceEveryMs),
      () => this.advance(),
    );
    this.loop("index", null, () => this.deleteIndexes());
    this.loop(
      "document",
      () => this.jitter(this.opts.documentEveryMs),
      () => this.deleteDocuments(),
    );
  }

  /** Stop the loops and wait for a pass in flight. */
  async stop() {
    this.stopped = true;
    for (const [t, end] of this.timers) {
      clearTimeout(t);
      end();
    }
    this.timers.clear();
    this.wake.index?.();
    this.wake.document?.();
    await Promise.allSettled([...this.running]);
  }

  /** Convex's `validate_snapshot`: a read at `ts` is refused once the index window passed it. */
  check(ts: number) {
    if (ts < this.minIndexTs)
      throw new OutOfRetentionError(
        ts,
        this.minIndexTs,
        `Index snapshot timestamp out of leader retention window: ${ts} < ${this.minIndexTs}`,
      );
  }

  private jitter(ms: number) {
    return ms * (0.5 + Math.random());
  }

  /**
   * A loop: run `pass`, then wait `every()` (or, with null, until the window moves past the cursor). After a
   * failure, back off from 50 ms doubling up to `maxBackoffMs`. A lost lease or a stopped committer ends it.
   */
  private loop(name: "advance" | "index" | "document", every: (() => number) | null, pass: () => Promise<boolean>) {
    let backoff = 50;
    const run = async () => {
      while (!this.stopped && !this.committer.stopped) {
        let more = false;
        try {
          more = await pass();
          backoff = 50;
        } catch (e) {
          if (e instanceof LeaseLostError || this.committer.stopped || this.stopped) return;
          this.stats.errors++;
          console.error(`retention (${name}): ${e instanceof Error ? e.message : e}`);
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
          continue;
        }
        if (more) continue; // a pass stopped at its cap: the next one follows at once
        if (every) await this.sleep(every());
        else await this.waitForWork(name as "index" | "document");
      }
    };
    const p = run();
    this.running.add(p);
    p.finally(() => this.running.delete(p));
  }

  private sleep(ms: number) {
    return new Promise<void>((ok) => {
      if (this.stopped) return ok();
      const t = setTimeout(() => {
        this.timers.delete(t);
        ok();
      }, ms);
      t.unref?.();
      this.timers.set(t, ok);
    });
  }

  private waitForWork(which: "index" | "document") {
    return new Promise<void>((ok) => {
      if (this.stopped) return ok();
      this.wake[which] = () => {
        this.wake[which] = null;
        ok();
      };
    });
  }

  /**
   * Convex's `go_advance_min_snapshot`: each window trails the newest commit by its delay; it only moves
   * forward, the document window never above the index window, and the store records it first.
   */
  async advance(): Promise<boolean> {
    const top = this.committer.visibleTs;
    const idx = top - this.opts.indexDelayMs * 1000; // timestamps are wall-clock µs (STUDY-06 D9)
    if (idx > this.minIndexTs) {
      await this.store.setGlobal(RETENTION_GLOBALS.minIndexTs, idx);
      this.minIndexTs = idx;
      this.stats.advances++;
      this.wake.index?.();
    }
    const doc = Math.min(top - this.opts.documentDelayMs * 1000, this.minIndexTs);
    if (doc > this.minDocumentTs) {
      await this.store.setGlobal(RETENTION_GLOBALS.minDocumentTs, doc);
      this.minDocumentTs = doc;
    }
    return false;
  }

  /** Passes of one deleter never overlap (a loop's and a direct call's). */
  private passes = { index: Promise.resolve(false), document: Promise.resolve(false) };
  private exclusive(which: "index" | "document", pass: () => Promise<boolean>) {
    const next = this.passes[which].catch(() => false).then(pass);
    this.passes[which] = next;
    return next;
  }

  /** One pass of the index deleter (Convex's `go_delete_indexes`); whether it stopped at its cap. */
  deleteIndexes(): Promise<boolean> {
    return this.exclusive("index", () => this.indexPass());
  }

  /** One pass of the document deleter (Convex's `go_delete_documents`); whether it stopped at its cap. */
  deleteDocuments(): Promise<boolean> {
    return this.exclusive("document", () => this.documentPass());
  }

  private async indexPass(): Promise<boolean> {
    const upTo = this.minIndexTs;
    let done = 0;
    while (this.indexCursor < upTo && done < this.opts.maxPerPass && !this.stopped) {
      const page = await this.store.readLog!(this.indexCursor, upTo, LOG_PAGE);
      if (!page.length) {
        this.indexCursor = upTo;
        break;
      }
      const through = page[page.length - 1].ts;
      const entries: IndexPrune[] = [];
      for (const c of page)
        for (const w of c.writes) entries.push({ index: w.index, key: w.key, ts: w.id === null ? c.ts : c.ts - 1 });
      for (let i = 0; i < entries.length; i += this.opts.indexChunk)
        this.stats.indexRowsDeleted += await this.store.pruneIndexes(
          entries.slice(i, i + this.opts.indexChunk),
          through,
        );
      done += entries.length;
      this.indexCursor = through;
    }
    await this.checkpoint("index");
    return this.indexCursor < upTo;
  }

  private async documentPass(): Promise<boolean> {
    const upTo = this.minDocumentTs;
    let scanned = 0;
    while (this.documentCursor < upTo && scanned < this.opts.maxPerPass && !this.stopped) {
      const rows = await this.store.readDocumentLog(this.documentCursor, upTo, LOG_PAGE);
      if (!rows.length) {
        this.documentCursor = upTo;
        break;
      }
      const through = rows[rows.length - 1].ts;
      const entries: DocPrune[] = rows.map((r) => ({ table: r.table, id: r.id, ts: r.deleted ? r.ts : r.ts - 1 }));
      for (let i = 0; i < entries.length; i += this.opts.documentChunk) {
        const chunk = entries.slice(i, i + this.opts.documentChunk);
        const t0 = performance.now();
        this.stats.documentRowsDeleted += await this.store.pruneDocuments(chunk, through);
        // The rate limit: a chunk of n takes at least n / rate seconds.
        const wait = (chunk.length / this.opts.documentRatePerSec) * 1000 - (performance.now() - t0);
        if (wait > 0) await this.sleep(wait);
      }
      scanned += rows.length;
      this.documentCursor = through;
    }
    await this.checkpoint("document");
    return this.documentCursor < upTo;
  }

  /** Persist a cursor at most every `checkpointEveryMs` (Convex's RETENTION_CHECKPOINT_PERIOD_SECS). */
  private async checkpoint(which: "index" | "document", force = false) {
    const now = Date.now();
    if (!force && now - this.lastCheckpoint[which] < this.opts.checkpointEveryMs) return;
    await this.store.setGlobal(
      which === "index" ? RETENTION_GLOBALS.indexCursor : RETENTION_GLOBALS.documentCursor,
      which === "index" ? this.indexCursor : this.documentCursor,
    );
    this.lastCheckpoint[which] = now;
  }
}
