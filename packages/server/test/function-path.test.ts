// A function path that does not parse is a 400 before the call (STUDY-67 H7, Convex's `parse_export_path`).
// The reasons are Convex's (its local backend's answers, STUDY-67 §5); the sentence around them is bunvex's.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { functionPathError } from "../src/function-path.ts";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const KEY = issueAdminKey({ instanceName: "probe", cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test("Convex's reasons", () => {
  expect(functionPathError("m:ok")).toBeNull();
  expect(functionPathError("m.js:ok")).toBeNull();
  expect(functionPathError("m")).toBeNull();
  expect(functionPathError("dir/m:ok")).toBeNull();
  expect(functionPathError("_system/frontend/x:y")).toBeNull();
  expect(functionPathError("m:ok:x")).toBe(
    "Path component m:ok.js can only contain alphanumeric characters, underscores, or periods.",
  );
  expect(functionPathError("")).toBe("Module path  doesn't have a filename.");
  expect(functionPathError("m:o-k")).toBe(
    "Identifier o-k has invalid character '-': Identifiers can only contain alphanumeric characters or underscores",
  );
  expect(functionPathError("m/ok:")).toBe("Identifier cannot be empty");
  expect(functionPathError("m:1x")).toBe(
    "Invalid first character '1' in 1x: Identifiers must start with an alphabetic character or underscore",
  );
  expect(functionPathError("m:__")).toBe("Identifier __ cannot have exclusively underscores");
  expect(functionPathError("m.ts:ok")).toBe("Module path (m.ts) has an extension that isn't 'js'.");
  expect(functionPathError("/m:ok")).toBe("Module paths must be relative (/m is absolute).");
  expect(functionPathError("a/../m:ok")).toBe("Invalid path component ParentDir in a/../m.");
  expect(functionPathError("./m:ok")).toBe("Invalid path component CurDir in ./m.");
  expect(functionPathError("m.:ok")).toBe("Module path (m.) has an extension that isn't 'js'.");
  expect(functionPathError("m/:ok")).toBeNull();
  expect(functionPathError("a/./m:ok")).toBeNull();
  expect(functionPathError("a b:ok")).toBe(
    "Path component a b.js can only contain alphanumeric characters, underscores, or periods.",
  );
});

test("over HTTP: 400 BadConvexFunctionIdentifier before the call; /api/function after its admin check", async () => {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: "probe", instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", { ok: query(async () => "ok") });
  const s = createServer({ engine, functions, port: 0, sitePort: null });
  stops.push(s.stop);
  const post = async (route: string, path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.server!.port}/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path, args: {} }),
    });
    return { status: r.status, body: await r.json() };
  };
  const bad = {
    status: 400,
    body: {
      code: "BadConvexFunctionIdentifier",
      message:
        "m:ok:x is not a valid path to a bunvex function. Path component m:ok.js can only contain alphanumeric characters, underscores, or periods.",
    },
  };
  for (const route of ["query", "mutation", "action"]) expect(await post(route, "m:ok:x")).toEqual(bad);
  // Before authentication: a bad key does not matter yet.
  expect(await post("query", "m:ok:x", { authorization: "Bunvex nope" })).toEqual(bad);
  expect((await post("function", "m:ok:x")).status).toBe(403);
  expect(await post("function", "m:ok:x", { authorization: `Bunvex ${KEY}` })).toEqual(bad);
  expect((await post("query", "m:ok")).body).toEqual({ status: "success", value: "ok" });
});
