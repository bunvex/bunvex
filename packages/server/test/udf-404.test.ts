// UDF_404_ON_BAD_PATH (STUDY-147 §3.8), Convex's switch: off (the default), a path naming no public function, or
// one of another kind, is the function's error (HTTP 200 `{status: "error"}`); on, it fails the request: 404
// `{code, message}` over HTTP (a whole batch with it), a sync session closed with 1000 and the code.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(on: boolean) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", {
    q: query(() => "q"),
    mu: mutation(() => "mu"),
  });
  expect(functions.udf404OnBadPath).toBe(false);
  functions.udf404OnBadPath = on;
  const server = createServer({ engine, functions, port: 0 });
  stops.push(server.stop);
  const port = server.server.port;
  const post = async (route: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return [r.status, (await r.json()) as Record<string, string>] as const;
  };
  return { post, port };
}

const NOT_FOUND = "Could not find public function for 'm:nope'.";
const WRONG_TYPE = "Trying to execute m.js:q as Mutation, but it is defined as Query.";

test("off (Convex's default): the function's error, HTTP 200", async () => {
  const { post } = await setup(false);
  for (const [route, path, message] of [
    ["query", "m:nope", NOT_FOUND],
    ["mutation", "m:q", WRONG_TYPE],
  ]) {
    const [status, body] = await post(route!, { path, args: {} });
    expect([status, body.status]).toEqual([200, "error"]);
    expect(body.errorMessage).toContain(message!);
  }
});

test("on: 404 with Convex's codes; a batch with one bad path fails whole", async () => {
  const { post } = await setup(true);
  expect(await post("query", { path: "m:nope", args: {} })).toEqual([
    404,
    { code: "FunctionPathNotFound", message: NOT_FOUND },
  ]);
  expect(await post("mutation", { path: "m:q", args: {} })).toEqual([
    404,
    { code: "FunctionPathWrongType", message: WRONG_TYPE },
  ]);
  expect((await post("query", { path: "m:q", args: {} }))[0]).toBe(200);
  const batch = await post("query_batch", {
    queries: [
      { path: "m:q", args: {} },
      { path: "m:nope", args: {} },
    ],
  });
  expect(batch).toEqual([404, { code: "FunctionPathNotFound", message: NOT_FOUND }]);
});

test("on: a sync subscription to a bad path closes the session with 1000 and the code", async () => {
  const { port } = await setup(true);
  const c = await v1Client(syncUrl(port));
  c.modify([add(0, "m:nope")]);
  const closed = await c.closed;
  expect([closed.code, closed.reason]).toEqual([1000, "FunctionPathNotFound"]);
  expect(c.got.some((m) => m.type === "FatalError")).toBe(false);
});
