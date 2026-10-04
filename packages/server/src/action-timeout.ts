// The action timeout (STUDY-77), as Convex's: an action may run for `V8_ACTION_USER_TIMEOUT_SECS` (1800 s),
// a `"use node"` action for `NODE_ACTION_USER_TIMEOUT_SECS` (600 s), counted from when it holds its permit
// and including what it awaits (its runQuery / runMutation / runAction calls, fetches, storage calls, timers),
// as Convex counts a V8 action's syscalls as user time (crates/isolate/src/environment/action/mod.rs) and as
// Node's executor races the whole invocation (npm-packages/node-executor/src/executor.ts).
//
// Past it the action fails with Convex's message, a user error (`JsError::from_message`): its caller, the
// function log and a scheduled job see it, and its permit is free again. Convex terminates the isolate, so
// nothing the action started runs further. One Bun process cannot stop running JS (STUDY-41 N5), so the
// handler is cut off instead: its run's signal is aborted, which rejects every later `ctx` call and `fetch`
// with the same error and aborts the fetches in flight. Calls already in flight (a mutation that reached the
// committer) finish, as in Convex, where a dropped mutation may or may not have committed.
import { AsyncLocalStorage } from "node:async_hooks";
import { formatDuration, outsideExecution, setFetchSignal } from "@bunvex/core";

/** Convex's `V8_ACTION_USER_TIMEOUT` default: 30 minutes. */
export const V8_ACTION_USER_TIMEOUT_MS = 1800 * 1000;
/** Convex's `NODE_ACTION_USER_TIMEOUT` default: 10 minutes. */
export const NODE_ACTION_USER_TIMEOUT_MS = 600 * 1000;

/** An action past its time: reported as its message alone, as Convex's `JsError::from_message`. */
export class ActionTimeoutError extends Error {
  override name = "ActionTimeoutError";
}

/** Convex's `UserTimeoutError` display: `Function execution timed out (maximum duration: 1800s)`. */
export const actionTimeoutError = (ms: number) =>
  new ActionTimeoutError(`Function execution timed out (maximum duration: ${formatDuration(ms)})`);

/** The Node executor's message, with the function's export name: ``Action `send` execution timed out …``. */
export const nodeActionTimeoutError = (exportName: string, ms: number) =>
  new ActionTimeoutError(`Action \`${exportName}\` execution timed out (maximum duration ${ms / 1000}s)`);

/** The running action's signal: aborted once it (or the action that called it) timed out. */
const runs = new AsyncLocalStorage<AbortSignal>();

// An action's fetches end with it: refused once it timed out, aborted if in flight then.
setFetchSignal(() => runs.getStore() ?? null);

/**
 * Run an action's body for at most `ms`. On time it settles as the body does; past it, it rejects with
 * `timeout()` and the run's signal is aborted with that error (the body itself goes on, cut off from `ctx`
 * and `fetch`). An action called by a timed-out one is cut off too, as Convex cancels it.
 */
export function withActionTimeout<T>(ms: number, timeout: () => Error, body: () => Promise<T>): Promise<T> {
  const parent = runs.getStore();
  const own = new AbortController();
  const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal;
  return new Promise<T>((resolve, reject) => {
    const timer = outsideExecution(() =>
      setTimeout(() => {
        const e = timeout();
        own.abort(e);
        reject(e);
      }, ms),
    );
    // A cut-off body that never settles must not keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    runs.run(signal, body).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Throw the running action's timeout if it has timed out (before a `ctx` call starts anything). */
export function checkActionAlive() {
  const signal = runs.getStore();
  if (signal?.aborted) throw signal.reason;
}

/** `obj` with every method refusing to start once the running action timed out (`ctx.scheduler`, `ctx.storage`). */
export function cutOffWithAction<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        checkActionAlive();
        return value.apply(target, args);
      };
    },
  });
}
