// Convex's value nesting limit on functions (STUDY-109): arguments nest at most 63 levels (Convex parses the
// positional `[args]` array, 64), results 64, with Convex's messages and order (nesting, then size, then the
// validator); a value of any depth fails with the message, never a stack overflow.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

const TOO_NESTED = "Value is too nested (nested 65 levels deep > maximum nesting 64)";

/** A value nested `n` levels: objects and arrays in turn around a leaf. */
const deep = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = i % 2 ? [v] : { a: v };
  return v;
};

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    echo: query((_, _args: { x?: unknown }) => "ok" as const),
    typed: query({ args: { x: v.number() }, handler: () => "ok" }),
    ret: query((_, { n }: { n: number }) => deep(n)),
    retTyped: query({ args: { n: v.number() }, returns: v.number(), handler: (_, { n }) => deep(n) as number }),
    write: mutation(async ({ db }, { n }: { n: number }) => {
      await db.insert("items", { n });
      return deep(n);
    }),
    act: action((_, { n }: { n: number }) => deep(n)),
    actArgs: action((_, _args: { x?: unknown }) => "ok"),
    inner: internalQuery((_, _args: { x?: unknown }) => "ok"),
    innerWrite: internalMutation(async ({ db }) => {
      await db.insert("items", {});
    }),
    callInner: query(async ({ runQuery }, { n }: { n: number }) => {
      try {
        return await runQuery("m:inner", { x: deep(n) });
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    }),
    actCallInner: action(async ({ runQuery }, { n }: { n: number }) => {
      try {
        return await runQuery("m:inner", { x: deep(n) });
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    }),
    schedule: mutation(async ({ scheduler }, { n }: { n: number }) => {
      await scheduler.runAfter(1000, "m:innerWrite" as never, { x: deep(n) } as never);
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
  });
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

test("arguments: 63 levels pass, 64 fail with Convex's message", async () => {
  const { fns } = await setup();
  // `{x: deep(62)}` is 63 levels; Convex's `[args]` makes it 64.
  expect(await fns.runQuery("m:echo", { x: deep(62) })).toBe("ok");
  const e = await fail(fns.runQuery("m:echo", { x: deep(63) }));
  expect(e.message).toBe(`Invalid arguments for m.js:echo: ${TOO_NESTED}`);
  expect((await fail(fns.runMutation("m:write", { n: 1, x: deep(63) }))).message).toBe(
    `Invalid arguments for m.js:write: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runAction("m:actArgs", { x: deep(63) }))).message).toBe(
    `Invalid arguments for m.js:actArgs: ${TOO_NESTED}`,
  );
});

test("arguments: the nesting is checked before the size, and both before the validator", async () => {
  const { fns } = await setup();
  fns.maxArgsSize = 50;
  // Too deep, too large and not a number: the nesting speaks.
  const e = await fail(fns.runQuery("m:typed", { x: deep(63), pad: "y".repeat(100) }));
  expect(e.message).toBe(`Invalid arguments for m.js:typed: ${TOO_NESTED}`);
  // Too large and not a number: the size.
  expect((await fail(fns.runQuery("m:typed", { x: deep(10), pad: "y".repeat(100) }))).message).toContain(
    "Arguments for m.js:typed are too large",
  );
  // A validated function's non-object argument is the validator's, after the size (Convex's `check_args`).
  expect((await fail(fns.runQuery("m:typed", "y".repeat(100) as never))).message).toContain("are too large");
});

test("results: 64 levels pass, 65 fail with Convex's message, before the size and the returns validator", async () => {
  const { fns } = await setup();
  expect(await fns.runQuery("m:ret", { n: 64 })).toEqual(deep(64));
  expect((await fail(fns.runQuery("m:ret", { n: 65 }))).message).toBe(
    `Function m.js:ret return value invalid: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runAction("m:act", { n: 65 }))).message).toBe(
    `Function m.js:act return value invalid: ${TOO_NESTED}`,
  );
  fns.maxResultSize = 10;
  // Too deep, too large and not a number: the nesting speaks.
  expect((await fail(fns.runQuery("m:retTyped", { n: 65 }))).message).toBe(
    `Function m.js:retTyped return value invalid: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runQuery("m:retTyped", { n: 64 }))).message).toContain("return value is too large");
});

test("a mutation whose result is too nested writes nothing", async () => {
  const { fns } = await setup();
  expect((await fail(fns.runMutation("m:write", { n: 65 }))).message).toBe(
    `Function m.js:write return value invalid: ${TOO_NESTED}`,
  );
  expect(await fns.runQuery("m:count", {})).toBe(0);
  await fns.runMutation("m:write", { n: 64 });
  expect(await fns.runQuery("m:count", {})).toBe(1);
});

test("100 000 levels fail with the message, not a stack overflow", async () => {
  const { fns } = await setup();
  expect((await fail(fns.runQuery("m:echo", { x: deep(100_000) }))).message).toBe(
    `Invalid arguments for m.js:echo: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runQuery("m:ret", { n: 100_000 }))).message).toBe(
    `Function m.js:ret return value invalid: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runMutation("m:write", { n: 100_000 }))).message).toBe(
    `Function m.js:write return value invalid: ${TOO_NESTED}`,
  );
  expect((await fail(fns.runAction("m:act", { n: 100_000 }))).message).toBe(
    `Function m.js:act return value invalid: ${TOO_NESTED}`,
  );
  expect(await fns.runQuery("m:count", {})).toBe(0);
});

test("a nested call: 64 levels are the callee's arguments error, 65 the `runUdf` syscall's (Convex's order)", async () => {
  const { fns } = await setup();
  // `{x: deep(62)}` passes; `{x: deep(63)}` (64 levels) is the callee's `[args]` check.
  expect(await fns.runQuery("m:callInner", { n: 62 })).toBe("ok");
  expect(await fns.runQuery("m:callInner", { n: 63 })).toBe(`caught: Invalid arguments for m.js:inner: ${TOO_NESTED}`);
  expect(await fns.runQuery("m:callInner", { n: 64 })).toBe(
    `caught: Invalid argument \`args\` for \`runUdf\`: ${TOO_NESTED}`,
  );
  expect(await fns.runQuery("m:callInner", { n: 100_000 })).toBe(
    `caught: Invalid argument \`args\` for \`runUdf\`: ${TOO_NESTED}`,
  );
  // An action's call takes its arguments as JSON to the callee's check, at any depth.
  expect(await fns.runAction("m:actCallInner", { n: 64 })).toBe(
    `caught: Invalid arguments for m.js:inner: ${TOO_NESTED}`,
  );
});

