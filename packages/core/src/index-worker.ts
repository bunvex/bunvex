// The index backfill worker (STUDY-29), as Convex's `IndexWorker` (crates/database/src/database_index_workers):
// it runs in the background in the process that holds the store's lease, finds every `backfilling` index,
// and copies its table's live documents into it in chunks, while every commit already maintains the index.
// Then it marks the index `backfilled` (an index of a system table: `enabled`) and lets the engine finish
// the schema change, which enables what is backfilled.
//
// How a chunk stays correct under concurrent writes, as Convex's (`IndexWriter::backfill_from_ts`, DV-127
// reversed): the table is read at one snapshot taken after the index was created, and each document's entries
// are written at the document version's OWN ts (`writeIndexEntries`, PERSIST-01 C17), directly, not through a
// commit. Every write after the index was created maintains it with entries at its own commit ts, above them:
// a document written after the snapshot has its newer entries (and the removal of the old key) from that write,
// so the two never fight; and an index entry always points at the document version it was made from, which is
// what the exact-ts join reads.

import {
  backfillMeta,
  backfillRow,
  databaseIndexRows,
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  type IndexBackfillMeta,
  type IndexMeta,
  indexMeta,
  indexStatePatch,
} from "./catalog.ts";
import type { Committer } from "./committer.ts";
import { internalIdOf } from "./internal-id.ts";
import { compareKeys, encodeKey, prefixEnd } from "./keyenc.ts";
import type { IndexEntryAt, IndexId, Persistence, TabletId } from "./persistence/index.ts";
import { type Doc, type IndexDef, indexKey, SYSTEM_INDEXES, type TableDef } from "./schema.ts";
import { decodeDoc, type Tx } from "./tx.ts";

/**
 * Convex's knobs (crates/common/src/knobs.rs), with their defaults: INDEX_BACKFILL_CHUNK_SIZE = 1024 index
 * entries per write, INDEX_BACKFILL_CHUNK_RATE = 16 chunks a second (a limit of 16 384 entries/s),
 * INDEX_BACKFILL_READ_SIZE = 500 documents per table read, INDEX_BACKFILL_PROGRESS_INTERVAL = 1 s,
 * INDEX_BACKFILL_CONCURRENCY = 8 tables at once, INDEX_WORKERS_INITIAL_BACKOFF = 500 ms and
 * INDEX_WORKERS_MAX_BACKOFF = 30 s after a failure.
 */
export const INDEX_BACKFILL_DEFAULTS = {
  chunkSize: 1024,
  chunkRate: 16 as number | null,
  readSize: 500,
  progressIntervalMs: 1000,
  concurrency: 8,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
};
/** `chunkRate: null` removes the rate limit (Convex's `IndexRateLimit::Unlimited`). */
export type IndexBackfillOptions = Partial<typeof INDEX_BACKFILL_DEFAULTS>;

const FULL_LO = new Uint8Array(0);
const FULL_HI = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

/** What the worker needs from the engine. */
export interface IndexWorkerHost {
  readonly committer: Committer;
  readonly persistence: Persistence;
  readonly catalog: { byTablet(tablet: TabletId): TableDef | undefined };
  /** Run a system transaction (OCC retries included). */
  system<T>(body: (db: Tx) => Promise<T>, source: string): Promise<T>;
  /** Install a committed `_index` change into the catalog (called from the commit's visibility). */
  installIndexChanges(changes: { enable: IndexId[]; disable: IndexId[]; drop: IndexId[] }, ts: bigint): void;
  /** Finish the schema change if nothing it waits for is still backfilling; true once finished. */
  finishSchema(): Promise<boolean>;
  /** The oldest snapshot retention still keeps (its index window): a backfill reads at or above it. */
  minSnapshotTs(): bigint;
  /** The table's document count from the table summaries, or null while they are not built (Convex's `table_count`). */
  tableCount?(tablet: TabletId): number | null;
}

