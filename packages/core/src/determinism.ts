// Deterministic execution for queries and mutations, as Convex does in its isolate: inside a transaction
// body, `Date.now()` / `new Date()` are frozen at the transaction's start, `performance.now()` is fixed in
// queries and counts up from that start in mutations, `Math.random()` comes from a PRNG seeded per
// execution, and `fetch` / `crypto.getRandomValues` throw. A result is then a function of what
// the transaction read, which the query cache and subscriptions rely on. Every execution (every mutation
// retry included) gets a fresh time and seed, as in Convex. Actions run outside and see the real globals.
//
// Convex owns a V8 isolate per function; bunvex shares one process, so the globals are replaced ONCE and
// each call looks up the current execution in an AsyncLocalStorage. Outside an execution they behave as
// the originals. The engine's own work — persistence reads issued by the transaction — runs back outside
// (`outsideExecution`), so drivers keep their real clocks, timers and randomness: the boundary Convex
// gets from its isolate. This is not a sandbox: code that captured `Date.now` before
// `installDeterminism()`, or that reaches a non-global API, still escapes.
import { AsyncLocalStorage } from "node:async_hooks";

/** `import`: a code version's modules being evaluated (Convex's import phase, STUDY-35). */
export type ExecutionKind = "query" | "mutation" | "import";
type Execution = {
  kind: ExecutionKind;
  now: number;
  random: () => number;
  /** `performance.now()` at the start: the execution's start time relative to `performance.timeOrigin`. */
  perfStart: number;
  /** The real monotonic clock at the start, to count a mutation's elapsed time from. */
  monotonicStart: number;
  /** What the body observed, for the caller (the query cache expires a result that read the clock). */
  observed: Observed;
  /** The running function's time budget (STUDY-41), when a user function runs. */
  timer?: UserTimer;
};

/**
 * A query's or mutation's time budget, as Convex's (crates/isolate/src/timeout.rs): user time is the wall
 * time minus the time paused — awaiting the store, or a nested call (which has its own budget). Over
 * `userMs`, the function fails with Convex's message; over `systemMs` of paused time, with Convex's system
 * timeout. In one process running JS cannot be interrupted: the budget is checked at every store call and
 * when the function ends (STUDY-41 N5), and once exceeded it cannot be caught.
 */
export type UserTimer = {
  start: number;
  paused: number;
  pausedSince: number | null;
  userMs: number;
  systemMs: number;
  /** The timeout, once hit: thrown again at every store call and at the end. */
  failed: Error | null;
};

