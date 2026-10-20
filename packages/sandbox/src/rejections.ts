// Unhandled rejections in the child (STUDY-171 §13, STUDY-168 §12.3's PR 4b): a promise the app's code rejected and
// left with no handler once the microtasks have drained fails the call whose code made it, as Convex's isolate fails
// the function (`crates/isolate/src/environment/udf/mod.rs` and `environment/action/mod.rs`: after each microtask
// checkpoint, `pending_unhandled_promise_rejections`, `ContextTerminationReason::UnhandledPromiseRejection`).
//
// Bun's `unhandledRejection` event carries no async context (DV-528's reason under `vm`), and a child runs several
// calls at once. So the child attributes a rejection by *when* it is reported, not by who made it:
//
// - every piece of the app's code the child resumes from a macrotask of its own (a call starting, an operation's
//   answer, a stream's chunk or message, an action's timer) runs inside `checkpoint(id, …)`: the microtasks left by
//   whatever ran before are drained first, unattributed; then the resumption runs, and `drainMicrotasks()` runs every
//   microtask it queued, to the end, before the next one is resumed;
// - Bun reports the promises still rejected with no handler at the end of that drain, synchronously, while `current`
//   names the call: that call's code is the only code that ran in it.
//
// The limits (STUDY-171 §13.3): code resumed by Bun itself rather than by the child (a native completion: `crypto.
// subtle`, a body of the child's own `Response` or `Blob` read, a stream made with no host) is attributed to the one
// call running, when there is one, and only printed otherwise; and a continuation of another call that one call's
// code resumes (a promise kept in module state, awaited by both) is that call's.
import { drainMicrotasks } from "bun:jsc";

/** A call that can fail of a rejection: a query's or mutation's (`ChildCall`), or an action's (`ChildActionCall`). */
export interface Rejectable {
  /** The app left `reason` rejected with no handler: the call fails with it, if it has not answered yet. */
  unhandled(reason: unknown): void;
  /** A checkpoint of this call ended: what it waited for to answer may now be there. */
  checkpointed(): void;
}

/** The calls that have not answered, by id (the host's, shared by both kinds). */
const live = new Map<number, Rejectable>();
/** The id a checkpoint of the child's own work runs as (a load's import phase): no call's. */
export const CHILD_WORK = -1;
/**
 * The call whose code the current drain runs, `CHILD_WORK`, or null: outside any checkpoint, or in one whose owner is
 * not known (a stream's chunk before the call took the stream).
 */
let current: number | null = null;
let inCheckpoint = false;

/** `call` runs from now until it answers (`untrack`). */
export function track(id: number, call: Rejectable) {
  live.set(id, call);
}

export function untrack(id: number) {
  live.delete(id);
}

/** The loads and evaluations running (their code is no call's): while one runs, no rejection falls to the one call. */
let working = 0;

/** `work`, the child's own (a load's import phase), counted while it runs. */
export async function childWork<T>(work: Promise<T>): Promise<T> {
  working++;
  try {
    return await work;
  } finally {
    working--;
  }
}

/** The call whose checkpoint is running, or null. */
export const checkpointOf = (): number | null => (inCheckpoint ? current : null);

/**
 * `resume` (the app's code of call `id`, resumed) and every microtask it queues, run to the end, with what Bun reports
 * unhandled at the end of the drain attributed to call `id`. `drainBefore`: the microtasks already queued are drained
 * first, unattributed (false when they are this call's own, see `ChildCall.settled`).
 */
export function checkpoint(id: number | null, resume: () => void, drainBefore = true) {
  if (inCheckpoint) {
    // Within a checkpoint already (a resumption the app's code caused synchronously): the same drain.
    resume();
    return;
  }
  inCheckpoint = true;
  try {
    if (drainBefore) drainMicrotasks();
    current = id;
    resume();
    drainMicrotasks();
  } finally {
    current = null;
    inCheckpoint = false;
  }
  if (id !== null) live.get(id)?.checkpointed();
}

/** The microtasks queued drained, in the checkpoint running (what they leave rejected is its call's). */
export function drain() {
  drainMicrotasks();
}

/** What a rejection no call can be found for does: printed to the child's stderr (the server's), as before. */
function printed(reason: unknown) {
  let text: string;
  try {
    text = Bun.inspect(reason);
  } catch {
    text = "a value that cannot be shown";
  }
  process.stderr.write(`bunvex sandbox: an unhandled rejection no call can be found for: ${text}\n`);
}

process.on("unhandledRejection", (reason) => {
  let call: Rejectable | undefined;
  if (current !== null) call = live.get(current);
  else if (live.size === 1 && working === 0) call = live.values().next().value;
  // A call that has answered is no longer tracked: what its leftover code rejects is printed (Convex's would not run).
  if (call) call.unhandled(reason);
  else printed(reason);
});
