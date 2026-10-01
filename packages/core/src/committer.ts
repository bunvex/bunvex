// The ONE committer: optimistic validation, timestamps and group commit.
//
// A transaction reads at a snapshot ts and records what it read as key intervals (its read-set). The
// committer validates the read-set against every commit made after the snapshot (the in-memory write
// log), assigns the next ts, applies the writes to persistence, and makes the whole GROUP durable with one
// flush. Commits queued while a group is being flushed form the next group.

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
  private log: LogEntry[] = [];
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
    private logWindow = 20_000,
    /** The clock commit timestamps follow, in microseconds (tests pass their own). */
    private clockUs: () => number = wallClockUs,
    private retry: FlushRetryOptions = {},
  ) {}

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
    if (from < this.purgedTs) return true;
    for (let i = this.log.length - 1; i >= 0 && this.log[i].ts > from; i--)
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

  /** The conflict that refuses `p`, or null when it may commit. */
  private validate(p: PendingCommit): Conflict | null {
    if (p.reads.length === 0) return null;
    // The window must still cover the snapshot, otherwise we cannot prove the absence of a conflict (this
    // holds with an empty log too: a snapshot from before the store was opened is refused; STUDY-24 S4).
    if (p.snapshot < this.purgedTs) return { writeTs: this.appliedTs };
    for (let i = this.log.length - 1; i >= 0 && this.log[i].ts > p.snapshot; i--) {
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
          const conflict = this.validate(p);
          if (conflict) {
            this.conflicts++;
            p.reject(new ConflictError(conflict));
            continue;
          }
          // As Convex's `next_commit_ts`: the wall clock, but always above the last timestamp assigned, so
          // timestamps strictly increase even when the clock stands still or steps back (STUDY-06 D9).
          const ts = Math.max(this.appliedTs + 1, this.clockUs());
          this.appliedTs = ts;
          const writes = p.idx.map((w) => ({ index: w.index, key: w.key, id: w.id }));
          accepted.push([p, p.source === undefined ? { ts, writes } : { ts, writes, source: p.source }]);
          this.persistence.apply(ts, p.docs, p.idx);
          this.log.push(accepted[accepted.length - 1][1]); // seen by the validation of the NEXT commits of this group
        }
        if (this.log.length > this.logWindow)
          this.purgedTs = this.log.splice(0, this.log.length - this.logWindow).at(-1)!.ts;
        if (!accepted.length) continue;
      } catch (e) {
        // A throwing apply (or the log trim): nothing of this group becomes visible, and the group, and
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
      const entries = accepted.map(([, e]) => e);
      for (const l of this.listeners) l(entries);
      for (const [p, e] of accepted) p.resolve(e.ts);
      this.wakeVisible();
    }
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
   * fence (PERSIST-01 C7, C9). A retry whose earlier attempt did commit fails as "unsure" (a duplicate key, or
   * the driver finding its group already there), which is not transient: fail-stop, as Convex. The lease
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
