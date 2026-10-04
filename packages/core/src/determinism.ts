// Deterministic execution for queries and mutations, as Convex does in its isolate: inside a transaction
// body, `Date.now()` / `new Date()` are frozen at the transaction's start, `performance.now()` is fixed in
// queries and counts up from that start in mutations, `Math.random()`, `crypto.getRandomValues()` and
// `crypto.randomUUID()` come from a PRNG seeded per execution, and `fetch`, timers and `crypto.subtle`'s
// randomness are refused (STUDY-66 §4). A result is then a function of what
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
import { createCipheriv, createHash } from "node:crypto";

/** `import`: a code version's modules being evaluated (Convex's import phase, STUDY-35). */
export type ExecutionKind = "query" | "mutation" | "import";
type Execution = {
  kind: ExecutionKind;
  now: number;
  random: () => number;
  /**
   * Fills an array for `crypto.getRandomValues` / `crypto.randomUUID`: a stream fixed per execution, as
   * Convex's seeded ChaCha12 is, and cryptographically strong as that is (apps make tokens with it).
   */
  cryptoBytes: (out: Uint8Array) => void;
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
  /** When the body ended (its user time stops there, as Convex's `into_function_execution_time`). */
  ended: number | null;
};

/** Rust's `Duration` Debug form, as Convex's message prints the limit (`1s`, `1.5s`, `500ms`). */
export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(9))}s`;
  if (ms >= 1) return `${Number(ms.toFixed(6))}ms`;
  return `${Number((ms * 1000).toFixed(3))}µs`;
}

export const SYSTEM_TIMEOUT_MESSAGE = "Your request timed out performing too many system operations.";

export function newUserTimer(userMs: number, systemMs: number): UserTimer {
  return { start: realPerformanceNow(), paused: 0, pausedSince: null, userMs, systemMs, failed: null, ended: null };
}

/**
 * The user time a body took, in ms (STUDY-71): its wall time minus the time paused in store calls and
 * nested calls, as Convex's `user_execution_time` (wall time minus its timeout's pauses); up to now while it
 * runs.
 */
export const userTimeMs = (t: UserTimer) => (t.ended ?? realPerformanceNow()) - t.start - pausedNow(t);

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

/** Record that the running function read the time (`ctx.meta.getSnapshotTs()`, as Convex's `observe_time`). */
export function observeTime() {
  const e = executions.getStore();
  if (e) e.observed.time = true;
}

/**
 * Fail the running function for good (a nested call's system error, STUDY-41 N6): the error is thrown at its
 * next store call and when it ends, even if it was caught, as Convex's non-catchable system errors.
 */
export function failExecution(e: Error) {
  const t = executions.getStore()?.timer;
  if (t && !t.failed) t.failed = e;
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
    timer.ended ??= realPerformanceNow();
    e.timer = outer;
  }
}

/**
 * A store read that failed under a function: the system's failure, not the function's (STUDY-20 D8). As
 * Convex's syscalls, whose non-user errors terminate the isolate with a system error
 * (crates/isolate/src/request_scope.rs, environment/helpers/promise.rs), the function cannot catch it, and a
 * client is never told its mutation failed when it may still commit: the sync connection closes and the
 * client resends.
 */
export class PersistenceReadError extends Error {
  constructor(cause: unknown) {
    super(`persistence read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PersistenceReadError";
  }
}

/**
 * A store call from a function (`Tx`): outside the execution, its time paused, the budget checked around it.
 * A failure is a `PersistenceReadError` the function cannot catch (`failExecution`).
 */
export async function storeCall<T>(fn: () => T | Promise<T>): Promise<T> {
  checkUserTime();
  let value: T;
  try {
    value = await pausingUserTime(async () => outsideExecution(fn));
  } catch (e) {
    // Out of retention stays itself (a try-again error, Convex's OutOfRetention); any other store failure is
    // a PersistenceReadError. Either way the function cannot catch it. (By name: committer.ts imports this.)
    const failure = e instanceof Error && e.name === "OutOfRetentionError" ? e : new PersistenceReadError(e);
    failExecution(failure);
    throw failure;
  }
  checkUserTime();
  return value;
}

/** What an execution read that makes its result depend on more than its reads. */
export type Observed = {
  /** `Date.now()`, `new Date()`, `Date()` or `performance.now()` (Convex's `observed_time`). */
  time: boolean;
  /**
   * A failure the body cannot catch, which fails it once it has ended (`settled`): a timer's, when no user
   * timer runs (one that does keeps it in `timer.failed`, STUDY-66 §4).
   */
  failure?: Error;
};

/** The body's value, or the failure it could not catch (see `Observed.failure`). */
export function settled<T>(observed: Observed, value: T): T {
  if (observed.failure) throw observed.failure;
  return value;
}

