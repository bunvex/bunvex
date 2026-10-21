// The clock and timers the engine and the server read (STUDY-132), as Convex's `Runtime`
// (crates/common/src/runtime/mod.rs: `system_time`, `monotonic_now`, `wait`): production uses the real ones
// (`realRuntime`), a test can pass a `TestRuntime` (test-runtime.ts) whose time moves only when the test says.
//
// The real runtime is the process's own clock and timers, captured when this module loads: before
// `installDeterminism()` replaces the globals for queries and mutations, so engine code that reads the time
// through a runtime is never frozen nor refused inside an execution.

import { type LongTimer, longInterval, longTimeout } from "./long-timer.ts";

/** A pending timer: a `LongTimer` for the real runtime (`unref` lets the process exit while it waits). */
export interface RuntimeTimer {
  ref(): unknown;
  unref(): unknown;
  hasRef(): boolean;
}

export interface Runtime {
  /** The wall clock, in ms since the Unix epoch (`Date.now()`). Callable detached, as `monotonicNow`. */
  readonly now: () => number;
  /** A monotonic clock, in ms from an arbitrary origin (`performance.now()`). */
  readonly monotonicNow: () => number;
  /**
   * The wall clock in fractional ms, never behind `now()`: a transaction's first `_creationTime` (Convex's
   * `CreationTime::for_transaction`). Not unique: the engine makes each transaction's start unique itself.
   */
  readonly preciseNow: () => number;
  /** The wall clock in ns, never behind `now()`: the clock of commit timestamps (Convex's `system_time` as u64). */
  readonly nowNs: () => bigint;
  /** A timer of any length: past 2^31-1 ms the real runtime re-arms for what is left (rule 6 trusts it). */
  setTimeout(fn: () => void, ms: number): RuntimeTimer;
  clearTimeout(timer: RuntimeTimer | null | undefined): void;
  setInterval(fn: () => void, ms: number): RuntimeTimer;
  clearInterval(timer: RuntimeTimer | null | undefined): void;
  /** Resolves after `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);

const origin = performance.timeOrigin;

/** `performance.now()` on the epoch, or the wall clock when that is ahead (it drifts by up to a millisecond). */
function realPreciseNow(): number {
  const precise = origin + realPerformanceNow();
  const wall = realNow();
  return precise > wall ? precise : wall;
}

/** The whole milliseconds from the clock and the fraction from `performance.now()` (sub-microsecond on Bun). */
function realNowNs(): bigint {
  const ms = realPreciseNow();
  const whole = Math.floor(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.floor((ms - whole) * 1e6));
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => void longTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      timer.clear();
      reject(signal.reason);
    };
    const timer = longTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The process's clock and timers: what every engine and server uses unless a test passes its own. */
export const realRuntime: Runtime = {
  now: () => realNow(),
  monotonicNow: realPerformanceNow,
  preciseNow: realPreciseNow,
  nowNs: realNowNs,
  // Any length, as Convex's `Runtime::wait` (a `Duration`): past 2^31-1 ms they re-arm (STUDY-174 Q8).
  setTimeout: (fn, ms) => longTimeout(fn, ms),
  clearTimeout: (t) => (t as LongTimer | null | undefined)?.clear(),
  setInterval: (fn, ms) => longInterval(fn, ms),
  clearInterval: (t) => (t as LongTimer | null | undefined)?.clear(),
  sleep: realSleep,
};
