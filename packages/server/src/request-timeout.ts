// The HTTP server's request timeout (STUDY-147 PR 3b), as Convex's `ConvexHttpService`
// (crates/common/src/http/mod.rs): tower's `TimeoutLayer` with `HTTP_SERVER_TIMEOUT_SECONDS` (300 s) around
// every route of the backend, the API's and the site's alike. A request whose handler has no response (its
// head) by then answers 408 with no body; what is sent after the head (a streamed body: a download, an export,
// an HTTP action's stream) is not timed. The handler's own time counts, reading the request's body included,
// so an upload slower than the timeout answers 408 too (owner, 2026-10-12: as Convex). It sits inside the
// concurrent request limit, as Convex's, so waiting for a permit does not count.
//
// Bun's own idle timeout is turned off for each request it times: it would close a connection whose handler
// is still working, with no answer at all, after 120 s. A WebSocket upgrade is not timed (Convex's answers
// 101 at once and runs the socket apart).
import { secondsKnob } from "@bunvex/core";

/** Convex's `HTTP_SERVER_TIMEOUT_DURATION`. */
export const REQUEST_TIMEOUT_MS = secondsKnob("HTTP_SERVER_TIMEOUT_SECONDS", 300);

/** `options`, its handler timed out after `ms` with a 408. */
export function withRequestTimeout<D>(options: Bun.Serve.Options<D, never>, ms: number): Bun.Serve.Options<D, never> {
  type Fetch = (req: Request, srv: Bun.Server<D>) => Response | undefined | Promise<Response | undefined>;
  const o = options as Bun.Serve.Options<D, never> & { fetch: Fetch };
  const fetch: Fetch = o.fetch.bind(o);
  const timed: Fetch = (req, srv) => {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return fetch(req, srv);
    srv.timeout(req, 0);
    const r = fetch(req, srv);
    if (!(r instanceof Promise)) return r;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    return Promise.race([r, timedOut]).then(
      (out) => {
        clearTimeout(timer);
        if (out !== "timeout") return out;
        // The handler keeps running, as an HTTP action's does in Convex; its response, if one comes, is never
        // sent, so its body is let go.
        void r.then((late) => late?.body?.cancel()).catch(() => {});
        return new Response(null, { status: 408 });
      },
      (e: unknown) => {
        clearTimeout(timer);
        throw e;
      },
    );
  };
  return { ...o, fetch: timed } as Bun.Serve.Options<D, never>;
}
