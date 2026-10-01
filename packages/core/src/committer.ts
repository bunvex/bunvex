// The ONE committer: optimistic validation, timestamps and group commit.
//
// A transaction reads at a snapshot ts and records what it read as key intervals (its read-set). The
// committer validates the read-set against every commit made after the snapshot (the in-memory write
// log), assigns the next ts, applies the writes to persistence, and makes the whole GROUP durable with one
// flush. Commits queued while a group is being flushed form the next group.
//
// The write log is kept as Convex keeps it (crates/database/src/write_log.rs, STUDY-06 D10): by TIME and
// approximate SIZE, never by count. A commit older than WRITE_LOG_MAX_RETENTION is dropped, or older than
// WRITE_LOG_MIN_RETENTION while the log is over WRITE_LOG_SOFT_MAX_SIZE. A transaction whose snapshot is
// older than what the log still holds cannot be validated: it fails with OutOfRetentionError, Convex's
// `OutOfRetention`, which is a system error ("try again later"), not an OCC conflict.

import { outsideExecution, wallClockUs } from "./determinism.ts";
import { compareKeys } from "./keyenc.ts";
import type { DocWrite, IndexWrite, Persistence } from "./persistence/index.ts";

export type Interval = { index: number; lo: Uint8Array; hi: Uint8Array };
/**
 * One commit in the write log: its index-key writes (`id` is the document whose entry it is, null for a
 * removed entry) and its write source (the mutation's name, when the caller gave one).
 */
export type LogEntry = { ts: number; writes: { index: number; key: Uint8Array; id: string | null }[]; source?: string };

/** The first write of `writes` inside one of `reads`, if any. */
export function firstOverlap(writes: LogEntry["writes"], reads: Interval[]): LogEntry["writes"][number] | undefined {
  for (const w of writes)
    for (const r of reads)
      if (r.index === w.index && compareKeys(w.key, r.lo) >= 0 && compareKeys(w.key, r.hi) < 0) return w;
  return undefined;
}

export function overlaps(writes: LogEntry["writes"], reads: Interval[]): boolean {
  return firstOverlap(writes, reads) !== undefined;
}

/**
 * What a rejected commit conflicted with, as Convex's `ConflictingReadWithWriteSource`: the commit that
 * wrote into its read-set (its ts, the index and document of the write, and its write source). Absent
 * fields are unknown, e.g. for a snapshot older than the write log.
 */
export type Conflict = { writeTs: number; index?: number; id?: string | null; source?: string };

/**
 * Convex's write-log knobs (crates/common/src/knobs.rs `WRITE_LOG_MIN_RETENTION_SECS`,
 * `WRITE_LOG_MAX_RETENTION_SECS`, `WRITE_LOG_SOFT_MAX_SIZE_BYTES`), in microseconds and bytes. Timestamps are
 * wall-clock microseconds (STUDY-06 D9), so a commit's age is read off its ts, as Convex does.
 */
export const WRITE_LOG_MIN_RETENTION_US = 30_000_000;
export const WRITE_LOG_MAX_RETENTION_US = 300_000_000;
export const WRITE_LOG_SOFT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
/**
 * NOT in Convex: the default hard byte cap on the write log (DV-128, decided by the owner on 2026-10-01, may
 * be revisited). See `WriteLogRetention.hardMaxBytes`.
 */
export const WRITE_LOG_HARD_MAX_BYTES = 256 * 1024 * 1024;
/**
 * Convex's `MAX_TRANSACTION_WINDOW` (10 s): how far behind the latest snapshot a transaction may BEGIN
 * (crates/database/src/snapshot_manager.rs `push` / `snapshot`).
 */
export const MAX_TRANSACTION_WINDOW_US = 10_000_000;

