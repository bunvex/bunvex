// Argument and result validation errors as Convex renders them (STUDY-67 H6): a message alone, no `Uncaught`,
// no frames; Convex's messages for arguments that are not one object. The expected messages are what
// Convex's local backend answered (STUDY-67 §5).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    typed: query({ args: { x: v.number() }, handler: async (_ctx, { x }) => x }),
    untyped: query(async (_ctx, args: unknown) => ({ got: args === undefined ? "undefined" : args })),
    badReturn: query({ args: {}, returns: v.string(), handler: async () => 5 as never }),
    actRunsBad: action({
      args: {},
      handler: async (ctx): Promise<string> => {
        try {
          await ctx.runQuery("m:typed" as never, { x: "s" } as never);
          return "no";
        } catch (e) {
          return (e as Error).message;
        }
      },
    }),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const call = async (route: string, path: string, args: unknown) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
    return body.status === "success"
      ? { value: body.value }
      : { error: body.errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "") };
  };
  return { call };
}

const args = (check: string) => ({ error: `Server Error\nArgumentValidationError: ${check}\n\n` });

test("a validator miss: the message alone, ending with two newlines, as Convex's", async () => {
  const { call } = await setup();
  expect(await call("query", "m:typed", { x: "s" })).toEqual(
    args('Value does not match validator.\nPath: .x\nValue: "s"\nValidator: v.float64()'),
  );
});

test("a validated function takes one object: Convex's messages otherwise", async () => {
  const { call } = await setup();
  expect(await call("query", "m:typed", 5)).toEqual(
    args("Expected to receive an object as the function's argument. Instead received: 5.0"),
  );
  expect(await call("query", "m:typed", [5])).toEqual(
    args("Expected to receive an object as the function's argument. Instead received: 5.0"),
  );
  expect(await call("query", "m:typed", null)).toEqual(
    args("Expected to receive an object as the function's argument. Instead received: null"),
  );
  expect(await call("query", "m:typed", [])).toEqual(
    args("Expected to receive a single object as the function's argument. Instead received 0 arguments: []"),
  );
  expect(await call("query", "m:typed", [{}, {}])).toEqual(
    args("Expected to receive a single object as the function's argument. Instead received 2 arguments: [{}, {}]"),
  );
  // The path resolves first: an unknown function is not an argument error.
  expect(await call("query", "m:nope", [{}, {}])).toEqual({
    error: "Server Error\nCould not find public function for 'm:nope'.\n",
  });
});

test("a function without a validator gets what came, as Convex's handler does", async () => {
  const { call } = await setup();
  expect(await call("query", "m:untyped", 5)).toEqual({ value: { got: 5 } });
  expect(await call("query", "m:untyped", null)).toEqual({ value: { got: null } });
  expect(await call("query", "m:untyped", [{ a: 1 }, { b: 2 }])).toEqual({ value: { got: { a: 1 } } });
});

test("a result that misses `returns`: the message alone, one newline", async () => {
  const { call } = await setup();
  expect(await call("query", "m:badReturn", {})).toEqual({
    error:
      "Server Error\nReturnsValidationError: Value does not match validator.\n\nValue: 5.0\nValidator: v.string()\n",
  });
});

test("a function that calls another sees the same message", async () => {
  const { call } = await setup();
  expect(await call("action", "m:actRunsBad", {})).toEqual({
    value: 'ArgumentValidationError: Value does not match validator.\nPath: .x\nValue: "s"\nValidator: v.float64()\n\n',
  });
});
