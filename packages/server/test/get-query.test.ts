// `GET /api/query?path=&args=&format=` (STUDY-67 H10, DV-313): a query by URL. Convex declares the
// route but answers every request 400 (it cannot read `args` from a query string); bunvex's works.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, query } from "../src/functions.ts";
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
    typed: query({ args: { x: v.number() }, handler: async (_ctx, { x }) => ({ x, n: 5n }) }),
    fails: query(async () => {
      throw new Error("boom");
    }),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const get = async (query: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/query?${query}`, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { get };
}

const args = (o: unknown) => encodeURIComponent(JSON.stringify(o));

test("path, args as JSON, format: answered as POST /api/query", async () => {
  const { get } = await setup();
  expect(await get(`path=m:typed&args=${args({ x: 3 })}`)).toEqual({
    status: 200,
    body: { status: "success", value: { n: "5", x: 3 } },
  });
  expect((await get(`path=m:typed&args=${args({ x: 3 })}&format=encoded_json`)).body.value).toEqual({
    n: { $integer: "BQAAAAAAAAA=" },
    x: 3,
  });
  const failed = await get(`path=m:fails&args=${args({})}`);
  expect([failed.status, failed.body.status]).toEqual([200, "error"]);
});

test("a missing or malformed parameter is 400 BadQueryArgs", async () => {
  const { get } = await setup();
  expect(await get(`args=${args({})}`)).toEqual({
    status: 400,
    body: { code: "BadQueryArgs", message: "Failed to deserialize query string: missing field `path`" },
  });
  expect(await get("path=m:typed")).toEqual({
    status: 400,
    body: { code: "BadQueryArgs", message: "Failed to deserialize query string: missing field `args`" },
  });
  const bad = await get("path=m:typed&args=nope");
  expect([bad.status, bad.body.code]).toEqual([400, "BadQueryArgs"]);
  expect((await get(`path=m:typed&args=${args({})}&format=bogus`)).body.code).toBe("BadFormat");
});

test("a path that does not parse is 400 BadBunvexFunctionIdentifier, as POST, before authentication", async () => {
  const { get } = await setup();
  const invalid = {
    status: 400,
    body: {
      code: "BadBunvexFunctionIdentifier",
      message:
        "m:o-k is not a valid path to a bunvex function. Identifier o-k has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    },
  };
  expect(await get(`path=${encodeURIComponent("m:o-k")}&args=${args({})}`)).toEqual(invalid);
  // Convex's `public_query_get` parses the path before it authenticates: a bad token does not hide it.
  expect(await get(`path=${encodeURIComponent("m:o-k")}&args=${args({})}`, { authorization: "Bearer nope" })).toEqual(
    invalid,
  );
  expect((await get(`path=${encodeURIComponent("../m:ok")}&args=${args({})}`)).body).toEqual({
    code: "BadBunvexFunctionIdentifier",
    message: "../m:ok is not a valid path to a bunvex function. Invalid path component ParentDir in ../m.",
  });
  // a path that parses but names nothing is the function's error, as before
  const missing = await get(`path=m:nothing&args=${args({})}`);
  expect([missing.status, missing.body.status]).toEqual([200, "error"]);
});
