// Convex's value limits on function arguments (DV-439, STUDY-137 R5): an array over 8192 elements or an object over
// 1024 fields (undefined fields not counted) fails before the call, as Convex's `parse_udf_args`, with its messages:
// "Invalid arguments for <path>: …", "Invalid argument `args` for `runUdf`: …" for a nested call (the syscall parses
// first), and the scheduler's "Invalid arguments for <target>: …".
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, internalMutation, internalQuery, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const LONG = "Array length is too long (8193 > maximum length 8192)";
const WIDE = "Object has too many fields (1025 > maximum number 1024)";
const array = (n: number) => Array.from({ length: n }, () => 1);
const object = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 1]));

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const fns = new Functions(engine).register("m", {
    loose: query((_, _args: { x?: unknown }) => "ran"),
    typed: query({ args: { x: v.any() }, handler: () => "ran" }),
    inner: internalQuery((_, _args: { x?: unknown }) => "ran"),
    innerWrite: internalMutation(async () => {}),
    callInner: query(async ({ runQuery }, { n }: { n: number }) => {
      try {
        return await runQuery("m:inner", { x: array(n) });
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
    }),
    schedule: mutation(async ({ scheduler }, { wide }: { wide: number }) => {
      await scheduler.runAfter(1000, "m:innerWrite" as never, { x: object(wide) } as never);
    }),
  });
  return { engine, fns };
}

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a failure");
};

test("8192 elements and 1024 fields pass; one more fails with Convex's message, with or without a validator", async () => {
  const { fns } = await setup();
  for (const path of ["m:loose", "m:typed"]) {
    expect(await fns.runQuery(path, { x: array(8192) })).toBe("ran");
    expect(await fns.runQuery(path, { x: object(1024) })).toBe("ran");
    expect(await fail(fns.runQuery(path, { x: array(8193) }))).toBe(
      `Invalid arguments for ${path.replace(":", ".js:")}: ${LONG}`,
    );
    expect(await fail(fns.runQuery(path, { x: object(1025) }))).toBe(
      `Invalid arguments for ${path.replace(":", ".js:")}: ${WIDE}`,
    );
  }
  // Deep inside, and undefined fields do not count.
  expect(await fail(fns.runQuery("m:loose", { x: { a: [{ b: array(9000) }] } }))).toContain(
    "(9000 > maximum length 8192)",
  );
  expect(await fns.runQuery("m:loose", { x: { ...object(1024), skipped: undefined } })).toBe("ran");
  // The inner container fails first, as Convex builds a value from the inside out.
  expect(await fail(fns.runQuery("m:loose", { x: [...array(8192), array(8200)] }))).toContain(
    "(8200 > maximum length 8192)",
  );
});

test("a nested call is refused by the runUdf syscall; a scheduled call by the scheduler", async () => {
  const { fns } = await setup();
  expect(await fns.runQuery("m:callInner", { n: 8192 })).toBe("ran");
  expect(await fns.runQuery("m:callInner", { n: 8193 })).toBe(
    `caught: Invalid argument \`args\` for \`runUdf\`: ${LONG}`,
  );
  await fns.runMutation("m:schedule", { wide: 1024 });
  expect(await fail(fns.runMutation("m:schedule", { wide: 1025 }))).toBe(
    `Invalid arguments for m.js:innerWrite: ${WIDE}`,
  );
});

test("over HTTP: a function error with the message, the function not run", async () => {
  const { engine, fns } = await setup();
  const { server, stop } = createServer({ engine, functions: fns, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const r = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:loose", args: { x: array(9000) } }),
  });
  expect(await r.json()).toMatchObject({
    status: "error",
    errorMessage: expect.stringContaining(
      "Invalid arguments for m.js:loose: Array length is too long (9000 > maximum length 8192)",
    ),
  });
});

test("a system function: Convex's `op_validate_args` error, raised inside it with no frames", async () => {
  const SECRET = "ab".repeat(32);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "limits", instanceSecret: SECRET },
  ).init();
  const { server, stop } = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    redactLogsToClient: false,
  });
  stops.push(stop);
  const key = issueAdminKey({ instanceName: "limits", cipherKey: adminKeyCipherKey(SECRET) });
  const call = async (args: object) =>
    (await (
      await fetch(`http://127.0.0.1:${server.port}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bunvex ${key}` },
        body: JSON.stringify({ path: "_system/cli/tableSize", args }),
      })
    ).json()) as { status: string; errorMessage?: string; value?: unknown };
  // Checked against Convex's local backend: "Uncaught Error: Invalid arguments: …", nothing after.
  expect((await call({ tableName: "items", junk: array(9000) })).errorMessage).toEndWith(
    "Server Error\nUncaught Error: Invalid arguments: Array length is too long (9000 > maximum length 8192)\n",
  );
  expect((await call({ tableName: "items", junk: object(1100) })).errorMessage).toEndWith(
    "Server Error\nUncaught Error: Invalid arguments: Object has too many fields (1100 > maximum number 1024)\n",
  );
  expect(await call({ tableName: "items" })).toMatchObject({ status: "success" });
});