/** Rust's `Duration` Debug form, as Convex's message prints the limit (`1s`, `1.5s`, `500ms`). */
export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(9))}s`;
  if (ms >= 1) return `${Number(ms.toFixed(6))}ms`;
  return `${Number((ms * 1000).toFixed(3))}µs`;
}

export const SYSTEM_TIMEOUT_MESSAGE = "Your request timed out performing too many system operations.";

export function newUserTimer(userMs: number, systemMs: number): UserTimer {
  return { start: realPerformanceNow(), paused: 0, pausedSince: null, userMs, systemMs, failed: null };
}

const pausedNow = (t: UserTimer) => t.paused + (t.pausedSince === null ? 0 : realPerformanceNow() - t.pausedSince);

/** Throw if the running function is over its budget (and remember it: the timeout cannot be caught). */
export function checkUserTime() {
  const t = executions.getStore()?.timer;
  if (!t) return;
  if (t.failed) throw t.failed;
  const paused = pausedNow(t);
  if (realPerformanceNow() - t.start - paused > t.userMs)
    t.failed = new Error(`Function execution timed out (maximum duration: ${formatDuration(t.userMs)})`);
  else if (paused > t.systemMs) t.failed = new Error(SYSTEM_TIMEOUT_MESSAGE);
  if (t.failed) throw t.failed;
}

/** Run `fn` with the running function's clock paused (a nested call: it has its own budget). */
export async function pausingUserTime<T>(fn: () => Promise<T>): Promise<T> {
  const t = executions.getStore()?.timer;
  if (!t || t.pausedSince !== null) return fn();
  t.pausedSince = realPerformanceNow();
  try {
    return await fn();
  } finally {
    t.paused += realPerformanceNow() - t.pausedSince;
    t.pausedSince = null;
  }
}

/**
 * Run a function's body under `timer` (replacing any, restored after); its timeout, once hit, is thrown
 * when the body ends even if the body caught it.
 */
export async function withUserTimer<T>(timer: UserTimer, fn: () => T): Promise<Awaited<T>> {
  const e = executions.getStore();
  if (!e) return await fn();
  const outer = e.timer;
  e.timer = timer;
  try {
    const value = await fn();
    checkUserTime();
    return value;
  } catch (err) {
    if (timer.failed) throw timer.failed;
    throw err;
  } finally {
    e.timer = outer;
  }
}

/** A store call from a function (`Tx`): outside the execution, its time paused, the budget checked around it. */
export async function storeCall<T>(fn: () => T | Promise<T>): Promise<T> {
  checkUserTime();
  const value = await pausingUserTime(async () => outsideExecution(fn));
  checkUserTime();
  return value;
}

/** What an execution read that makes its result depend on more than its reads. */
export type Observed = {
  /** `Date.now()`, `new Date()`, `Date()` or `performance.now()` (Convex's `observed_time`). */
  time: boolean;
};

const executions = new AsyncLocalStorage<Execution>();

const RealDate = Date;
const realNow = Date.now;
const realRandom = Math.random;
const realFetch = globalThis.fetch;
const realGetRandomValues = crypto.getRandomValues.bind(crypto);
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

/** The wall clock, whether or not an execution is running (for the engine's own bookkeeping). */
export const wallClock = (): number => realNow();

const realPerformanceNow = performance.now.bind(performance);
const origin = performance.timeOrigin;

/**
 * The wall clock in whole microseconds, whether or not an execution is running: the unit of commit
 * timestamps (STUDY-06 D9). Convex counts nanoseconds in a u64, which a JS number cannot hold exactly;
 * microseconds stay exact until the year 2255. Never behind Date.now().
 */
export const wallClockUs = (): number => Math.floor(Math.max(origin + realPerformanceNow(), realNow()) * 1000);

/**
 * Round down to 0.1 ms, as Convex's `secs_as_dom_high_res_ms` (crates/isolate/src/ops/time.rs) does to
 * blunt timing side channels.
 */
const toTenthMs = (ms: number) => Math.floor(ms * 10) / 10;
/**
 * The wall clock in FRACTIONAL milliseconds (sub-ms precision), as Convex takes a transaction's first
 * `_creationTime` from a nanosecond clock (`CreationTime::for_transaction`); `Date.now()` inside the
 * execution is its floor (`udf_unix_timestamp`).
 */
let lastPrecise = 0;
export const preciseClock = (): number => {
  // performance.now() drifts from the wall clock by up to a millisecond: never fall behind Date.now(), and
  // never repeat a value, so two transactions never share a first _creationTime.
  let t = origin + realPerformanceNow();
  const wall = realNow();
  if (t < wall) t = wall;
  if (t <= lastPrecise) t = nextUp(lastPrecise);
  lastPrecise = t;
  return t;
};

function notAllowed(what: string, kind: ExecutionKind): Error {
  // At import time Convex refuses every syscall the same way (`No<Op>DuringImport`, isolate analyze.rs).
  if (kind === "import") return new Error(`${what} unsupported at import time`);
  return new Error(`Can't use ${what} in ${kind === "query" ? "queries" : "mutations"}. Use an action instead.`);
}

let installed = false;
/** Replace the globals (idempotent). The engine calls it; apps never need to. */
export function installDeterminism() {
  if (installed) return;
  installed = true;
  RealDate.now = () => {
    const e = executions.getStore();
    if (!e) return realNow();
    e.observed.time = true;
    return e.now;
  };
  Math.random = () => {
    const e = executions.getStore();
    return e ? e.random() : realRandom();
  };
  // `new Date()` with no argument and `Date()` called as a function read the frozen time; everything else
  // (and `instanceof Date`, `Date.prototype`, `Date.UTC`, …) goes straight to the real Date.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      const e = args.length === 0 ? executions.getStore() : undefined;
      if (e) e.observed.time = true;
      return Reflect.construct(target, e ? [e.now] : args, newTarget);
    },
    apply(target) {
      const e = executions.getStore();
      if (!e) return target();
      e.observed.time = true;
      return new target(e.now).toString();
    },
  });
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const e = executions.getStore();
      if (e) return Promise.reject(notAllowed("fetch()", e.kind));
      return realFetch(...args);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  // Convex refuses timers in queries and mutations too: a transaction cannot wait on the clock.
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
    const e = executions.getStore();
    if (e) throw notAllowed("setTimeout()", e.kind);
    return realSetTimeout(...args);
  }, realSetTimeout) as typeof setTimeout;
  globalThis.setInterval = Object.assign((...args: Parameters<typeof setInterval>) => {
    const e = executions.getStore();
    if (e) throw notAllowed("setInterval()", e.kind);
    return realSetInterval(...args);
  }, realSetInterval) as typeof setInterval;
  // Convex (`performance_now_fixed` / `performance_now_incrementing`, crates/isolate/src/environment/udf):
  // a query sees one fixed instant, its start, so its result stays a function of what it read; a mutation
  // sees its start plus the real time elapsed since, so it can still time its own work.
  performance.now = () => {
    const e = executions.getStore();
    if (!e) return realPerformanceNow();
    e.observed.time = true;
    // Convex's import phase sees 0.
    if (e.kind === "import") return 0;
    const elapsed = e.kind === "mutation" ? realPerformanceNow() - e.monotonicStart : 0;
    return toTenthMs(e.perfStart + elapsed);
  };
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    const e = executions.getStore();
    if (e?.kind === "import") throw new Error("Cannot use cryptographic randomness at import time");
    if (e) throw notAllowed("crypto.getRandomValues()", e.kind);
    return realGetRandomValues(array as never) as T;
  }) as typeof crypto.getRandomValues;
}

