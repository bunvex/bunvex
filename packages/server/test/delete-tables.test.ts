// `/api/delete_tables` (Convex's dashboard route): user tables deleted in one commit, a missing one skipped,
// the schema's tables (and those it points to with `v.id`) refused with Convex's messages, system tables
// refused, WriteData required.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SECRET = "7d".repeat(32);
const NAME = "delete-tables";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("delete_tables: in one commit, as Convex's route", async () => {
  const engine = await new Engine(
    defineSchema({ posts: defineTable({ author: v.id("authors") }) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  for (const t of ["a", "b", "authors"]) await engine.mutation((db) => db.insert(t, { x: 1 }));
  const { server, stop } = createServer({ engine, functions: new Functions(engine), port: 0 });
  stops.push(stop);
  const del = async (body: object, key = KEY) => {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/delete_tables`, {
      method: "POST",
      headers: { authorization: `Bunvex ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: r.status === 200 ? await r.text() : await r.json() };
  };
  expect(await del({ tableNames: ["a", "b", "never"], componentId: null })).toEqual({ status: 200, body: "" });
  expect(engine.catalog.tables.has("a")).toBe(false);
  expect(engine.catalog.tables.has("b")).toBe(false);
  await engine.tablesDeleted();
  expect(engine.catalog.deleting.size).toBe(0);
  expect(await del({ tableNames: ["posts"] })).toEqual({
    status: 400,
    body: {
      code: "SchemaEnforcementError",
      message: 'Failed to delete table "posts" because it appears in the schema',
    },
  });
  expect(await del({ tableNames: ["authors"] })).toEqual({
    status: 400,
    body: {
      code: "SchemaEnforcementError",
      message: 'Failed to delete table "authors" because `v.id("authors")` appears in the schema of table "posts"',
    },
  });
  expect(engine.catalog.tables.has("authors")).toBe(true);
  expect(await del({ tableNames: ["_storage"] })).toEqual({
    status: 500,
    body: { code: "InternalServerError", message: "Your request couldn't be completed. Try again later." },
  });
  expect(await del({ tableNames: ["_file_storage"] })).toMatchObject({ status: 500 });
  expect(engine.catalog.tables.has("_file_storage")).toBe(true);
  expect((await del({ tableNames: ["bad-name"] })).body).toMatchObject({ code: "InvalidTableName" });
  expect((await del({ tableNames: ["x"] }, READ_ONLY)).status).toBe(403);
  expect((await del({ tableNames: ["x"], componentId: "abc" })).body).toMatchObject({ code: "ComponentsNotSupported" });
});
