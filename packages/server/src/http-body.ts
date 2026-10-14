// An HTTP action's response body as Convex's streamer sends it (STUDY-76, crates/isolate/src/environment/
// action/mod.rs `handle_http_streamed_part`): at most HTTP_ACTION_RESPONSE_BODY_LIMIT bytes. The first chunk
// that would cross it is dropped with an `error:httpAction` line, and so is every chunk after it (Convex since
// 82e5c50; before, later chunks that fit still went); a body that fails is reported the same way. `sent`
// settles once the body ended or the client went away, with the bytes sent, those lines, whether the body
// went over the limit and whether the client left mid-body (its `signal` aborted before the body ended:
// Convex's `info:httpActionClientDisconnect` line, http_routing.rs), for the run's log.
//
// A body that fails (STUDY-31 §10) is an uncaught error in Convex's isolate, which stops the run: in the handler's
// turn, before the head went, the run fails with it (the 500); after, the response ends there, cleanly, and the run
// gets an `error:httpAction` line of the error (`run_http_action`'s termination error).
import { formatBytes } from "@bunvex/core";
import { describeUncaught } from "./errors.ts";

/** Convex's HTTP_ACTION_RESPONSE_BODY_LIMIT: 100 MiB since 82e5c50 (20 MiB before). */
export const HTTP_ACTION_RESPONSE_LIMIT = 100 << 20;

/** The microtask turns a body has to fail in before its head goes (`failedEarly`, DV-485). */
const TURN_MICROTASKS = 32;

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
  // The body's error, once it failed (its start or a pull threw, or it was errored).
  let failed: { error: unknown } | null = null;
  reader.closed.catch((error: unknown) => {
    failed ??= { error };
  });
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
          errors.push(describeUncaught(e).message);
          controller.close();
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
  /**
   * The body's error if it failed in the handler's turn: Convex's isolate drains the microtask queue and looks for
   * an uncaught error before it sends the head, so a body that fails right away (in its start, or in its first pull
   * before anything outside the isolate is awaited) fails the run. Bun cannot tell when the queue is drained short of
   * a macrotask (setImmediate cost ~45 % of the requests per second of a streamed response), so this lets
   * TURN_MICROTASKS turns pass: a pull that throws after up to ~29 awaits (DV-485).
   */
  const failedEarly = async () => {
    for (let i = 0; i < TURN_MICROTASKS && !failed; i++) await null;
    return failed;
  };
  return { stream, sent, failedEarly };
}
