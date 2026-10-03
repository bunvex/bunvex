// How many actions run at once (STUDY-31), as Convex's action limiter
// (crates/application/src/application_function_runner/mod.rs): every action — called over HTTP or the
// sync protocol, scheduled, run by another action, or an HTTP action — takes a permit; one that waits longer
// than the timeout fails with `TooManyConcurrentRequests` (HTTP 429). Knobs, with Convex's names:
// APPLICATION_MAX_CONCURRENT_V8_ACTIONS (64) and APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT (ms,
// 10 000).

export class TooManyConcurrentRequestsError extends Error {
  override name = "TooManyConcurrentRequestsError";
  readonly code = "TooManyConcurrentRequests";
  constructor(limit: number) {
    // Convex's message; its last sentence (an upgrade offer) is replaced by how to raise the limit here.
    super(
      `Too many concurrent requests. Your backend is limited to ${limit} concurrent actions. To raise the limit, set APPLICATION_MAX_CONCURRENT_V8_ACTIONS.`,
    );
  }
}

export class ActionPermits {
  private inUse = 0;
  private readonly waiting: (() => void)[] = [];
  /** For tests and benchmarks. */
  readonly stats = { peak: 0, refused: 0 };

  constructor(
    readonly max: number,
    readonly waitMs: number,
  ) {}

  static fromEnv(env = process.env): ActionPermits {
    const num = (k: string, d: number) => {
      const v = env[k];
      if (v === undefined || v === "") return d;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1) throw new Error(`${k}: not a positive number: ${v}`);
      return n;
    };
    return new ActionPermits(
      num("APPLICATION_MAX_CONCURRENT_V8_ACTIONS", 64),
      num("APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT", 10_000),
    );
  }

  /** Running and queued executions per kind, for the app metrics' `function_concurrency` (STUDY-58). */
  readonly outstanding = { Action: { running: 0, queued: 0 }, HttpAction: { running: 0, queued: 0 } };
  /** Called when `outstanding` changes. */
  onChange: ((kind: "Action" | "HttpAction") => void) | null = null;

  /** Run `fn` holding a permit; wait for one up to the timeout. */
  async run<T>(fn: () => Promise<T>, kind: "Action" | "HttpAction" = "Action"): Promise<T> {
    const o = this.outstanding[kind];
    // A permit freed while others wait goes straight to the first of them, so none can be taken in between.
    if (this.inUse >= this.max) {
      o.queued++;
      this.onChange?.(kind);
      try {
        await this.wait();
      } finally {
        o.queued--;
      }
    } else this.inUse++;
    if (this.inUse > this.stats.peak) this.stats.peak = this.inUse;
    o.running++;
    this.onChange?.(kind);
    try {
      return await fn();
    } finally {
      o.running--;
      this.onChange?.(kind);
      const next = this.waiting.shift();
      if (next) next();
      else this.inUse--;
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(wake);
        if (i !== -1) this.waiting.splice(i, 1);
        this.stats.refused++;
        reject(new TooManyConcurrentRequestsError(this.max));
      }, this.waitMs);
      this.waiting.push(wake);
    });
  }
}
