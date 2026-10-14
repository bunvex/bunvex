// The headers an HTTP action's response gets from its body (STUDY-31 §8): `GET /body?kind=<kind>` answers a
// `Response` of the body `kind` names; `-explicit` adds an explicit Content-Type, `-length` an explicit
// Content-Length. `/inside` answers what the handler itself sees of the Responses it builds.
import { httpActionGeneric, httpRouter } from "convex/server";

const bytes = () => new TextEncoder().encode("bytes");
const bodies: Record<string, () => unknown> = {
  string: () => "hello",
  "empty-string": () => "",
  number: () => 42,
  search: () => new URLSearchParams({ a: "1", b: "x y" }),
  form: () => {
    const f = new FormData();
    f.append("a", "1");
    f.append("file", new Blob(["data"], { type: "text/csv" }), "f.csv");
    return f;
  },
  "blob-typed": () => new Blob(["<p>hi</p>"], { type: "Text/HTML" }),
  "blob-untyped": () => new Blob(["hi"]),
  arraybuffer: () => bytes().buffer,
  uint8: bytes,
  dataview: () => new DataView(bytes().buffer),
  big: () => "x".repeat(1 << 20),
  "big-bytes": () => new Uint8Array(1 << 20),
  stream: () =>
    new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("one,"));
        await new Promise((r) => setTimeout(r, 30));
        c.enqueue(new TextEncoder().encode("two"));
        c.close();
      },
    }),
  "short-stream": () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("short"));
        c.close();
      },
    }),
  null: () => null,
  undefined: () => undefined,
};

const http = httpRouter();
http.route({
  path: "/body",
  method: "GET",
  handler: httpActionGeneric(async (_ctx, req) => {
    const kind = new URL(req.url).searchParams.get("kind") ?? "";
    const base = kind.replace(/-explicit$|-length$/, "");
    const headers: Record<string, string> = {};
    if (kind.endsWith("-explicit")) headers["content-type"] = "application/x-explicit";
    if (kind.endsWith("-length")) headers["content-length"] = "5";
    if (base === "json") return Response.json({ a: 1 }, { headers });
    return new Response(bodies[base]!() as BodyInit, { headers });
  }),
});
http.route({
  path: "/inside",
  method: "GET",
  handler: httpActionGeneric(async () =>
    Response.json([
      new Response("x").headers.get("content-type"),
      new Response(new URLSearchParams("a=1")).headers.get("content-type"),
      new Response(new Blob(["x"], { type: "text/plain" })).headers.get("content-type"),
      Response.json(1, { headers: { "content-type": "text/x" } }).headers.get("content-type"),
      new Response("x", { headers: { "content-type": "" } }).headers.get("content-type"),
      new Response(new Uint8Array(1)).headers.get("content-type"),
      new Response("x").headers.get("content-length"),
      /^multipart\/form-data; boundary=/.test(new Response(new FormData()).headers.get("content-type") ?? ""),
      await new Response(7 as unknown as BodyInit).text(),
    ]),
  ),
});
export default http;
