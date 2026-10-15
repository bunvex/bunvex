// HTTP routes for the 500's `trace` test (STUDY-31 §11): a handler that throws an Error (its frames), one with no
// message, a value that is no Error (no frames), an Error whose stack has no frames, one that returns no Response,
// a body that fails in the handler's turn with a string, and one that runs past the action timeout. For the `code`
// test: messages of several lines, ones that end with a newline, and a nested action's error (its message carries the
// callee's frames).
import { anyApi, httpActionGeneric, httpRouter } from "convex/server";

const results: Record<string, (ctx: { runAction: (f: unknown) => Promise<unknown> }) => unknown> = {
  nested: (ctx) => ctx.runAction(anyApi.throws!.fails),
  error: () => {
    throw new Error("boom");
  },
  empty: () => {
    throw new Error("");
  },
  typeError: () => {
    throw new TypeError("bad type");
  },
  multiline: () => {
    throw new Error("line one\nline two");
  },
  trailingNewline: () => {
    throw new Error("ends with a newline\n");
  },
  multilineTypeError: () => {
    throw new TypeError("first\n\nthird");
  },
  trailingNewlineString: () => {
    throw "a string\n";
  },
  string: () => {
    throw "a string";
  },
  multilineString: () => {
    throw "one\ntwo";
  },
  number: () => {
    throw 42;
  },
  object: () => {
    throw { a: 1 };
  },
  null: () => {
    throw null;
  },
  undefined: () => {
    throw undefined;
  },
  noStack: () => {
    const e = new Error("no stack");
    e.stack = "Error: no stack";
    throw e;
  },
  nonResponse: () => ({ not: "a response" }),
  // Past the action timeout (3 s in the test).
  timeout: () => new Promise((r) => setTimeout(r, 10_000)),
  streamString: () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error("in turn");
        },
      }),
    ),
};

const http = httpRouter();
http.route({
  pathPrefix: "/trace/",
  method: "GET",
  handler: httpActionGeneric(async (ctx, req) => {
    const kind = new URL(req.url).pathname.slice("/trace/".length);
    return (await results[kind]!(ctx as never)) as Response;
  }),
});
export default http;
