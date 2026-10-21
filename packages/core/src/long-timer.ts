// Timers of any length (STUDY-174 F2, F3, S8; owner, 2026-10-21: Q8). Past 2^31-1 ms (24.8 days) Bun, like Node,
// fires a timer after about 1 ms; Convex's tokio sleeps take any `Duration`. `timerDelay` caps a delay for a loop
// that looks again when woken; `longTimeout` / `longInterval` / `longSleep` sleep the whole length, re-arming for
// what is left. No imports: the real timers and clock are captured when this module loads, before
// `installDeterminism()` replaces the globals for queries and mutations.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realPerformanceNow = performance.now.bind(performance);

/**
 * The longest delay a timer takes: past 2^31-1 ms (24.8 days) Bun, like Node, fires it after about 1 ms
 * (STUDY-174 I-25). Convex's tokio sleeps take any duration.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * A timer's delay, at least 0 and at most `MAX_TIMER_MS`. A sleep towards a far timestamp wakes early and looks
 * again. Every delay a `setTimeout` computes from a clock goes through it (`bun run check:deps`, rule 6).
 */
export const timerDelay = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));

/** The timers a long timer re-arms with: the process's own by default; a test passes its own. */
export type TimerHost = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  now: () => number;
};
const realTimerHost: TimerHost = {
  setTimeout: (fn, ms) => realSetTimeout(fn, ms),
  clearTimeout: (t) => realClearTimeout(t as ReturnType<typeof setTimeout>),
  now: realPerformanceNow,
};

/**
 * A timer of any length (STUDY-174 S8, Q8): Convex's knobs are `Duration`s that tokio sleeps for whatever their
 * length, while a JS timer past `MAX_TIMER_MS` fires after about 1 ms. This one sleeps at most `MAX_TIMER_MS` at a
 * time and re-arms for what is left, towards a deadline on the monotonic clock; `clear()` cancels it, mid-wait
 * included. `unref()` / `ref()` apply to every step, as Bun's own timers' do. Clear one with `clearLongTimer`.
 */
export class LongTimer {
  private timer: unknown = null;
  private referenced = true;
  private done = false;
  private due: number;
  private readonly wait: number;
  private readonly every: number | null;

  constructor(
    private readonly fn: () => void,
    ms: number,
    repeat: boolean,
    private readonly host: TimerHost = realTimerHost,
  ) {
    this.wait = Number.isFinite(ms) ? Math.max(0, ms) : MAX_TIMER_MS;
    this.every = repeat ? Math.max(1, this.wait) : null;
    this.due = host.now() + this.wait;
    this.arm(this.due);
  }

  private arm(due: number) {
    if (this.done) return;
    this.due = due;
    this.timer = this.host.setTimeout(
      () => {
        if (this.done || this.due !== due) return;
        if (this.host.now() < due) return this.arm(due); // a step of a longer wait: sleep again for what is left
        if (this.every === null) this.done = true;
        else this.arm(this.host.now() + this.every);
        this.fn();
      },
      timerDelay(due - this.host.now()),
    );
    if (!this.referenced) (this.timer as { unref?: () => void }).unref?.();
  }

  /** Start the wait again from now, for its whole length (Bun's `Timeout.refresh`). */
  refresh(): this {
    if (this.done) return this;
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    this.arm(this.host.now() + (this.every ?? this.wait));
    return this;
  }

  clear() {
    this.done = true;
    if (this.timer !== null) this.host.clearTimeout(this.timer);
    this.timer = null;
  }

  unref(): this {
    this.referenced = false;
    (this.timer as { unref?: () => void } | null)?.unref?.();
    return this;
  }

  ref(): this {
    this.referenced = true;
    (this.timer as { ref?: () => void } | null)?.ref?.();
    return this;
  }

  hasRef(): boolean {
    return this.referenced && !this.done;
  }
}

/** `setTimeout` for a delay of any length (a knob's, an option's): see `LongTimer`. */
export const longTimeout = (fn: () => void, ms: number, host?: TimerHost): LongTimer =>
  new LongTimer(fn, ms, false, host);

/** `setInterval` for a period of any length: see `LongTimer`. */
export const longInterval = (fn: () => void, ms: number, host?: TimerHost): LongTimer =>
  new LongTimer(fn, ms, true, host);

/** Cancel a long timer (`null` and `undefined` are ignored, as `clearTimeout`'s). */
export const clearLongTimer = (t: LongTimer | null | undefined): void => t?.clear();

/** Resolves after `ms`, however long. */
export const longSleep = (ms: number): Promise<void> => new Promise((resolve) => void longTimeout(resolve, ms));
