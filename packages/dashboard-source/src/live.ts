// A screen's live reads, as Convex's dashboard keeps them (STUDY-149 PR 5): every list it shows is a
// `usePaginatedQuery` or `useQuery`, a subscription per loaded page, so a change on any page reaches the screen.
// The contract's watchers are signals (STUDY-12 D3), so a `LiveGroup` remembers the reads the source answered
// for one screen and, while someone watches, keeps each subscribed; a new result tells the watchers.
//
// A busy list is paused as Convex's `usePausedLiveData` (`dashboard-common/src/lib/usePausedLiveData.ts:9-46`):
// past 100 updates in a 10 s window its subscriptions stop and the watchers hear `paused: true`; the list is
// then read once per fetch until someone subscribes again (Convex's "Go live"). What Convex keeps live beside it
// (the cron jobs, the file count) stays subscribed.
import { DataSourceError, type LiveChange, type Unsubscribe } from "@bunvex/dashboard/data-source";
import type { AdminSync, Args } from "./sync.ts";

/** Convex's `RATE_LIMIT_BUCKET_MS`. */
export const PAUSE_WINDOW_MS = 10_000;
/** Convex's `RATE_LIMIT_THRESHOLD`: more updates than this in a window pause the list. */
export const PAUSE_THRESHOLD = 100;
/** How many lists (a query and its filter) a group follows at most; the oldest one read is dropped. */
export const MAX_LISTS = 8;

/**
 * Convex's `useRateLimitChanges`: a window that starts when counting starts and restarts at the first update
 * after it ends; `hit` is true for the update that goes past the threshold.
 */
export class UpdateCounter {
  private count = 0;
  private start: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.start = clock();
  }

  hit(): boolean {
    const now = this.clock();
    if (now - this.start > PAUSE_WINDOW_MS) {
      this.count = 0;
      this.start = now;
    }
    this.count += 1;
    return this.count > PAUSE_THRESHOLD;
  }
}

/**
 * What a result is, for telling a new one from the last: its JSON, with int64 and bytes spelled out and a
 * page's cursors left out (the page and whether it is the last are what the screen shows).
 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, function (key, v: unknown) {
    if ((key === "continueCursor" || key === "splitCursor") && "page" in this) return undefined;
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof ArrayBuffer) return [...new Uint8Array(v)];
    return v;
  });
}

type Read = {
  udfPath: string;
  args: Args;
  /** Paused with the list (Convex's paged lists), or kept live (the rest). */
  pausable: boolean;
  last: string | undefined;
  off: (() => void) | null;
};

type Watcher = { onChange: (change: LiveChange) => void; onError: (e: DataSourceError) => void };

export type ReadOptions = {
  /** The list this read belongs to: a query and its filter, without the page. */
  list: string;
  /** The list's first page: the pages read before it are no longer shown. */
  first: boolean;
  pausable: boolean;
  signal?: AbortSignal | undefined;
};

export class LiveGroup {
  private readonly reads = new Map<string, Read>();
  /** Each list's reads, the most recently read list last. */
  private readonly lists = new Map<string, Set<string>>();
  private readonly watchers = new Set<Watcher>();
  private counter: UpdateCounter;
  private paused = false;

  constructor(
    private readonly sync: AdminSync,
    private readonly clock: () => number = Date.now,
  ) {
    this.counter = new UpdateCounter(clock);
  }

  /** A query's current result; remembered, and kept subscribed while someone watches. */
  async read<T>(udfPath: string, args: Args, opts: ReadOptions): Promise<T> {
    const key = fingerprint([udfPath, args]);
    let pages = this.lists.get(opts.list);
    if (pages && opts.first) for (const k of pages) if (k !== key) this.forget(k);
    if (!pages || opts.first) pages = new Set();
    this.lists.delete(opts.list);
    this.lists.set(opts.list, pages.add(key));
    while (this.lists.size > MAX_LISTS) {
      const [oldest, keys] = this.lists.entries().next().value as [string, Set<string>];
      for (const k of keys) this.forget(k);
      this.lists.delete(oldest);
    }
    let read = this.reads.get(key);
    if (!read) {
      read = { udfPath, args, pausable: opts.pausable, last: undefined, off: null };
      this.reads.set(key, read);
    }
    // followed first, so the read shares its subscription (one query token, as the client's)
    if (this.watchers.size > 0) this.follow(read);
    const value = await this.sync.query<T>(udfPath, args, opts.signal);
    // a read the group dropped meanwhile is answered and not remembered
    if (this.reads.get(key) === read) read.last = fingerprint(value);
    return value;
  }

  /**
   * Tells `onChange` whenever a remembered read has a new result (never synchronously). Subscribing resumes a
   * paused group and starts its count afresh, as a view mounted again.
   */
  watch(onChange: (change: LiveChange) => void, onError: (e: DataSourceError) => void): Unsubscribe {
    const watcher: Watcher = { onChange, onError };
    if (this.watchers.size === 0 || this.paused) {
      this.paused = false;
      this.counter = new UpdateCounter(this.clock);
    }
    this.watchers.add(watcher);
    for (const r of this.reads.values()) this.follow(r);
    return () => {
      if (!this.watchers.delete(watcher) || this.watchers.size > 0) return;
      for (const r of this.reads.values()) this.unfollow(r);
    };
  }

  /** Whether the paged lists are paused (Convex's auto-pause). */
  get isPaused(): boolean {
    return this.paused;
  }

  close(): void {
    this.watchers.clear();
    for (const k of [...this.reads.keys()]) this.forget(k);
    this.lists.clear();
  }

  private follow(read: Read) {
    if (read.off || (read.pausable && this.paused)) return;
    read.off = this.sync.watch(read.udfPath, read.args, (r) => {
      if (!r.success) {
        const e = new DataSourceError("unavailable", `${read.udfPath}: ${r.errorMessage}`);
        for (const w of [...this.watchers]) w.onError(e);
        return;
      }
      const now = fingerprint(r.value);
      const known = read.last;
      read.last = now;
      // the first result of a read not answered yet is what the read returns, not a change
      if (known !== undefined && now !== known) this.changed(read);
    });
  }

  private unfollow(read: Read) {
    read.off?.();
    read.off = null;
  }

  private forget(key: string) {
    const read = this.reads.get(key);
    if (!read) return;
    this.unfollow(read);
    this.reads.delete(key);
  }

  private changed(read: Read) {
    if (read.pausable && this.counter.hit()) {
      this.paused = true;
      for (const r of this.reads.values()) if (r.pausable) this.unfollow(r);
    }
    for (const w of [...this.watchers]) w.onChange({ paused: this.paused });
  }
}
