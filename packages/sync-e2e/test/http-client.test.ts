// The HTTP client against a real bunvex server (STUDY-26 §9), and the official one as the oracle.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexHttpClient, v1 } from "@bunvex/client";
import { BunvexError } from "@bunvex/values";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as convexApi } from "convex/server";
import { ConvexError } from "convex/values";
import { startServer, until } from "./harness.ts";

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
    const c = new ConvexHttpClient(h.url, { skipConvexDeploymentUrlCheck: true, logger: false });
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
});