test("scheduling: arguments past 63 levels fail with the target's message; 63 levels schedule", async () => {
  const { fns } = await setup();
  await fns.runMutation("m:schedule", { n: 62 });
  for (const n of [63, 100_000])
    expect((await fail(fns.runMutation("m:schedule", { n }))).message).toBe(
      `Invalid arguments for m.js:innerWrite: ${TOO_NESTED}`,
    );
});

test("over HTTP and the sync protocol, deep arguments are a function error with the message", async () => {
  const { engine, fns } = await setup();
  const { server, stop } = createServer({ engine, functions: fns, port: 0, redactLogsToClient: false });
  stops.push(stop);
  // `n` levels of arrays as JSON text (JSON.stringify itself overflows the stack on 100 000).
  const deepJson = (n: number) => `${"[".repeat(n)}1${"]".repeat(n)}`;
  for (const n of [62, 100_000]) {
    // `{x: <n + 1 levels>}`: 64 levels and more.
    const r = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"path":"m:echo","args":{"x":${deepJson(n + 1)}}}`,
    });
    const body = (await r.json()) as { status: string; errorMessage: string };
    expect(body.status).toBe("error");
    expect(body.errorMessage).toContain(`Invalid arguments for m.js:echo: ${TOO_NESTED}`);
  }
  const ok = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:echo", args: { x: deep(62) } }),
  });
  expect(((await ok.json()) as { status: string }).status).toBe("success");

  const c = await v1Client(syncUrl(server.port));
  c.modify([add(1, "m:echo", { x: deep(63) }), add(2, "m:echo", { x: deep(62) })]);
  const t = await c.transition(0);
  const failed = t.modifications.find((m) => m.type === "QueryFailed") as { errorMessage: string } | undefined;
  expect(failed?.errorMessage).toContain(`Invalid arguments for m.js:echo: ${TOO_NESTED}`);
  expect(t.modifications.some((m) => m.type === "QueryUpdated")).toBe(true);
  c.ws.send(`{"type":"Mutation","requestId":0,"udfPath":"m:write","args":[{"n":1,"x":${deepJson(100_000)}}]}`);
  const res = await c.until(() => c.responses()[0]);
  expect(res).toMatchObject({ requestId: 0, success: false });
  expect((res as { result: string }).result).toContain(`Invalid arguments for m.js:write: ${TOO_NESTED}`);
  expect(c.ws.readyState).toBe(WebSocket.OPEN);
});
