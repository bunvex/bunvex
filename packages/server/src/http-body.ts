// An HTTP action's response body as Convex's streamer sends it (STUDY-76, crates/isolate/src/environment/
// action/mod.rs `handle_http_streamed_part`): at most HTTP_ACTION_BODY_LIMIT bytes. A chunk that would cross
// it is dropped with an `error:httpAction` line (later chunks that fit still go, as in Convex); a body that
// fails is reported the same way. `sent` settles once the body ended or the client went away, with the bytes
// sent, those lines and whether the client left mid-body (its `signal` aborted before the body ended: Convex's
// `info:httpActionClientDisconnect` line, http_routing.rs), for the run's log.
import { formatBytes } from "@bunvex/core";

/** Convex's HTTP_ACTION_BODY_LIMIT, for responses. */
export const HTTP_ACTION_RESPONSE_LIMIT = 20 << 20;

export type SentBody = { bytes: number; errors: string[]; disconnected: boolean };

export function meteredBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  let bytes = 0;
  const errors: string[] = [];
  let settle!: (v: SentBody) => void;
  const sent = new Promise<SentBody>((r) => {
    settle = r;
  });
  const finish = (disconnected = false) => settle({ bytes, errors, disconnected });
  const reader = body.getReader();
  // Set once the client cancelled: a read still pending then must not touch the closed controller (that threw
  // "Controller is already closed", logged as a body error).
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (cancelled) return;
            if (done) {
              controller.close();
              finish();
              return;
            }
            if (bytes + value.byteLength > HTTP_ACTION_RESPONSE_LIMIT) {
              errors.push(
                `HttpResponseTooLarge: HTTP actions support responses up to ${formatBytes(HTTP_ACTION_RESPONSE_LIMIT)}`,
              );
              continue;
            }
            bytes += value.byteLength;
            controller.enqueue(value);
            return;
          }
        } catch (e) {
          if (cancelled) return;
          errors.push(e instanceof Error ? e.message : String(e));
          controller.error(e);
          finish();
        }
      },
      cancel(reason) {
        cancelled = true;
        void reader.cancel(reason).catch(() => {});
        // A HEAD request also cancels the body, with no abort: only a client that left counts.
        finish(signal?.aborted === true);
      },
      // Pulled only as the client reads, as Convex's streamer sends: a body that never ends is not read ahead.
    },
    { highWaterMark: 0 },
  );
  return { stream, sent };
}
