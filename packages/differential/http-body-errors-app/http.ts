// HTTP routes for the body error test (STUDY-31 §10): a streamed body that fails in the handler's turn (its start
// errors it after a chunk, its first pull throws, at once or after a few awaits, it is errored with a string), ones
// that fail after the head (two chunks a timer apart, then an Error or a string, pulled or from its start), and one
// that ends well. Each logs a line first, so its
// Progress entry shows.
import { httpActionGeneric, httpRouter } from "convex/server";

const bytes = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 10));
/** Two chunks a timer apart, then `fail` (or the end). */
const later = (fail?: unknown) => {
  let n = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      await tick();
      if (n++ < 2) c.enqueue(bytes(`part${n} `));
      else if (fail === undefined) c.close();
      else c.error(fail);
    },
  });
};
const bodies: Record<string, () => ReadableStream<Uint8Array>> = {
  start: () =>
    new ReadableStream({
      start(c) {
        c.enqueue(bytes("hello "));
        c.error(new Error("body boom"));
      },
    }),
  pull: () =>
    new ReadableStream({
      pull() {
        throw new Error("pull boom");
      },
    }),
  // Its first pull throws after a few awaits: still in the handler's turn.
  microtasks: () =>
    new ReadableStream({
      async pull() {
        for (let i = 0; i < 5; i++) await null;
        throw new Error("pull boom after awaits");
      },
    }),
  string: () =>
    new ReadableStream({
      start(c) {
        c.error("a string");
      },
    }),
  later: () => later(new TypeError("late body boom")),
  // Errored by its start, two chunks and two timers in, whether or not the body is read.
  startLater: () =>
    new ReadableStream({
      async start(c) {
        for (const n of [1, 2]) {
          c.enqueue(bytes(`part${n} `));
          await tick();
        }
        c.error(new RangeError("start boom"));
      },
    }),
  laterString: () => later("a late string"),
  ok: () => later(),
};

const http = httpRouter();
http.route({
  pathPrefix: "/stream/",
  method: "GET",
  handler: httpActionGeneric(async (_ctx, req) => {
    const kind = new URL(req.url).pathname.slice("/stream/".length);
    console.log(`streaming ${kind}`);
    return new Response(bodies[kind]!(), { headers: { "content-type": "text/plain" } });
  }),
});
export default http;
