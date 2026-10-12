// An action's `fetch` (STUDY-142): what a request answers or how it fails, as data the test compares — the
// response (status, body, url, redirected) or the error (its class, name and message), a body's read failure
// included. `abortAfter` aborts the request after that many ms; `abortBody` aborts while the body is read;
// `streamBody` sends that text as a stream.
import { actionGeneric } from "convex/server";
import { v } from "convex/values";

type Init = RequestInit & { abortAfter?: number; abortBody?: boolean; streamBody?: string };

const failure = (e: unknown, where: "request" | "body") => {
  const err = e as Error;
  return { where, class: err?.constructor?.name, name: err?.name, message: String(err?.message) };
};

export const get = actionGeneric({
  args: { url: v.string(), init: v.optional(v.any()) },
  handler: async (_ctx, { url, init }) => {
    const { abortAfter, abortBody, streamBody, ...rest } = (init ?? {}) as Init;
    if (streamBody !== undefined)
      rest.body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(streamBody));
          c.close();
        },
      });
    const c = new AbortController();
    if (abortAfter !== undefined || abortBody) rest.signal = c.signal;
    if (abortAfter !== undefined) setTimeout(() => c.abort(), abortAfter);
    let r: Response;
    try {
      r = await fetch(url, rest);
    } catch (e) {
      return failure(e, "request");
    }
    if (abortBody) c.abort();
    try {
      const body = await r.text();
      return { status: r.status, body, url: r.url, redirected: r.redirected };
    } catch (e) {
      return failure(e, "body");
    }
  },
});
