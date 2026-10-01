// Client-side timeouts on database calls (STUDY-25 L3). A remote store can stop answering without closing
// the connection: a frozen server, a paused VM, a network that silently drops packets. Without a timeout,
// the call waits forever, and so do startup, the query that made it, or a commit. Every remote driver
// therefore bounds each call on the client side and drops the connection a timed-out call ran on.

/**
 * A database call got no answer within its client-side timeout. The connection it ran on is not reused (the
 * driver drops it), and a flush that times out is fail-stop like any failed flush: whether the group
 * committed is unknown, so the committer stops and the process recovers from what the store holds.
 */
export class DatabaseTimeoutError extends Error {
  constructor(
    /** The store, e.g. "Postgres". */
    readonly store: string,
    readonly timeoutMs: number,
  ) {
    super(`Database Timeout (${store}): no answer within ${timeoutMs} ms`);
    this.name = "DatabaseTimeoutError";
  }
}

/**
 * Run one database call under a client-side timeout of `ms`. `fn` receives `progress()`: each call re-arms
 * the timer, so a call made of several round trips (a transaction: BEGIN, its statements, COMMIT) is bounded
 * per round trip, as a per-statement timeout would bound it. When the timer fires, `onTimeout` runs (the
 * driver drops the connection) and the call rejects with `DatabaseTimeoutError` at once; whatever `fn`
 * settles with later is ignored. `ms` of 0 or less, or Infinity, disables the timeout.
 */
export function withTimeout<T>(
  store: string,
  ms: number,
  fn: (progress: () => void) => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  if (!(ms > 0 && ms < Infinity)) return fn(() => {});
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        onTimeout?.();
      } finally {
        reject(new DatabaseTimeoutError(store, ms));
      }
    }, ms);
    const settle = () => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      return true;
    };
    let p: Promise<T>;
    try {
      p = fn(() => {
        if (!done) timer.refresh();
      });
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => settle() && resolve(v),
      (e) => settle() && reject(e),
    );
  });
}

/**
 * The timeout of a lease renewal (PERSIST-01 C7): a quarter of the lease's TTL, or the call timeout if that is
 * shorter. The engine renews every TTL/3, so a renewal stuck on a dead connection has failed, and the driver
 * has dropped that connection, before the next renewal is due; the next one runs on a fresh connection, and
 * the lease survives one dead connection. Waiting longer is pointless: past the TTL, the lease may already be
 * another process's, and the engine stops (fail-stop) when no renewal succeeded within the TTL.
 */
export const renewTimeoutMs = (callTimeoutMs: number, ttlMs: number) =>
  callTimeoutMs > 0 && callTimeoutMs < Infinity ? Math.min(callTimeoutMs, ttlMs / 4) : ttlMs / 4;
