// The deployment's write throughput limit (STUDY-78), as Convex's `WriteThroughputLimiter`
// (crates/database/src/write_throughput_limiter.rs, snapshot_manager.rs): every commit's bytes are recorded at
// its timestamp once it is published, whoever wrote it; before a mutation (or an import step) starts, the
// bytes committed within the last window are compared with `MAX_BYTES_WRITTEN_PER_SECOND` (4 MiB) × the
// window (`WRITE_THROUGHPUT_WINDOW`, 1 s). Since Convex 75d250e each commit also records its rows (document
// writes plus index writes), checked against `MAX_ROWS_WRITTEN_PER_SECOND` × the window after the bytes; 0,
// the default, turns the rows limit off. The check does not count the transaction about to run: one large
// commit can take the window over the limit, and then the next writers wait.

import { wallClockNs } from "./determinism.ts";

/** Convex's `MAX_BYTES_WRITTEN_PER_SECOND` default: 4 MiB. */
export const MAX_BYTES_WRITTEN_PER_SECOND = 4 * 1024 * 1024;
/** Convex's `WRITE_THROUGHPUT_WINDOW` default: 1 s. */
export const WRITE_THROUGHPUT_WINDOW_MS = 1000;
/** Convex's `MAX_ROWS_WRITTEN_PER_SECOND` default: 0, no rows limit. */
export const MAX_ROWS_WRITTEN_PER_SECOND = 0;

export type WriteThroughputOptions = {
  /** Bytes a second (default 4 MiB); `0` refuses every gated write once anything was written. */
  maxBytesPerSecond?: number;
  /** Document and index rows a second (default 0: no rows limit). */
  maxRowsPerSecond?: number;
  /** The window, in ms (default 1000). */
  windowMs?: number;
};

/** Byte units from the largest, binary and decimal, as Convex's `format_bytes` tries them. */
const BYTE_UNITS: [number, string][] = [
  [2 ** 30, "GiB"],
  [1e9, "GB"],
  [2 ** 20, "MiB"],
  [1e6, "MB"],
  [2 ** 10, "KiB"],
  [1e3, "KB"],
];

/** A byte count as Convex's `format_bytes` writes it: `4 MiB`, `4.5 MiB`, `1534 bytes`. */
export function formatByteCount(n: number): string {
  if (n === 0) return "0 bytes";
  for (const [size, unit] of BYTE_UNITS) {
    if (n < size) continue;
    if (n % size === 0) return `${n / size} ${unit}`;
    if ((n * 10) % size === 0) return `${Math.floor(n / size)}.${Math.floor((n * 10) / size) % 10} ${unit}`;
  }
  return `${n} bytes`;
}

/** Which limit the writes in the window went over (Convex's `WriteThroughputLimit`). */
export type WriteThroughputLimit = "bytes" | "rows";

/**
 * Convex's `ErrorMetadata::rate_limited("TooManyWrites", …)`: HTTP 429, and a sync session closes with "try
 * again". Both messages name the per-second limit (since Convex 75d250e, whatever the window). Their upgrade
 * offer is replaced by how to raise the limit here, as for `TooManyConcurrentRequests` (STUDY-68).
 */
export class TooManyWritesError extends Error {
  override name = "TooManyWritesError";
  readonly code = "TooManyWrites";
  constructor(limit: WriteThroughputLimit, maxPerSecond: number) {
    super(
      limit === "bytes"
        ? `Too many writes per second. Your deployment is limited to ${formatByteCount(maxPerSecond)} bytes written per second. Reduce your write rate or set MAX_BYTES_WRITTEN_PER_SECOND to raise the limit.`
        : `Too many writes per second. Your deployment is limited to ${maxPerSecond} document and index rows written per second. Reduce your write rate, remove unused indexes, or set MAX_ROWS_WRITTEN_PER_SECOND to raise the limit.`,
    );
  }
}

