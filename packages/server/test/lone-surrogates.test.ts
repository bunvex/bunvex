// Strings with a lone surrogate through the server's paths (STUDY-135): nested calls, an action's calls and
// the scheduler fail with serde's "Received invalid json: …"; a result fails its function; a client's
// arguments are "Invalid arguments provided"; logs and messages carry U+FFFD; an application error whose
// data holds one has no data (Q2; Q1 is DV-431). The messages are the ones Convex's local backend answered
// (STUDY-135 §1.2).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { action, Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const H = "\ud800";
const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function caught(f: () => Promise<unknown>) {
  try {
    return { ok: await f() };
  } catch (e) {
    return { caught: (e as Error).message };
  }
}

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "probe", instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    echoQ: internalQuery(async (_ctx, { s }: { s: unknown }) => s),
    echoM: internalMutation(async (_ctx, { s }: { s: unknown }) => s),
    echo: query(async (_ctx, { s }: { s: unknown }) => s),
    nested: mutation(async (ctx) => ({
      q: await caught(() => ctx.runQuery("m:echoQ" as never, { s: H } as never)),
      m: await caught(() => ctx.runMutation("m:echoM" as never, { s: H } as never)),
      scheduled: await caught(() => ctx.scheduler.runAfter(0, "m:echoM" as never, { s: H } as never)),
    })),
    fromAction: action(async (ctx) => ({
      q: await caught(() => ctx.runQuery("m:echoQ" as never, { s: H } as never)),
      m: await caught(() => ctx.runMutation("m:echoM" as never, { s: H } as never)),
    })),
    ret: query(async () => H),
    retObject: mutation(async () => ({ k: "\udc00" })),
    logs: mutation(async () => {
      console.log(`log ${H} line`);
      return null;
    }),
    boom: mutation(async () => {
      throw new Error(`boom ${H}`);
    }),
    dataString: mutation(async () => {
      throw new BunvexError(H);
    }),
    dataObject: mutation(async () => {
      throw new BunvexError({ k: H });
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    jobs: query(async ({ db }) => (await db.system.query("_scheduled_functions").collect()).length),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const base = `http://127.0.0.1:${s.server!.port}`;
  const call = async (route: string, path: string, args: object = {}) => {
    const r = await fetch(`${base}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // JSON.stringify writes a lone surrogate as `\ud800`, as a client does.
      body: JSON.stringify({ path, args, format: "json" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: the answer's JSON
    const body = (await r.json()) as any;
    // The request id differs by design.
    if (typeof body.errorMessage === "string")
      body.errorMessage = body.errorMessage.replace(/^\[Request ID: [^\]]+\] /, "");
    return body;
  };
  return { call };
}

const END = (column: number) => `Received invalid json: unexpected end of hex escape at line 1 column ${column}`;

test("nested calls and the scheduler: serde's message, the column in their text", async () => {
  const { call } = await setup();
  const r = await call("mutation", "m:nested");
  // `{"udfType":"query","args":{"s":"` and `{"udfType":"mutation",…`: 39 and 42, as Convex's.
  expect(r.value.q).toEqual({ caught: END(39) });
  expect(r.value.m).toEqual({ caught: END(42) });
  // `{"name":"m:echoM","ts":<seconds>,"args":{"s":"`: the column moves with the time's digits.
  expect(r.value.scheduled.caught).toMatch(
    /^Received invalid json: unexpected end of hex escape at line 1 column \d+$/,
  );
  expect((await call("query", "m:jobs")).value).toBe(0);
});

test("an action's calls: the function's address comes first", async () => {
  const { call } = await setup();
  const r = await call("action", "m:fromAction");
  // `{"name":"m:echoQ","args":{"s":"`: 31 + the name's length (42 for Convex's probe:echoQ).
  expect(r.value).toEqual({ q: { caught: END(31 + 7) }, m: { caught: END(31 + 7) } });
});

test("a result with a lone surrogate fails its function", async () => {
  const { call } = await setup();
  expect((await call("query", "m:ret")).errorMessage).toBe(
    "Server Error\nFunction m.js:ret failed. Could not parse return value as json: unexpected end of hex escape at line 1 column 8\n",
  );
  expect((await call("mutation", "m:retObject")).errorMessage).toBe(
    "Server Error\nFunction m.js:retObject failed. Could not parse return value as json: lone leading surrogate in hex escape at line 1 column 12\n",
  );
});

test("a client's arguments with a lone surrogate: Invalid arguments provided", async () => {
  const { call } = await setup();
  expect(await call("query", "m:echo", { s: H })).toMatchObject({
    status: "error",
    errorMessage: "Server Error\nInvalid arguments provided\n",
  });
  expect((await call("query", "m:echo", { s: "\ud83d\ude00" })).value).toBe("\ud83d\ude00");
});

test("logs and messages carry U+FFFD; an application error's data with one is left out", async () => {
  const { call } = await setup();
  expect((await call("mutation", "m:logs")).logLines).toEqual(["[LOG] 'log \ufffd line'"]);
  expect((await call("mutation", "m:boom")).errorMessage).toStartWith("Server Error\nUncaught Error: boom \ufffd\n");
  // Q1 (DV-431): a function error, no data, where Convex answers an InternalServerError.
  const s = await call("mutation", "m:dataString");
  expect(s.errorMessage).toStartWith("Server Error\nUncaught BunvexError: \ufffd\n");
  expect(s.errorData).toBeUndefined();
  // Q2: the message keeps the data's JSON, the data is left out, as Convex's.
  const o = await call("mutation", "m:dataObject");
  expect(o.errorMessage).toStartWith('Server Error\nUncaught BunvexError: {"k":"\\ud800"}\n');
  expect(o.errorData).toBeUndefined();
});
