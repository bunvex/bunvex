// Streaming import (STUDY-141 PR 1), Convex's `/api/streaming_import/*`: `clear_tables` (empty tables in one
// commit, a missing one created, a `clear_tables` audit event as the caller), `get_schema`, `replace_tables`,
// ImportBackups, and the names Convex's `ValidIdentifier` makes. The same requests are compared with Convex's
// binary in packages/differential/test/streaming-import.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { slugify, validTableName } from "../src/streaming-import.ts";

const SECRET = "7a".repeat(32);
const NAME = "streaming-import";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 7 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({
      items: defineTable(v.any()).index("by_tag", ["tag"]),
      others: defineTable(v.any()),
    }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    add: mutation(async ({ db }, { table, tag }: { table: string; tag: string }) => db.insert(table, { tag })),
    byTag: query(async ({ db }, { tag }: { tag: string }) =>
      db
        .query("items")
        .withIndex("by_tag", (q) => q.eq("tag", tag))
        .collect(),
    ),
    count: query(async ({ db }, { table }: { table: string }) => (await db.query(table).collect()).length),
  });
  const s = createServer({ engine, functions, port: 0, sitePort: null });
  stops.push(s.stop);
  const api = `http://127.0.0.1:${s.server!.port}`;
  const request = async (method: string, path: string, body?: string, key: string | null = KEY) => {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "streaming-test" };
    if (key !== null) headers.authorization = `Bunvex ${key}`;
    const r = await fetch(`${api}/api/streaming_import/${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await r.text();
    return { status: r.status, body: text === "" ? "" : JSON.parse(text) };
  };
  const clear = (tableNames: unknown, key: string | null = KEY) =>
    request("PUT", "clear_tables", JSON.stringify({ tableNames }), key);
  const call = (kind: "mutation" | "query", path: string, args: object) =>
    kind === "mutation" ? functions.runMutation(path, args) : functions.runQuery(path, args);
  const events = () =>
    engine.query((db) =>
      db.asSystem(async () =>
        (await db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect()).filter((e) => e.action === "clear_tables"),
      ),
    );
  return { engine, request, clear, call, events };
}

describe("clear_tables", () => {
  test("empties the tables in one commit, keeps their indexes and numbers, records one event", async () => {
    const { engine, clear, call, events } = await setup();
    const id = (await call("mutation", "m:add", { table: "items", tag: "x" })) as string;
    await call("mutation", "m:add", { table: "others", tag: "y" });
    const number = engine.catalog.table("items").number;
    const ts = engine.committer.visibleTs;
    expect(await clear(["items", "others"])).toEqual({ status: 200, body: "" });
    // One commit for both tables and the event (the hidden tables' own commits come before it).
    expect(await call("query", "m:count", { table: "items" })).toBe(0);
    expect(await call("query", "m:count", { table: "others" })).toBe(0);
    expect(await call("query", "m:byTag", { tag: "x" })).toEqual([]);
    expect(engine.catalog.table("items").number).toBe(number);
    expect(engine.committer.visibleTs > ts).toBe(true);
    // An id of before still names this table (its number), of a document gone.
    expect(await engine.query((db) => db.get("items", id as never))).toBeNull();
    const [event, ...more] = await events();
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      action: "clear_tables",
      metadata: {},
      member_id: 7n,
      client_user_agent: "streaming-test",
    });
  });

  test("creates a missing table, under a valid name", async () => {
    const { engine, clear, events } = await setup();
    expect(await clear(["Fresh Table!", "_storage", "Café 北亰"])).toEqual({ status: 200, body: "" });
    for (const name of ["source_fresh_table", "source_storage", "source_cafe_bei_jing"])
      expect(engine.catalog.tables.has(name)).toBe(true);
    expect(await events()).toHaveLength(1);
  });

  test("a table named twice: TableConflict for one that exists, nothing cleared, no event", async () => {
    const { clear, call, events } = await setup();
    await call("mutation", "m:add", { table: "items", tag: "x" });
    expect(await clear(["items", "items"])).toEqual({
      status: 400,
      body: {
        code: "TableConflict",
        message:
          "New table `items` has IDs that conflict with existing table `items`. To delete all existing tables, import with `bunvex import --replace-all`.",
      },
    });
    expect(await call("query", "m:count", { table: "items" })).toBe(1);
    expect(await events()).toEqual([]);
    // A missing table twice is one new table.
    expect((await clear(["zz", "zz"])).status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  test("ImportBackups, checked after the body", async () => {
    const { clear, request, events } = await setup();
    expect(await clear([], READ_ONLY)).toMatchObject({ status: 403 });
    expect(await clear([], null)).toMatchObject({ status: 403, body: { code: "BadDeployKey" } });
    // The body is read first, as Convex's extractors run before the handler.
    expect(await request("PUT", "clear_tables", "{}", null)).toEqual({
      status: 400,
      body: {
        code: "BadJsonBody",
        message:
          "Failed to deserialize the JSON body into the target type: missing field `tableNames` at line 1 column 2",
      },
    });
    expect(await events()).toEqual([]);
  });

  test("a name that cannot be made valid is an internal error", async () => {
    const { clear } = await setup();
    expect(await clear(["x".repeat(65)])).toMatchObject({ status: 500, body: { code: "InternalServerError" } });
  });

  test("the body limit is 2 MiB", async () => {
    const { request } = await setup();
    const big = JSON.stringify({ tableNames: [], pad: "x".repeat(2 * 1024 * 1024) });
    expect(await request("PUT", "clear_tables", big)).toEqual({
      status: 400,
      body: { code: "BadJsonBody", message: "Failed to buffer the request body: length limit exceeded" },
    });
  });
});

describe("get_schema and replace_tables", () => {
  test("get_schema answers null with no pushed schema", async () => {
    // A pushed schema's JSON is compared with Convex's in packages/differential.
    const { request } = await setup();
    expect(await request("GET", "get_schema")).toEqual({ status: 200, body: null });
    expect(await request("GET", "get_schema", undefined, null)).toMatchObject({ status: 403 });
  });

  test("replace_tables always fails, with no auth needed", async () => {
    const { request } = await setup();
    const overwrite = {
      status: 400,
      body: {
        code: "OverwriteNotSupported",
        message: "Overwrite sync mode is not supported. Please use a different sync mode.",
      },
    };
    expect(await request("POST", "replace_tables", '{"tableNames":{"a":"b"}}', null)).toEqual(overwrite);
    expect((await request("POST", "replace_tables", '{"tableNames":{"a":1}}')).body.code).toBe("BadJsonBody");
  });

  test("a wrong method is 405; a route not built is 404 with no body", async () => {
    const { request } = await setup();
    expect(await request("POST", "clear_tables", "{}")).toEqual({ status: 405, body: "" });
    expect(await request("POST", "import_airbyte_records", "{}")).toEqual({ status: 404, body: "" });
  });
});

describe("names (Convex's ValidIdentifier and slugify)", () => {
  test("the slugify crate's own examples, with `_`", () => {
    expect(slugify("hello world")).toBe("hello_world");
    expect(slugify("影師嗎")).toBe("ying_shi_ma");
    expect(slugify("Æúű--cool?")).toBe("aeuu_cool");
    expect(slugify("Nín hǎo. Wǒ shì zhōng guó rén")).toBe("nin_hao_wo_shi_zhong_guo_ren");
  });

  test("a valid user name is kept; anything else gets the prefix", () => {
    expect(validTableName("messages")).toBe("messages");
    expect(validTableName("_storage")).toBe("source_storage");
    expect(validTableName("My Table!")).toBe("source_my_table");
    expect(validTableName("")).toBe("source_");
    expect(validTableName("9lives")).toBe("source_9lives");
    expect(validTableName("x".repeat(64))).toBe("x".repeat(64));
    expect(validTableName(`_${"x".repeat(57)}`)).toBe(`source_${"x".repeat(57)}`);
    expect(() => validTableName("x".repeat(65))).toThrow("Failed to create a valid identifier.");
    // Past U+FFFE nothing is transliterated.
    expect(validTableName("a😀b")).toBe("source_ab");
  });
});
