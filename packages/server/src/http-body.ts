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
//
// A chunk is bytes (an ArrayBuffer or a view of one) or nothing (null or undefined, skipped): Convex's runtime hands
// each chunk to its `stream/extend` op (`06_streams.ts` `constructStreamId`, `crates/isolate/src/ops/stream.rs`), whose
// `Option<ByteBuf>` argument refuses anything else, so a string, a number or an object fails the body as above. The
// error is Convex's in all but its words: serde_v8's message names a library bunvex does not use, so bunvex says what
// a chunk must be, with the same type names (DV-529, STUDY-161 §15).
import { types } from "node:util";
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
  const reader = body.getReader() as ReadableStreamDefaultReader<unknown>;
  // Reads started in the handler's turn (`failedEarly`), in order: `pull` takes them before reading on.
  const early: ReturnType<typeof reader.read>[] = [];
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
            const { value, done } = await (early.shift() ?? reader.read());
            if (cancelled) return;
            if (done) {
              controller.close();
              finish();
              return;
            }
            // Nothing to send: Convex's op takes it as no chunk.
            if (value === undefined || value === null) continue;
            if (!isBytes(value)) throw notBytes(value);
            if (tooLarge) continue;
            if (bytes + value.byteLength > HTTP_ACTION_RESPONSE_LIMIT) {
              tooLarge = true;
              errors.push(
                `HttpResponseTooLarge: HTTP actions support responses up to ${formatBytes(HTTP_ACTION_RESPONSE_LIMIT)}`,
              );
              continue;
            }
            bytes += value.byteLength;
            // Bun's stream takes an ArrayBuffer or any view as bytes.
            controller.enqueue(value as Uint8Array);
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
   *
   * Convex's runtime reads the body as soon as the handler returns it, so a chunk that is not bytes fails the run
   * the same way when it comes in that turn: the turn reads what the body has ready, and `pull` sends it later.
   */
  const failedEarly = async () => {
    let reading = false;
    for (let i = 0; i < TURN_MICROTASKS && !failed; i++) {
      if (!reading) {
        reading = true;
        const read = reader.read();
        early.push(read);
        read.then(
          ({ value, done }) => {
            if (done) return;
            if (value !== undefined && value !== null && !isBytes(value)) failed ??= { error: notBytes(value) };
            // The next one, unless the turn found an error.
            else reading = false;
          },
          () => {},
        );
      }
      await null;
    }
    return failed;
  };
  return { stream, sent, failedEarly };
}

/**
 * A chunk Convex's `stream/extend` takes: an ArrayBuffer, or a view of one, of any realm, neither shared nor
 * resizable (Convex's serde_v8 refuses both).
 */
function isBytes(v: unknown): v is ArrayBuffer | ArrayBufferView {
  const buffer = ArrayBuffer.isView(v) ? v.buffer : v;
  return types.isArrayBuffer(buffer) && !resizable(buffer);
}

/** A resizable ArrayBuffer, or a growable SharedArrayBuffer. */
const resizable = (buffer: object) => {
  const b = buffer as { resizable?: boolean; growable?: boolean };
  return b.resizable === true || b.growable === true;
};

/**
 * The error for a chunk Convex's `ByteBuf` refuses (serde_v8's `magic/v8slice.rs`; v8's `Value::type_repr` names the
 * value), raised in Convex's Rust: an `Error` with no frames of the app. Its words are bunvex's (DV-529).
 */
function notBytes(v: unknown): Error {
  const buffer = ArrayBuffer.isView(v) ? v.buffer : v;
  const e = new Error(
    types.isAnyArrayBuffer(buffer) && resizable(buffer)
      ? "HTTP action response body chunks must not be a resizable ArrayBuffer or a view of one"
      : `HTTP action response body chunks must be an ArrayBuffer or a view of one, got ${typeRepr(v)}`,
  );
  e.stack = `Error: ${e.message}`;
  return e;
}

/** v8's `Value::type_repr` (rusty_v8 `src/value.rs`): the first of its checks a value passes, in its order. */
function typeRepr(v: unknown): string {
  const tag = Object.prototype.toString.call(v);
  if (types.isModuleNamespaceObject(v)) return "Module";
  if (tag === "[object WebAssembly.Module]") return "WASM module";
  if (tag === "[object WebAssembly.Memory]") return "WASM memory object";
  if (types.isProxy(v)) return "Proxy";
  if (types.isSharedArrayBuffer(v)) return "SharedArrayBuffer";
  if (types.isDataView(v)) return "DataView";
  if (types.isTypedArray(v)) {
    const name = tag.slice(8, -1);
    return TYPED_ARRAYS.has(name) ? name : "TypedArray";
  }
  if (types.isArrayBuffer(v)) return "ArrayBuffer";
  if (types.isWeakSet(v)) return "WeakSet";
  if (types.isWeakMap(v)) return "WeakMap";
  if (types.isSetIterator(v)) return "Set Iterator";
  if (types.isMapIterator(v)) return "Map Iterator";
  if (types.isSet(v)) return "Set";
  if (types.isMap(v)) return "Map";
  if (types.isPromise(v)) return "Promise";
  if (types.isGeneratorFunction(v)) return "Generator function";
  if (types.isAsyncFunction(v)) return "Async function";
  if (types.isRegExp(v)) return "RegExp";
  if (types.isDate(v)) return "Date";
  if (typeof v === "number") return "Number";
  if (typeof v === "boolean") return "Boolean";
  if (typeof v === "bigint") return "bigint";
  if (Array.isArray(v)) return "array";
  if (typeof v === "function") return "function";
  if (typeof v === "symbol") return "symbol";
  if (typeof v === "string") return "string";
  return "unknown";
}

/** The typed arrays v8 names (no Float16Array: v8 calls it `TypedArray`). */
const TYPED_ARRAYS = new Set([
  "BigUint64Array",
  "BigInt64Array",
  "Float64Array",
  "Float32Array",
  "Int32Array",
  "Uint32Array",
  "Int16Array",
  "Uint16Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Uint8Array",
]);
