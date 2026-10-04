// `POST /api/run/{functionIdentifier}` (STUDY-67 H8, Convex's `public_function_post_with_path`): any function
// by its path in the URL, clean JSON by default. Expected answers are Convex's local backend's (STUDY-67 §5).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, internalQuery, mutation, query } from "../src/functions.ts";
import { createServer, runPath } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const KEY = issueAdminKey({ instanceName: "probe", cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "probe", instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine)
    .register("m", {
      ok: query(async () => ({ n: 5n, s: "x" })),
      cfails: query(async () => {
        throw new BunvexError({ code: "nope", n: 7n });
      }),
      mut: mutation(async () => 1),
      secret: internalQuery(async () => "internal"),
      default: query(async () => "default"),
    })
    .register("nested/deep", { f: query(async () => "deep") });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const base = `http://127.0.0.1:${s.server!.port}`;
  const run = async (path: string, body: object = { args: {} }, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/run/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text === "" ? null : JSON.parse(text) };
  };
  return { base, run };
}

test("any kind, by module path and name; clean JSON by default, whatever the client", async () => {
  const { run } = await setup();
  expect(await run("m/ok")).toEqual({ status: 200, body: { status: "success", value: { n: "5", s: "x" } } });
  expect((await run("m/ok", { args: {} }, { "bunvex-client": "npm-1.0.0" })).body.value).toEqual({ n: "5", s: "x" });
  expect((await run("m/ok", { args: {}, format: "encoded_json" })).body.value).toEqual({
    n: { $integer: "BQAAAAAAAAA=" },
    s: "x",
  });
  expect((await run("m/mut")).body.value).toBe(1);
  expect((await run("nested/deep/f")).body.value).toBe("deep");
  expect((await run("nested%2Fdeep/f")).body.value).toBe("deep");
  expect((await run("m/default")).body.value).toBe("default");
  expect((await run("m.js/ok")).body.value).toEqual({ n: "5", s: "x" });
});

test("a function error is a 200, errorData in the format", async () => {
  const { run } = await setup();
  const r = await run("m/cfails");
  expect(r.status).toBe(200);
  expect(r.body.errorData).toEqual({ code: "nope", n: "7" });
});

test("missing or internal: Convex's message; an admin runs an internal function", async () => {
  const { run } = await setup();
  const notFound = (p: string) =>
    `Server Error\nCould not find function for '${p}'. Did you forget to run \`bunvex dev\`?\n`;
  const message = async (r: Promise<{ body: { errorMessage?: string } }>) =>
    (await r).body.errorMessage?.replace(/^\[Request ID: [0-9a-f]+\] /, "");
  expect(await message(run("m/nope"))).toBe(notFound("m:nope"));
  expect(await message(run("m/secret"))).toBe(notFound("m:secret"));
  expect((await run("m/secret", { args: {} }, { authorization: `Bunvex ${KEY}` })).body.value).toBe("internal");
});

test("request errors: one segment, no args, another method", async () => {
  const { base, run } = await setup();
  expect(await run("ok")).toEqual({
    status: 400,
    body: {
      code: "MissingIdentifier",
      message: "Path or function name not provided in path, e.g. /api/run/messages/list",
    },
  });
  expect(await run("m/ok", {})).toEqual({
    status: 400,
    body: {
      code: "BadJsonBody",
      message: "Failed to deserialize the JSON body into the target type: missing field `args` at line 1 column 2",
    },
  });
  const get = await fetch(`${base}/api/run/m/ok`);
  expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
  expect((await fetch(`${base}/api/run/`, { method: "POST" })).status).toBe(404);
});

test("runPath", () => {
  expect(runPath("messages/list")).toBe("messages:list");
  expect(runPath("a/b/c")).toBe("a/b:c");
  expect(runPath("a%2Fb/c")).toBe("a/b:c");
  expect(runPath("list")).toBeNull();
  expect(runPath("a/%E0%A4%A")).toBeNull();
});
