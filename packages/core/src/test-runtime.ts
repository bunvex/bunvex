// A runtime with virtual time, for tests (STUDY-132), as Convex's test runtime (tokio's paused clock behind
// `TestRuntime`, `rt.advance_time(d)`): nothing waits on the real clock, and time moves only when the test
// moves it, so a timing test asserts what happens at each instant instead of sleeping and hoping the
// machine kept up.
//
//   const rt = new TestRuntime();
//   const engine = new Engine(schema, persistence, { runtime: rt });
//   ...
//   await rt.advance(30_000); // every timer due in the next 30 s fires, in order, each at its instant
//   await rt.runUntilIdle();  // fire timers until only unref'd ones (heartbeats, sweepers) are left
//
// Between timers the test runtime lets the process run (one real macrotask turn), so the promise chains a
// timer starts settle before time moves on. Real I/O (a socket, a child process) is not virtual: a test
// awaits it as usual, then moves the time.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Runtime, RuntimeTimer } from "./runtime.ts";

const realSetImmediate = globalThis.setImmediate;

type Entry = {
  at: number;
  seq: number;
  fn: () => void;
  /** An interval's period; null for a timeout. */
  every: number | null;
  ref: boolean;
  /** Fired in the async context it was set in, as a real timer is. */
  run: <R>(fn: () => R) => R;
  handle: TestTimer;
};

class TestTimer implements RuntimeTimer {
  constructor(public entry: Entry | null) {}
  ref() {
    if (this.entry) this.entry.ref = true;
    return this;
  }
  unref() {
    if (this.entry) this.entry.ref = false;
    return this;
  }
  hasRef() {
    return this.entry?.ref ?? false;
  }
}

/** One real macrotask turn: every microtask queued so far, and those they queue, run. */
const turn = () => new Promise<void>((resolve) => realSetImmediate(resolve));

export class TestRuntime implements Runtime {
  private mono = 0;
  private readonly wallStart: number;
  private seq = 0;
  /** Pending timers, by `at` then `seq`. Few at a time in a test: a sorted array is enough. */
  private readonly timers: Entry[] = [];

  /** `now`: the wall clock at the start (default: a fixed instant, 2026-01-01T00:00:00Z). */
  constructor(opts: { now?: number } = {}) {
    this.wallStart = opts.now ?? Date.UTC(2026, 0, 1);
  }

  // Fields, not methods: a clock is handed around detached (`newUserTimer(…, rt.monotonicNow)`).
  readonly now = (): number => this.wallStart + this.mono;
  readonly monotonicNow = (): number => this.mono;

  setTimeout(fn: () => void, ms: number): RuntimeTimer {
    return this.add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): RuntimeTimer {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearTimeout(timer: RuntimeTimer | null | undefined): void {
    if (!(timer instanceof TestTimer) || !timer.entry) return;
    const i = this.timers.indexOf(timer.entry);
    if (i !== -1) this.timers.splice(i, 1);
    timer.entry = null;
  }

  clearInterval(timer: RuntimeTimer | null | undefined): void {
    this.clearTimeout(timer);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = this.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** How many timers are pending (`refOnly`: those that keep a process alive). */
  pending(refOnly = false): number {
    return refOnly ? this.timers.filter((t) => t.ref).length : this.timers.length;
  }

  /** When the next timer is due, in monotonic ms; null if none is pending. */
  nextAt(): number | null {
    return this.timers[0]?.at ?? null;
  }

  /**
   * Move the time `ms` forward. Every timer due by then fires in order, the clock reading its instant, and
   * what it started settles before the next one; then the clock stops at the target.
   */
  async advance(ms: number): Promise<void> {
    if (!(ms >= 0)) throw new RangeError(`advance: not a duration: ${ms}`);
    const target = this.mono + ms;
    await this.settle();
    for (let next = this.timers[0]; next && next.at <= target; next = this.timers[0]) {
      this.fire(next);
      await this.settle();
    }
    this.mono = target;
    await this.settle();
  }

  /**
   * Fire timers, moving the time to each, until only unref'd timers are left: what a process would do before
   * it could exit. Throws after `maxTimers` (a referenced interval never lets it end).
   */
  async runUntilIdle(maxTimers = 10_000): Promise<void> {
    await this.settle();
    for (let fired = 0; this.timers.some((t) => t.ref); fired++) {
      if (fired >= maxTimers)
        throw new Error(`runUntilIdle: still busy after ${maxTimers} timers (a referenced interval?)`);
      this.fire(this.timers[0]!);
      await this.settle();
    }
  }

  /** Let the process run: real turns, until one passes in which no timer was set (at most 100). */
  private async settle() {
    for (let i = 0; i < 100; i++) {
      const before = this.seq;
      await turn();
      if (this.seq === before) return;
    }
  }

  /**
   * Run until `p` settles, as Convex's tests run on tokio's paused clock: whenever the process has nothing
   * left to do but wait (a turn passed and `p` is still pending), the time jumps to the next timer. Returns
   * `p`'s outcome. For work that waits on virtual time only: a real socket's answer is not waited for, the
   * time jumps past it (`maxIdleTurns` turns with no timer to fire, and it fails).
   */
  async runUntilSettled<T>(p: Promise<T>, maxIdleTurns = 1000): Promise<T> {
    let settled = false;
    const done = p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let idle = 0; ; ) {
      await this.settle();
      if (settled) break;
      const next = this.timers[0];
      if (next) {
        idle = 0;
        this.fire(next);
      } else if (++idle > maxIdleTurns)
        throw new Error(`runUntilSettled: still pending after ${maxIdleTurns} turns with no timer to fire`);
    }
    await done;
    return p;
  }

  /**
   * The thread is busy for `ms` (a function's own work, a synchronous loop): the clock moves, and no timer
   * fires meanwhile; those that came due fire late, at the next `advance` or `runUntilIdle`, as a real one
   * does after the event loop was blocked.
   */
  blockFor(ms: number): void {
    if (!(ms >= 0)) throw new RangeError(`blockFor: not a duration: ${ms}`);
    this.mono += ms;
  }

  private add(fn: () => void, ms: number, every: number | null): TestTimer {
    const handle = new TestTimer(null);
    const entry: Entry = {
      at: this.mono + Math.max(0, Number(ms) || 0),
      seq: this.seq++,
      fn,
      every,
      ref: true,
      run: AsyncLocalStorage.snapshot(),
      handle,
    };
    handle.entry = entry;
    this.insert(entry);
    return handle;
  }

  private insert(e: Entry) {
    let i = this.timers.length;
    while (
      i > 0 &&
      (this.timers[i - 1]!.at > e.at || (this.timers[i - 1]!.at === e.at && this.timers[i - 1]!.seq > e.seq))
    )
      i--;
    this.timers.splice(i, 0, e);
  }

  private fire(e: Entry) {
    this.timers.splice(this.timers.indexOf(e), 1);
    if (e.at > this.mono) this.mono = e.at;
    if (e.every !== null) {
      // Rescheduled before it runs, so the callback can clear it.
      e.at = this.mono + e.every;
      e.seq = this.seq++;
      this.insert(e);
    } else e.handle.entry = null;
    e.run(e.fn);
  }
}
