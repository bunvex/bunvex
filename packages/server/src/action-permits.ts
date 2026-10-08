// How many functions run at once (STUDY-31, STUDY-68), as Convex's limiters
// (crates/application/src/application_function_runner/mod.rs `Limiter`): one per kind — queries, mutations,
// actions (HTTP actions included) and Node actions. A query or mutation run (each attempt), an action and an
// HTTP action take a permit; a cached query and a call inside another function's transaction do not. A
// request that waits longer than the timeout fails with `TooManyConcurrentRequests` (HTTP 429; the sync
// protocol closes with "try again"); scheduled and cron actions wait as long as it takes. Knobs, with
// Convex's names: APPLICATION_MAX_CONCURRENT_QUERIES and _MUTATIONS (16), _V8_ACTIONS and _NODE_ACTIONS (64);
// APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT (ms, 5 000) and _ACTION_SEMAPHORE_TIMEOUT (ms, 10 000).

import { outsideExecution, type Runtime, realRuntime } from "@bunvex/core";

export type LimitedKind = "query" | "mutation" | "action";

const PLURAL: Record<LimitedKind, string> = { query: "queries", mutation: "mutations", action: "actions" };

export class TooManyConcurrentRequestsError extends Error {
  override name = "TooManyConcurrentRequestsError";
  readonly code = "TooManyConcurrentRequests";
  constructor(limit: number, kind: LimitedKind = "action", knob = "APPLICATION_MAX_CONCURRENT_V8_ACTIONS") {
    // Convex's message (its plurals since b352fab); its last sentence (an upgrade offer) is replaced by how to
    // raise the limit here.
    super(
      `Too many concurrent requests. Your backend is limited to ${limit} concurrent ${PLURAL[kind]}. To raise the limit, set ${knob}.`,
    );
  }
}

/** Convex's `Limiter`: at most `max` running; others queue, up to `waitMs` unless told to wait. */
export class ConcurrencyLimiter {
  private inUse = 0;
  private readonly waiting: (() => void)[] = [];
  /** For tests and benchmarks. */
  readonly stats = { peak: 0, refused: 0 };
  /** Running and queued now, for the metrics' `function_concurrency` (STUDY-58). */
  readonly outstanding = { running: 0, queued: 0 };
  /** Called when `outstanding` changes. */
  onChange: (() => void) | null = null;

  constructor(
    readonly max: number,
    readonly waitMs: number,
    readonly kind: LimitedKind = "action",
    readonly knob = "APPLICATION_MAX_CONCURRENT_V8_ACTIONS",
    /** Whose timers time a wait out (STUDY-132). */
    private readonly runtime: Runtime = realRuntime,
  ) {}

  /** Run `fn` holding a permit. `wait`: no timeout (Convex's scheduled and cron runs). */
  async run<T>(fn: () => Promise<T>, opts: { wait?: boolean } = {}): Promise<T> {
    const o = this.outstanding;
    // A permit freed while others wait goes straight to the first of them, so none can be taken in between.
    if (this.inUse >= this.max) {
      o.queued++;
      this.onChange?.();
      try {
        await this.wait(opts.wait === true);
      } finally {
        o.queued--;
      }
    } else this.inUse++;
    if (this.inUse > this.stats.peak) this.stats.peak = this.inUse;
    o.running++;
    this.onChange?.();
    try {
      return await fn();
    } finally {
      o.running--;
      this.onChange?.();
      const next = this.waiting.shift();
      if (next) next();
      else this.inUse--;
    }
  }

  private wait(forever: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      // Queries and mutations wait inside their deterministic execution, where timers are refused: this one
      // is the server's, not the function's.
      const timer = forever
        ? null
        : outsideExecution(() =>
            this.runtime.setTimeout(() => {
              const i = this.waiting.indexOf(wake);
              if (i !== -1) this.waiting.splice(i, 1);
              this.stats.refused++;
              reject(new TooManyConcurrentRequestsError(this.max, this.kind, this.knob));
            }, this.waitMs),
          );
      const wake = () => {
        if (timer) outsideExecution(() => this.runtime.clearTimeout(timer));
        resolve();
      };
      this.waiting.push(wake);
    });
  }
}

/** The action limiter (STUDY-31): actions and HTTP actions share it, as in Convex. */
export class ActionPermits extends ConcurrencyLimiter {
  constructor(max: number, waitMs: number, runtime: Runtime = realRuntime) {
    super(max, waitMs, "action", "APPLICATION_MAX_CONCURRENT_V8_ACTIONS", runtime);
  }

  static fromEnv(env = process.env, runtime: Runtime = realRuntime): ActionPermits {
    return new ActionPermits(
      knob(env, "APPLICATION_MAX_CONCURRENT_V8_ACTIONS", 64),
      knob(env, "APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT", 10_000),
      runtime,
    );
  }
}

function knob(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const v = env[k];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${k}: not a positive number: ${v}`);
  return n;
}

/** Every limiter of a deployment (STUDY-68). */
export type FunctionLimits = {
  query: ConcurrencyLimiter;
  mutation: ConcurrencyLimiter;
  action: ConcurrencyLimiter;
  /** `"use node"` actions (DV-87: they run in this process, but have their own limit, as in Convex). */
  nodeAction: ConcurrencyLimiter;
};

export function functionLimitsFromEnv(
  env = process.env,
  action?: ConcurrencyLimiter,
  /** Whose timers time the waits out (STUDY-132). */
  runtime: Runtime = realRuntime,
) {
  const wait = knob(env, "APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT", 5000);
  const actionWait = knob(env, "APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT", 10_000);
  return {
    query: new ConcurrencyLimiter(
      knob(env, "APPLICATION_MAX_CONCURRENT_QUERIES", 16),
      wait,
      "query",
      "APPLICATION_MAX_CONCURRENT_QUERIES",
      runtime,
    ),
    mutation: new ConcurrencyLimiter(
      knob(env, "APPLICATION_MAX_CONCURRENT_MUTATIONS", 16),
      wait,
      "mutation",
      "APPLICATION_MAX_CONCURRENT_MUTATIONS",
      runtime,
    ),
    action: action ?? ActionPermits.fromEnv(env, runtime),
    nodeAction: new ConcurrencyLimiter(
      knob(env, "APPLICATION_MAX_CONCURRENT_NODE_ACTIONS", 64),
      actionWait,
      "action",
      "APPLICATION_MAX_CONCURRENT_NODE_ACTIONS",
      runtime,
    ),
  } satisfies FunctionLimits;
}
