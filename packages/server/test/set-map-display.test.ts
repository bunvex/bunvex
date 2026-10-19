// A pushed function's `Set` or `Map` where a value goes (STUDY-18 §9): its realm is the function's context, not the
// server's, and the message prints its entries as Convex's does (`Set[1]`, `Map[["a",1]]`; Convex's
// `instanceof Set` in `convexToJson`, npm-packages/convex/src/values/value.ts), wherever it is passed: returned
// (a `returns` validator or not), written, scheduled, or passed to a nested call. What it holds and the original
// object print as any other value (DV-316: a `Set` inside is `Set {…}`, where Convex's `JSON.stringify` prints `{}`).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const MAKE = `const make = {
  setEmpty: () => new Set(),
  setOne: () => new Set([1]),
  setMany: () => new Set([1, "two", null, [3], { four: 4n }]),
  mapEmpty: () => new Map(),
  mapOne: () => new Map([["a", 1]]),
  mapMany: () => new Map([["a", 1], [2, [true]], [null, { b: "c" }]]),
  setOfSets: () => new Set([new Set([1]), new Map([[1, 2]])]),
  inObject: () => ({ x: 1, m: new Map([["k", 1]]) }),
  inArray: () => [0, [new Set(["s"])]],
};`;

// What each kind prints as, and where in it the Set or Map is (its path, the original object), when it is the
// value itself (`top`) or the field `v` of the arguments or the document (`inV`).
const SHOWN: Record<string, { head: string; at?: string; original?: string }> = {
  setEmpty: { head: "Set[]" },
  setOne: { head: "Set[1]" },
  setMany: { head: 'Set[1,"two",null,[3],{"four":"4n"}]' },
  mapEmpty: { head: "Map[]" },
  mapOne: { head: 'Map[["a",1]]' },
  mapMany: { head: 'Map[["a",1],[2,[true]],[null,{"b":"c"}]]' },
  setOfSets: { head: "Set[Set {…},Map {…}]" },
  inObject: { head: 'Map[["k",1]]', at: ".m", original: '{"x":1,"m":Map {…}}' },
  inArray: { head: 'Set["s"]', at: "[1][0]", original: "[0,[Set {…}]]" },
};
const KINDS = Object.keys(SHOWN);
const not = "is not a supported value type";
const top = (k: string) => {
  const { head, at, original } = SHOWN[k]!;
  return at ? `${head} ${not} (present at path ${at} in original object ${original}).` : `${head} ${not}.`;
};
const inV = (k: string) => {
  const { head, at = "", original } = SHOWN[k]!;
  return `${head} ${not} (present at path .v${at} in original object {"v":${original ?? head.replace(/\[.*$/s, " {…}")}}).`;
};

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
import { v } from ${JSON.stringify(VALUES)};
${MAKE}
export const q = query(async (_ctx, { kind }) => make[kind]());
export const validated = query({ args: { kind: v.string() }, returns: v.string(), handler: async (_ctx, { kind }) => make[kind]() });
export const m = mutation(async (_ctx, { kind }) => make[kind]());
export const a = action(async (_ctx, { kind }) => make[kind]());
export const echo = query(async (_ctx, args) => args);
export const insert = mutation(async (ctx, { kind }) => { await ctx.db.insert("items", { v: make[kind]() }); });
export const patch = mutation(async (ctx, { kind }) => {
  const id = await ctx.db.insert("items", {});
  await ctx.db.patch(id, { v: make[kind]() });
});
export const replace = mutation(async (ctx, { kind }) => {
  const id = await ctx.db.insert("items", {});
  await ctx.db.replace(id, { v: make[kind]() });
});
export const schedule = mutation(async (ctx, { kind }) => { await ctx.scheduler.runAfter(0, "values:echo", { v: make[kind]() }); });
export const scheduleAt = mutation(async (ctx) => {
  const at = Date.now() + 60000;
  const id = await ctx.scheduler.runAt(new Date(at), "values:echo", {});
  return (await ctx.db.system.get(id)).scheduledTime === at;
});
export const scheduleFromAction = action(async (ctx, { kind }) => { await ctx.scheduler.runAfter(0, "values:echo", { v: make[kind]() }); });
export const runQueryWith = action(async (ctx, { kind }) => { await ctx.runQuery("values:echo", { v: make[kind]() }); });
export const runMutationWith = action(async (ctx, { kind }) => { await ctx.runMutation("values:m", { v: make[kind]() }); });
export const tooLarge = query(async () => ["x".repeat(9000000), "y".repeat(9000000), new Set([1])]);
export const tooDeep = query(async () => {
  let v = { s: new Set([1]) };
  for (let i = 0; i < 70; i++) v = { a: v };
  return v;
});
export const echoValidated = query({ args: { v: v.number() }, handler: async () => null });
export const runQueryFromMutation = mutation(async (ctx, { kind }) => { await ctx.runQuery("values:echo", { v: make[kind]() }); });
export const runValidatedFromMutation = mutation(async (ctx, { kind }) => { await ctx.runQuery("values:echoValidated", { v: make[kind]() }); });
export const runValidatedFromAction = action(async (ctx, { kind }) => { await ctx.runQuery("values:echoValidated", { v: make[kind]() }); });
export const argsNotObjectFromMutation = mutation(async (ctx) => { await ctx.runQuery("values:echo", new Set([1])); });
export const argsNotObjectFromAction = action(async (ctx) => { await ctx.runQuery("values:echo", new Set([1])); });
export const nestedValidated = mutation(async (ctx, { kind }) => { await ctx.runQuery("values:validated", { kind }); });`,
    },
  ]);
  const base = `http://127.0.0.1:${s.server.port}/api`;
  return async (kind: string, path: string, args: object) =>
    (await (
      await fetch(`${base}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()) as { status: string; errorMessage?: string; value?: unknown };
}

/** The error's message line: past the request id, before the frames. */
const head = (r: { status: string; errorMessage?: string }) => {
  expect(r.status).toBe("error");
  return r.errorMessage!.split("\n")[1];
};

test("returned: Convex's text, a `returns` validator or not (the value is converted before it is checked)", async () => {
  const call = await deployment();
  for (const [kind, path] of [
    ["query", "values:q"],
    ["query", "values:validated"],
    ["mutation", "values:m"],
    ["action", "values:a"],
    ["mutation", "values:nestedValidated"],
  ] as const)
    for (const k of KINDS)
      expect({ path, k, m: head(await call(kind, path, { kind: k })) }).toEqual({
        path,
        k,
        m: `Uncaught Error: ${top(k)}`,
      });
});

test("returned, too large or too deep: not a value first, as Convex converts before Rust measures", async () => {
  const call = await deployment();
  expect(head(await call("query", "values:tooLarge", {}))).toStartWith(
    `Uncaught Error: Set[1] ${not} (present at path [2] in original object ["xxx`,
  );
  expect(head(await call("query", "values:tooDeep", {}))).toStartWith(
    `Uncaught Error: Set[1] ${not} (present at path ${".a".repeat(70)}.s in original object {"a":{"a":`,
  );
});

test("written, scheduled or passed on: Convex's text, at the argument's or field's path", async () => {
  const call = await deployment();
  for (const [kind, path] of [
    ["mutation", "values:insert"],
    ["mutation", "values:patch"],
    ["mutation", "values:replace"],
    ["mutation", "values:schedule"],
    ["action", "values:scheduleFromAction"],
    ["action", "values:runQueryWith"],
    ["action", "values:runMutationWith"],
    ["mutation", "values:runQueryFromMutation"],
    ["mutation", "values:runValidatedFromMutation"],
    ["action", "values:runValidatedFromAction"],
  ] as const)
    for (const k of KINDS)
      expect({ path, k, m: head(await call(kind, path, { kind: k })) }).toEqual({
        path,
        k,
        m: `Uncaught Error: ${inV(k)}`,
      });
});

test("a nested call's arguments that are not an object: Convex's `parseArgs` message, first", async () => {
  const call = await deployment();
  for (const [kind, path] of [
    ["mutation", "values:argsNotObjectFromMutation"],
    ["action", "values:argsNotObjectFromAction"],
  ])
    expect({ path, m: head(await call(kind, path, {})) }).toEqual({
      path,
      m: "Uncaught Error: The arguments to a bunvex function must be an object. Received: [object Set]",
    });
});

test("a pushed function's `Date` is a time for `runAt`", async () => {
  const call = await deployment();
  expect(await call("mutation", "values:scheduleAt", {})).toMatchObject({ status: "success", value: true });
});
