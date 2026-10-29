// A pushed function's value that is not a supported value (returned, written, or passed to a nested call): the
// error the client sees carries no frame of the server's own code — no path of the server's installation, no
// `node:` or native frame of its own — only the app's frames, where its code made the call (Convex raises it in
// the app's bundle: npm-packages/convex/src/values/value.ts `convexToJson`, under `database_impl.ts` `insert`
// and `actions_impl.ts` `runQuery`).
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["@bunvex", "server"].join("/");
const REPO = resolve(import.meta.dir, "../../..");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const MAKE = `class Point { constructor() { this.x = 1; } }
const make = {
  set: () => new Set(["hello", "world"]),
  map: () => new Map([["a", 1]]),
  fn: () => () => 1,
  instance: () => new Point(),
  nested: () => ({ a: [1, new Set([1])] }),
  // Deeper than the stack's frame limit counts the serializer's recursion.
  deep: () => ({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: new Set([1]) } } } } } } } } } }),
};`;

async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
  });
  stops.push(() => s.shutdown());
  await s.deployCode([
    {
      path: "values.js",
      environment: "isolate",
      source: `import { action, mutation, query } from ${JSON.stringify(SERVER)};
${MAKE}
export const q = query(async (_ctx, { kind }) => make[kind]());
export const m = mutation(async (_ctx, { kind }) => make[kind]());
export const a = action(async (_ctx, { kind }) => make[kind]());
export const echo = query(async (_ctx, args) => args);
export const seed = mutation(async (ctx) => { await ctx.db.insert("items", { v: 1 }); });
export const insert = mutation(async (ctx, { kind }) => {
  await ctx.db.insert("items", { v: make[kind]() });
});
export const insertNew = mutation(async (ctx, { kind }) => {
  await ctx.db.insert("fresh", { v: make[kind]() });
});
export const runQueryCaught = action(async (ctx, { kind }) => {
  try {
    await ctx.runQuery("values:echo", { v: make[kind]() });
  } catch (e) {
    return { name: e.name, message: e.message };
  }
});
export const runQueryWith = action(async (ctx, { kind }) => {
  await ctx.runQuery("values:echo", { v: make[kind]() });
});`,
    },
    {
      path: "node.js",
      environment: "node",
      source: `"use node";
import { action } from ${JSON.stringify(SERVER)};
${MAKE}
export const a = action(async (_ctx, { kind }) => make[kind]());
export const runQueryWith = action(async (ctx, { kind }) => {
  await ctx.runQuery("values:echo", { v: make[kind]() });
});`,
    },
  ]);
  const base = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (kind: string, path: string, args: object) =>
    (await (
      await fetch(`${base}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; errorMessage?: string };
  await call("mutation", "values:seed", {});
  return call;
}

const KINDS = ["set", "map", "fn", "instance", "nested", "deep"];
const frames = (message: string) => message.split("\n").filter((l) => /^\s+at /.test(l));

test("a value returned that is not supported: no server frame reaches the client", async () => {
  const call = await deployment();
  for (const [kind, path] of [
    ["query", "values:q"],
    ["mutation", "values:m"],
    ["action", "values:a"],
    ["action", "node:a"],
  ] as const)
    for (const k of KINDS) {
      const r = await call(kind, path, { kind: k });
      expect({ path, k, status: r.status }).toEqual({ path, k, status: "error" });
      expect(r.errorMessage).toContain("is not a supported value type");
      // Returned values are checked after the function ran: no frame of the app's either.
      expect({ path, k, frames: frames(r.errorMessage!) }).toEqual({ path, k, frames: [] });
    }
});

test("a value written or passed to a nested call: thrown at the app's call, its frame alone", async () => {
  const call = await deployment();
  for (const [kind, path, file] of [
    ["mutation", "values:insert", "values.js"],
    // A table the insert would create: the value is refused before the table is.
    ["mutation", "values:insertNew", "values.js"],
    ["action", "values:runQueryWith", "values.js"],
    ["action", "node:runQueryWith", "node.js"],
  ] as const)
    for (const k of KINDS) {
      const r = await call(kind, path, { kind: k });
      const [server, head, ...rest] = r.errorMessage!.split("\n");
      expect(server).toMatch(/^\[Request ID: [0-9a-f]{16}\] Server Error$/);
      expect(head).toMatch(/^Uncaught Error: .* is not a supported value type \(present at path \.v/);
      // Thrown synchronously at the call, as Convex's serialization in the app's code: no `async` frame, no
      // nested call's blank line.
      expect({ path, k, rest }).toEqual({
        path,
        k,
        rest: [expect.stringMatching(new RegExp(`^ {4}at <anonymous> \\(${file}:\\d+:\\d+\\)$`)), ""],
      });
    }
});

test("an action that catches it sees the bare message, as Convex's own serialization error", async () => {
  const call = await deployment();
  const r = (await call("action", "values:runQueryCaught", { kind: "set" })) as unknown as { value: unknown };
  expect(r.value).toEqual({
    name: "Error",
    message:
      'Set["hello","world"] is not a supported value type (present at path .v in original object {"v":Set {…}}).',
  });
});

test("no client-visible error of a pushed function holds a path of the server's installation", async () => {
  const call = await deployment();
  const paths = [
    "values:q",
    "values:m",
    "values:a",
    "node:a",
    "values:insert",
    "values:insertNew",
    "values:runQueryWith",
    "node:runQueryWith",
  ];
  const kinds: Record<string, string> = {
    "values:q": "query",
    "values:m": "mutation",
    "values:insert": "mutation",
    "values:insertNew": "mutation",
  };
  for (const path of paths)
    for (const k of KINDS) {
      const r = await call(kinds[path] ?? "action", path, { kind: k });
      expect({
        path,
        k,
        leaks: r.errorMessage?.includes(REPO) || /\(node:|\(native|processTicksAndRejections/.test(r.errorMessage!),
      }).toEqual({ path, k, leaks: false });
    }
});
