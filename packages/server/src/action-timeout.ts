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

/**
 * The running action: its signal, aborted once it (or the action that called it) timed out; whether it has ended
 * (its answer given, or its time up), after which nothing it calls may start (Convex's isolate ends with the action,
 * `environment/action/mod.rs:1226-1233`); and the timers its code set, cleared when it ends (null: an action whose run
 * outlives its answer, an HTTP action whose body still streams, a `"use node"` action).
 */
type Run = { signal: AbortSignal; life: ActionLife; timers: Set<unknown> | null };

/**
 * Whether an action has ended, shared by its run and its `ctx`: a `ctx` kept past its action's end (in module state)
 * refuses whoever calls it, as the function sandbox's child refuses an ended call's operations.
 */
export type ActionLife = { ended: boolean; timedOut?: unknown };

/** What a call of an ended action throws: its timeout if it timed out, else the refusal. */
export const endedError = (life: ActionLife): unknown =>
  life.timedOut !== undefined ? life.timedOut : new Error(ACTION_ENDED_MESSAGE);
const runs = new AsyncLocalStorage<Run>();

/** What a `ctx` call or a `fetch` an action makes after it ended throws (the function sandbox's child says the same). */
export const ACTION_ENDED_MESSAGE = "the action has ended: its operations can no longer run";

/** A signal aborted with the ended action's refusal (a new error each time, made where the app called). */
const ended = () => AbortSignal.abort(new Error(ACTION_ENDED_MESSAGE));

// An action's fetches end with it: refused once it timed out or ended, aborted if in flight at its timeout (one in
// flight when it answered goes on, as its other operations do).
setFetchSignal(() => {
  const r = runs.getStore();
  if (!r) return null;
  return r.life.ended && !r.signal.aborted ? ended() : r.signal;
});

/** The action has ended: the timers its code set and that have not fired are cleared, and its `ctx` refuses. */
function end(run: Run) {
  run.life.ended = true;
  if (!run.timers) return;
  for (const t of run.timers) clearTimeout(t as Parameters<typeof clearTimeout>[0]);
  run.timers.clear();
}

/**
 * A timer the running action's code set (`setTimeout`, `setInterval` in its context): cleared when the action ends,
 * as Convex's sleeps never resolve once its isolate is gone. Set after the end (an operation in flight then, whose
 * answer the code still awaited), it is cleared at once.
 */
export function trackActionTimer(t: unknown) {
  const r = runs.getStore();
  if (!r?.timers) return;
  if (r.life.ended) clearTimeout(t as Parameters<typeof clearTimeout>[0]);
  else r.timers.add(t);
}

/** The running action's life (null outside an action): once ended, what it calls refuses. */
export const currentActionLife = (): ActionLife | null => runs.getStore()?.life ?? null;

/**
 * Run an action's body for at most `ms`. On time it settles as the body does; past it, it rejects with
 * `timeout()` and the run's signal is aborted with that error (the body itself goes on, cut off from `ctx`
 * and `fetch`). An action called by a timed-out one is cut off too, as Convex cancels it. `endsWithAnswer`: once it
 * settles or times out the action has ended: the timers its code set are cleared and its `ctx` and `fetch` refuse.
 */
export function withActionTimeout<T>(
  ms: number,
  timeout: () => Error,
  body: () => Promise<T>,
  opts: { endsWithAnswer?: boolean; life?: ActionLife } = {},
): Promise<T> {
  const parent = runs.getStore()?.signal;
  const own = new AbortController();
  const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal;
  const run: Run = { signal, life: opts.life ?? { ended: false }, timers: opts.endsWithAnswer ? new Set() : null };
  const finish = () => {
    if (opts.endsWithAnswer) end(run);
  };
  return new Promise<T>((resolve, reject) => {
    const timer = outsideExecution(() =>
      // Not the action's own timer: run outside its async context.
      runs.exit(() =>
        setTimeout(() => {
          const e = timeout();
          own.abort(e);
          run.life.timedOut = e;
          finish();
          reject(e);
        }, ms),
      ),
    );
    // A cut-off body that never settles must not keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    runs.run(run, body).then(
      (value) => {
        clearTimeout(timer);
        finish();
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        finish();
        reject(e);
      },
    );
  });
}

/**
 * `fn` run as an action whose code's timers are tracked, for a runtime that runs actions outside `withActionTimeout`
 * (the function sandbox's child, whose host keeps the timeout): `end()` clears them once the action has ended.
 */
export function trackedActionTimers<T>(fn: () => T): { value: T; end: () => void } {
  const run: Run = { signal: new AbortController().signal, life: { ended: false }, timers: new Set() };
  return { value: runs.run(run, fn), end: () => end(run) };
}

/**
 * Throw the running action's timeout if it has timed out, or its refusal if it has ended (before a `ctx` call starts
 * anything).
 */
export function checkActionAlive() {
  const r = runs.getStore();
  if (!r) return;
  if (r.signal.aborted) throw r.signal.reason;
  if (r.life.ended) throw endedError(r.life);
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
