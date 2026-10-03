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
  await fetch(`${api}/api/mutation`, { method: "POST", body: JSON.stringify({ path: "m:seed", args: {} }) });
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
