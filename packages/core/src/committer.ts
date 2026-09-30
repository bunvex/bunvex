// The ONE committer: optimistic validation, timestamps and group commit.
//
// A transaction reads at a snapshot ts and records what it read as key intervals (its read-set). The
// committer validates the read-set against every commit made after the snapshot (the in-memory write
// log), assigns the next ts, applies the writes to persistence, and makes the whole GROUP durable with one
// flush. Commits queued while a group is being flushed form the next group.
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
  constructor(cause: unknown) {
    super(
      `the committer stopped after a persistence failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
  }
}

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
  /** Set once persistence has failed; the committer accepts nothing afterwards. */
  stopped: CommitterStoppedError | null = null;

  constructor(
    private persistence: Persistence,
    private logWindow = 20_000,
  ) {}

  /**
   * Whether a durable commit in `(from, to]` (`to` ≤ visibleTs) wrote into `reads`. When it did not, a query
   * result read at either end is also the result at the other: its reads saw the same data (Convex's
   * `extend_validity`). True when the write log no longer reaches back to `from`, as the absence of a
   * conflict can then not be proven.
   */
  changedBetween(reads: Interval[], from: number, to: number): boolean {
    if (to > this.visibleTs) throw new Error(`changedBetween: ${to} is past the visible ts ${this.visibleTs}`);
    if (from >= to) return false;
    if (this.log.length === 0 || this.log[0].ts > from + 1) return true;
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
    // The window must still cover the snapshot, otherwise we cannot prove the absence of a conflict.
    if (this.log.length && this.log[0].ts > p.snapshot + 1 && p.snapshot < this.appliedTs)
      return { writeTs: this.appliedTs };
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
          const ts = ++this.appliedTs;
          const writes = p.idx.map((w) => ({ index: w.index, key: w.key, id: w.id }));
          accepted.push([p, p.source === undefined ? { ts, writes } : { ts, writes, source: p.source }]);
          this.persistence.apply(ts, p.docs, p.idx);
          this.log.push(accepted[accepted.length - 1][1]); // seen by the validation of the NEXT commits of this group
        }
        if (this.log.length > this.logWindow) this.log.splice(0, this.log.length - this.logWindow);
        if (!accepted.length) continue;
        await this.persistence.flush();
      } catch (e) {
        // Nothing of this group becomes visible: visibleTs stays where it was, and readers ignore versions
        // above it. The group, and everything queued behind it, is refused.
        this.stop(e);
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

  private stop(cause: unknown) {
    if (this.stopped) return;
    this.stopped = new CommitterStoppedError(cause);
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) p.reject(this.stopped);
    this.wakeVisible();
    for (const l of this.fatalListeners) l(this.stopped);
  }
}