const executions = new AsyncLocalStorage<Execution>();

const RealDate = Date;
const realNow = Date.now;
const realRandom = Math.random;
const realFetch = globalThis.fetch;
const realGetRandomValues = crypto.getRandomValues.bind(crypto);
const realRandomUUID = crypto.randomUUID.bind(crypto);
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

/**
 * Convex's refusal of an async op (crates/isolate/src/environment/udf/mod.rs `not_allowed_in_udf`; at import
 * time, analyze.rs `No<Op>DuringImport`): the same words for queries and mutations, without Convex's docs link.
 */
function notAllowed(what: string, kind: ExecutionKind): Error {
  if (kind === "import") return new Error(`${what} unsupported at import time`);
  return new Error(`Can't use ${what} in queries and mutations. Please consider using an action.`);
}

/** Convex's refusal of cryptographic randomness (`crypto_rng`): only `crypto.subtle` asks for it. */
function noCryptoRandomness(kind: ExecutionKind): Error {
  if (kind === "import") return new Error("Cannot use cryptographic randomness at import time");
  return notAllowed("cryptographic randomness", kind);
}

/**
 * A timer in a query or mutation (Convex's `02_timers.ts`): `setTimeout` returns its id, its sleep op is
 * refused, and that rejection, unhandled, fails the function — which a `try` around `setTimeout` cannot stop.
 * Here: the callback never runs, and the error fails the execution at its next store call or when it ends.
 */
function refuseTimer(e: Execution, name: string): number {
  const err = notAllowed(name, e.kind);
  if (e.timer) {
    if (!e.timer.failed) e.timer.failed = err;
  } else if (!e.observed.failure) e.observed.failure = err;
  return 0;
}

const INTEGER_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
]);
/** Convex's cap on one `getRandomValues` call (crates/isolate/src/ops/crypto.rs). */
const MAX_RANDOM_BYTES = 65536;

/**
 * A deterministic, cryptographically strong byte stream from a 32-byte key: AES-256-CTR's keystream. Convex's
 * `getRandomValues` draws from its seeded ChaCha12 (a CSPRNG); sfc32, bunvex's `Math.random`, is not one.
 */
function keystream(key: Uint8Array): (out: Uint8Array) => void {
  const cipher = createCipheriv("aes-256-ctr", key, new Uint8Array(16));
  return (out) => out.set(cipher.update(new Uint8Array(out.length)));
}

/** A stream keyed on first use, from the real CSPRNG (most executions never draw). */
function lazyKeystream(): (out: Uint8Array) => void {
  let stream: ((out: Uint8Array) => void) | undefined;
  return (out) => {
    if (!stream) stream = keystream(realGetRandomValues(new Uint8Array(32)));
    stream(out);
  };
}

