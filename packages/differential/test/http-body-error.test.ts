// A streamed HTTP action body that fails (STUDY-31 §10), on Convex's backend (the oracle) and on bunvex's: the routes
// of `http-body-errors-app/` answer a stream that fails in the handler's turn (an error in its start, a pull that
// throws at once or after a few awaits, a string), ones that fail after the head (two chunks a timer apart, then an
// Error or a string, pulled or from its start) and one that ends well. Read off a raw socket and compared: the status, the body, whether the response ended cleanly (the
// chunked terminator, or all of its `content-length`); a 500's `code` and the first line of its `trace`; the function
// log stream's entries (each Progress and Completion's name, the first line of each line, status and error line:
// the frames differ in their paths) and the route's app metrics. Local only: skipped, with a note, when Convex's
// backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
//
// The routes under `/chunk/` stream a chunk that is not bytes (a string, a number, an object, …), nothing (null,
// undefined) or bytes of another kind (an ArrayBuffer, a DataView, a Uint16Array), in the handler's turn or after the
// head (STUDY-161 §15), compared the same way, the error read in Convex's words (bunvex has its own, DV-529).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-body-error: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-body-errors-app");
const KINDS = ["start", "pull", "microtasks", "string", "later", "laterString", "startLater", "ok"];
const CHUNKS = [
  ...[
    "string",
    "empty",
    "number",
    "boolean",
    "object",
    "array",
    "blob",
    "map",
    "symbol",
    "bigint",
    "sharedView",
    "resizable",
    "proxy",
    "null",
    "undefined",
    "arrayBuffer",
    "dataView",
    "uint16",
  ].map((k) => `now/${k}`),
  ...["string", "number", "object", "null", "arrayBuffer"].map((k) => `later/${k}`),
];

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

/** One HTTP/1.1 request on its own connection to the site port, read raw: the head, the body, whether it ended. */
function raw(b: Backend, path: string) {
  const site = new URL(b.url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`));
  return new Promise<{ status: number; type?: string; body: string; ended: boolean }>((done, fail) => {
    const parts: Buffer[] = [];
    let reset = false;
    const s = connect(Number(site.port), site.hostname, () =>
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${site.host}\r\nConnection: close\r\n\r\n`),
    );
    s.on("data", (d: Buffer) => parts.push(d));
    s.on("error", () => {
      reset = true;
    });
    s.on("close", () => {
      const all = Buffer.concat(parts);
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) return fail(new Error(`no head for ${path} (${reset ? "reset" : "closed"})`));
      const [statusLine, ...lines] = all.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const i = l.indexOf(":");
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      let body = all.subarray(end + 4);
      let ended: boolean;
      if (headers["transfer-encoding"] === "chunked") {
        const out: Buffer[] = [];
        ended = false;
        for (let at = 0; ; ) {
          const eol = body.indexOf("\r\n", at);
          if (eol < 0) break;
          const n = Number.parseInt(body.subarray(at, eol).toString(), 16);
          if (!n) {
            ended = body.subarray(eol, eol + 4).toString() === "\r\n\r\n";
            break;
          }
          out.push(body.subarray(eol + 2, eol + 2 + n));
          at = eol + 2 + n + 2;
        }
        body = Buffer.concat(out);
      } else ended = body.length === Number(headers["content-length"]);
      done({
        status: Number(statusLine!.split(" ")[1]),
        type: headers["content-type"],
        body: body.toString(),
        ended: ended && !reset,
      });
    });
  });
}

type Entry = {
  kind: string;
  udfType: string;
  identifier: string;
  logLines: string[];
  success?: unknown;
  error?: string;
};

