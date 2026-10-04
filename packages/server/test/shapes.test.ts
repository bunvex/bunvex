// `GET /api/shapes2` (STUDY-52): each user table's inferred shape, in Convex's dashboard form.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "59".repeat(32);
const NAME = "shapes-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("each user table's shape: system fields, ids by table name, optional fields; Never when empty", async () => {
  const engine = await new Engine(
    defineSchema({ users: defineTable(v.any()), posts: defineTable(v.any()), empty: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    seed: mutation(async ({ db }) => {
      const ada = await db.insert("users", { name: "Ada Lovelace" });
      await db.insert("users", { name: "Bob", age: 41n });
      await db.insert("posts", { owner: ada, score: 1.5 });
    }),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  await fetch(`${api}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "m:seed", args: {} }),
  });
  const r = await fetch(`${api}/api/shapes2`, { headers: { authorization: `Bunvex ${KEY}` } });
  expect(r.status).toBe(200);
  const shapes = (await r.json()) as Record<string, any>;
  expect(Object.keys(shapes)).toEqual(["empty", "posts", "users"]);
  expect(shapes.empty).toEqual({ type: "Never" });
  const float = { type: "Float64", float64Range: { hasSpecialValues: false } };
  expect(shapes.users).toEqual({
    type: "Object",
    fields: [
      { fieldName: "_creationTime", optional: false, shape: float },
      { fieldName: "_id", optional: false, shape: { type: "Id", tableName: "users" } },
      { fieldName: "age", optional: true, shape: { type: "Int64" } },
      { fieldName: "name", optional: false, shape: { type: "String" } },
    ],
  });
  expect(shapes.posts.fields.find((f: any) => f.fieldName === "owner").shape).toEqual({
    type: "Id",
    tableName: "users",
  });
  expect((await fetch(`${api}/api/shapes2`)).status).toBe(403);
  expect(
    (await fetch(`${api}/api/shapes2?component=abc`, { headers: { authorization: `Bunvex ${KEY}` } })).status,
  ).toBe(400);
});

test("tableSize system functions: a table's count from the summaries; cached results follow writes", async () => {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()), b: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }, { table }: { table: string }) => db.insert(table as never, {})),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(s.stop);
  await engine.summariesReady();
  const api = `http://127.0.0.1:${s.server!.port}`;
  const q = async (path: string, args: object) =>
    (
      (await (
        await fetch(`${api}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bunvex ${KEY}` },
          body: JSON.stringify({ path, args }),
        })
      ).json()) as { value: number }
    ).value;
  const add = (table: string) =>
    fetch(`${api}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:add", args: { table } }),
    });
  expect(await q("_system/cli/tableSize", { tableName: "a" })).toBe(0);
  await add("a");
  await add("a");
  await add("b");
  expect(await q("_system/cli/tableSize", { tableName: "a" })).toBe(2);
  expect(await q("_system/frontend/tableSize", { tableName: "b" })).toBe(1);
  expect(await q("_system/frontend/tableSize", { tableName: "" })).toBe(0);
  expect(await q("_system/frontend/tableSize", { tableName: "missing" })).toBe(0);
  expect(await q("_system/frontend/tableSize:sizeOfAllTables", {})).toBe(3);
  await add("b");
  expect(await q("_system/frontend/tableSize:sizeOfAllTables", {})).toBe(4);
});
