// The headers an HTTP action's response gets from its body (STUDY-31 §8), as Convex's runtime gives them
// (udf-runtime 22_body.ts `extractBody`, 23_response.ts): unless the app set a Content-Type, a string's is
// `text/plain;charset=UTF-8`, a URLSearchParams' `application/x-www-form-urlencoded;charset=UTF-8`, a FormData's
// multipart with its boundary, a Blob's its type; `Response.json` always `application/json`; bytes, a stream and no
// body none. A body that is not a stream goes with its `content-length` (the app's own kept), a stream chunked.
// Pushed code, whose `Response` is the functions' one; the wire read raw.
import { afterEach, expect, test } from "bun:test";
import { request } from "node:http";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import type { FunctionLog } from "../src/function-log.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["bunvex", "server"].join("/");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  delete process.env.FUNCTION_LIMIT_WARNING_RATIO;
});

// `GET /body?kind=<kind>`: a Response of the body `kind` names; `-explicit` adds an explicit Content-Type, `-length`
// an explicit Content-Length. `/inside` answers what the handler itself sees of its Responses.
const HTTP = `import { httpActionGeneric, httpRouter } from ${JSON.stringify(SERVER)};
const bytes = () => new TextEncoder().encode("bytes");
const bodies = {
  string: () => "hello",
  "empty-string": () => "",
  number: () => 42,
  search: () => new URLSearchParams({ a: "1", b: "x y" }),
  form: () => { const f = new FormData(); f.append("a", "1"); return f; },
  "blob-typed": () => new Blob(["<p>hi</p>"], { type: "Text/HTML" }),
  "blob-untyped": () => new Blob(["hi"]),
  arraybuffer: () => bytes().buffer,
  uint8: bytes,
  dataview: () => new DataView(bytes().buffer),
  big: () => "x".repeat(1 << 20),
  "big-bytes": () => new Uint8Array(1 << 20),
  stream: () => new ReadableStream({ async start(c) {
    c.enqueue(new TextEncoder().encode("one,"));
    await new Promise((r) => setTimeout(r, 30));
    c.enqueue(new TextEncoder().encode("two"));
    c.close();
  } }),
  null: () => null,
  undefined: () => undefined,
};
const http = httpRouter();
http.route({ path: "/body", method: "GET", handler: httpActionGeneric(async (_ctx, req) => {
  const kind = new URL(req.url).searchParams.get("kind");
  const base = kind.replace(/-explicit$|-length$/, "");
  const headers = {};
  if (kind.endsWith("-explicit")) headers["content-type"] = "application/x-explicit";
  if (kind.endsWith("-length")) headers["content-length"] = "5";
  if (base === "json") return Response.json({ a: 1 }, { headers });
  return new Response(bodies[base](), { headers });
}) });
http.route({ path: "/inside", method: "GET", handler: httpActionGeneric(async () => {
  const seen = [
    new Response("x").headers.get("content-type"),
    new Response(new Blob(["x"], { type: "text/plain" })).headers.get("content-type"),
    Response.json(1, { headers: { "content-type": "text/x" } }).headers.get("content-type"),
    new Response("x", { headers: { "content-type": "" } }).headers.get("content-type"),
    new Response(new Uint8Array(1)).headers.get("content-type"),
    new Response("x").headers.get("content-length"),
    await new Response(7).text(),
    new Response("x") instanceof Response,
  ];
  return Response.json(seen);
}) });
export default http;`;

async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, deployable: true, moduleStorage: new MemoryBlobStore() });
  stops.push(() => s.shutdown());
  await s.deployCode([{ path: "http.js", source: HTTP, environment: "isolate" }]);
  const completions: { identifier: string; logLines: unknown[] }[] = [];
  functions.functionLog = {
    append: (p: { kind: string; identifier: string; logLines: unknown[] }) => {
      if (p.kind === "Completion") completions.push(p);
    },
  } as unknown as FunctionLog;
  const origin = `http://127.0.0.1:${s.server.port}/http`;
  /** The answer as sent: status, headers (lower-cased, `date` and the request id left out) and body. */
  const raw = (path: string, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | undefined>; body: string }>((resolve, reject) => {
      const r = request(`${origin}${path}`, { method }, (m) => {
        let body = "";
        m.setEncoding("latin1");
        m.on("data", (c) => {
          body += c;
        });
        m.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (let i = 0; i < m.rawHeaders.length; i += 2)
            headers[m.rawHeaders[i]!.toLowerCase()] = m.rawHeaders[i + 1]!;
          delete headers.date;
          resolve({ status: m.statusCode!, headers, body });
        });
      });
      r.on("error", reject);
      r.end();
    });
  const get = (kind: string, method = "GET") => raw(`/body?kind=${kind}`, method);
  return { get, raw, completions };
}