/** Each path under `prefix` in turn, read raw, then the log entries of their runs. */
async function play(b: Backend, prefix = "/stream/", paths = KINDS) {
  const answers: unknown[] = [];
  for (const path of paths) {
    const r = await raw(b, `${prefix}${path}`);
    if (r.status !== 500) {
      answers.push(r);
      continue;
    }
    const body = JSON.parse(r.body) as { code: string; trace?: string };
    answers.push({
      ...r,
      body: { code: body.code.replace(/^\[Request ID: \w+\] /, ""), trace: body.trace?.split("\n")[0] },
    });
  }
  let entries: Entry[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${b.url}/api/stream_function_logs?cursor=0`, { headers: auth(b) });
    entries = ((await r.json()) as { entries: Entry[] }).entries.filter(
      (e) => e.udfType === "HttpAction" && e.identifier.startsWith(`GET ${prefix}`),
    );
    if (entries.filter((e) => e.kind === "Completion").length >= paths.length) break;
    await Bun.sleep(100);
  }
  const log = entries.map((e) => ({
    kind: e.kind,
    identifier: e.identifier,
    lines: e.logLines.map((l) => l.split("\n")[0]),
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
    const q = new URLSearchParams({ metric, udfType: "HttpAction", path: "GET /stream/*", window });
    const r = await fetch(`${b.url}/api/app_metrics/udf_rate?${q}`, { headers: auth(b) });
    const [[, rate]] = (await r.json()) as [unknown, number][];
    out.push(Math.round(rate * 660));
  }
  return out;
}

describe.skipIf(!ready)("a body that fails, against Convex's backend", () => {
  test("in the handler's turn: the 500; after the head: a clean end and an error line", async () => {
    const c = await play(convex);
    const b = await play(bunvex);
    expect(b.answers).toEqual(c.answers);
    expect(b.log).toEqual(c.log);
    // What the oracle shows, spelled out.
    const failed = (message: string) => ({
      status: 500,
      type: "application/json",
      ended: true,
      body: { code: `Server Error: ${message}`, trace: message },
    });
    const text = (body: string) => ({ status: 200, type: "text/plain", body, ended: true });
    expect(c.answers).toEqual([
      failed("Uncaught Error: body boom"),
      failed("Uncaught Error: pull boom"),
      failed("Uncaught Error: pull boom after awaits"),
      failed("Uncaught a string"),
      text("part1 part2 "),
      text("part1 part2 "),
      text("part1 part2 "),
      text("part1 part2 "),
    ]);
    const lines = c.log.filter((e) => e.kind === "Progress").flatMap((e) => e.lines);
    expect(lines.filter((l) => l.startsWith("[ERROR]"))).toEqual([
      "[ERROR] Uncaught TypeError: late body boom",
      "[ERROR] Uncaught a late string",
      "[ERROR] Uncaught RangeError: start boom",
    ]);
    // A run whose body failed is logged under the request and not measured; the one that ended well is.
    const done = c.log.filter((e) => e.kind === "Completion").map((e) => [e.identifier, e.success, e.error]);
    expect(done).toEqual([
      ["GET /stream/start", null, "Uncaught Error: body boom"],
      ["GET /stream/pull", null, "Uncaught Error: pull boom"],
      ["GET /stream/microtasks", null, "Uncaught Error: pull boom after awaits"],
      ["GET /stream/string", null, "Uncaught a string"],
      ["GET /stream/later", { status: "200" }, null],
      ["GET /stream/laterString", { status: "200" }, null],
      ["GET /stream/startLater", { status: "200" }, null],
      ["GET /stream/*", { status: "200" }, null],
    ]);
    const cm = await metrics(convex);
    expect(await metrics(bunvex)).toEqual(cm);
    expect(cm).toEqual([1, 0]);
  }, 60_000);
});

describe.skipIf(!ready)("a chunk that is not bytes, against Convex's backend", () => {
  test("in the handler's turn: the 500; after the head: a clean end and an error line; nothing is no chunk", async () => {
    const c = await play(convex, "/chunk/", CHUNKS);
    const b = await play(bunvex, "/chunk/", CHUNKS);
    // DV-529: bunvex words the error its own way, with the same type names. Everything else is compared as is: each
    // message read in serde_v8's words, and every bunvex one must read back.
    const words = JSON.stringify(b);
    const read = words
      .replaceAll(
        /HTTP action response body chunks must be an ArrayBuffer or a view of one, got ([^"\\]+)/g,
        "serde_v8 error: invalid type; expected: buffer, got: $1",
      )
      .replaceAll(
        "HTTP action response body chunks must not be a resizable ArrayBuffer or a view of one",
        "serde_v8 error: can't create slice from resizable ArrayBuffer",
      );
    expect(read).not.toContain("HTTP action response body chunks");
    expect(words).not.toContain("serde_v8");
    const seen = JSON.parse(read) as typeof b;
    expect(seen.answers).toEqual(c.answers);
    expect(seen.log).toEqual(c.log);
    // What the oracle shows, spelled out.
    const refused = (got: string) => {
      const message = `Uncaught Error: serde_v8 error: ${got.startsWith("can't") ? got : `invalid type; expected: buffer, got: ${got}`}`;
      return {
        status: 500,
        type: "application/json",
        ended: true,
        body: { code: `Server Error: ${message}`, trace: message },
      };
    };
    const text = (body: string) => ({ status: 200, type: "text/plain", body, ended: true });
    expect(c.answers).toEqual([
      ...["string", "string", "Number", "Boolean", "unknown", "array", "unknown", "Map", "symbol", "bigint"].map(
        refused,
      ),
      refused("Uint8Array"),
      refused("can't create slice from resizable ArrayBuffer"),
      refused("Proxy"),
      text("first  last"),
      text("first  last"),
      text("first ab last"),
      text("first dv last"),
      text("first hi last"),
      text("first "),
      text("first "),
      text("first "),
      text("first  last"),
      text("first ab last"),
    ]);
    const lines = c.log.filter((e) => e.kind === "Progress").flatMap((e) => e.lines);
    expect(lines.filter((l) => l.startsWith("[ERROR]"))).toEqual(
      ["string", "Number", "unknown"].map(
        (got) => `[ERROR] Uncaught Error: serde_v8 error: invalid type; expected: buffer, got: ${got}`,
      ),
    );
  }, 60_000);
});