/** A token bucket over index entries, as Convex's `governor` quota: `rate` per second, bursts up to `rate`. */
class RateLimiter {
  private tokens: number;
  private at = performance.now();
  constructor(private readonly rate: number) {
    this.tokens = rate;
  }
  async take(n: number, stopped: () => boolean) {
    for (;;) {
      const now = performance.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 1000) * this.rate);
      this.at = now;
      // A request larger than the bucket waits for a full bucket, then overdraws it.
      const need = Math.min(n, this.rate);
      if (this.tokens >= need || stopped()) {
        this.tokens -= n;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(1, ((need - this.tokens) / this.rate) * 1000)));
    }
  }
}

export class IndexWorker {
  private readonly opts: typeof INDEX_BACKFILL_DEFAULTS;
  private readonly limiter: RateLimiter | null;
  private stopped = false;
  private running: Promise<void> | null = null;
  /** For tests and measurements. */
  readonly stats = { chunks: 0, docsIndexed: 0, checkpoints: 0, failures: 0 };

  constructor(
    private readonly host: IndexWorkerHost,
    opts: IndexBackfillOptions = {},
    /** Called with each failure the worker backs off from (it retries, as Convex's worker loop). */
    private readonly onError: (e: unknown) => void = (e) => console.error("index backfill failed; retrying:", e),
  ) {
    this.opts = { ...INDEX_BACKFILL_DEFAULTS, ...opts };
    this.limiter = this.opts.chunkRate === null ? null : new RateLimiter(this.opts.chunkRate * this.opts.chunkSize);
  }

  /** Start, or start again after it finished (a push added indexes, STUDY-35). */
  start() {
    this.stopped = false;
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
  }

  /**
   * Backfill these indexes now, table by table, and resolve once they are `backfilled` (or enabled): the
   * indexes of tables a schema change just created, which are empty, so that the change can finish at once.
   * `emptyTables`: nothing can have written them yet, so their count is 0 while the summaries are not built.
   */
  async backfillNow(metas: IndexMeta[], emptyTables = false) {
    const byTablet = new Map<TabletId, IndexMeta[]>();
    for (const m of metas) byTablet.set(m.tablet, [...(byTablet.get(m.tablet) ?? []), m]);
    for (const group of byTablet.values()) await this.backfillTable(group, emptyTables);
  }

  /** Stop after the chunk in flight; resolves once the worker has stopped writing. */
  async stop() {
    this.stopped = true;
    await this.running;
  }

  private async loop() {
    let failures = 0;
    while (!this.stopped && !this.host.committer.stopped) {
      try {
        const backfilling = await this.host.system(
          async (db) =>
            databaseIndexRows(await db.query(INDEX_TABLE).collect()).filter((i) => i.state === "backfilling"),
          "index_worker_scan",
        );
        if (backfilling.length === 0) {
          await this.host.finishSchema();
          return;
        }
        // As Convex's `queue_index_backfill`: the indexes of one table are filled in one pass over it.
        const byTablet = new Map<TabletId, IndexMeta[]>();
        for (const m of backfilling) byTablet.set(m.tablet, [...(byTablet.get(m.tablet) ?? []), m]);
        const groups = [...byTablet.values()];
        let next = 0;
        const lanes = Array.from({ length: Math.min(this.opts.concurrency, groups.length) }, async () => {
          while (next < groups.length && !this.stopped) {
            await this.backfillTable(groups[next++]);
            // A table done may complete the schema change while others are still being filled.
            if (!this.stopped) await this.host.finishSchema();
          }
        });
        await Promise.all(lanes);
        failures = 0;
      } catch (e) {
        if (this.stopped || this.host.committer.stopped) return;
        this.stats.failures++;
        this.onError(e);
        const { initialBackoffMs, maxBackoffMs } = this.opts;
        await new Promise((r) =>
          setTimeout(r, Math.min(initialBackoffMs * 2 ** failures, maxBackoffMs) * Math.random()),
        );
        failures++;
      }
    }
  }

