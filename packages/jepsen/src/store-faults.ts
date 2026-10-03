// Store faults for the embedded stores (STUDY-57 §4): the server process wraps its persistence in this when
// JEPSEN_STORE_FAULTS=<seed> is set, so reads and flushes are slow now and then, sometimes fail, and a flush
// sometimes fails *after* it made the group durable — the lost answer of a remote store. The remote stores
// get the same faults from the network (a proxy in front of the database). Test-only: the wrapper keeps
// every method of the driver (the lease, the log), it only intercepts these.
import type { Persistence } from "@bunvex/core";
import { rng } from "./rng.ts";

/** An injected failure the committer may retry (as a lost connection to a remote store). */
export class InjectedTransientError extends Error {
  constructor(where: string) {
    super(`injected store fault (transient): ${where}`);
    this.name = "InjectedTransientError";
  }
}

export type StoreFaultRates = {
  /** A read (get, scan) or a flush waits a few milliseconds. */
  delay: number;
  /** A read fails. */
  readError: number;
  /** A flush fails before writing (transient: retried). */
  flushErrorBefore: number;
  /** A flush fails after its group is durable (transient: the retry finds nothing left to write). */
  flushErrorAfter: number;
  /** A flush fails for good: the committer stops and the process exits (fail-stop); the nemesis restarts it. */
  flushFatal: number;
};

export const DEFAULT_RATES: StoreFaultRates = {
  delay: 0.05,
  readError: 0.002,
  flushErrorBefore: 0.02,
  flushErrorAfter: 0.02,
  flushFatal: 0.002,
};

/**
 * Faults switched on from outside, for a scenario that needs one at a precise moment (test/regressions.test.ts):
 * SIGUSR1 toggles "every read fails", SIGUSR2 toggles "every flush takes 500 ms".
 */
const forced = { reads: false, slowFlush: false };
process.on("SIGUSR1", () => {
  forced.reads = !forced.reads;
  console.log(`forced read errors ${forced.reads ? "on" : "off"}`);
});
process.on("SIGUSR2", () => {
  forced.slowFlush = !forced.slowFlush;
  console.log(`slow flushes ${forced.slowFlush ? "on" : "off"}`);
});

/** The wrapped store, and `arm()` to start the faults once the engine is up (recovery itself is not faulted). */
export function withStoreFaults<P extends Persistence>(
  inner: P,
  seed: number,
  rates = DEFAULT_RATES,
): { store: P; arm(): void } {
  const r = rng(seed);
  let armed = false;
  const pause = () => Bun.sleep(1 + r.int(20));
  const read =
    <A extends unknown[], T>(name: string, f: (...a: A) => T | Promise<T>) =>
    (...a: A): T | Promise<T> => {
      if (!armed) return f(...a);
      if (forced.reads) throw new Error(`injected store fault: ${name} (forced)`);
      if (r.chance(rates.readError)) throw new Error(`injected store fault: ${name}`);
      if (r.chance(rates.delay)) return pause().then(() => f(...a));
      return f(...a);
    };
  const flush = async () => {
    if (!armed) return inner.flush();
    if (forced.slowFlush) await Bun.sleep(500);
    if (r.chance(rates.delay)) await pause();
    if (r.chance(rates.flushFatal)) throw new Error("injected store fault (fatal): flush");
    if (r.chance(rates.flushErrorBefore)) throw new InjectedTransientError("flush, before writing");
    await inner.flush();
    if (r.chance(rates.flushErrorAfter)) throw new InjectedTransientError("flush, after writing");
  };
  const isTransient = (e: unknown) => e instanceof InjectedTransientError || (inner.isTransient?.(e) ?? false);
  const overrides: Partial<Persistence> = {
    get: read("get", inner.get.bind(inner)),
    scan: read("scan", inner.scan.bind(inner)),
    flush,
    isTransient,
  };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof Persistence];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return {
    store,
    arm: () => {
      armed = true;
    },
  };
}
