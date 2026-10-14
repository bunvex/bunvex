// The headers an HTTP action's response gets from its body (STUDY-31 §8), on Convex's backend (the oracle) and on
// bunvex's: the app of `http-headers-app/` answers a Response of every body type — a string, an empty string, a
// number, a URLSearchParams, a FormData, a typed and an untyped Blob, `Response.json`, an ArrayBuffer, a Uint8Array,
// a DataView, a 1 MiB string, a stream, no body — with and without an explicit Content-Type or Content-Length, by
// GET and by HEAD, read off the wire. Compared: the status, Content-Type, Content-Length, the body. A FormData's
// boundary is random on both (only its form is compared) and so is its encoding (the parts read back are). The
// framing of a stream and of untyped bytes is the decided-or-pending difference (DV-483), asserted per backend.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-content-type: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-headers-app");

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

type Answer = { status: number; headers: Record<string, string>; body: Buffer };

/** One HTTP/1.1 request on its own connection, read raw: the head as sent, the body de-chunked. */
function raw(b: Backend, path: string, method = "GET"): Promise<Answer> {
  const site = new URL(b.url.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`));
  return new Promise((done, fail) => {
    const parts: Buffer[] = [];
    const s = connect(Number(site.port), site.hostname, () =>
      s.write(`${method} ${path} HTTP/1.1\r\nHost: ${site.host}\r\nConnection: close\r\n\r\n`),
    );
    s.on("data", (d: Buffer) => parts.push(d));
    s.on("error", fail);
    s.on("close", () => {
      const all = Buffer.concat(parts);
      const end = all.indexOf("\r\n\r\n");
      const [statusLine, ...lines] = all.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const i = l.indexOf(":");
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      let body = all.subarray(end + 4);
      if (headers["transfer-encoding"] === "chunked") {
        const out: Buffer[] = [];
        for (let at = 0; ; ) {
          const eol = body.indexOf("\r\n", at);
          const n = Number.parseInt(body.subarray(at, eol).toString(), 16);
          if (!n) break;
          out.push(body.subarray(eol + 2, eol + 2 + n));
          at = eol + 2 + n + 2;
        }
        body = Buffer.concat(out);
      }
      done({ status: Number(statusLine!.split(" ")[1]), headers, body });
    });
  });
}

/** What is compared: the status, the type (a boundary's value left out), the length, the body. */
async function seen(b: Backend, kind: string, method = "GET") {
  const r = await raw(b, `/body?kind=${kind}`, method);
  const type = r.headers["content-type"];
  const boundary = type?.match(/boundary=(.+)$/)?.[1];
  return {
    status: r.status,
    type: boundary ? type!.replace(boundary, "<boundary>") : type,
    length: r.headers["content-length"],
    // A multipart body by its parts, as the client reads them.
    body:
      boundary && method !== "HEAD"
        ? [...(await new Response(r.body, { headers: { "content-type": type! } }).formData())].map(([k, v]) =>
            typeof v === "string" ? [k, v] : [k, v.name, v.type, v.size],
          )
        : r.body.length > 64
          ? `${r.body.length} bytes`
          : r.body.toString("latin1"),
    framing: r.headers["transfer-encoding"] ?? (r.headers["content-length"] !== undefined ? "length" : "close"),
    multipartLengthRight:
      boundary && method !== "HEAD" ? r.headers["content-length"] === String(r.body.length) : undefined,
  };
}

async function same(kind: string, method = "GET") {
  const c = await seen(convex, kind, method);
  const b = await seen(bunvex, kind, method);
  // A multipart body's length is its own encoding's on each backend (checked right on both); under an explicit type
  // its parts are not read back, so its bytes are not compared either.
  const own = (x: typeof c) =>
    x.type?.startsWith("multipart/")
      ? { ...x, length: undefined }
      : kind === "form-explicit"
        ? { ...x, length: undefined, body: undefined }
        : x;
  expect(own(b)).toEqual(own(c));
  return c;
}

const KNOWN_LENGTH = [
  "string",
  "empty-string",
  "number",
  "search",
  "form",
  "blob-typed",
  "blob-untyped",
  "json",
  "arraybuffer",
  "uint8",
  "dataview",
  "big",
];

describe.skipIf(!ready)("an HTTP action response's implicit headers, against Convex's backend", () => {
  test("every body of known length: its type and its length, by GET and by HEAD", async () => {
    const types: Record<string, string | undefined> = {};
    for (const kind of KNOWN_LENGTH) {
      const c = await same(kind);
      types[kind] = c.type;
      expect(c.framing).toBe("length");
      const head = await same(kind, "HEAD");
      expect([head.type, head.length, head.body]).toEqual([c.type, c.length, ""]);
    }
    expect(types).toEqual({
      string: "text/plain;charset=UTF-8",
      "empty-string": "text/plain;charset=UTF-8",
      number: "text/plain;charset=UTF-8",
      search: "application/x-www-form-urlencoded;charset=UTF-8",
      form: "multipart/form-data; boundary=<boundary>",
      "blob-typed": "text/html",
      "blob-untyped": undefined,
      json: "application/json",
      arraybuffer: undefined,
      uint8: undefined,
      dataview: undefined,
      big: "text/plain;charset=UTF-8",
    });
  });

  test("an explicit Content-Type wins over the body's, but not over Response.json's; an explicit length is kept", async () => {
    for (const kind of ["string", "search", "form", "blob-typed", "uint8"])
      expect((await same(`${kind}-explicit`)).type).toBe("application/x-explicit");
    expect((await same("json-explicit")).type).toBe("application/json");
    expect(await same("string-length")).toMatchObject({ type: "text/plain;charset=UTF-8", length: "5", body: "hello" });
  });

  test("a stream and no body have no type and no length of their own", async () => {
    for (const kind of ["stream", "short-stream", "null", "undefined"]) {
      const c = await seen(convex, kind);
      const b = await seen(bunvex, kind);
      expect([b.status, b.type, b.body]).toEqual([c.status, c.type, c.body]);
      expect(c.type).toBeUndefined();
      // HEAD: no type, a length of 0 on both.
      const ch = await seen(convex, kind, "HEAD");
      expect(await seen(bunvex, kind, "HEAD")).toEqual(ch);
    }
  });

  test("the framing Bun picks (DV-483): Convex streams these chunked, bunvex gives some a length", async () => {
    const framing = async (b: Backend) => {
      const out: Record<string, string> = {};
      for (const kind of ["stream", "short-stream", "null", "big-bytes"]) {
        const r = await seen(b, kind);
        out[kind] = r.framing + (r.length !== undefined ? ` ${r.length}` : "");
      }
      return out;
    };
    expect(await framing(convex)).toEqual({
      stream: "chunked",
      "short-stream": "chunked",
      null: "chunked",
      "big-bytes": `length ${1 << 20}`,
    });
    expect(await framing(bunvex)).toEqual({
      stream: "chunked",
      "short-stream": "length 5",
      null: "length 0",
      "big-bytes": "chunked",
    });
    // The bytes are the same.
    expect((await seen(bunvex, "big-bytes")).body).toBe((await seen(convex, "big-bytes")).body);
  });

  test("the handler sees the same headers on the Responses it builds", async () => {
    const c = await raw(convex, "/inside");
    const b = await raw(bunvex, "/inside");
    expect(JSON.parse(b.body.toString())).toEqual(JSON.parse(c.body.toString()));
    expect(JSON.parse(c.body.toString())).toEqual([
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded;charset=UTF-8",
      "text/plain",
      "application/json",
      "",
      null,
      null,
      true,
      "7",
    ]);
  });
});