  /** Fill every `backfilling` index of one table, from its checkpoint, then mark them done. */
  private async backfillTable(metas: IndexMeta[], empty = false) {
    const t = this.host.catalog.byTablet(metas[0].tablet);
    if (!t) return;
    const defs = metas
      .map((m) => t.pending.find((p) => p.id === m.indexId))
      .filter((d): d is IndexDef => d !== undefined);
    if (defs.length === 0) return;
    const { committer } = this.host;

    // The checkpoints (Convex's `IndexBackfillModel`): created at the first pass, read on a resume.
    const progress = await this.host.system(async (db) => {
      const out: IndexBackfillMeta[] = [];
      for (const m of metas) {
        const row = await db
          .query(INDEX_BACKFILLS_TABLE)
          .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", m._id))
          .first();
        let p = row ? backfillMeta(row as Record<string, unknown>) : null;
        if (!p) {
          // As Convex's `initialize_database_index_backfill`: the table's count when the summaries have it.
          const fields = {
            indexId: m._id,
            numDocsIndexed: 0,
            totalDocs: this.host.tableCount?.(m.tablet) ?? (empty ? 0 : null),
            cursor: { snapshotTs: db.snapshot, cursor: null },
          };
          p = { _id: await db.insert(INDEX_BACKFILLS_TABLE, backfillRow(fields)), ...fields };
        }
        out.push(p);
      }
      return out;
    }, "index_worker_backfill_initialization");

    // Resume after the least advanced checkpoint: re-writing an entry another index already has is harmless.
    let resumeAfter: string | null = null;
    for (const [i, p] of progress.entries()) {
      const c = p.cursor?.cursor ?? null;
      if (c === null) {
        resumeAfter = null;
        break;
      }
      if (i === 0 || compareKeys(encodeKey([c]), encodeKey([resumeAfter!])) < 0) resumeAfter = c;
    }
    let lo = resumeAfter === null ? FULL_LO : prefixEnd(encodeKey([resumeAfter]));
    const perChunk = Math.max(1, Math.ceil(this.opts.chunkSize / defs.length));
    const done = progress.map((p) => p.numDocsIndexed);
    let lastId = resumeAfter;
    let sinceCheckpoint = 0;
    let checkpointAt = performance.now();
    const checkpoint = async () => {
      const cursor = lastId;
      const n = sinceCheckpoint;
      sinceCheckpoint = 0;
      checkpointAt = performance.now();
      for (let i = 0; i < done.length; i++) done[i] += n;
      await this.host.system(async (db) => {
        // As Convex's `update_index_backfill_progress`: the count so far and the cursor; a total the summaries
        // did not know at the start is taken from them now.
        for (const [i, p] of progress.entries()) {
          p.totalDocs ??= this.host.tableCount?.(metas[i].tablet) ?? null;
          await db.replace(
            INDEX_BACKFILLS_TABLE,
            p._id,
            backfillRow({
              indexId: p.indexId,
              numDocsIndexed: done[i],
              totalDocs: p.totalDocs,
              cursor: { snapshotTs: p.cursor?.snapshotTs ?? 0n, cursor },
            }),
          );
        }
      }, "index_worker_backfill_progress");
      this.stats.checkpoints++;
    };

    // As Convex's `backfill_from_ts`: the table walked at ONE snapshot, the checkpoint's (a resume continues at
    // it), and each document's entries written at the document's own ts, directly (not a commit): below every
    // write made after the index was created, which maintains it with entries of its own (DV-127 reversed).
    // A snapshot retention has passed meanwhile can no longer be read: the backfill starts over at a new one.
    let snapshot = progress.reduce((s, p) => {
      const c = p.cursor?.snapshotTs ?? 0n;
      return c > s ? c : s;
    }, 0n);
    if (snapshot < this.host.minSnapshotTs() || snapshot > committer.visibleTs) {
      snapshot = committer.visibleTs;
      lo = FULL_LO;
      lastId = null;
      for (const p of progress) p.cursor = { snapshotTs: snapshot, cursor: null };
    }
    for (;;) {
      if (this.stopped) {
        if (sinceCheckpoint > 0) await checkpoint();
        return;
      }
      const docs = await this.readChunk(t, lo, snapshot, perChunk);
      if (docs.length === 0) break;
      // The entries this chunk writes, as Convex's rate limit counts them: an empty table costs nothing.
      await this.limiter?.take(docs.length * defs.length, () => this.stopped);
      const entries: IndexEntryAt[] = [];
      for (const { doc, ts } of docs) {
        const id = internalIdOf(doc._id);
        for (const ix of defs) entries.push({ index: ix.id, key: indexKey(ix, doc), table: t.id, id, ts });
      }
      await this.host.persistence.writeIndexEntries(entries);
      const hi = prefixEnd(encodeKey([docs[docs.length - 1].doc._id]));
      this.stats.chunks++;
      this.stats.docsIndexed += docs.length;
      lo = hi;
      lastId = docs[docs.length - 1].doc._id;
      sinceCheckpoint += docs.length;
      if (performance.now() - checkpointAt >= this.opts.progressIntervalMs) await checkpoint();
    }

    // Every document is in the indexes: as Convex's `mark_retention_started`, a commit of its own records it
    // before the backfill finishes (bunvex has no catching up to do: each chunk committed at a new ts).
    await this.host.system(async (db) => {
      for (const m of metas) {
        const row = await db.get(INDEX_TABLE, m._id);
        const cur = row ? indexMeta(row as Record<string, unknown>) : null;
        if (cur?.state === "backfilling" && !cur.retentionStarted)
          await db.patch(INDEX_TABLE, m._id, indexStatePatch(cur, { retentionStarted: true }));
      }
    }, "index_worker_retention_started");

    // Done: as Convex's `finish_backfill`, a user index becomes `backfilled` (the schema change enables it);
    // an index of a system table, or a system index, is enabled at once. Its `_index_backfills` row stays, as
    // Convex's (nothing there deletes one).
    await this.host.system(async (db) => {
      const enabled: IndexId[] = [];
      for (const m of metas) {
        const row = await db.get(INDEX_TABLE, m._id);
        const cur = row ? indexMeta(row as Record<string, unknown>) : null;
        if (cur?.state === "backfilling") {
          const enableNow = t.name.startsWith("_") || m.name in SYSTEM_INDEXES;
          await db.patch(
            INDEX_TABLE,
            m._id,
            indexStatePatch(cur, enableNow ? { state: "enabled", staged: false } : { state: "backfilled" }),
          );
          if (enableNow) enabled.push(m.indexId);
        }
      }
      if (enabled.length)
        db.onCommitVisible = (ts) => this.host.installIndexChanges({ enable: enabled, disable: [], drop: [] }, ts);
    }, "index_worker_finish_backfill");
  }

  /**
   * Up to `limit` live documents of `t` from `lo` on, in id order, at `snapshot` (pages of `readSize`), each with
   * the ts of its version (Convex's revision pairs).
   */
  private async readChunk(
    t: TableDef,
    lo: Uint8Array,
    snapshot: bigint,
    limit: number,
  ): Promise<{ doc: Doc; ts: bigint }[]> {
    const p = this.host.persistence;
    const out: { doc: Doc; ts: bigint }[] = [];
    let from = lo;
    while (out.length < limit) {
      const n = Math.min(this.opts.readSize, limit - out.length);
      // Each entry's document at the entry's ts; a missing one rejects (PERSIST-01 C15).
      const rows = await p.scan(t.id, t.byId.id, from, FULL_HI, snapshot, n, false);
      for (const r of rows) out.push({ doc: decodeDoc(r.json), ts: r.ts });
      if (rows.length < n) break;
      if (rows.length) from = prefixEnd(encodeKey([out[out.length - 1]!.doc._id]));
    }
    return out;
  }
}
