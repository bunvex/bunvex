// The 500 of an HTTP action that failed before its head (STUDY-31 §11), on Convex's backend (the oracle) and on
// bunvex's: the routes of `http-trace-app/` throw an Error, a value that is no Error, an Error whose stack has no
// frames, return no Response, fail their body in the handler's turn, or run past the action timeout. Compared: the `trace` whole when it has no
// frames (it ends with a newline on Convex), and its first line and last character when it has (the frames differ in
// their paths, and Convex's point into its router). Local only: skipped, with a note, when Convex's backend is not
// there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-500-trace: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-trace-app");
const FRAMED = ["error", "empty", "typeError", "nonResponse"];
const BARE = [
  "timeout",
  "string",
  "multilineString",
  "number",
  "object",
  "null",
  "undefined",
  "noStack",
  "streamString",
];

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  // A short action timeout on both, for the route that runs past it.
  const env = { V8_ACTION_USER_TIMEOUT_SECS: "3" };
  [convex, bunvex] = await Promise.all([startConvex({ app: APP, env }), startBunvex({ app: APP, env })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

async function traces(b: Backend) {
  const site = b.url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);
  const out: Record<string, object> = {};
  for (const kind of [...FRAMED, ...BARE]) {
    const r = await fetch(`${site}/trace/${kind}`);
    const { trace } = (await r.json()) as { trace: string };
    out[kind] = FRAMED.includes(kind)
      ? { status: r.status, first: trace.split("\n")[0], framed: /\n {4}at /.test(trace), last: trace.slice(-1) }
      : { status: r.status, trace };
  }
  return out;
}

describe.skipIf(!ready)("the 500's trace, against Convex's backend", () => {
  test("it ends with a newline, after the last frame or after the message alone", async () => {
    const c = await traces(convex);
    const b = await traces(bunvex);
    // bunvex lists only the app's frames: a failure in its own router (no Response) has none.
    const seen: Record<string, object> = { ...b, nonResponse: { ...b.nonResponse, framed: true } };
    expect(seen).toEqual(c);
    // What the oracle shows, spelled out.
    expect(c).toMatchObject({
      error: { status: 500, first: "Uncaught Error: boom", framed: true, last: "\n" },
      empty: { first: "Uncaught Error", last: "\n" },
      nonResponse: { first: "Uncaught Error: HTTP actions must return a Response", last: "\n" },
      timeout: { status: 500, trace: "Function execution timed out (maximum duration: 3s)\n" },
      string: { status: 500, trace: "Uncaught a string\n" },
      multilineString: { trace: "Uncaught one\ntwo\n" },
      number: { trace: "Uncaught 42\n" },
      object: { trace: "Uncaught #<Object>\n" },
      null: { trace: "Uncaught null\n" },
      undefined: { trace: "Uncaught undefined\n" },
      noStack: { trace: "Uncaught Error: no stack\n" },
      streamString: { trace: "Uncaught in turn\n" },
    });
  }, 60_000);
});