/**
 * The sliding window of committed bytes and rows. `record` keeps the commits of the last window (dropping
 * older ones only then, as Convex's); `exceeded` compares what was committed within the window before `now`,
 * re-summing only when a running total is over its limit, so an idle deployment's stale totals never block it.
 */
export class WriteThroughputLimiter {
  readonly maxBytesPerSecond: number;
  readonly maxRowsPerSecond: number;
  readonly windowMs: number;
  private readonly maxInWindow: number;
  /** Infinity when there is no rows limit. */
  private readonly maxRowsInWindow: number;
  private readonly windowNs: bigint;
  /** Commit timestamps (ns), their bytes and rows, oldest first, from `head`. */
  private ts: bigint[] = [];
  private bytes: number[] = [];
  private rows: number[] = [];
  private head = 0;
  private total = 0;
  private totalRows = 0;
  /** For tests and metrics: checks refused. */
  refused = 0;

  constructor(o: WriteThroughputOptions = {}) {
    this.maxBytesPerSecond = o.maxBytesPerSecond ?? MAX_BYTES_WRITTEN_PER_SECOND;
    this.maxRowsPerSecond = o.maxRowsPerSecond ?? MAX_ROWS_WRITTEN_PER_SECOND;
    this.windowMs = o.windowMs ?? WRITE_THROUGHPUT_WINDOW_MS;
    this.maxInWindow = (this.maxBytesPerSecond * this.windowMs) / 1000;
    this.maxRowsInWindow = this.maxRowsPerSecond > 0 ? (this.maxRowsPerSecond * this.windowMs) / 1000 : Infinity;
    this.windowNs = BigInt(Math.round(this.windowMs * 1_000_000));
  }

  /** The bytes and rows (document writes plus index writes) of a commit published at `ts`. */
  record(ts: bigint, bytes: number, rows = 0) {
    while (this.head < this.ts.length && ts - this.ts[this.head]! > this.windowNs) {
      this.total -= this.bytes[this.head]!;
      this.totalRows -= this.rows[this.head]!;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.ts.length) {
      this.ts = this.ts.slice(this.head);
      this.bytes = this.bytes.slice(this.head);
      this.rows = this.rows.slice(this.head);
      this.head = 0;
    }
    this.ts.push(ts);
    this.bytes.push(bytes);
    this.rows.push(rows);
    this.total += bytes;
    this.totalRows += rows;
  }

  /**
   * The limit the commits within the window before `now` went over, bytes checked first as Convex's
   * `exceeded_limit`, or null when a writer may start.
   */
  exceeded(now: bigint): WriteThroughputLimit | null {
    if (this.total <= this.maxInWindow && this.totalRows <= this.maxRowsInWindow) return null;
    let inWindow = 0;
    let rowsInWindow = 0;
    for (let i = this.head; i < this.ts.length; i++) {
      const t = this.ts[i]!;
      if (now < t || now - t <= this.windowNs) {
        inWindow += this.bytes[i]!;
        rowsInWindow += this.rows[i]!;
      }
    }
    const limit = inWindow > this.maxInWindow ? "bytes" : rowsInWindow > this.maxRowsInWindow ? "rows" : null;
    if (limit) this.refused++;
    return limit;
  }

  /** The limit refused now (the wall clock commit timestamps follow), or null. */
  exceededNow(): WriteThroughputLimit | null {
    return this.exceeded(wallClockNs());
  }

  /** Whether a writer may start at `now`. */
  allows(now: bigint): boolean {
    return this.exceeded(now) === null;
  }

  /** Whether a writer may start now. */
  allowsNow(): boolean {
    return this.exceededNow() === null;
  }

  /** The error for a refused writer. */
  error(limit: WriteThroughputLimit): TooManyWritesError {
    return new TooManyWritesError(limit, limit === "bytes" ? this.maxBytesPerSecond : this.maxRowsPerSecond);
  }

  /** Throw `TooManyWritesError` unless a writer may start at `now`. */
  check(now: bigint) {
    const limit = this.exceeded(now);
    if (limit) throw this.error(limit);
  }
}
