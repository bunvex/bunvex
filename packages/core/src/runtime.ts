// The clock and timers the engine and the server read (STUDY-132), as Convex's `Runtime`
// (crates/common/src/runtime/mod.rs: `system_time`, `monotonic_now`, `wait`): production uses the real ones
// (`realRuntime`), a test can pass a `TestRuntime` (test-runtime.ts) whose time moves only when the test says.
//
// The real runtime is the process's own clock and timers, captured when this module loads: before
// `installDeterminism()` replaces the globals for queries and mutations, so engine code that reads the time
// through a runtime is never frozen nor refused inside an execution.

/** A pending timer: Bun's own for the real runtime (`unref` lets the process exit while it waits). */
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
  setTimeout(fn: () => void, ms: number): RuntimeTimer;
  clearTimeout(timer: RuntimeTimer | null | undefined): void;
  setInterval(fn: () => void, ms: number): RuntimeTimer;
  clearInterval(timer: RuntimeTimer | null | undefined): void;
  /** Resolves after `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => realSetTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      realClearTimeout(timer);
      reject(signal.reason);
    };
    const timer = realSetTimeout(() => {
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
  setTimeout: (fn, ms) => realSetTimeout(fn, ms),
  clearTimeout: (t) => realClearTimeout(t as ReturnType<typeof setTimeout> | undefined),
  setInterval: (fn, ms) => realSetInterval(fn, ms),
  clearInterval: (t) => realClearInterval(t as ReturnType<typeof setInterval> | undefined),
  sleep: realSleep,
};
