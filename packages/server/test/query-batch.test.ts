// `POST /api/query_batch` (STUDY-67 H9, Convex's `public_query_batch_post`): several queries at one
// timestamp, each answered as `/api/query` answers it. Expected answers are Convex's local backend's
// (STUDY-67 §5).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
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
    ok: query(async () => {
      console.log("hi");
      return { n: 5n, s: "x" };
    }),
    fails: query(async () => {
      console.log("before");
      throw new Error("boom");
    }),
    mut: mutation(async () => 1),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const batch = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/query_batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { batch };
}

const strip = (m: string) => m.replace(/^\[Request ID: [0-9a-f]+\] /, "").replace(/\n {4}at [^\n]*/g, "");

test("each query's UdfResponse, in order, each in its own format", async () => {
  const { batch } = await setup();
  const r = await batch({
    queries: [
      { path: "m:ok", args: {}, format: "json" },
      { path: "m:ok", args: {}, format: "encoded_json" },
      { path: "m:fails", args: {} },
      { path: "m:nope", args: {} },
      { path: "m:mut", args: {} },
    ],
  });
  expect(r.status).toBe(200);
  const [clean, encoded, fails, nope, mut] = r.body.results;
  expect(clean).toEqual({ status: "success", value: { n: "5", s: "x" }, logLines: ["[LOG] 'hi'"] });
  expect(encoded.value).toEqual({ n: { $integer: "BQAAAAAAAAA=" }, s: "x" });
  expect({ ...fails, errorMessage: strip(fails.errorMessage) }).toEqual({
    status: "error",
    errorMessage: "Server Error\nUncaught Error: boom\n",
    logLines: ["[LOG] 'before'"],
  });
  expect(strip(nope.errorMessage)).toBe("Server Error\nCould not find public function for 'm:nope'.\n");
  expect(strip(mut.errorMessage)).toBe(
    "Server Error\nTrying to execute m.js:mut as Query, but it is defined as Mutation.\n",
  );
  expect(await batch({ queries: [] })).toEqual({ status: 200, body: { results: [] } });
});

test("a bad format fails the batch; so does a body of the wrong shape", async () => {
  const { batch } = await setup();
  expect(
    await batch({
      queries: [
        { path: "m:ok", args: {} },
        { path: "m:ok", args: {}, format: "bogus" },
      ],
    }),
  ).toEqual({
    status: 400,
    body: { code: "BadFormat", message: "format param must be one of [`json`]. Got bogus" },
  });
  expect(await batch({})).toEqual({
    status: 400,
    body: {
      code: "BadJsonBody",
      message: "Failed to deserialize the JSON body into the target type: missing field `queries` at line 1 column 2",
    },
  });
  expect(await batch({ queries: [{ path: "m:ok" }] })).toEqual({
    status: 400,
    body: {
      code: "BadJsonBody",
      message:
        "Failed to deserialize the JSON body into the target type: queries[0]: missing field `args` at line 1 column 27",
    },
  });
});

test("an entry's path that does not parse fails the batch, after that entry's format (STUDY-67 H7)", async () => {
  const { batch } = await setup();
  expect(
    await batch({
      queries: [
        { path: "m:ok", args: {} },
        { path: "m:o-k", args: {} },
      ],
    }),
  ).toEqual({
    status: 400,
    body: {
      code: "BadBunvexFunctionIdentifier",
      message:
        "m:o-k is not a valid path to a bunvex function. Identifier o-k has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
    },
  });
  expect((await batch({ queries: [{ path: "m:o-k", args: {}, format: "bogus" }] })).body.code).toBe("BadFormat");
});
