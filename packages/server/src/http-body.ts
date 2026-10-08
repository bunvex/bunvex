// An HTTP action's response body as Convex's streamer sends it (STUDY-76, crates/isolate/src/environment/
// action/mod.rs `handle_http_streamed_part`): at most HTTP_ACTION_RESPONSE_BODY_LIMIT bytes. The first chunk
// that would cross it is dropped with an `error:httpAction` line, and so is every chunk after it (Convex since
// 82e5c50; before, later chunks that fit still went); a body that fails is reported the same way. `sent`
// settles once the body ended or the client went away, with the bytes sent, those lines, whether the body
// went over the limit and whether the client left mid-body (its `signal` aborted before the body ended:
// Convex's `info:httpActionClientDisconnect` line, http_routing.rs), for the run's log.
import { formatBytes } from "@bunvex/core";

/** Convex's HTTP_ACTION_RESPONSE_BODY_LIMIT: 100 MiB since 82e5c50 (20 MiB before). */
export const HTTP_ACTION_RESPONSE_LIMIT = 100 << 20;

export type SentBody = { bytes: number; errors: string[]; tooLarge: boolean; disconnected: boolean };

export function meteredBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  let bytes = 0;
  let tooLarge = false;
  const errors: string[] = [];
  let settle!: (v: SentBody) => void;
  const sent = new Promise<SentBody>((r) => {
    settle = r;
  });
  const finish = (disconnected = false) => settle({ bytes, errors, tooLarge, disconnected });
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
            if (tooLarge) continue;
            if (bytes + value.byteLength > HTTP_ACTION_RESPONSE_LIMIT) {
              tooLarge = true;
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
