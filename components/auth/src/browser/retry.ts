// The retry of the client's auth calls (a session refresh, an OAuth code's redemption), as v2's (STUDY-201 §1.12): on
// mobile they often fail while the app is in the background and succeed once it is back, so a network error is retried
// twice, after 500 ms and 2 s (plus up to 100 ms of jitter), before a last attempt.

const BACKOFF_MS = [500, 2000];
const JITTER_MS = 100;

/** A fetch that failed on the network, as Chromium, Firefox and WebKit word it. */
const isNetworkError = (error: unknown) =>
  error instanceof TypeError && /network|failed to fetch|load failed/i.test(error.message);

/** `fn`, again after a backoff when it throws a network error; any other error, or the last attempt's, is thrown. */
export async function retryOnNetworkError<T>(fn: () => Promise<T>, log?: (message: string) => void): Promise<T> {
  for (const [i, backoff] of BACKOFF_MS.entries()) {
    try {
      return await fn();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      const wait = backoff + JITTER_MS * Math.random();
      log?.(`network error, retry ${i + 1} in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return await fn();
}
