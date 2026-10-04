// A store whose reads fail on demand (a store fault that outlived the driver's retries), for the tests of
// background workers: they must log and retry such a failure, never let it reach the process (an unhandled
// rejection exits it).
import type { Persistence } from "@bunvex/core";

export function failingReads<P extends Persistence>(inner: P) {
  const state = { failing: false, failed: 0 };
  const read =
    (f: (...a: never[]) => unknown) =>
    (...a: never[]) => {
      if (state.failing) {
        state.failed++;
        throw new Error("injected store fault: read");
      }
      return f(...a);
    };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const bound = v.bind(target);
      return prop === "get" || prop === "scan" ? read(bound) : bound;
    },
  });
  return { store, state };
}

/** Collect unhandled rejections (and keep the process up) until the returned stopper runs. */
export function watchUnhandled() {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", on);
  return { seen, stop: () => process.off("unhandledRejection", on) };
}

/** Collect `console.error` calls (silenced) until the returned stopper runs. */
export function captureErrors() {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => calls.push(a);
  return {
    calls,
    stop: () => {
      console.error = original;
    },
  };
}
