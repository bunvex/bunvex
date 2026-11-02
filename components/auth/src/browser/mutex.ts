// The lock that serializes token refreshes (STUDY-201 §1.12), as v2's: callers racing to refresh (tabs, components
// mounting together) collapse to one refresh instead of each rotating the refresh token. With the Web Locks API it holds
// across tabs; without it, an in-process queue serializes callers of this realm only (tabs then race, a race the server's
// grace window and the shared storage narrow; every major browser has Web Locks).

/** Run `callback` holding the lock named `key`: one callback per key at a time. */
export async function runWithMutex<T>(key: string, callback: () => Promise<T>): Promise<T> {
  // An environment may have `navigator` without the API, or with it as null (happy-dom): only a `request` will do.
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return typeof locks?.request === "function" ? await locks.request(key, callback) : await queued(key, callback);
}

/** Each key's queue: the tail callers chain onto. */
const tails = new Map<string, Promise<unknown>>();

function queued<T>(key: string, callback: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(callback, callback);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
