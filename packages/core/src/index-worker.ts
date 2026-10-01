// The index backfill worker (STUDY-29), as Convex's `IndexWorker` (crates/database/src/database_index_workers):
// it runs in the background in the process that holds the store's lease, finds every `backfilling` index,
// and copies its table's live documents into it in chunks, while every commit already maintains the index.
// Then it marks the index `backfilled` (an index of a system table: `enabled`) and lets the engine finish
// the schema change, which enables what is backfilled.
//
// How a chunk stays correct under concurrent writes: Convex writes the entries at each document's own
// timestamp, below every live write. bunvex's persistence cannot write below its latest ts (PERSIST-01
// applies commits in ts order, and there is no per-document ts to read; DV-66), so a chunk is an ordinary
// COMMIT at a new ts whose read-set is the `by_id` range it scanned at its snapshot: a write to any of those
// documents after the snapshot (an update, a delete, an insert in the range) conflicts, and the chunk is
// read again at a newer snapshot. A document the chunk saw unchanged gets the entry it has at the commit's
// ts; a document written later gets its entries from that write, which maintains the index.

import {
  INDEX_BACKFILLS_INDEX,
  INDEX_BACKFILLS_TABLE,
  INDEX_TABLE,
  type IndexBackfillMeta,
  type IndexMeta,
} from "./catalog.ts";
import { type Committer, ConflictError } from "./committer.ts";
import { compareKeys, encodeKey, prefixEnd } from "./keyenc.ts";
import type { IndexWrite, Persistence, ScanDocs } from "./persistence/index.ts";
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
  readonly catalog: { byTablet(tablet: number): TableDef | undefined };
  /** Run a system transaction (OCC retries included). */
  system<T>(body: (db: Tx) => Promise<T>, source: string): Promise<T>;
  /** Install a committed `_index` change into the catalog (called from the commit's visibility). */
  installIndexChanges(changes: { enable: number[]; disable: number[]; drop: number[] }, ts: number): void;
  /** Finish the schema change if nothing it waits for is still backfilling; true once finished. */
  finishSchema(): Promise<boolean>;
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
  readonly stats = { chunks: 0, conflicts: 0, docsIndexed: 0, checkpoints: 0, failures: 0 };

  constructor(
    private readonly host: IndexWorkerHost,
    opts: IndexBackfillOptions = {},
    /** Called with each failure the worker backs off from (it retries, as Convex's worker loop). */
    private readonly onError: (e: unknown) => void = (e) => console.error("index backfill failed; retrying:", e),
  ) {
    this.opts = { ...INDEX_BACKFILL_DEFAULTS, ...opts };
    this.limiter = this.opts.chunkRate === null ? null : new RateLimiter(this.opts.chunkRate * this.opts.chunkSize);
  }

  start() {
    this.running ??= this.loop();
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
            ((await db.query(INDEX_TABLE).collect()) as unknown as IndexMeta[]).filter(
              (i) => i.state === "backfilling",
            ),
          "index_worker_scan",
        );
        if (backfilling.length === 0) {
          await this.host.finishSchema();
          return;
        }
        // As Convex's `queue_index_backfill`: the indexes of one table are filled in one pass over it.
        const byTablet = new Map<number, IndexMeta[]>();
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
  private async backfillTable(metas: IndexMeta[]) {
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
        let p = (await db
          .query(INDEX_BACKFILLS_TABLE)
          .withIndex(INDEX_BACKFILLS_INDEX, (q) => q.eq("indexId", m._id))
          .first()) as unknown as IndexBackfillMeta | null;
        if (!p) {
          const fields = {
            indexId: m._id,
            numDocsIndexed: 0,
            totalDocs: null,
            cursor: { snapshotTs: db.snapshot, cursor: null },
          };
          p = { _id: await db.insert(INDEX_BACKFILLS_TABLE, fields), ...fields };
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
        for (const [i, p] of progress.entries())
          await db.patch(INDEX_BACKFILLS_TABLE, p._id, {
            numDocsIndexed: done[i],
            cursor: { snapshotTs: p.cursor?.snapshotTs ?? 0, cursor },
          });
      }, "index_worker_backfill_progress");
      this.stats.checkpoints++;
    };

    // A chunk refused by a write is read again at half the size, so a range under constant writes still
    // makes progress (a single document conflicts only if it is itself written meanwhile); it grows back
    // after each success.
    let size = perChunk;
    for (;;) {
      if (this.stopped) {
        if (sinceCheckpoint > 0) await checkpoint();
        return;
      }
      await this.limiter?.take(size * defs.length, () => this.stopped);
      const snapshot = committer.visibleTs;
      const docs = await this.readChunk(t, lo, snapshot, size);
      if (docs.length === 0) break;
      const idx: IndexWrite[] = [];
      for (const d of docs) for (const ix of defs) idx.push({ index: ix.id, key: indexKey(ix, d), id: d._id });
      const hi = prefixEnd(encodeKey([docs[docs.length - 1]._id]));
      try {
        await committer.commit({
          snapshot,
          // Everything this chunk scanned: any write to it since the snapshot refuses the chunk.
          reads: [{ index: t.byId.id, lo, hi }],
          docs: [],
          idx,
          source: "index_worker_backfill",
          logWrites: false,
        });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        this.stats.conflicts++;
        size = Math.max(1, size >> 1);
        await committer.waitForVisible(e.conflict.writeTs);
        continue; // the same range, at a newer snapshot
      }
      size = Math.min(perChunk, size * 2);
      this.stats.chunks++;
      this.stats.docsIndexed += docs.length;
      lo = hi;
      lastId = docs[docs.length - 1]._id;
      sinceCheckpoint += docs.length;
      if (performance.now() - checkpointAt >= this.opts.progressIntervalMs) await checkpoint();
    }

    // Done: as Convex's `finish_backfill`, a user index becomes `backfilled` (the schema change enables it);
    // an index of a system table, or a system index, is enabled at once.
    await this.host.system(async (db) => {
      const enabled: number[] = [];
      for (const [i, m] of metas.entries()) {
        const cur = (await db.get(INDEX_TABLE, m._id)) as unknown as IndexMeta | null;
        if (cur?.state === "backfilling") {
          const enableNow = t.name.startsWith("_") || m.name in SYSTEM_INDEXES;
          await db.patch(INDEX_TABLE, m._id, enableNow ? { state: "enabled", staged: false } : { state: "backfilled" });
          if (enableNow) enabled.push(m.indexId);
        }
        if (await db.get(INDEX_BACKFILLS_TABLE, progress[i]._id))
          await db.delete(INDEX_BACKFILLS_TABLE, progress[i]._id);
      }
      if (enabled.length)
        db.onCommitVisible = (ts) => this.host.installIndexChanges({ enable: enabled, disable: [], drop: [] }, ts);
    }, "index_worker_finish_backfill");
  }

  /** Up to `limit` live documents of `t` from `lo` on, in id order, at `snapshot` (pages of `readSize`). */
  private async readChunk(t: TableDef, lo: Uint8Array, snapshot: number, limit: number): Promise<Doc[]> {
    const p = this.host.persistence;
    const out: Doc[] = [];
    let from = lo;
    while (out.length < limit) {
      const n = Math.min(this.opts.readSize, limit - out.length);
      let page: Doc[];
      let fetched: number;
      if (typeof (p as Partial<ScanDocs>).scanDocs === "function") {
        const jsons = await (p as unknown as ScanDocs).scanDocs(t.id, t.byId.id, from, FULL_HI, snapshot, n, false);
        page = jsons.map(decodeDoc);
        fetched = jsons.length;
      } else {
        const ids = await p.scan(t.byId.id, from, FULL_HI, snapshot, n, false);
        fetched = ids.length;
        page = [];
        for (const id of ids) {
          const json = await p.get(t.id, id, snapshot);
          if (json) page.push(decodeDoc(json));
        }
        if (ids.length) from = prefixEnd(encodeKey([ids[ids.length - 1]]));
      }
      out.push(...page);
      if (fetched < n) break;
      if (page.length) from = prefixEnd(encodeKey([page[page.length - 1]._id]));
    }
    return out;
  }
}
