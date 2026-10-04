// Function results and errors on the wire, as Convex answers them (STUDY-20): the HTTP API's status codes
// and body shape, BunvexError data, redaction, and the log lines a call returns.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { action, type FunctionDef, Functions, mutation, query } from "../src/functions.ts";
import { formatLogLine, MAX_LOG_LINE_LENGTH } from "../src/logs.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { add, syncUrl, updated, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function serve(fns: Record<string, FunctionDef>, opts: Partial<ServerOptions> = {}) {
  const persistence = await MemoryPersistence.open(null, { durable: false });
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), persistence).init();
  const functions = new Functions(engine).register("m", fns);
  const { server, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false, ...opts });
  stops.push(stop);
  const base = `http://127.0.0.1:${server!.port}`;
  const call = async (kind: string, path: string, args: unknown = {}) => {
    const r = await fetch(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "encoded_json" }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { call, base, engine, persistence, port: server!.port };
}

const REQUEST_ID = /^\[Request ID: [0-9a-f]{16}\] Server Error/;

test("a BunvexError answers HTTP 200 with status error, the Convex-shaped message, and its data", async () => {
  const { call } = await serve({
    fail: mutation(() => {
      throw new BunvexError({ code: "NOT_ALLOWED", n: 3n });
    }),
  });
  const r = await call("mutation", "m:fail");
  expect(r.status).toBe(200);
  expect(r.body.status).toBe("error");
  expect(r.body.errorMessage).toMatch(REQUEST_ID);
  expect(r.body.errorMessage).toContain('\nUncaught BunvexError: {"code":"NOT_ALLOWED","n":"3n"}\n');
  expect(r.body.errorMessage).toMatch(/\n {4}at .+\n$/); // the frames, one per line
  // data travels in Convex's JSON form: the bigint as $integer
  expect(r.body.errorData).toEqual({ code: "NOT_ALLOWED", n: { $integer: "AwAAAAAAAAA=" } });
  expect(Object.keys(r.body)).toEqual(["status", "errorMessage", "errorData"]); // no empty logLines
});

test("a BunvexError with a string keeps it as message and data; an ordinary Error has no errorData", async () => {
  const { call } = await serve({
    str: query(() => {
      throw new BunvexError("sold out");
    }),
    plain: query(() => {
      throw new TypeError("boom");
    }),
    notAnError: query(() => {
      throw "just a string";
    }),
  });
  const s = await call("query", "m:str");
  expect(s.body.errorMessage).toContain("\nUncaught BunvexError: sold out\n");
  expect(s.body.errorData).toBe("sold out");
  const p = await call("query", "m:plain");
  expect(p.status).toBe(200);
  expect(p.body.errorMessage).toMatch(REQUEST_ID);
  expect(p.body.errorMessage).toContain("\nUncaught TypeError: boom\n");
  expect("errorData" in p.body).toBe(false);
  const n = await call("query", "m:notAnError");
  expect(n.body.errorMessage).toMatch(/Server Error\nUncaught just a string\n$/);
});

test("a BunvexError whose data is not a value is reported as such, without data", async () => {
  const { call } = await serve({
    bad: action(() => {
      throw new BunvexError({ when: new Date(0) } as never);
    }),
  });
  const r = await call("action", "m:bad");
  expect(r.body.errorMessage).toContain("\nBunvexError with invalid data: Date ");
  expect("errorData" in r.body).toBe(false);
});

test("redaction hides the details and the log lines, never the BunvexError data", async () => {
  const { call } = await serve(
    {
      app: mutation(() => {
        console.log("secret");
        throw new BunvexError({ code: 1 });
      }),
      internal: query(() => {
        console.log("secret");
        throw new Error("password=hunter2");
      }),
      ok: query(() => {
        console.log("secret");
        return 1;
      }),
    },
    { redactLogsToClient: true },
  );
  const a = await call("mutation", "m:app");
  expect(a.body.errorMessage).toMatch(/^\[Request ID: [0-9a-f]{16}\] Server Error$/);
  expect(a.body.errorData).toEqual({ code: 1 });
  expect("logLines" in a.body).toBe(false);
  const i = await call("query", "m:internal");
  expect(i.body.errorMessage).toMatch(/^\[Request ID: [0-9a-f]{16}\] Server Error$/);
  expect(JSON.stringify(i.body)).not.toContain("hunter2");
  const o = await call("query", "m:ok");
  expect(o.body).toEqual({ status: "success", value: 1 });
});

