// The `format` of results over HTTP (STUDY-67 H3): Convex's value formats, and its client's default when a
// request names none. The expected bodies are what Convex's local backend answers (STUDY-67 §5).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { defaultFormat } from "../src/value-format.ts";

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
  const functions = new Functions(engine).register("m", {
    ok: query(async () => ({ n: 5n, f: 1.5, b: new Uint8Array([0, 0]).buffer, s: "x", nan: Number.NaN })),
    cfails: query(async () => {
      throw new BunvexError({ code: "nope", n: 7n });
    }),
    insert: mutation(async ({ db }) => {
      await db.insert("items", {});
    }),
    count: query(async ({ db }) => (await db.query("items").collect()).length),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null, redactLogsToClient: false });
  stops.push(s.stop);
  const base = `http://127.0.0.1:${s.server!.port}`;
  const call = async (route: string, body: object, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { call, base };
}

const CLEAN = { b: "AAA=", f: 1.5, n: "5", nan: "NaN", s: "x" };
const ENCODED = {
  b: { $bytes: "AAA=" },
  f: 1.5,
  n: { $integer: "BQAAAAAAAAA=" },
  nan: { $float: "AAAAAAAA+H8=" },
  s: "x",
};
const EXPORT = { b: { $bytes: "AAA=" }, f: 1.5, n: 5, nan: { $float: "AAAAAAAA+H8=" }, s: "x" };

test("each format, by bunvex's names (DV-307); no format and no client header is clean JSON", async () => {
  const { call } = await setup();
  const value = async (format?: string) =>
    (await call("query", { path: "m:ok", args: {}, ...(format === undefined ? {} : { format }) })).body.value;
  expect(await value()).toEqual(CLEAN);
  expect(await value("json")).toEqual(CLEAN);
  expect(await value("clean_json")).toEqual(CLEAN);
  expect(await value("encoded_json")).toEqual(ENCODED);
  expect(await value("export_json")).toEqual(EXPORT);
});

test("Convex's format names are a 400 BadFormat (DV-307)", async () => {
  const { call } = await setup();
  for (const format of ["convex_encoded_json", "convex_json", "convex_clean_json"]) {
    const r = await call("query", { path: "m:ok", args: {}, format });
    expect([r.status, r.body]).toEqual([
      400,
      { code: "BadFormat", message: `format param must be one of [\`json\`]. Got ${format}` },
    ]);
  }
});

test("errorData is in the format too", async () => {
  const { call } = await setup();
  expect((await call("query", { path: "m:cfails", args: {} })).body.errorData).toEqual({ code: "nope", n: "7" });
  expect((await call("query", { path: "m:cfails", args: {}, format: "encoded_json" })).body.errorData).toEqual({
    code: "nope",
    n: { $integer: "BwAAAAAAAAA=" },
  });
});

test("a bad format is a 400 BadFormat, once the function has run (a mutation commits)", async () => {
  const { call } = await setup();
  const bad = { code: "BadFormat", message: "format param must be one of [`json`]. Got bogus" };
  expect(await call("query", { path: "m:ok", args: {}, format: "bogus" })).toEqual({ status: 400, body: bad });
  expect(await call("query", { path: "m:cfails", args: {}, format: "bogus" })).toEqual({ status: 400, body: bad });
  expect(await call("mutation", { path: "m:insert", args: {}, format: "bogus" })).toEqual({ status: 400, body: bad });
  expect((await call("query", { path: "m:count", args: {} })).body.value).toBe(1);
});

test("the client's default: encoded for old npm, CLI and python clients, clean for the rest", async () => {
  const { call } = await setup();
  const as = async (client: string) =>
    (await call("query", { path: "m:ok", args: {} }, { "bunvex-client": client })).body.value;
  expect(await as("npm-1.0.0")).toEqual(ENCODED);
  expect(await as("npm-cli-1.0.0")).toEqual(ENCODED);
  expect(await as("python-0.4.0")).toEqual(ENCODED);
  expect(await as("npm-1.46.0")).toEqual(CLEAN);
  expect(await as("python-0.5.0")).toEqual(CLEAN);
  expect(await as("swift-0.1.0")).toEqual(CLEAN);
});

test("query_at_ts and /api/function take the format as well", async () => {
  const { call, base } = await setup();
  const { ts } = (await (await fetch(`${base}/api/query_ts`, { method: "POST" })).json()) as { ts: string };
  expect((await call("query_at_ts", { path: "m:ok", args: {}, ts })).body.value).toEqual(CLEAN);
  expect((await call("query_at_ts", { path: "m:ok", args: {}, ts, format: "export_json" })).body.value).toEqual(EXPORT);
  const admin = { authorization: `Bunvex ${KEY}` };
  expect((await call("function", { path: "m:ok", args: {} }, admin)).body.value).toEqual(CLEAN);
  expect((await call("function", { path: "m:ok", args: {}, format: "encoded_json" }, admin)).body.value).toEqual(
    ENCODED,
  );
});

test("defaultFormat parses `<client>-<semver>` as Convex's ClientVersion does", () => {
  expect(defaultFormat(null)).toBe("clean");
  expect(defaultFormat("npm-1.4.0")).toBe("encoded");
  expect(defaultFormat("npm-1.4.1")).toBe("clean");
  expect(defaultFormat("npm-1.4.1-alpha.1")).toBe("encoded");
  expect(defaultFormat("NPM-1.0.0")).toBe("encoded");
  expect(defaultFormat("actions-1.0.0")).toBe("encoded");
  expect(defaultFormat("npm-abc")).toBe("clean");
  expect(defaultFormat("garbage")).toBe("clean");
  expect(defaultFormat("my-esolang-client-0.0.1")).toBe("clean");
});
