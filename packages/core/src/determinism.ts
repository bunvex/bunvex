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

export type ExecutionKind = "query" | "mutation";
type Execution = {
  kind: ExecutionKind;
  now: number;
  random: () => number;
  /** `performance.now()` at the start: the execution's start time relative to `performance.timeOrigin`. */
  perfStart: number;
  /** The real monotonic clock at the start, to count a mutation's elapsed time from. */
  monotonicStart: number;
  /** SPIKE (STUDY-28 B5): the auth dispatcher's executions use the real CSPRNG. */
  realCrypto?: boolean;
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
  return new Error(`Can't use ${what} in ${kind === "query" ? "queries" : "mutations"}. Use an action instead.`);
}

let installed = false;
/** Replace the globals (idempotent). The engine calls it; apps never need to. */
export function installDeterminism() {
  if (installed) return;
  installed = true;
  RealDate.now = () => {
    const e = executions.getStore();
    return e ? e.now : realNow();
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
      return Reflect.construct(target, e ? [e.now] : args, newTarget);
    },
    apply(target) {
      const e = executions.getStore();
      return e ? new target(e.now).toString() : target();
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
    const elapsed = e.kind === "mutation" ? realPerformanceNow() - e.monotonicStart : 0;
    return toTenthMs(e.perfStart + elapsed);
  };
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    const e = executions.getStore();
    if (e && !e.realCrypto) throw notAllowed("crypto.getRandomValues()", e.kind);
    return realGetRandomValues(array as never) as T;
  }) as typeof crypto.getRandomValues;
}

/** Run `fn` as a deterministic execution frozen at `now` (ms), with a fresh random seed. */
export function runDeterministic<T>(kind: ExecutionKind, now: number, fn: () => T): T {
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
  };
  return executions.run(execution, fn);
}

/** SPIKE (STUDY-28 B5): run `fn` in the current execution with the real `crypto.getRandomValues`. */
export function withRealCrypto<T>(fn: () => T): T {
  const e = executions.getStore();
  return e ? executions.run({ ...e, realCrypto: true }, fn) : fn();
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