test("a missing function answers Convex's message, alone: no Uncaught, no frames", async () => {
  const { call } = await serve({ ok: query(() => 1) });
  const r = await call("query", "m:missing");
  expect(r.body.errorMessage).toMatch(
    /^\[Request ID: [0-9a-f]{16}\] Server Error\nCould not find public function for 'm:missing'\.\n$/,
  );
});

test("a cached query result answers the log lines of the run that filled the cache", async () => {
  const { call } = await serve({
    logs: query(() => {
      console.log("computed");
      return 1;
    }),
  });
  const first = await call("query", "m:logs");
  const hit = await call("query", "m:logs");
  expect(first.body.logLines).toEqual(["[LOG] 'computed'"]);
  expect(hit.body).toEqual(first.body);
});

test("the redaction default comes from REDACT_LOGS_TO_CLIENT", async () => {
  const fns = {
    f: query(() => {
      throw new Error("detail");
    }),
  };
  const saved = process.env.REDACT_LOGS_TO_CLIENT;
  try {
    process.env.REDACT_LOGS_TO_CLIENT = "true";
    const on = await serve(fns, { redactLogsToClient: undefined });
    expect((await on.call("query", "m:f")).body.errorMessage).not.toContain("detail");
    // As Convex's entry script: any non-empty value turns it on, even "false".
    process.env.REDACT_LOGS_TO_CLIENT = "false";
    const alsoOn = await serve(fns, { redactLogsToClient: undefined });
    expect((await alsoOn.call("query", "m:f")).body.errorMessage).not.toContain("detail");
    delete process.env.REDACT_LOGS_TO_CLIENT;
    const off = await serve(fns, { redactLogsToClient: undefined });
    expect((await off.call("query", "m:f")).body.errorMessage).toContain("Uncaught Error: detail");
  } finally {
    if (saved === undefined) delete process.env.REDACT_LOGS_TO_CLIENT;
    else process.env.REDACT_LOGS_TO_CLIENT = saved;
  }
});

test("console lines come back as logLines, rendered as Convex renders them", async () => {
  const { call } = await serve({
    q: query(() => {
      console.log("hi", { a: 1, b: "x" }, [1, 2], 10n);
      console.info("info");
      console.warn("warn");
      console.error("error");
      console.debug("debug");
      return null;
    }),
    fail: mutation(() => {
      console.log("before");
      throw new Error("after");
    }),
  });
  const r = await call("query", "m:q");
  expect(r.body).toEqual({
    status: "success",
    value: null,
    logLines: [
      "[LOG] 'hi' {\n  a: 1,\n  b: 'x'\n} [ 1, 2 ] 10n",
      "[INFO] 'info'",
      "[WARN] 'warn'",
      "[ERROR] 'error'",
      "[DEBUG] 'debug'",
    ],
  });
  expect(Object.keys(r.body)).toEqual(["status", "value", "logLines"]);
  const f = await call("mutation", "m:fail");
  expect(f.body.logLines).toEqual(["[LOG] 'before'"]); // an error's lines are returned too
});

test("console.time / timeLog / timeEnd, and warnings for unknown timers", async () => {
  const { call } = await serve({
    t: query(() => {
      console.time("x");
      console.time("x");
      console.timeLog("x", "mid");
      console.timeEnd("x");
      console.timeEnd("x");
      return null;
    }),
  });
  const lines = (await call("query", "m:t")).body.logLines as string[];
  expect(lines[0]).toBe("[WARN] Timer 'x' already exists");
  expect(lines[1]).toMatch(/^\[INFO\] x: \d+ms 'mid'$/);
  expect(lines[2]).toMatch(/^\[INFO\] x: \d+ms$/);
  expect(lines[3]).toBe("[WARN] Timer 'x' does not exist");
});

