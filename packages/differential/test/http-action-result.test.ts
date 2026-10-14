// A handler that returns something other than a Response (STUDY-31 §9), on Convex's backend (the oracle) and on
// bunvex's: the routes of `http-results-app/` return an object, `undefined`, `null`, a string, a number and an
// object shaped like a Response, and one a Response. Compared: each answer (the 500's `code` and the first line of
// its `trace`), the function log stream's entries (each Progress and Completion's name, lines, status and the
// first line of its error: the frames differ, Convex's point into its router) and the app metrics of the route.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-action-result: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-results-app");
const KINDS = ["object", "undefined", "null", "string", "number", "like", "response"];

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

const auth = (b: Backend) => ({ authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` });

type Entry = {
  kind: string;
  udfType: string;
  identifier: string;
  logLines: string[];
  success?: unknown;
  error?: string;
};

async function play(b: Backend) {
  const answers: unknown[] = [];
  for (const kind of KINDS) {
    const r = await fetch(`${b.url}/http/result/${kind}`);
    const text = await r.text();
    if (r.status !== 500) {
      answers.push({ status: r.status, text });
      continue;
    }
    const body = JSON.parse(text) as { code: string; trace?: string };
    answers.push({
      status: r.status,
      type: r.headers.get("content-type"),
      code: body.code.replace(/^\[Request ID: \w+\] /, ""),
      trace: body.trace?.split("\n")[0],
    });
  }
  let entries: Entry[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: auth(b) });
    entries = ((await r.json()) as { entries: Entry[] }).entries.filter((e) => e.udfType === "HttpAction");
    if (entries.filter((e) => e.kind === "Completion").length >= KINDS.length) break;
    await Bun.sleep(100);
  }
  const log = entries.map((e) => ({
    kind: e.kind,
    identifier: e.identifier,
    lines: e.logLines,
    ...(e.kind === "Completion" && { success: e.success ?? null, error: e.error?.split("\n")[0] ?? null }),
  }));
  return { answers, log };
}

/** The route's invocations and errors in the app metrics (one 660 s bucket). */
async function metrics(b: Backend) {
  const now = Math.floor(Date.now() / 1000);
  const window = JSON.stringify({
    start: { secs_since_epoch: now - 600, nanos_since_epoch: 0 },
    end: { secs_since_epoch: now + 60, nanos_since_epoch: 0 },
    num_buckets: 1,
  });
  const out: number[] = [];
  for (const metric of ["invocations", "errors"]) {
    const q = new URLSearchParams({ metric, udfType: "HttpAction", path: "GET /result/*", window });
    const r = await fetch(`${b.url}/api/app_metrics/udf_rate?${q}`, { headers: auth(b) });
    const [[, rate]] = (await r.json()) as [unknown, number][];
    out.push(Math.round(rate * 660));
  }
  return out;
}

describe.skipIf(!ready)("a handler's non-Response, against Convex's backend", () => {
  test("answered with the 500 and logged with Convex's error", async () => {
    const c = await play(convex);
    const b = await play(bunvex);
    expect(b.answers).toEqual(c.answers);
    expect(b.log).toEqual(c.log);
    // What the oracle shows, spelled out.
    const failed = { status: 500, type: "application/json" };
    const message = "Uncaught Error: HTTP actions must return a Response";
    expect(c.answers).toEqual([
      ...KINDS.slice(0, -1).map(() => ({ ...failed, code: `Server Error: ${message}`, trace: message })),
      { status: 200, text: "fine" },
    ]);
    const done = c.log.filter((e) => e.kind === "Completion");
    expect(done.map((e) => e.error)).toEqual([...KINDS.slice(0, -1).map(() => message), null]);
    // Failed runs are logged under the request and not measured; the Response is, under its route.
    expect(done.map((e) => e.identifier)).toEqual([
      ...KINDS.slice(0, -1).map((k) => `GET /result/${k}`),
      "GET /result/*",
    ]);
    const cm = await metrics(convex);
    expect(await metrics(bunvex)).toEqual(cm);
    expect(cm).toEqual([1, 0]);
  }, 60_000);
});
