// Unhandled rejections in the child (STUDY-171 §13, STUDY-168 §12.3's PR 4b): a promise the app's code rejected and
// left with no handler once the microtasks have drained fails the call whose code made it, as Convex's isolate fails
// the function (`crates/isolate/src/environment/udf/mod.rs` and `environment/action/mod.rs`: after each microtask
// checkpoint, `pending_unhandled_promise_rejections`, `ContextTerminationReason::UnhandledPromiseRejection`).
//
// Bun's `unhandledRejection` event carries no async context (DV-528's reason under `vm`), and a child runs several
// calls at once. So the child attributes a rejection by *when* it happened, not by who made it:
//
// - every piece of the app's code the child resumes from a macrotask of its own (a call starting, an operation's
//   answer, a stream's chunk or message, an action's timer) runs inside `checkpoint(id, …)`: the microtasks left by
//   whatever ran before are drained first, and a marker (a promise rejected with a `Marker` of no call) closes what
//   they left; then the resumption runs, `drainMicrotasks()` runs every microtask it queued to the end, and a marker of
//   call `id` closes what that left;
// - Bun reports rejections in the order they happened, each marker among them: what comes before a call's marker, and
//   after the marker before it, is that call's. Bun 1.4.2 reports them at the end of the drain itself, while `current`
//   names the call; later versions at the end of the event loop's turn (§13.3).
// - A call learns its checkpoint was checked when its marker is reported (`checked`): only then may it answer, or
//   send what an action started in it (Convex runs neither once the checkpoint found a rejection).
// - Where Bun reports at the end of the turn (`REPORTS_AT_DRAIN` false), a call's next resumption waits for its last
//   marker's report (`later`), so each checkpoint of a call is checked before the next one runs, as Convex's are.
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
  /** Every rejection of the call's checkpoints so far has been reported: what waited for that may go. */
  checked(): void;
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
/** Rejections reported outside a checkpoint's drain, waiting for the marker that tells whose they are. */
const unmarked: unknown[] = [];

/** What a checkpoint leaves, rejected, after what it ran: the rejections reported before it are `id`'s. */
class Marker {
  constructor(
    readonly id: number | null,
    readonly seq: number,
  ) {}
}
let seq = 0;
/** Each call's last marker not reported yet: only its report says that every checkpoint of the call was checked. */
const lastMarker = new Map<number, number>();
/** Each call's resumptions waiting for its last marker's report (`later`), in order. */
const queued = new Map<number, (() => void)[]>();

/**
 * Whether Bun reports what a `drainMicrotasks()` left rejected with no handler before it returns (Bun 1.4.2), rather
 * than at the end of the event loop's turn (later versions). Found once, at start.
 */
export const REPORTS_AT_DRAIN = (() => {
  let seen = false;
  const listen = () => {
    seen = true;
  };
  process.on("unhandledRejection", listen);
  const p = Promise.reject(new Marker(null, 0));
  drainMicrotasks();
  p.catch(() => {});
  process.off("unhandledRejection", listen);
  return seen;
})();

/** Closes the rejections made so far: those reported before this marker are `id`'s (null: no call's). */
function mark(id: number | null) {
  const marker = new Marker(id, ++seq);
  if (id !== null) lastMarker.set(id, marker.seq);
  void Promise.reject(marker);
  // Bun reports at the end of a turn of the event loop: one more turn, so a child left idle still hears it.
  if (!REPORTS_AT_DRAIN) setImmediate(() => {});
}

/** `call` runs from now until it answers (`untrack`). */
export function track(id: number, call: Rejectable) {
  live.set(id, call);
}

export function untrack(id: number) {
  live.delete(id);
  lastMarker.delete(id);
  // Its late answers (dropped, or the code it left running): each in a turn of its own.
  for (const resume of queued.get(id) ?? []) setImmediate(resume);
  queued.delete(id);
}

/** `resume`, in a checkpoint of call `id` once its last checkpoint was checked: at once if it was. */
export function later(id: number, resume: () => void) {
  if (REPORTS_AT_DRAIN || !lastMarker.has(id)) return void setImmediate(() => checkpoint(id, resume));
  let q = queued.get(id);
  if (!q) queued.set(id, (q = []));
  q.push(() => checkpoint(id, resume));
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
 * `resume` (the app's code of call `id`, resumed) and every microtask it queues, run to the end, with what it leaves
 * rejected with no handler attributed to call `id`. `drainBefore`: the microtasks already queued are drained first,
 * and are no call's (false when they are this call's own, see `ChildCall.settled`).
 */
export function checkpoint(id: number | null, resume: () => void, drainBefore = true) {
  // Bun reports at the end of the turn: what this call's last checkpoint left is not known yet; this one runs after.
  if (!REPORTS_AT_DRAIN && !inCheckpoint && id !== null && lastMarker.has(id)) {
    let q = queued.get(id);
    if (!q) queued.set(id, (q = []));
    q.push(() => checkpoint(id, resume, drainBefore));
    return;
  }
  if (inCheckpoint) {
    // Within a checkpoint already (a resumption the app's code caused synchronously): the same drain.
    resume();
    return;
  }
  inCheckpoint = true;
  try {
    if (drainBefore) {
      drainMicrotasks();
      mark(null);
    }
    current = id;
    resume();
    drainMicrotasks();
  } finally {
    current = null;
    inCheckpoint = false;
  }
  mark(id);
}

/** The microtasks queued drained, in the checkpoint running (what they leave rejected is its call's). */
export function drain() {
  drainMicrotasks();
}

/** A checkpoint of `id`'s own, next turn: for a call that settled or started something outside one. */
export function checkSoon(id: number) {
  setImmediate(() => checkpoint(id, () => {}, false));
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

/** `reason`, rejected in a checkpoint of `id` (null: of no call), failing that call. */
function attribute(id: number | null, reason: unknown) {
  let call: Rejectable | undefined;
  if (id !== null) call = live.get(id);
  // Code Bun resumed itself: the one call running's, if there is one and no load runs.
  else if (live.size === 1 && working === 0) call = live.values().next().value;
  // A call that has answered is no longer tracked: what its leftover code rejects is printed (Convex's would not run).
  if (call) call.unhandled(reason);
  else printed(reason);
}

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Marker) {
    for (const r of unmarked.splice(0)) attribute(reason.id, r);
    if (reason.id !== null && lastMarker.get(reason.id) === reason.seq) {
      lastMarker.delete(reason.id);
      live.get(reason.id)?.checked();
      // Its next resumption, in a turn of its own (Bun reports this turn's rejections at its end).
      const next = queued.get(reason.id)?.shift();
      if (next) setImmediate(next);
    }
    return;
  }
  // Reported at the end of a checkpoint's drain (Bun 1.4.2): the call it names.
  if (current !== null) attribute(current, reason);
  else unmarked.push(reason);
});