/**
 * Run `fn` as a deterministic execution frozen at `now` (ms), with a fresh random seed. `observed` is
 * filled in with what the body read (the clock).
 */
export function runDeterministic<T>(
  kind: ExecutionKind,
  now: number,
  fn: () => T,
  observed: Observed = { time: false },
): T {
  let rng: (() => number) | undefined;
  // The seed is drawn on first use: most executions never call Math.random.
  const random = () => {
    if (!rng) rng = seededRandom(realGetRandomValues(new Uint32Array(4)));
    return rng();
  };
  const execution: Execution = {
    kind,
    now: Math.floor(now),
    random,
    perfStart: now - origin,
    monotonicStart: realPerformanceNow(),
    observed,
  };
  return executions.run(execution, fn);
}

/**
 * Run a code version's import phase (Convex's: `Math.random` seeded and `Date.now()` fixed by the
 * deployment, `performance.now()` 0; no fetch, timers or cryptographic randomness).
 */
export function runImportPhase<T>(seed: Uint32Array, now: number, fn: () => T): T {
  const rng = seededRandom(seed);
  const execution: Execution = {
    kind: "import",
    now: Math.floor(now),
    random: rng,
    perfStart: 0,
    monotonicStart: realPerformanceNow(),
    observed: { time: false },
  };
  return executions.run(execution, fn);
}

/**
 * The same deterministic `Date` and `Math.random` in another realm (a code version's `vm` context,
 * STUDY-35): its intrinsics are its own, so they are replaced there too; the rest (fetch, timers,
 * `performance`, `crypto`) are this realm's, already replaced, and handed to the context as they are.
 */
export function installDeterminismIn(g: { Date: DateConstructor; Math: Math }) {
  installDeterminism();
  const ContextDate = g.Date;
  const contextNow = ContextDate.now.bind(ContextDate);
  const contextRandom = g.Math.random.bind(g.Math);
  ContextDate.now = () => {
    const e = executions.getStore();
    if (!e) return contextNow();
    e.observed.time = true;
    return e.now;
  };
  g.Math.random = () => {
    const e = executions.getStore();
    return e ? e.random() : contextRandom();
  };
  g.Date = new Proxy(ContextDate, {
    construct(target, args, newTarget) {
      const e = args.length === 0 ? executions.getStore() : undefined;
      if (e) e.observed.time = true;
      return Reflect.construct(target, e ? [e.now] : args, newTarget);
    },
    apply(target) {
      const e = executions.getStore();
      if (!e) return target();
      e.observed.time = true;
      return new target(e.now).toString();
    },
  });
}

/** Run engine work (a persistence call) outside the current execution: real globals, no restrictions. */
export function outsideExecution<T>(fn: () => T): T {
  return executions.exit(fn);
}

/** sfc32: a small, fast, seedable PRNG (not cryptographic — neither is Convex's `Math.random`). */
export function seededRandom(seed: Uint32Array): () => number {
  let a = seed[0] | 0;
  let b = seed[1] | 0;
  let c = seed[2] | 0;
  let d = seed[3] | 0;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // mix the seed
  return next;
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
/** The next representable double above a positive `x` (Rust's `f64::next_up`). */
export function nextUp(x: number): number {
  f64[0] = x;
  u64[0] += 1n;
  return f64[0];
}
