// The admin routes' client (STUDY-149 §3.3): its headers, and how a failure becomes the contract's error code.
import { describe, expect, test } from "bun:test";
import { DataSourceError } from "@bunvex/dashboard/data-source";
import { AdminHttp, codeOfStatus } from "../src/admin-http.ts";

const fetchOf = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(respond(String(input), init))) as typeof fetch;

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("AdminHttp", () => {
  test("every request carries the admin key and the dashboard's client header; a body goes as JSON", async () => {
    let seen: RequestInit | undefined;
    let where = "";
    const http = new AdminHttp({
      url: "http://127.0.0.1:3210/",
      adminKey: "local|k",
      fetch: fetchOf((url, init) => {
        where = url;
        seen = init;
        return new Response("{}");
      }),
    });
    await http.json("/api/v1/pause_deployment", { body: { a: 1 } });
    expect(where).toBe("http://127.0.0.1:3210/api/v1/pause_deployment");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers).toEqual({
      Authorization: "Bunvex local|k",
      "Bunvex-Client": "dashboard-0.0.0",
      "Content-Type": "application/json",
    });
    expect(seen?.body).toBe('{"a":1}');
  });

  test("statuses map to the contract's codes", () => {
    expect([401, 403, 404, 400, 422, 500, 503].map(codeOfStatus)).toEqual([
      "unauthorized",
      "unauthorized",
      "not_found",
      "invalid_request",
      "invalid_request",
      "unavailable",
      "unavailable",
    ]);
  });

  test("a failed response's error carries the server's message", async () => {
    const http = new AdminHttp({
      url: "http://x",
      adminKey: "k",
      fetch: fetchOf(
        () =>
          new Response(JSON.stringify({ code: "OperationNotPermitted", message: "You do not have permission" }), {
            status: 403,
          }),
      ),
    });
    const e = await failure(http.json("/stats"));
    expect(e).toBeInstanceOf(DataSourceError);
    expect([(e as DataSourceError).code, (e as DataSourceError).message]).toEqual([
      "unauthorized",
      "You do not have permission",
    ]);
  });

  test("a network error is unavailable; an abort rejects with the signal's AbortError", async () => {
    const offline = new AdminHttp({
      url: "http://x",
      adminKey: "k",
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    });
    expect(((await failure(offline.json("/stats"))) as DataSourceError).code).toBe("unavailable");
    const ac = new AbortController();
    ac.abort();
    const aborted = await failure(offline.json("/stats", { signal: ac.signal }));
    expect((aborted as Error).name).toBe("AbortError");
  });
});
