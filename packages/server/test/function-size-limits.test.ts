// Function result and argument size limits (STUDY-64 §1.7), as Convex's `FUNCTION_MAX_RESULT_SIZE` and
// `FUNCTION_MAX_ARGS_SIZE`: 16 MiB each, a function error with Convex's message, the size checked before the
// validators, at any nesting depth.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import {
  action,
  FUNCTION_MAX_ARGS_SIZE,
  FUNCTION_MAX_RESULT_SIZE,
  Functions,
  internalQuery,
  mutation,
  query,
} from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A string whose value size (UTF-8 length + 2, as Convex's) is exactly `n` bytes. */
const ofSize = (n: number) => "x".repeat(n - 2);

async function setup(limits?: { result?: number; args?: number }) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    big: query((_, { n }: { n: number }) => ofSize(n)),
    bigInternal: internalQuery((_, { n }: { n: number }) => ofSize(n)),
    writeBig: mutation(async ({ db }, { n }: { n: number }) => {
      await db.insert("items", { n });
      return ofSize(n);
    }),
    actBig: action((_, { n }: { n: number }) => ofSize(n)),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    nested: query(async ({ runQuery }, { n }: { n: number }) => {
      try {
        return await runQuery("m:bigInternal", { n });
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    }),
    typed: query({ args: { s: v.number() }, returns: v.number(), handler: () => "not a number" as never }),
  });
  if (limits?.result !== undefined) fns.maxResultSize = limits.result;
  if (limits?.args !== undefined) fns.maxArgsSize = limits.args;
  return { engine, fns };
}

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};

test("the defaults are Convex's: 16 MiB each", () => {
  expect(FUNCTION_MAX_RESULT_SIZE).toBe(16 * 1024 * 1024);
  expect(FUNCTION_MAX_ARGS_SIZE).toBe(16 * 1024 * 1024);
});

test("a query returning 16 MiB + 1 byte fails with Convex's message; 16 MiB passes", async () => {
  const { fns } = await setup();
  expect(((await fns.runQuery("m:big", { n: FUNCTION_MAX_RESULT_SIZE })) as string).length).toBe(
    FUNCTION_MAX_RESULT_SIZE - 2,
  );
  const e = await fail(fns.runQuery("m:big", { n: FUNCTION_MAX_RESULT_SIZE + 1 }));
  expect(e.message).toBe("Function m.js:big return value is too large (actual: 16 MiB, limit: 16 MiB)");
});

test("a mutation's result over the limit fails and writes nothing", async () => {
  const { fns } = await setup({ result: 1000 });
  const e = await fail(fns.runMutation("m:writeBig", { n: 1500 }));
  expect(e.message).toBe("Function m.js:writeBig return value is too large (actual: 1.46 KiB, limit: 1000 B)");
  expect(await fns.runQuery("m:count", {})).toBe(0);
  await fns.runMutation("m:writeBig", { n: 1000 });
  expect(await fns.runQuery("m:count", {})).toBe(1);
});

test("an action's result over the limit fails", async () => {
  const { fns } = await setup({ result: 1000 });
  const e = await fail(fns.runAction("m:actBig", { n: 1001 }));
  expect(e.message).toBe("Function m.js:actBig return value is too large (actual: 1001 B, limit: 1000 B)");
});

test("a nested call's result over the limit is the caller's catchable error", async () => {
  const { fns } = await setup({ result: 1000 });
  expect(await fns.runQuery("m:nested", { n: 1001 })).toBe(
    "caught: Function m.js:bigInternal return value is too large (actual: 1001 B, limit: 1000 B)",
  );
});

test("the size is checked before the returns validator, as Convex", async () => {
  const { fns } = await setup({ result: 5 });
  // "not a number" is 14 bytes: over the limit, and not a number either.
  const e = await fail(fns.runQuery("m:typed", { s: 1 }));
  expect(e.message).toBe("Function m.js:typed return value is too large (actual: 14 B, limit: 5 B)");
});

test("arguments over the limit are refused before the args validator", async () => {
  const { fns } = await setup({ args: 100 });
  // [{s: "…"}]: 2 (array) + 2 (object) + 1 + 1 ("s" and its separator) + the string.
  const e = await fail(fns.runQuery("m:typed", { s: ofSize(95) }));
  expect(e.message).toBe("Arguments for m.js:typed are too large (actual: 101 B, limit: 100 B)");
  // At the limit: the validator speaks.
  const v = await fail(fns.runQuery("m:typed", { s: ofSize(94) }));
  expect(v.message).toContain("ArgumentValidationError");
});

test("over HTTP and the sync protocol it is a function error, not a system error", async () => {
  const { engine, fns } = await setup({ result: 1000 });
  const { server, stop } = createServer({ engine, functions: fns, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const r = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:big", args: { n: 1001 } }),
  });
  expect([200, 560]).toContain(r.status); // a function error (not 500)
  const body = (await r.json()) as { status: string; errorMessage: string };
  expect(body.status).toBe("error");
  expect(body.errorMessage).toContain("Function m.js:big return value is too large (actual: 1001 B, limit: 1000 B)");

  const c = await v1Client(syncUrl(server.port));
  c.modify([add(1, "m:big", { n: 1001 })]);
  const t = await c.transition(0);
  expect(t.modifications[0]).toMatchObject({ type: "QueryFailed", queryId: 1 });
  expect((t.modifications[0] as { errorMessage: string }).errorMessage).toContain("return value is too large");
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
});

test("a WebSocket frame up to 16 MiB is accepted (Convex's frame cap; it was 8 MiB)", async () => {
  const { engine, fns } = await setup();
  const { server, stop } = createServer({ engine, functions: fns, port: 0 });
  stops.push(stop);
  const c = await v1Client(syncUrl(server.port));
  // About 12 MiB of arguments: over the old 8 MiB cap, within Convex's.
  c.mutate(0, "m:writeBig", { n: 3, pad: "y".repeat(12 * 1024 * 1024) });
  const res = await c.until(() => c.responses()[0]);
  expect(res).toMatchObject({ requestId: 0, success: true });
});
