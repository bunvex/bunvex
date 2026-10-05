// The HTTP server's concurrent request limit (STUDY-110), as Convex's `ConvexHttpService`
// (crates/common/src/http/mod.rs): one semaphore for every request the backend serves — the API's and the
// site's alike, as Convex's site proxy forwards into the backend's service. A request past the limit waits its
// turn (first come, first served): no 503, no message. It holds its permit until its handler has the response
// (its head): a streamed body does not count, as tower's `GlobalConcurrencyLimitLayer` releases when the
// response future resolves. Convex's 300 s timeout sits inside the limit, so the wait does not count toward it.
//
// Default 128, the self-hosted backend's `MAX_CONCURRENT_REQUESTS` (crates/local_backend/src/lib.rs); the knob
// `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` sets it, which self-hosted Convex ignores (DV-364).
//
// Exempt: a WebSocket upgrade (Convex's answers 101 at once and runs the socket apart, so it holds no permit
// once upgraded; bunvex does not make the handshake wait either, DV-365) and `/version` (Convex's meta route,
// merged outside the layers).

export const MAX_CONCURRENT_REQUESTS = 128;

/** A FIFO counting semaphore with a synchronous fast path: no promise when a permit is free. */
export class RequestLimit {
  private inUse = 0;
  /** Waiters, oldest first, from `head` on (a queue without `shift`'s copying). */
  private queue: (() => void)[] = [];
  private head = 0;
  /** For tests and metrics. */
  readonly stats = { peak: 0, queued: 0 };

  constructor(readonly max: number) {}

  /** Requests holding a permit now. */
  get running(): number {
    return this.inUse;
  }

  /** Requests waiting for one now. */
  get waiting(): number {
    return this.queue.length - this.head;
  }

  /** Run `fn` with a permit, released when what it returns settles (or it throws). */
  run<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (this.inUse < this.max) {
      this.inUse++;
      if (this.inUse > this.stats.peak) this.stats.peak = this.inUse;
      return this.hold(fn);
    }
    this.stats.queued++;
    return new Promise<void>((resolve) => this.queue.push(resolve)).then(() => this.hold(fn));
  }

  private hold<T>(fn: () => T | Promise<T>): T | Promise<T> {
    let out: T | Promise<T>;
    try {
      out = fn();
    } catch (e) {
      this.release();
      throw e;
    }
    if (out instanceof Promise)
      return out.then(
        (v) => {
          this.release();
          return v;
        },
        (e) => {
          this.release();
          throw e;
        },
      );
    this.release();
    return out;
  }

  /** A freed permit goes straight to the oldest waiter, so none can be taken in between. */
  private release() {
    if (this.head < this.queue.length) {
      const next = this.queue[this.head]!;
      this.queue[this.head++] = undefined as never;
      if (this.head > 1024 && this.head * 2 > this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      next();
    } else this.inUse--;
  }
}

/** The limit from `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` (Convex's knob), else 128. */
export function requestLimitFromEnv(env: Record<string, string | undefined> = process.env): RequestLimit {
  const v = env.HTTP_SERVER_MAX_CONCURRENT_REQUESTS;
  if (v === undefined || v === "") return new RequestLimit(MAX_CONCURRENT_REQUESTS);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`HTTP_SERVER_MAX_CONCURRENT_REQUESTS: not a positive integer: ${v}`);
  return new RequestLimit(n);
}

/** Whether a request is exempt: a WebSocket upgrade, or `/version`. */
function exempt(req: Request): boolean {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return true;
  const url = req.url;
  const start = url.indexOf("/", url.indexOf("//") + 2);
  return start !== -1 && url.startsWith("/version", start) && (url.length === start + 8 || url[start + 8] === "?");
}

/** Bun server options whose `fetch` runs under `limit` (every request but the exempt ones). */
export function withRequestLimit<D>(
  options: Bun.Serve.Options<D, never>,
  limit: RequestLimit,
): Bun.Serve.Options<D, never> {
  type Fetch = (req: Request, srv: Bun.Server<D>) => Response | undefined | Promise<Response | undefined>;
  const o = options as Bun.Serve.Options<D, never> & { fetch: Fetch };
  const fetch: Fetch = o.fetch.bind(o);
  const limited: Fetch = (req, srv) => (exempt(req) ? fetch(req, srv) : limit.run(() => fetch(req, srv)));
  return { ...o, fetch: limited } as Bun.Serve.Options<D, never>;
}
