// A null body status (204, 205, 304) in functions, as Convex's runtime since a74b7c3
// (npm-packages/udf-runtime/src/23_response.ts, 26_fetch.ts; STUDY-186 A5): a `Response` built with one and a body
// throws a `TypeError`; a fetched response with one, or answering a `HEAD`, has no body. The oracle case:
// packages/differential `null-body-status.test.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import { isolateFetch } from "../src/action-fetch.ts";
import { contextGlobals } from "../src/code-version.ts";
import { SpecResponse } from "../src/web-response.ts";

const NULL_BODY = "Response with null body status cannot have body";

const outcome = (f: () => Response) => {
  try {
    const r = f();
    return `ok ${r.status}`;
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
};

describe("a null body status", () => {
  test("with a body, the Response throws a TypeError, whatever the body", () => {
    const bodies: unknown[] = [
      "x",
      "",
      0,
      new Uint8Array(1),
      new ArrayBuffer(0),
      new Blob(["x"]),
      new URLSearchParams("a=1"),
      new FormData(),
      new ReadableStream(),
    ];
    for (const status of [204, 205, 304])
      for (const body of bodies) {
        expect({ status, body, out: outcome(() => new SpecResponse(body, { status })) }).toEqual({
          status,
          body,
          out: `TypeError: ${NULL_BODY}`,
        });
      }
    expect(outcome(() => SpecResponse.json({ a: 1 }, { status: 204 }))).toBe(`TypeError: ${NULL_BODY}`);
  });

  test("without one, it builds; other statuses take a body; a status out of range fails first", () => {
    for (const status of [204, 205, 304]) {
      expect(outcome(() => new SpecResponse(null, { status }))).toBe(`ok ${status}`);
      expect(outcome(() => new SpecResponse(undefined, { status }))).toBe(`ok ${status}`);
    }
    for (const status of [200, 201, 206, 303, 404, 500])
      expect(outcome(() => new SpecResponse("x", { status }))).toBe(`ok ${status}`);
    expect(outcome(() => new SpecResponse("x", { status: 100 }))).toMatch(/^RangeError: /);
  });

  test("a function context's Response is this one; a \"use node\" action keeps the host's", () => {
    const iso = contextGlobals(false, {}).Response as typeof Response;
    expect(outcome(() => new iso("x", { status: 204 }))).toBe(`TypeError: ${NULL_BODY}`);
    const node = contextGlobals(true, {}).Response as typeof Response;
    expect(node).toBe(globalThis.Response);
  });
});

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

describe("a fetched response", () => {
  test("with a null body status, or answering HEAD, has no body, even when the server sent one", async () => {
    // A raw server, which sends a body whatever the status (Bun's own would not).
    const srv = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(s, d) {
          const status = /\/(\d{3})/.exec(d.toString())?.[1] ?? "200";
          s.write(`HTTP/1.1 ${status} X\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello`);
          s.end();
        },
      },
    });
    servers.push(srv);
    const f = isolateFetch(fetch);
    const seen = async (path: string, method = "GET") => {
      const r = await f(`http://127.0.0.1:${srv.port}${path}`, { method });
      return [r.status, r.body === null, await r.text()];
    };
    expect(await seen("/204")).toEqual([204, true, ""]);
    expect(await seen("/205")).toEqual([205, true, ""]);
    expect(await seen("/304")).toEqual([304, true, ""]);
    expect(await seen("/200", "HEAD")).toEqual([200, true, ""]);
  });
});