test("at most 256 lines, the last one an overflow notice", async () => {
  const { call } = await serve({
    many: query(() => {
      for (let i = 0; i < 300; i++) console.log(i);
      return null;
    }),
    exactly255: query(() => {
      for (let i = 0; i < 255; i++) console.log(i);
      return null;
    }),
  });
  const lines = (await call("query", "m:many")).body.logLines as string[];
  expect(lines).toHaveLength(256);
  expect(lines[254]).toBe("[LOG] 254");
  expect(lines[255]).toBe("[ERROR] Log overflow (maximum 256). Remaining log lines omitted.");
  expect((await call("query", "m:exactly255")).body.logLines).toHaveLength(255);
});

test("a long line is cut at 32 KiB of UTF-8 and marked", () => {
  expect(formatLogLine("LOG", ["a", "b"])).toBe("[LOG] a b");
  const long = formatLogLine("LOG", ["x".repeat(10), "é".repeat(MAX_LOG_LINE_LENGTH)]);
  expect(long.endsWith(" (truncated due to length)")).toBe(true);
  const kept = long.slice("[LOG] ".length, -" (truncated due to length)".length);
  expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(MAX_LOG_LINE_LENGTH);
  expect(kept.startsWith(`${"x".repeat(10)} é`)).toBe(true);
});

test("a mutation retried after a conflict returns only the committed attempt's lines", async () => {
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstRead!: () => void;
  const readDone = new Promise<void>((r) => (firstRead = r));
  const { call, engine } = await serve({
    bump: mutation(async ({ db }) => {
      const n = ++attempts;
      console.log(`attempt ${n}`);
      await db.query("items").collect();
      if (n === 1) {
        firstRead();
        await gate; // another commit lands on what this attempt read
      }
      await db.insert("items", { n });
      return n;
    }),
  });
  const pending = call("mutation", "m:bump");
  await readDone;
  await engine.mutation((db) => db.insert("items", { other: true }));
  release();
  const r = await pending;
  expect(r.body.value).toBe(2);
  expect(r.body.logLines).toEqual(["[LOG] 'attempt 2'"]);
});

test("an action's lines include those of the queries and mutations it runs, in order", async () => {
  const { call } = await serve({
    q: query(() => {
      console.log("in query");
      return 1;
    }),
    w: mutation(() => {
      console.log("in mutation");
      return 2;
    }),
    a: action(async (ctx) => {
      console.log("start");
      await ctx.runQuery("m:q", {});
      await ctx.runMutation("m:w", {});
      console.log("end");
      return 3;
    }),
  });
  const r = await call("action", "m:a");
  expect(r.body.logLines).toEqual(["[LOG] 'start'", "[LOG] 'in query'", "[LOG] 'in mutation'", "[LOG] 'end'"]);
});

test("a subscription re-run by a mutation's commit does not add its lines to the mutation's", async () => {
  const { call, port } = await serve({
    list: query(async ({ db }) => {
      console.log("subscription run");
      return (await db.query("items").collect()).length;
    }),
    add: mutation(async ({ db }) => {
      console.log("adding");
      await db.insert("items", {});
    }),
  });
  const c = await v1Client(syncUrl(port));
  c.modify([add(1, "m:list")]);
  await c.transition(0);
  const r = await call("mutation", "m:add");
  expect(r.body.logLines).toEqual(["[LOG] 'adding'"]);
  await c.until(() => c.transitions().some((t) => updated(t)[1] === 1));
  c.ws.close();
});

test("a system failure is a 500 with the fixed message, not the function's error", async () => {
  const { call, persistence } = await serve(
    { add: mutation(({ db }) => db.insert("items", {})) },
    { onFatal: () => {} },
  );
  persistence.flush = () => Promise.reject(new Error("disk on fire"));
  const r = await call("mutation", "m:add");
  expect(r.status).toBe(500);
  expect(r.body).toEqual({
    code: "InternalServerError",
    message: "Your request couldn't be completed. Try again later.",
  });
});

test("request errors use Convex's {code, message} body; args may be wrapped in an array", async () => {
  const { call, base } = await serve({ echo: query((_ctx, args) => args) });
  const bad = await fetch(`${base}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).code).toBe("BadJsonBody");
  const missing = await fetch(`${base}/api/nothing`, { method: "POST", body: "{}" });
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as any).code).toBe("NotFound");
  expect((await call("query", "m:echo", [{ a: 1 }])).body.value).toEqual({ a: 1 });
});
