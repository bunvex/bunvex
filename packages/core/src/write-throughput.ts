// The deployment's write throughput limit (STUDY-78), as Convex's `WriteThroughputLimiter`
// (crates/database/src/write_throughput_limiter.rs, snapshot_manager.rs): every commit's bytes are recorded at
// its timestamp once it is published, whoever wrote it; before a mutation (or an import step) starts, the
// bytes committed within the last window are compared with `MAX_BYTES_WRITTEN_PER_SECOND` (4 MiB) × the
// window (`WRITE_THROUGHPUT_WINDOW`, 1 s). The check does not count the transaction about to run: one large
// commit can take the window over the limit, and then the next writers wait.

import { wallClockNs } from "./determinism.ts";

/** Convex's `MAX_BYTES_WRITTEN_PER_SECOND` default: 4 MiB. */
export const MAX_BYTES_WRITTEN_PER_SECOND = 4 * 1024 * 1024;
/** Convex's `WRITE_THROUGHPUT_WINDOW` default: 1 s. */
export const WRITE_THROUGHPUT_WINDOW_MS = 1000;

export type WriteThroughputOptions = {
  /** Bytes a second (default 4 MiB); `0` refuses every gated write once anything was written. */
  maxBytesPerSecond?: number;
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

/** A duration as Convex's `format_duration` writes it: `1 second`, `2 seconds`, `1.5 seconds`, `500ms`. */
export function formatWindow(ms: number): string {
  if (ms === 0) return "0ms";
  if (ms >= 1000) {
    if (ms % 1000 === 0) return ms === 1000 ? "1 second" : `${ms / 1000} seconds`;
    if ((ms * 10) % 1000 === 0) return `${Math.floor(ms / 1000)}.${Math.floor((ms * 10) / 1000) % 10} seconds`;
  }
  return `${ms}ms`;
}

/**
 * Convex's `ErrorMetadata::rate_limited("TooManyWrites", …)`: HTTP 429, and a sync session closes with "try
 * again". Its last sentence (an upgrade offer) is replaced by how to raise the limit here, as for
 * `TooManyConcurrentRequests` (STUDY-68).
 */
export class TooManyWritesError extends Error {
  override name = "TooManyWritesError";
  readonly code = "TooManyWrites";
  constructor(maxBytesPerSecond: number, windowMs: number) {
    super(
      `Too many writes per second. Your deployment is limited to ${formatByteCount(maxBytesPerSecond)} bytes written per ${formatWindow(windowMs)}. Reduce your write rate or set MAX_BYTES_WRITTEN_PER_SECOND to raise the limit.`,
    );
  }
}

/**
 * The sliding window of committed bytes. `record` keeps the commits of the last window (dropping older ones
 * only then, as Convex's); `check` compares the bytes committed within the window before `now`, re-summing
 * only when the running total is over the limit, so an idle deployment's stale total never blocks it.
 */
export class WriteThroughputLimiter {
  readonly maxBytesPerSecond: number;
  readonly windowMs: number;
  private readonly maxInWindow: number;
  private readonly windowNs: bigint;
  /** Commit timestamps (ns) and their bytes, oldest first, from `head`. */
  private ts: bigint[] = [];
  private bytes: number[] = [];
  private head = 0;
  private total = 0;
  /** For tests and metrics: checks refused. */
  refused = 0;

  constructor(o: WriteThroughputOptions = {}) {
    this.maxBytesPerSecond = o.maxBytesPerSecond ?? MAX_BYTES_WRITTEN_PER_SECOND;
    this.windowMs = o.windowMs ?? WRITE_THROUGHPUT_WINDOW_MS;
    this.maxInWindow = (this.maxBytesPerSecond * this.windowMs) / 1000;
    this.windowNs = BigInt(Math.round(this.windowMs * 1_000_000));
  }

  /** The bytes of a commit published at `ts`. */
  record(ts: bigint, bytes: number) {
    while (this.head < this.ts.length && ts - this.ts[this.head]! > this.windowNs) {
      this.total -= this.bytes[this.head]!;
      this.head++;
    }
    if (this.head > 1024 && this.head * 2 > this.ts.length) {
      this.ts = this.ts.slice(this.head);
      this.bytes = this.bytes.slice(this.head);
      this.head = 0;
    }
    this.ts.push(ts);
    this.bytes.push(bytes);
    this.total += bytes;
  }

  /** Whether a writer may start at `now`: the bytes committed within the window are at most the limit. */
  allows(now: bigint): boolean {
    if (this.total <= this.maxInWindow) return true;
    let inWindow = 0;
    for (let i = this.head; i < this.ts.length; i++) {
      const t = this.ts[i]!;
      if (now < t || now - t <= this.windowNs) inWindow += this.bytes[i]!;
    }
    if (inWindow <= this.maxInWindow) return true;
    this.refused++;
    return false;
  }

  /** Whether a writer may start now (the wall clock commit timestamps follow). */
  allowsNow(): boolean {
    return this.allows(wallClockNs());
  }

  /** Throw `TooManyWritesError` unless a writer may start at `now`. */
  check(now: bigint) {
    if (!this.allows(now)) throw new TooManyWritesError(this.maxBytesPerSecond, this.windowMs);
  }
}