test("a body's own Content-Type and its Content-Length, as Convex's", async () => {
  const { get } = await deployment();
  const sent = async (kind: string) => {
    const r = await get(kind);
    return [r.headers["content-type"], r.headers["content-length"], r.headers["transfer-encoding"], r.body];
  };
  expect(await sent("string")).toEqual(["text/plain;charset=UTF-8", "5", undefined, "hello"]);
  expect(await sent("empty-string")).toEqual(["text/plain;charset=UTF-8", "0", undefined, ""]);
  expect(await sent("number")).toEqual(["text/plain;charset=UTF-8", "2", undefined, "42"]);
  expect(await sent("search")).toEqual([
    "application/x-www-form-urlencoded;charset=UTF-8",
    "9",
    undefined,
    "a=1&b=x+y",
  ]);
  expect(await sent("blob-typed")).toEqual(["text/html", "9", undefined, "<p>hi</p>"]);
  expect(await sent("blob-untyped")).toEqual([undefined, "2", undefined, "hi"]);
  expect(await sent("json")).toEqual(["application/json", "7", undefined, '{"a":1}']);
  for (const kind of ["arraybuffer", "uint8", "dataview"])
    expect(await sent(kind)).toEqual([undefined, "5", undefined, "bytes"]);
  // Multipart, with the boundary its body uses.
  const form = await get("form");
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(form.headers["content-type"]!)![1]!;
  expect(form.headers["content-length"]).toBe(String(form.body.length));
  const parsed = await new Response(form.body, {
    headers: { "content-type": form.headers["content-type"]! },
  }).formData();
  expect([...parsed]).toEqual([["a", "1"]]);
  expect(form.body.startsWith(`--${boundary}`)).toBe(true);
});

test("a body past Bun's first chunk keeps its Content-Length; a stream is chunked; no body has neither", async () => {
  const { get } = await deployment();
  const big = await get("big");
  expect([big.headers["content-length"], big.headers["transfer-encoding"], big.body.length]).toEqual([
    String(1 << 20),
    undefined,
    1 << 20,
  ]);
  expect(big.headers["content-type"]).toBe("text/plain;charset=UTF-8");
  const stream = await get("stream");
  expect([
    stream.headers["content-type"],
    stream.headers["content-length"],
    stream.headers["transfer-encoding"],
  ]).toEqual([undefined, undefined, "chunked"]);
  expect(stream.body).toBe("one,two");
  // Untyped bytes past Bun's first chunk: Bun would type them if sent whole, so they are streamed and go chunked,
  // where Convex sends their length (DV-483).
  const bytes = await get("big-bytes");
  expect([bytes.headers["content-type"], bytes.headers["content-length"], bytes.headers["transfer-encoding"]]).toEqual([
    undefined,
    undefined,
    "chunked",
  ]);
  expect(bytes.body.length).toBe(1 << 20);
  for (const kind of ["null", "undefined"]) {
    const r = await get(kind);
    expect([r.headers["content-type"], r.body]).toEqual([undefined, ""]);
  }
});

test("an explicit Content-Type wins over the body's, except over Response.json's; an explicit Content-Length is kept", async () => {
  const { get } = await deployment();
  for (const kind of ["string", "search", "form", "blob-typed", "uint8"])
    expect((await get(`${kind}-explicit`)).headers["content-type"]).toBe("application/x-explicit");
  expect((await get("json-explicit")).headers["content-type"]).toBe("application/json");
  const r = await get("string-length");
  expect([r.headers["content-type"], r.headers["content-length"], r.body]).toEqual([
    "text/plain;charset=UTF-8",
    "5",
    "hello",
  ]);
});

test("a HEAD request gets GET's Content-Type and Content-Length, with no body", async () => {
  const { get } = await deployment();
  const r = await get("string", "HEAD");
  expect([r.headers["content-type"], r.headers["content-length"], r.body]).toEqual([
    "text/plain;charset=UTF-8",
    "5",
    "",
  ]);
  const blob = await get("blob-typed", "HEAD");
  expect([blob.headers["content-type"], blob.headers["content-length"]]).toEqual(["text/html", "9"]);
  const bytes = await get("uint8", "HEAD");
  expect([bytes.headers["content-type"], bytes.headers["content-length"]]).toEqual([undefined, "5"]);
  const stream = await get("stream", "HEAD");
  expect([stream.headers["content-type"], stream.headers["content-length"]]).toEqual([undefined, "0"]);
});

test("the handler sees the same headers on the Responses it builds", async () => {
  const { raw } = await deployment();
  expect(JSON.parse((await raw("/inside")).body)).toEqual([
    "text/plain;charset=UTF-8",
    "text/plain",
    "application/json",
    "",
    null,
    null, // the length is sent, not in the headers
    "7",
    true,
  ]);
});

test("a body sent whole is logged with its size (the response-size warning)", async () => {
  process.env.FUNCTION_LIMIT_WARNING_RATIO = "0.00000001";
  const { get, completions } = await deployment();
  await get("string");
  for (let i = 0; i < 200 && !completions.some((c) => c.identifier === "GET /body"); i++) await Bun.sleep(5);
  const c = completions.find((x) => x.identifier === "GET /body")!;
  expect(JSON.stringify(c.logLines)).toContain("Large response returned from an HTTP action (actual: 5 bytes");
});
