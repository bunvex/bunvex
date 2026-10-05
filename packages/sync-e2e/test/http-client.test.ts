// The HTTP client against a real bunvex server (STUDY-26 §9), and the official one as the oracle.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexHttpClient, v1 } from "@bunvex/client";
import { BunvexError } from "@bunvex/values";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as convexApi } from "convex/server";
import { ConvexError } from "convex/values";
import { ADMIN_KEY, renameFormat, startServer, until } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const h = await startServer();
  cleanup.push(h.stop);
  const lines: unknown[][] = [];
  const logger = { log: (...a: unknown[]) => lines.push(a), warn: () => {}, error: () => {}, logVerbose: () => {} };
  return { h, lines, http: new BunvexHttpClient(h.url, { logger }) };
}

describe("BunvexHttpClient", () => {
  test("query, mutation and action, with int64 values", async () => {
    const { http } = await setup();
    expect(await http.mutation(api.messages.send, { body: "a" })).toBe("A");
    expect(await http.query(api.messages.list)).toEqual(["a"]);
    expect(await http.action(api.messages.echo, { x: { n: 5n } })).toEqual({ n: 5n });
  });

  test("a function error is a BunvexError with the server's message and data", async () => {
    const { http } = await setup();
    const e = (await http.mutation(api.messages.fail, {}).catch((x) => x)) as BunvexError<{ code: string; n: bigint }>;
    expect(e).toBeInstanceOf(BunvexError);
    expect(e.data).toEqual({ code: "nope", n: 7n });
    expect(e.message).toStartWith("[Request ID: ");
    await expect(http.query(api.messages.nope)).rejects.toThrow("Could not find public function for 'messages:nope'.");
  });

  test("a path that does not parse is the server's 400, its code and reason as given (DV-312)", async () => {
    const { http } = await setup();
    const e = (await http.query("messages:li-st").catch((x) => x)) as Error;
    expect(e).not.toBeInstanceOf(BunvexError);
    expect(JSON.parse(e.message)).toEqual({
      code: "BadBunvexFunctionIdentifier",
      message:
        "messages:li-st is not a valid path to a bunvex function. Identifier li-st has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    });
  });

  test("mutations run one at a time, in order; skipQueue does not wait", async () => {
    const { h, http } = await setup();
    const open = h.gate("first");
    const first = http.mutation(api.messages.send, { body: "first" });
    const second = http.mutation(api.messages.send, { body: "second" });
    await until(() => h.runs.includes("first"), "first started");
    await Bun.sleep(30);
    expect(h.runs).toEqual(["first"]); // the second waits for the first
    expect(await http.mutation(api.messages.send, { body: "skip" }, { skipQueue: true })).toBe("SKIP");
    open();
    await Promise.all([first, second]);
    expect(h.runs).toEqual(["first", "skip", "second"]);
  });

  test("consistentQuery reads every query at the first one's timestamp", async () => {
    const { http } = await setup();
    await http.mutation(api.messages.send, { body: "before" });
    expect(await http.consistentQuery(api.messages.count)).toBe(1);
    await http.mutation(api.messages.send, { body: "after" });
    expect(await http.consistentQuery(api.messages.count)).toBe(1);
    expect(await http.consistentQuery(api.messages.list)).toEqual(["before"]);
    expect(await http.query(api.messages.count)).toBe(2);
  });

  test("function(): any kind by an admin, internal ones included, arguments as the object itself", async () => {
    const { h, http } = await setup();
    const sent: unknown[] = [];
    const spy = new BunvexHttpClient(h.url, {
      logger: false,
      fetch: ((url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(init.body as string) });
        return fetch(url, init);
      }) as typeof fetch,
    });
    spy.setAdminAuth(ADMIN_KEY);
    expect(await spy.function(api.messages.send, undefined, { body: "a" })).toBe("A");
    await spy.function("messages:send", "", { body: "b" });
    expect(await spy.function(api.messages.list)).toEqual(["a", "b"]);
    expect(await spy.function(api.messages.echo, undefined, { x: 5n })).toBe(5n);
    expect(await spy.function(api.messages.clear, undefined, { keep: "b" })).toBe("b");
    expect(await http.query(api.messages.list)).toEqual(["b"]);
    expect(sent[0]).toEqual({
      url: `${h.url}/api/function`,
      body: { path: "messages:send", args: { body: "a" }, format: "encoded_json" },
    });
    expect((sent[1] as { body: unknown }).body).toMatchObject({ componentPath: "", path: "messages:send" });
    const e = (await spy.function(api.messages.fail).catch((x) => x)) as BunvexError<{ code: string }>;
    expect(e).toBeInstanceOf(BunvexError);
    expect(e.data).toMatchObject({ code: "nope" });
  });

  test("function() without an admin key: the server's 401 BadDeployKey", async () => {
    const { http } = await setup();
    const e = (await http.function(api.messages.list).catch((x) => x)) as Error;
    expect(JSON.parse(e.message)).toMatchObject({ code: "BadDeployKey" });
    http.setAuth("not-a-user-token-the-server-accepts");
    await expect(http.function(api.messages.list)).rejects.toThrow();
  });

  test("the function's log lines reach the logger; a ts from the future is refused", async () => {
    const { h, lines, http } = await setup();
    await http.mutation(api.messages.logged, {});
    expect(lines.flat().join(" ")).toContain("[BUNVEX M(messages:logged)] [LOG]");
    const r = await fetch(`${h.url}/api/query_at_ts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "messages:count", args: [{}], ts: v1.encodeU64(2n ** 62n) }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: "InvalidTimestamp" });
  });
});

describe("the official ConvexHttpClient against bunvex", () => {
  test("query, mutation, consistentQuery and errors with data", async () => {
    const { h } = await setup();
    const c = new ConvexHttpClient(h.url, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: renameFormat(globalThis.fetch),
    });
    expect(await c.mutation(convexApi.messages.send, { body: "x" })).toBe("X");
    expect(await c.query(convexApi.messages.list, {})).toEqual(["x"]);
    expect(await c.consistentQuery(convexApi.messages.count, {})).toBe(1);
    await c.mutation(convexApi.messages.send, { body: "y" });
    expect(await c.consistentQuery(convexApi.messages.count, {})).toBe(1);
    const e = (await c.mutation(convexApi.messages.fail, {}).catch((x) => x)) as ConvexError<{
      code: string;
      n: bigint;
    }>;
    expect(e).toBeInstanceOf(ConvexError);
    expect(e.data).toEqual({ code: "nope", n: 7n });
  });

  test("function(), as bunvex's: the same request and answers", async () => {
    const { h } = await setup();
    // Its admin scheme is `Convex <key>`, bunvex's `Bunvex <key>` (DV-97): renamed as the format is.
    const adminScheme = ((url: string, init: RequestInit) => {
      const headers = { ...(init.headers as Record<string, string>) };
      headers.Authorization = headers.Authorization!.replace(/^Convex /, "Bunvex ");
      return fetch(url, { ...init, headers });
    }) as typeof fetch;
    // Both are `@internal`, so not in its published types.
    const c = new ConvexHttpClient(h.url, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: renameFormat(adminScheme),
    }) as unknown as {
      setAdminAuth(key: string): void;
      function(f: unknown, componentPath?: string, args?: unknown): Promise<unknown>;
    };
    c.setAdminAuth(ADMIN_KEY);
    expect(await c.function(convexApi.messages.send, undefined, { body: "x" })).toBe("X");
    expect(await c.function(convexApi.messages.clear, undefined, { keep: "x" })).toBe("x");
    expect(await c.function("messages:list")).toEqual(["x"]);
  });

  test("as it is, it asks for Convex's format name, which bunvex refuses (DV-307)", async () => {
    const { h } = await setup();
    const c = new ConvexHttpClient(h.url, { skipConvexDeploymentUrlCheck: true, logger: false });
    await expect(c.query(convexApi.messages.list, {})).rejects.toThrow(
      "format param must be one of [`json`]. Got convex_encoded_json",
    );
  });
});
