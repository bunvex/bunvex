// The ONE committer: optimistic validation, timestamps and group commit.
//
// A transaction reads at a snapshot ts and records what it read as key intervals (its read-set). The
// committer validates the read-set against every commit made after the snapshot (the in-memory write
// log), assigns the next ts, applies the writes to persistence, and makes the whole GROUP durable with one
// flush. Commits queued while a group is being flushed form the next group.
import { compareKeys } from "./keyenc.ts";
import type { DocWrite, IndexWrite, Persistence } from "./persistence/index.ts";

export type Interval = { index: number; lo: Uint8Array; hi: Uint8Array };
export type LogEntry = { ts: number; writes: { index: number; key: Uint8Array }[] };

export function overlaps(writes: LogEntry["writes"], reads: Interval[]): boolean {
  for (const w of writes)
    for (const r of reads)
      if (r.index === w.index && compareKeys(w.key, r.lo) >= 0 && compareKeys(w.key, r.hi) < 0) return true;
  return false;
}

export class ConflictError extends Error {
  constructor() {
    super("write conflict");
  }
}

type PendingCommit = {
  snapshot: number;
  reads: Interval[];
  docs: DocWrite[];
  idx: IndexWrite[];
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

  constructor(
    private persistence: Persistence,
    private logWindow = 20_000,
  ) {}

  /** Subscribe to durable commits (the query cache and subscriptions). */
  onCommit(fn: (entries: LogEntry[]) => void) {
    this.listeners.push(fn);
  }

  commit(c: Omit<PendingCommit, "resolve" | "reject">): Promise<number> {
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

  private validate(p: PendingCommit): boolean {
    if (p.reads.length === 0) return true;
    // The window must still cover the snapshot, otherwise we cannot prove the absence of a conflict.
    if (this.log.length && this.log[0].ts > p.snapshot + 1 && p.snapshot < this.appliedTs) return false;
    for (let i = this.log.length - 1; i >= 0 && this.log[i].ts > p.snapshot; i--)
      if (overlaps(this.log[i].writes, p.reads)) return false;
    return true;
  }

  private async drain() {
    while (this.queue.length) {
      const group = this.queue;
      this.queue = [];
      const accepted: [PendingCommit, LogEntry][] = [];
      for (const p of group) {
        if (!this.validate(p)) {
          this.conflicts++;
          p.reject(new ConflictError());
          continue;
        }
        const ts = ++this.appliedTs;
        this.persistence.apply(ts, p.docs, p.idx);
        const entry: LogEntry = { ts, writes: p.idx.map((w) => ({ index: w.index, key: w.key })) };
        this.log.push(entry); // visible to the validation of the NEXT commits of this very group
        accepted.push([p, entry]);
      }
      if (this.log.length > this.logWindow) this.log.splice(0, this.log.length - this.logWindow);
      if (!accepted.length) continue;
      try {
        await this.persistence.flush();
        this.groups++;
        this.visibleTs = accepted[accepted.length - 1][1].ts;
        const entries = accepted.map(([, e]) => e);
        for (const l of this.listeners) l(entries);
        for (const [p, e] of accepted) p.resolve(e.ts);
      } catch (e) {
        for (const [p] of accepted) p.reject(e);
      }
    }
    this.running = false;
  }
}
