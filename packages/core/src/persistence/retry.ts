// Transient errors and retries (STUDY-25 L4/L5, as Convex). A remote store fails for reasons that pass: a
// connection the server or the network closed, a server restarting, a call that timed out. Convex retries
// those (a read once on a fresh connection, a commit with backoff), and stops for anything else.

/**
 * A retried flush found that an earlier attempt of the SAME group did commit, although that attempt failed
 * on the client side (its answer was lost with the connection, or came after the timeout). Convex reaches the
 * same point through a duplicate key and stops: "Unsure if transaction committed to disk". It is never
 * transient: the committer stops (fail-stop) and the process recovers from what the store holds, where the
 * group is present exactly once.
 */
export class UnsureCommitError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`unsure if the group committed: ${detail}`, options);
    this.name = "UnsureCommitError";
  }
}

/**
 * Run a read (or an idempotent init step) and, if it fails with an error `retryable` accepts, run it once more
 * after `beforeRetry` (which gets the driver a fresh connection), as Convex's `with_retry`
 * (`crates/postgres/src/connection.rs`) and `MYSQL_MAX_QUERY_RETRIES = 1`. Never for a statement inside a
 * transaction or a flush: only a whole call that has no effect, or none that a second run would repeat.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  retryable: (e: unknown) => boolean,
  beforeRetry?: (e: unknown) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!retryable(e)) throw e;
    beforeRetry?.(e);
    return fn();
  }
}
