// What an HTTP action is logged as (STUDY-31 §7), on Convex's backend (the oracle) and on bunvex's: the same
// requests to the routes of `http-routes-app/` (an exact route, prefix routes, failing ones, one past the action
// timeout, `V8_ACTION_USER_TIMEOUT_SECS=3` on both) and to paths no route matches; their answers, the function log
// stream's entries (`/api/stream_function_logs`: each Progress and Completion's name, status, error and lines) and
// the app metrics of each route and request path compared. An error's first line only: the frames differ in their
// paths. Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh,
// or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-action-log-route: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-routes-app");

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  const env = { V8_ACTION_USER_TIMEOUT_SECS: "3" };
  [convex, bunvex] = await startAll([startConvex({ app: APP, env }), startBunvex({ app: APP, env })]);
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

/** Each request's status and body, then the HTTP actions' log entries once `completions` are in. */
async function play(b: Backend, requests: [string, string][], completions: number) {
  const answers: [number, string][] = [];
  for (const [method, path] of requests) {
    const r = await fetch(`${b.url}/http${path}`, { method });
    const text = await r.text();
    // A 500's body carries a fresh request id and the frames: its first line is enough.
    answers.push([r.status, r.status === 500 ? JSON.parse(text).code.replace(/^\[Request ID: \w+\] /, "") : text]);
  }
  let entries: Entry[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: auth(b) });
    entries = ((await r.json()) as { entries: Entry[] }).entries.filter((e) => e.udfType === "HttpAction");
    if (entries.filter((e) => e.kind === "Completion").length >= completions) break;
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

/** A route's or a request path's invocations and errors in the app metrics (one 660 s bucket). */
async function metrics(b: Backend, names: string[]) {
  const now = Math.floor(Date.now() / 1000);
  const window = JSON.stringify({
    start: { secs_since_epoch: now - 600, nanos_since_epoch: 0 },
    end: { secs_since_epoch: now + 60, nanos_since_epoch: 0 },
    num_buckets: 1,
  });
  const out: Record<string, number[]> = {};
  for (const path of names) {
    out[path] = [];
    for (const metric of ["invocations", "errors"]) {
      const q = new URLSearchParams({ metric, udfType: "HttpAction", path, window });
      const r = await fetch(`${b.url}/api/app_metrics/udf_rate?${q}`, { headers: auth(b) });
      const [[, rate]] = (await r.json()) as [unknown, number][];
      out[path].push(Math.round(rate * 660));
    }
  }
  return out;
}

describe.skipIf(!ready)("an HTTP action's log name, against Convex's backend", () => {
  test("exact and prefix routes, failures, a timeout, and requests no route matches", async () => {
    const requests: [string, string][] = [
      ["GET", "/hello"],
      ["GET", "/files/abc"],
      ["HEAD", "/files/abc"],
      ["POST", "/files/x/y"],
      ["GET", "/files/deep/z?q=1"],
      ["GET", "/fail/z"],
      ["GET", "/late/x"],
      ["GET", "/slow/x"],
      ["GET", "/nope"],
      ["DELETE", "/nope"],
      ["PUT", "/hello"],
      ["GET", "/hello/"],
      ["GET", "/files"],
      ["PATCH", "/files/q?x=1"],
      ["GET", "/f%20s/a"],
    ];
    const c = await play(convex, requests, requests.length);
    const b = await play(bunvex, requests, requests.length);
    expect(b.answers).toEqual(c.answers);
    expect(b.log).toEqual(c.log);
    // What the oracle shows, spelled out: lines by the request, a run that ended well by its route.
    const done = c.log.filter((e) => e.kind === "Completion").map((e) => e.identifier);
    expect(done).toEqual([
      "GET /hello",
      "GET /files/*",
      "GET /files/*",
      "POST /files/*",
      "GET /files/deep/*",
      "GET /fail/z",
      "GET /late/x",
      "GET /slow/x",
      "GET /nope",
      "DELETE /nope",
      "PUT /hello",
      "GET /hello/",
      "GET /files",
      "PATCH /files/q",
      "GET /f%20s/a",
    ]);
    expect(c.log.find((e) => e.kind === "Progress" && e.lines[0]?.includes("get"))?.identifier).toBe("GET /files/abc");

    const names = [
      "GET /hello",
      "GET /files/*",
      "POST /files/*",
      "GET /files/abc",
      "GET /files/deep/*",
      "GET /fail/*",
      "GET /fail/z",
      "GET /late/*",
      "GET /slow/*",
      "GET /nope",
    ];
    const cm = await metrics(convex, names);
    expect(await metrics(bunvex, names)).toEqual(cm);
    // A route is measured by its path whatever the method; failed runs and unmatched requests are not.
    expect(cm["GET /files/*"]).toEqual([3, 0]);
    expect(cm["GET /fail/*"]).toEqual([0, 0]);
    expect(cm["GET /nope"]).toEqual([0, 0]);
  }, 60_000);
});