export type WriteLogRetention = {
  /** Commits younger than this (relative to the latest commit) are always kept. */
  minRetentionUs: number;
  /** Commits older than this are always dropped. */
  maxRetentionUs: number;
  /** Above this approximate size, commits older than `minRetentionUs` are dropped too. */
  softMaxBytes: number;
  /**
   * NOT in Convex (DV-128; default `WRITE_LOG_HARD_MAX_BYTES`, 256 MiB): above this approximate size, the
   * oldest commits are dropped whatever their age. Convex's minimum retention has no upper bound in bytes;
   * at bunvex's commit rates (~100k commits/s on the memory driver) 30 s of commits is gigabytes.
   * `null`, `0` or `Infinity` turns the cap off, which is Convex's exact behaviour (STUDY-06 §7).
   */
  hardMaxBytes: number | null;
};

const DEFAULT_RETENTION: WriteLogRetention = {
  minRetentionUs: WRITE_LOG_MIN_RETENTION_US,
  maxRetentionUs: WRITE_LOG_MAX_RETENTION_US,
  softMaxBytes: WRITE_LOG_SOFT_MAX_SIZE_BYTES,
  hardMaxBytes: WRITE_LOG_HARD_MAX_BYTES,
};

/**
 * The approximate heap size of a log entry, as Convex sums `heap_size()` of what it keeps: the entry and its
 * `writes` array, and per write its object, key bytes and id (one byte per character: ids and function names
 * are ASCII, which JavaScriptCore stores as Latin-1). Calibrated on Bun 1.4 with `bench/write-log.ts
 * calibrate`: a three-index insert is estimated at ~580 bytes and measured at ~590.
 */
export function logEntryBytes(e: LogEntry): number {
  let n = ENTRY_OVERHEAD + (e.source === undefined ? 0 : e.source.length);
  for (const w of e.writes) n += WRITE_OVERHEAD + w.key.byteLength + (w.id === null ? 0 : w.id.length);
  return n;
}
const ENTRY_OVERHEAD = 96;
const WRITE_OVERHEAD = 80;

/**
 * A timestamp outside the write log's retention: a commit whose snapshot is older than what the log still
 * holds, or a transaction begun too far behind the latest snapshot. Convex's `OutOfRetention`
 * (crates/database/src/write_log.rs, crates/errors/src/lib.rs): a system error the client sees as
 * "InternalServerError" / "Your request couldn't be completed. Try again later." (HTTP 503, WebSocket close
 * 1013). The engine does NOT retry it as an OCC conflict, as Convex's mutation runner does not.
 */
export class OutOfRetentionError extends Error {
  override name = "OutOfRetentionError";
  constructor(
    readonly ts: number,
    readonly minTs: number,
    message = `Timestamp ${ts} is outside of write log retention window (minimum timestamp ${minTs})`,
  ) {
    super(message);
  }
}

/** A commit refused by validation: something it read changed after its snapshot. The engine retries it. */
export class ConflictError extends Error {
  constructor(readonly conflict: Conflict = { writeTs: 0 }) {
    super("write conflict");
  }
}

/**
 * The committer stopped because persistence failed (a throwing `apply` or `flush`). As in Convex, this is
 * fail-stop: nothing after the failure is ever made visible, every later commit is refused, and the process
 * is expected to restart and recover from what persistence durably holds (PERSIST-01 C5).
 */
