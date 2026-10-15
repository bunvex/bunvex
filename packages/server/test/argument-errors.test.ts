// Argument and result validation errors as Convex renders them (STUDY-67 H6): a message alone, no `Uncaught`,
// no frames; Convex's messages for arguments that are not one object. The expected messages are what
// Convex's local backend answered (STUDY-67 §5).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add as add_, syncUrl, v1Client } from "./v1-client.ts";

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
    // Convex hands an unvalidated handler whatever came, which the types do not allow for.
    untyped: query((async (_ctx: unknown, args: unknown) => ({
      got: args === undefined ? "undefined" : args,
    })) as never),
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

test("a system function checks its own arguments, inside it: `Uncaught Error: <check>`, no frames", async () => {
  // Convex does not analyze its system modules: each checks its arguments in its handler and throws an `Error`
  // (system-udfs `withArgsValidated`). The expected messages are what Convex's local backend answered.
  const SECRET = "ab".repeat(32);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "sysargs", instanceSecret: SECRET },
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    sitePort: null,
    redactLogsToClient: false,
  });
  stops.push(s.stop);
  const key = issueAdminKey({ instanceName: "sysargs", cipherKey: adminKeyCipherKey(SECRET) });
  const call = async (path: string, args: unknown) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bunvex ${key}` },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return ((await r.json()) as { errorMessage?: string }).errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "");
  };
  const uncaught = (check: string) => `Server Error\nUncaught Error: ${check}\n\n`;
  expect(await call("_system/frontend/listCronJobs", { extra: 1 })).toBe(
    uncaught(
      "Object contains extra field `extra` that is not in the validator.\n\nObject: {extra: 1.0}\nValidator: v.object({componentId: v.optional(v.union(v.string(), v.null()))})",
    ),
  );
  expect(await call("_system/frontend/listCronJobs", [1])).toBe(
    uncaught("Expected to receive an object as the function's argument. Instead received: 1.0"),
  );
  expect(await call("_system/frontend/paginatedScheduledJobs", {})).toBe(
    uncaught(
      "Object is missing the required field `paginationOpts`. Consider wrapping the field validator in `v.optional(...)` if this is expected.\n\nObject: {}\nValidator: v.object({componentId: v.optional(v.union(v.string(), v.null())), paginationOpts: v.object({cursor: v.union(v.string(), v.null()), endCursor: v.optional(v.union(v.string(), v.null())), id: v.optional(v.float64()), maximumBytesRead: v.optional(v.float64()), maximumRowsRead: v.optional(v.float64()), numItems: v.float64()}), udfPath: v.optional(v.string())})",
    ),
  );
});

test("a system function reads its own arguments: what Convex's backend parse refuses is its error (STUDY-161 §6)", async () => {
  // Convex leaves a `_system/` path's arguments as JSON; the system function's wrapper reads them with the JS
  // values library, after the access check. The expected messages are what Convex's local backend answered
  // (without its `at map [as map] (<anonymous>)` frames).
  const SECRET = "cd".repeat(32);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "sysargs", instanceSecret: SECRET },
  ).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    sitePort: null,
    redactLogsToClient: false,
  });
  stops.push(s.stop);
  const key = issueAdminKey({ instanceName: "sysargs", cipherKey: adminKeyCipherKey(SECRET) });
  const call = async (kind: "query" | "mutation", path: string, args: unknown, admin = true) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(admin && { authorization: `Bunvex ${key}` }) },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = (await r.json()) as { status: string; errorMessage?: string };
    return body.status === "success" ? "ok" : body.errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "");
  };
  const uncaught = (m: string) => `Server Error\nUncaught Error: ${m}\n`;
  const add = (documents: unknown) => call("mutation", "_system/frontend/addDocument", { table: "items", documents });
  const mapping = (args: unknown) => call("query", "_system/frontend/getTableMapping", args);
  const deep = (n: number): unknown => (n === 0 ? 1 : { a: deep(n - 1) });

  expect(await add([{ $x: 1 }])).toBe(uncaught("Field name $x starts with a '$', which is reserved."));
  expect(await mapping({ x: { a: { $x: 1 } } })).toBe(uncaught("Field name $x starts with a '$', which is reserved."));
  expect(await mapping([{ $x: 1 }, { y: 1 }])).toBe(uncaught("Field name $x starts with a '$', which is reserved."));
  expect(await add([{ "a\u0001": 1 }])).toBe(
    uncaught(
      "Field name a\u0001 has invalid character '\u0001': Field names can only contain non-control ASCII characters",
    ),
  );
  expect(await add([{ $integer: "zz" }])).toBe(uncaught("Invalid string. Length must be a multiple of 4"));
  expect(await mapping({ x: { $integer: 1 } })).toBe(uncaught("Malformed $integer field on [object Object]"));
  expect(await mapping({ x: { $bytes: 1 } })).toBe(uncaught("Malformed $bytes field on [object Object]"));
  expect(await mapping({ x: { $float: "AQI=" } })).toBe(uncaught("Received 2 bytes, expected 8 for $float"));
  expect(await mapping({ x: { $commitTs: 1 } })).toBe(uncaught("Malformed $commitTs field on [object Object]"));
  expect(await mapping({ x: { $set: [] } })).toBe(
    uncaught("Received a Set which is no longer supported as a bunvex type."),
  );
  // read, then refused by the function's own check (the placeholder Convex reads `$commitTs: null` as)
  expect(await mapping({ x: { $commitTs: null } })).toStartWith(
    "Server Error\nUncaught Error: Object contains extra field `x` that is not in the validator.",
  );
  // the access check first: anyone but an admin is refused before the arguments are read
  const denied = "Server Error\nYou don't have permission to perform this operation.\n";
  expect(await call("mutation", "_system/frontend/addDocument", { documents: [{ $x: 1 }] }, false)).toBe(denied);
  expect(await call("query", "_system/frontend/getTableMapping", { $x: 1 }, false)).toBe(denied);
  // past 64 levels the backend's parse no longer speaks: the function's `validateArgs` does; at 64, the validator
  expect(await mapping({ x: deep(64) })).toBe(
    uncaught("Invalid arguments: Value is too nested (nested 65 levels deep > maximum nesting 64)"),
  );
  expect(await mapping({ x: deep(63) })).toBe(
    uncaught("Value is too nested (nested 65 levels deep > maximum nesting 64)"),
  );
  expect(await add([deep(62)])).toBe(uncaught("Value is too nested (nested 65 levels deep > maximum nesting 64)"));
  expect(await mapping({ x: deep(62) })).toStartWith(
    "Server Error\nUncaught Error: Object contains extra field `x` that is not in the validator.",
  );
  expect(await add([{ ok: 1 }])).toBe("ok");

  // the same over the sync protocol, as an admin
  const c = await v1Client(syncUrl(s.server!.port));
  stops.push(() => c.ws.close());
  c.send({ type: "Authenticate", tokenType: "Admin", value: key, baseVersion: 0 });
  c.mutate(1, "_system/frontend/addDocument", { table: "items", documents: [{ $x: 1 }] });
  const r = await c.until(() => c.responses()[0]);
  expect(r.success).toBe(false);
  const noId = (m: string) => m.replace(/^\[Request ID: [0-9a-f]+\] /, "");
  expect(noId((r as { result: string }).result)).toBe(uncaught("Field name $x starts with a '$', which is reserved."));
  c.modify([add_(0, "_system/frontend/getTableMapping", { x: { $integer: 1 } })]);
  const t = await c.until(() => c.transitions().find((x) => x.modifications.some((m) => m.type === "QueryFailed")));
  const failed = t.modifications.find((m) => m.type === "QueryFailed") as { errorMessage: string };
  expect(noId(failed.errorMessage)).toBe(uncaught("Malformed $integer field on [object Object]"));
});
