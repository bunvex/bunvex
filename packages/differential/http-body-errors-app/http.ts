// HTTP routes for the body error test (STUDY-31 §10): a streamed body that fails in the handler's turn (its start
// errors it after a chunk, its first pull throws, at once or after a few awaits, it is errored with a string), ones
// that fail after the head (two chunks a timer apart, then an Error or a string, pulled or from its start), and one
// that ends well. Each logs a line first, so its
// Progress entry shows. Under `/chunk/`, a stream with a chunk that is not bytes (or is nothing, or bytes of another
// kind) between two byte chunks, in the handler's turn (`now`) or a timer later (`later`) (STUDY-161 §15).
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
/** The chunks of `/chunk/<when>/<kind>`, each made fresh. */
const chunks: Record<string, () => unknown> = {
  string: () => "a string",
  empty: () => "",
  number: () => 42,
  boolean: () => true,
  object: () => ({ a: 1 }),
  array: () => [104, 105],
  blob: () => new Blob(["blob"]),
  map: () => new Map(),
  symbol: () => Symbol("s"),
  bigint: () => 1n,
  sharedView: () => new Uint8Array(new SharedArrayBuffer(2)),
  resizable: () => new ArrayBuffer(2, { maxByteLength: 4 }),
  proxy: () => new Proxy({}, {}),
  null: () => null,
  undefined: () => undefined,
  arrayBuffer: () => bytes("ab").buffer,
  dataView: () => new DataView(bytes("dv").buffer),
  uint16: () => new Uint16Array([0x6968]),
};
/** `first `, the chunk, then ` last`: all in its start (`now`), or each pulled a timer apart (`later`). */
const withChunk = (when: string, chunk: unknown) => {
  const parts = [bytes("first "), chunk, bytes(" last")];
  let n = 0;
  return new ReadableStream({
    start(c) {
      if (when !== "now") return;
      for (const p of parts) c.enqueue(p);
      c.close();
    },
    async pull(c) {
      await tick();
      if (n < parts.length) c.enqueue(parts[n++]);
      else c.close();
    },
  }) as ReadableStream<Uint8Array>;
};
http.route({
  pathPrefix: "/chunk/",
  method: "GET",
  handler: httpActionGeneric(async (_ctx, req) => {
    const [when, kind] = new URL(req.url).pathname.slice("/chunk/".length).split("/");
    console.log(`chunk ${when} ${kind}`);
    return new Response(withChunk(when!, chunks[kind!]!()), { headers: { "content-type": "text/plain" } });
  }),
});
export default http;