export class CommitterStoppedError extends Error {
  constructor(
    cause: unknown,
    /** What failed, when known: a flush is "write failed, unsure if the group committed to disk" (Convex). */
    context?: string,
  ) {
    super(
      `the committer stopped after a persistence failure: ${context ? `${context}: ` : ""}${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Convex's backoff for retrying a failed persistence write (`crates/common/src/knobs.rs`,
 * INITIAL_PERSISTENCE_WRITES_BACKOFF_MS = 100 and MAX_PERSISTENCE_WRITES_BACKOFF_MS = 10 000), full jitter.
 */
export const WRITE_RETRY_INITIAL_BACKOFF_MS = 100;
export const WRITE_RETRY_MAX_BACKOFF_MS = 10_000;

/** How a failed flush is retried (STUDY-25 L4). */
export type FlushRetryOptions = {
  /** First backoff, in ms (default: Convex's 100). */
  initialBackoffMs?: number;
  /** Backoff cap, in ms (default: Convex's 10 000). */
  maxBackoffMs?: number;
  /** Called before each retry (Convex logs "Failed to write to persistence"). Default: console.error. */
  onRetry?: (error: unknown, failures: number, delayMs: number) => void;
};

type PendingCommit = {
  snapshot: number;
  reads: Interval[];
  docs: DocWrite[];
  idx: IndexWrite[];
  /** The write source recorded in the log, for other transactions' conflict errors. */
  source?: string;
  /**
   * False for an index backfill's commit (STUDY-29): its writes go only to an index no transaction may read
   * yet, so no read-set can overlap them and they are left out of the write log (validation, the query
   * cache's invalidation and subscriptions would otherwise scan them all for nothing).
   */
  logWrites?: boolean;
  /** Called with the ts once the commit is visible, before the commit listeners (a catalog change). */
  onVisible?: (ts: number) => void;
  resolve: (ts: number) => void;
  reject: (e: unknown) => void;
};

const defaultOnRetry = (e: unknown, failures: number, delayMs: number) =>
  console.error(
    `bunvex: a flush failed with a transient error (attempt ${failures}); retrying in ${Math.round(delayMs)} ms: ${e instanceof Error ? e.message : String(e)}`,
  );

export class Committer {
  /** Highest ts applied to persistence (possibly not yet durable). */
  appliedTs = 0;
  /** Highest ts that is DURABLE: new transactions read at this snapshot. */
  visibleTs = 0;
  groups = 0;
  conflicts = 0;
  /** Commits refused because their snapshot was older than the write log (OutOfRetentionError). */
  outOfRetention = 0;
  /** The write log, oldest first, from `log[logHead]` (trimmed by advancing the head; compacted now and then). */
  private log: LogEntry[] = [];
  private logHead = 0;
  /** The approximate heap size of the retained log (`logEntryBytes`), as Convex's `WriteLogManager.size`. */
  logBytes = 0;
  private retention: WriteLogRetention;
  private queue: PendingCommit[] = [];
  private running = false;
  private listeners: ((e: LogEntry[]) => void)[] = [];
  private fatalListeners: ((e: CommitterStoppedError) => void)[] = [];
  /** Callers of `waitForVisible`, woken once `visibleTs` reaches their ts. */
  private visibleWaiters: { ts: number; resolve: () => void }[] = [];
  /**
   * Every commit with a ts above this is in the write log; the ones at or below it are not (trimmed, or
   * made before the store was opened). Timestamps are sparse (STUDY-06 D9), so "the log reaches back to a
   * snapshot" is `snapshot >= purgedTs`, never a guess from the first entry's ts.
   */
  private purgedTs = 0;
  /** Set once persistence has failed; the committer accepts nothing afterwards. */
  stopped: CommitterStoppedError | null = null;

  constructor(
    private persistence: Persistence,
    /** The write log's retention (default: Convex's knobs). */
    retention: Partial<WriteLogRetention> = {},
    /** The clock commit timestamps follow, in microseconds (tests pass their own). */
    private clockUs: () => number = wallClockUs,
    /** How a flush that failed with a transient error is retried (STUDY-25 L4). */
    private retry: FlushRetryOptions = {},
  ) {
    const r = { ...DEFAULT_RETENTION };
    for (const [k, v] of Object.entries(retention)) if (v !== undefined) (r as Record<string, unknown>)[k] = v;
    // The hard cap is off for `null`/`0` (and `Infinity`); the comparison below wants a number.
    if (!r.hardMaxBytes) r.hardMaxBytes = Number.POSITIVE_INFINITY;
    this.retention = r;
  }

  /** The retention policy in effect (defaults filled in; a disabled hard cap reads as `Infinity`). */
  get retentionPolicy(): Readonly<WriteLogRetention> {
    return this.retention;
  }

  /** How many commits the write log holds. */
  get logLength(): number {
    return this.log.length - this.logHead;
  }

  /** Every commit with a ts above this is in the write log (Convex's `purged_ts`). */
  get logStartTs(): number {
    return this.purgedTs;
  }

  /** Start after the store's durable maxTs (PERSIST-01 C5): nothing at or below it is in the write log. */
  resume(maxTs: number) {
    this.appliedTs = this.visibleTs = this.purgedTs = maxTs;
  }

  /**
   * Whether a durable commit in `(from, to]` (`to` ≤ visibleTs) wrote into `reads`. When it did not, a query
   * result read at either end is also the result at the other: its reads saw the same data (Convex's
   * `extend_validity`). True when the write log no longer reaches back to `from`, as the absence of a
   * conflict can then not be proven.
   */
  changedBetween(reads: Interval[], from: number, to: number): boolean {
    if (to > this.visibleTs) throw new Error(`changedBetween: ${to} is past the visible ts ${this.visibleTs}`);
    if (from >= to) return false;
    if (from < this.purgedTs) return true; // Convex's `refresh_token`: out of retention, re-run
    for (let i = this.log.length - 1; i >= this.logHead && this.log[i].ts > from; i--)
      if (this.log[i].ts <= to && overlaps(this.log[i].writes, reads)) return true;
    return false;
  }

  /** Subscribe to durable commits (the query cache and subscriptions). */
  onCommit(fn: (entries: LogEntry[]) => void) {
    this.listeners.push(fn);
  }

  /** Called once, when persistence fails and the committer stops (the server shuts the process down). */
  onFatal(fn: (e: CommitterStoppedError) => void) {
    this.fatalListeners.push(fn);
  }

  /**
   * Resolve once `ts` is visible (durable) or the committer stops, as Convex's `wait_for_write_ts`: a
   * mutation retried after a conflict first waits for the write it conflicted with, so its next snapshot
   * includes it.
   */
  waitForVisible(ts: number): Promise<void> {
    if (ts <= this.visibleTs || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.visibleWaiters.push({ ts, resolve }));
  }

  private wakeVisible() {
    if (this.visibleWaiters.length === 0) return;
    const ready = this.visibleWaiters.filter((w) => w.ts <= this.visibleTs || this.stopped);
    if (ready.length === 0) return;
    this.visibleWaiters = this.visibleWaiters.filter((w) => !(w.ts <= this.visibleTs || this.stopped));
    for (const w of ready) w.resolve();
  }

  commit(c: Omit<PendingCommit, "resolve" | "reject">): Promise<number> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise((resolve, reject) => {
      this.queue.push({ ...c, resolve, reject });
      if (!this.running) {
        this.running = true;
        // setImmediate, not a microtask: callers whose previous commit just resolved get to enqueue
        // their next one first, so they land in the SAME group.
        setImmediate(() => this.drain());
      }
    });
  }

  /**
   * Refuse to BEGIN a transaction at `ts` when it is further behind the latest snapshot than Convex's
   * `MAX_TRANSACTION_WINDOW` allows. Convex's snapshot manager keeps the snapshot versions whose successor is
   * within the window of the latest one, so the earliest ts a transaction may begin at is the last commit
   * before `latest - window` (or the oldest one known); anything before it is `OutOfRetention`
   * ("Timestamp … is too early, retry with a higher timestamp").
   */
  checkBeginTs(ts: number, windowUs = MAX_TRANSACTION_WINDOW_US) {
    const earliest = this.earliestBeginTs(windowUs);
    if (ts < earliest)
      throw new OutOfRetentionError(ts, earliest, `Timestamp ${ts} is too early, retry with a higher timestamp`);
  }

  /** The earliest snapshot a transaction may begin at (see `checkBeginTs`). */
  earliestBeginTs(windowUs = MAX_TRANSACTION_WINDOW_US): number {
    const bound = this.visibleTs - windowUs;
    // The last durable commit with ts < bound: binary search the retained log (sorted by ts).
    let lo = this.logHead;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.log[mid].ts < bound) lo = mid + 1;
      else hi = mid;
    }
    // log[lo - 1] is the last entry below the bound; without one, the last trimmed commit (or the store's
    // ts when it was opened) is the oldest version known, as Convex's front version.
    return lo > this.logHead ? this.log[lo - 1].ts : this.purgedTs;
  }

  /** Why `p` is refused (a conflict, or a snapshot out of the log's retention), or null when it may commit. */
  private validate(p: PendingCommit): Conflict | OutOfRetentionError | null {
    // As Convex's `is_stale`: a snapshot older than the log cannot be validated, whatever it read (this
    // holds with an empty log too: a snapshot from before the store was opened is refused; STUDY-24 S4).
    if (p.snapshot < this.purgedTs) return new OutOfRetentionError(p.snapshot, this.purgedTs);
    if (p.reads.length === 0) return null;
    for (let i = this.log.length - 1; i >= this.logHead && this.log[i].ts > p.snapshot; i--) {
      const e = this.log[i];
      const w = firstOverlap(e.writes, p.reads);
      if (w) return { writeTs: e.ts, index: w.index, id: w.id, source: e.source };
    }
    return null;
  }

  private async drain() {
    try {
      await this.drainGroups();
    } catch (e) {
      this.stop(e);
    }
    this.running = false;
    // A commit queued between drainGroups' last check and this point (a caller whose previous commit just
    // resolved, re-committing in the same microtask chain) found `running` still true and scheduled
    // nothing: drain again for it.
    if (this.queue.length && !this.stopped) {
      this.running = true;
      setImmediate(() => this.drain());
    }
  }

  private async drainGroups() {
    while (this.queue.length) {
      const group = this.queue;
      this.queue = [];
      const accepted: [PendingCommit, LogEntry][] = [];
      try {
        for (const p of group) {
          const refused = this.validate(p);
          if (refused instanceof OutOfRetentionError) {
            this.outOfRetention++;
            p.reject(refused);
            continue;
          }
          if (refused) {
            this.conflicts++;
            p.reject(new ConflictError(refused));
            continue;
          }
          // As Convex's `next_commit_ts`: the wall clock, but always above the last timestamp assigned, so
          // timestamps strictly increase even when the clock stands still or steps back (STUDY-06 D9).
          const ts = Math.max(this.appliedTs + 1, this.clockUs());
          this.appliedTs = ts;
          const writes = p.logWrites === false ? [] : p.idx.map((w) => ({ index: w.index, key: w.key, id: w.id }));
          const entry: LogEntry = p.source === undefined ? { ts, writes } : { ts, writes, source: p.source };
          accepted.push([p, entry]);
          this.persistence.apply(ts, p.docs, p.idx);
          this.log.push(entry); // seen by the validation of the NEXT commits of this group
          this.logBytes += logEntryBytes(entry);
        }
        if (!accepted.length) continue;
      } catch (e) {
        // A throwing apply: nothing of this group becomes visible, and the group, and
        // everything queued behind it, is refused.
        this.stop(e);
        for (const [p] of accepted) p.reject(this.stopped);
        return;
      }
      try {
        await this.flushWithRetries();
      } catch (e) {
        // Nothing of this group becomes visible: visibleTs stays where it was, and readers ignore versions
        // above it. The group, and everything queued behind it, is refused. Whether the group reached the store
        // is unknown (its last attempt may have committed before the error), as Convex says it.
        this.stop(e, "write failed, unsure if the group committed to disk");
        for (const [p] of accepted) p.reject(this.stopped);
        return;
      }
      this.groups++;
      this.visibleTs = accepted[accepted.length - 1][1].ts;
      for (const [p, e] of accepted) p.onVisible?.(e.ts);
      const entries = accepted.map(([, e]) => e);
      for (const l of this.listeners) l(entries);
      for (const [p, e] of accepted) p.resolve(e.ts);
      this.wakeVisible();
      // As Convex, once the commits are published to subscriptions, relative to the latest of them.
      this.enforceRetention(this.visibleTs);
    }
  }

  /**
   * Drop the commits the retention policy no longer keeps (Convex's `enforce_retention_policy`): older than
   * the max retention, or older than the min retention while the log is over its soft size. `purgedTs`
   * becomes the ts of the last one dropped.
   */
  private enforceRetention(currentTs: number) {
    const { minRetentionUs, maxRetentionUs, softMaxBytes, hardMaxBytes } = this.retention;
    const hardLimit = currentTs - minRetentionUs;
    const softLimit = currentTs - maxRetentionUs;
    while (this.logHead < this.log.length) {
      const e = this.log[this.logHead];
      if (
        this.logBytes <= (hardMaxBytes ?? Number.POSITIVE_INFINITY) &&
        e.ts >= (this.logBytes >= softMaxBytes ? hardLimit : softLimit)
      )
        break;
      this.purgedTs = e.ts;
      this.logBytes -= logEntryBytes(e);
      this.log[this.logHead++] = undefined as unknown as LogEntry; // release it now
    }
    // Compact once the dropped prefix is the larger part: amortized O(1) per commit.
    if (this.logHead > 1024 && this.logHead * 2 > this.log.length) {
      this.log = this.log.slice(this.logHead);
      this.logHead = 0;
    }
    if (this.logHead === this.log.length) this.logBytes = 0; // no drift from the estimate
  }

  /** Wakes the backoff sleep of a flush retry when the committer stops. */
  private wakeRetry: (() => void) | null = null;
  /** Failed flush attempts so far, in total (retried or not). */
  flushFailures = 0;

  /**
   * Flush the group, retrying transient failures as Convex's write batcher does (STUDY-25 L4,
   * `crates/database/src/write_batcher.rs`): a failure the driver classifies as transient (`isTransient`: a
   * timeout, a lost connection, a server shutting down) is retried with full-jitter exponential backoff from
   * 100 ms up to 10 s, with no limit on the number of attempts; any other failure ends it. The driver keeps
   * the group it failed to flush, so the retry writes the same rows at the same timestamps, behind the same
   * fence (PERSIST-01 C7, C9). A retry whose earlier attempt did commit finds it through the lease record and
   * succeeds without writing (DV-124; Convex stops); one that lands while the retry writes fails as "unsure"
   * (a duplicate key, or MongoDB's fence), which is not transient: fail-stop, as Convex. The lease
   * bounds the retries in practice: renewals fail too while the store is unreachable, and the engine stops
   * the committer once the TTL runs out without one.
   */
  private async flushWithRetries() {
    const initial = this.retry.initialBackoffMs ?? WRITE_RETRY_INITIAL_BACKOFF_MS;
    const max = this.retry.maxBackoffMs ?? WRITE_RETRY_MAX_BACKOFF_MS;
    for (let failures = 0; ; ) {
      try {
        await this.persistence.flush();
        return;
      } catch (e) {
        this.flushFailures++;
        if (this.stopped || !this.persistence.isTransient?.(e)) throw e;
        // The real Math.random: the drain may run in the async context of the mutation that started it.
        const delay = Math.min(initial * 2 ** failures, max) * outsideExecution(Math.random);
        failures++;
        (this.retry.onRetry ?? defaultOnRetry)(e, failures, delay);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          this.wakeRetry = done;
        });
        this.wakeRetry = null;
        if (this.stopped) throw e;
      }
    }
  }

  /** Resolve once nothing is queued or being flushed (a clean shutdown lets the last group land). */
  async idle() {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 1));
  }

  /** Stop the committer from outside, as a persistence failure does (a lost lease). Fail-stop. */
  fail(cause: unknown) {
    this.stop(cause);
  }

  private stop(cause: unknown, context?: string) {
    if (this.stopped) return;
    this.stopped = new CommitterStoppedError(cause, context);
    this.wakeRetry?.();
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) p.reject(this.stopped);
    this.wakeVisible();
    for (const l of this.fatalListeners) l(this.stopped);
  }
}