/** The algorithm's name, upper-cased (WebCrypto matches names case-insensitively). */
const algorithmName = (a: unknown) =>
  String(typeof a === "string" ? a : ((a as { name?: unknown } | null)?.name ?? "")).toUpperCase();

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
  // `fetch` is async in Convex's runtime: the refusal is a rejected promise the app can catch.
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const e = executions.getStore();
      if (e) return Promise.reject(notAllowed("fetch()", e.kind));
      const send = fetchSender?.() ?? realFetch;
      const meter = fetchMeter?.();
      return meter ? meteredFetch(send, meter, ...args) : send(...args);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  // Convex refuses timers in queries and mutations too: a transaction cannot wait on the clock.
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
    const e = executions.getStore();
    if (e) return refuseTimer(e, "setTimeout");
    return realSetTimeout(...args);
  }, realSetTimeout) as typeof setTimeout;
  globalThis.setInterval = Object.assign((...args: Parameters<typeof setInterval>) => {
    const e = executions.getStore();
    if (e) return refuseTimer(e, "setInterval");
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
  // Convex's `crypto.getRandomValues` and `crypto.randomUUID` draw from the seeded PRNG, as `Math.random`
  // does (crates/isolate/src/ops/crypto.rs `provider.rng()`): allowed, and deterministic per execution.
  crypto.getRandomValues = function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    const e = executions.getStore();
    if (!e) return realGetRandomValues(array as never) as T;
    if (arguments.length < 1)
      throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present.");
    // By tag, not `instanceof`: a code version's arrays come from its own realm.
    const tag = ArrayBuffer.isView(array) ? Object.prototype.toString.call(array).slice(8, -1) : "";
    if (!INTEGER_ARRAYS.has(tag))
      throw new DOMException("The provided ArrayBufferView is not an integer array type", "TypeMismatchError");
    const view = array as unknown as ArrayBufferView;
    if (view.byteLength > MAX_RANDOM_BYTES)
      throw new TypeError(
        `Byte length (${view.byteLength}) exceeds the number of bytes of entropy available via this API (${MAX_RANDOM_BYTES})`,
      );
    e.cryptoBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return array;
  } as typeof crypto.getRandomValues;
  crypto.randomUUID = (() => {
    const e = executions.getStore();
    if (!e) return realRandomUUID();
    const b = new Uint8Array(16);
    e.cryptoBytes(b);
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }) as typeof crypto.randomUUID;
  // Cryptographic randomness is refused (Convex's `crypto_rng`, crates/webcrypto/src/lib.rs): every
  // `generateKey`, `encrypt` with RSA-OAEP, `sign` with RSA-PSS or ECDSA. A rejected promise, as the
  // methods are async.
  const subtle = crypto.subtle;
  const realGenerateKey = subtle.generateKey.bind(subtle);
  const realEncrypt = subtle.encrypt.bind(subtle);
  const realSign = subtle.sign.bind(subtle);
  subtle.generateKey = ((...args: Parameters<SubtleCrypto["generateKey"]>) => {
    const e = executions.getStore();
    if (e) return Promise.reject(noCryptoRandomness(e.kind));
    return realGenerateKey(...(args as [never, never, never]));
  }) as SubtleCrypto["generateKey"];
  subtle.encrypt = ((...args: Parameters<SubtleCrypto["encrypt"]>) => {
    const e = executions.getStore();
    if (e && algorithmName(args[0]) === "RSA-OAEP") return Promise.reject(noCryptoRandomness(e.kind));
    return realEncrypt(...args);
  }) as SubtleCrypto["encrypt"];
  subtle.sign = ((...args: Parameters<SubtleCrypto["sign"]>) => {
    const e = executions.getStore();
    const name = algorithmName(args[0]);
    if (e && (name === "RSA-PSS" || name === "ECDSA")) return Promise.reject(noCryptoRandomness(e.kind));
    return realSign(...args);
  }) as SubtleCrypto["sign"];
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
    cryptoBytes: lazyKeystream(),
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
export function runImportPhase<T>(seed: Uint32Array, now: number, fn: () => T): Promise<Awaited<T>> {
  const rng = seededRandom(seed);
  const execution: Execution = {
    kind: "import",
    now: Math.floor(now),
    random: rng,
    // Keyed by the deployment's seed, so an import draws the same bytes every time it is loaded.
    cryptoBytes: keystream(
      createHash("sha256")
        .update(new Uint8Array(seed.buffer, seed.byteOffset, seed.byteLength))
        .digest(),
    ),
    perfStart: 0,
    monotonicStart: realPerformanceNow(),
    observed: { time: false },
  };
  return executions.run(execution, async (): Promise<Awaited<T>> => settled(execution.observed, await fn()));
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
/**
 * Who a `fetch` outside a query or mutation is charged to (STUDY-71): set by the server, it returns the
 * running action's counter, or null when nothing meters this call.
 */
let fetchMeter: (() => ((bytes: number | null) => void) | null) | null = null;
export function setFetchMeter(m: typeof fetchMeter) {
  fetchMeter = m;
}

/**
 * How a `fetch` outside a query or mutation is sent (set by the server): for the running action, the function
 * that checks and sends its request (STUDY-80); null, or no running action, sends it as is.
 */
let fetchSender: (() => typeof fetch | null) | null = null;
export function setFetchSender(s: typeof fetchSender) {
  fetchSender = s;
}

/** The process's own `fetch`, never refused nor metered: what a fetch sender sends with. */
export const directFetch: typeof fetch = realFetch;

/** A body's bytes when they can be known without reading it; null for a stream or form data. */
function knownBodySize(body: unknown): number | null {
  if (body === null || body === undefined) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  return null;
}

/**
 * A metered fetch, as Convex's (`track_fetch_egress`): the request body's bytes — not its headers or URL,
 * nor the response — charged once the request went out without failing.
 */
async function meteredFetch(
  send: typeof fetch,
  charge: (bytes: number | null) => void,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  // `charge` hears once that the request settled: its body's bytes when it went out, null when it failed.
  let charged: number | null = null;
  try {
    const [input, init] = args;
    let size = init && "body" in init ? knownBodySize(init.body) : input instanceof Request ? null : 0;
    let res: Response;
    if (size === null) {
      const req =
        typeof input === "string" || input instanceof URL
          ? new Request(input.toString(), init)
          : new Request(input, init);
      size = req.body ? (await req.clone().arrayBuffer()).byteLength : 0;
      res = await send(req);
    } else res = await send(...args);
    charged = size;
    return res;
  } finally {
    charge(charged);
  }
}

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
