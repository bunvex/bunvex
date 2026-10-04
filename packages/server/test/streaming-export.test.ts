// Streaming export (STUDY-60), Convex's legacy connector API: `list_snapshot` pages per table, then
// `document_deltas` from its snapshot (whole commits, deletes as `_deleted`), the three value encodings,
// `json_schemas` and `get_table_column_names` from the inferred shapes, and the routes' errors and access.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { toJsonValue, v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, mutation } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { writeValue } from "../src/streaming-export.ts";

const SECRET = "8d".repeat(32);
const NAME = "export-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 4 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

describe("the encodings", () => {
  test("json (clean), encoded_json and export_json, as Convex's export.rs", () => {
    const doc = { i: 33n, f: 1, nan: Number.NaN, inf: -Infinity, z: -0, b: new Uint8Array([1, 2]).buffer, s: "x" };
    expect(writeValue(doc, "clean")).toBe(
      '{"b":"AQI=","f":1.0,"i":"33","inf":"-Infinity","nan":"NaN","s":"x","z":-0.0}',
    );
    expect(writeValue(doc, "encoded")).toBe(
      '{"b":{"$bytes":"AQI="},"f":1.0,"i":{"$integer":"IQAAAAAAAAA="},"inf":{"$float":"AAAAAAAA8P8="},"nan":{"$float":"AAAAAAAA+H8="},"s":"x","z":{"$float":"AAAAAAAAAIA="}}',
    );
    expect(writeValue(doc, "export")).toBe(
      '{"b":{"$bytes":"AQI="},"f":1.0,"i":33,"inf":{"$float":"AAAAAAAA8P8="},"nan":{"$float":"AAAAAAAA+H8="},"s":"x","z":-0.0}',
    );
  });
});

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()), b: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    put: mutation(({ db }, { table, n, doc }: { table: string; n: number; doc?: object }) =>
      Promise.all(Array.from({ length: n }, () => db.insert(table, (doc ?? {}) as never))),
    ),
    patch: mutation(({ db }, { id, doc }: { id: string; doc: object }) => db.patch(id as never, doc as never)),
    del: mutation(({ db }, { id }: { id: string }) => db.delete(id as never)),
  });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const api = `http://127.0.0.1:${s.server.port}/api`;
  const call = async (path: string, args: object) =>
    (
      (await (
        await fetch(`${api}/mutation`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args: toJsonValue(args as never) }),
        })
      ).json()) as { value: any }
    ).value;
  const get = async (route: string, params: Record<string, string> = {}, key: string | null = KEY) => {
    const r = await fetch(`${api}/${route}?${new URLSearchParams(params)}`, {
      headers: key ? { authorization: `Bunvex ${key}` } : {},
    });
    const text = await r.text();
    return { status: r.status, text, body: text ? JSON.parse(text) : null };
  };
  const post = async (route: string, body: string) => {
    const r = await fetch(`${api}/${route}`, {
      method: "POST",
      headers: { authorization: `Bunvex ${KEY}`, "content-type": "application/json" },
      body,
    });
    return { status: r.status, text: await r.text() };
  };
  return { engine, call, get, post };
}

/** Every page of a list_snapshot, from the first call. */
async function listAll(t: Awaited<ReturnType<typeof setup>>, params: Record<string, string> = {}) {
  const pages: any[] = [];
  let first = await t.get("list_snapshot", params);
  pages.push(first.body);
  const snapshot = /"snapshot":(\d+)/.exec(first.text)![1]!;
  while (first.body.hasMore) {
    first = await t.get("list_snapshot", { ...params, snapshot, cursor: first.body.cursor });
    pages.push(first.body);
  }
  return { pages, snapshot, values: pages.flatMap((p) => p.values) };
}

test("list_snapshot: one table per page, by tablet then id, at one snapshot; then document_deltas from it", async () => {
  const t = await setup();
  const [a1] = await t.call("m:put", { table: "a", n: 3, doc: { k: 1n } });
  await t.call("m:put", { table: "b", n: 2 });
  const { pages, snapshot, values } = await listAll(t);
  expect(pages.map((p) => p.values.map((x: any) => x._table))).toEqual([
    ["a", "a", "a"],
    ["b", "b"],
  ]);
  expect(pages.at(-1)).toMatchObject({ cursor: null, hasMore: false });
  // The fields in Convex's order; `_ts` the snapshot; int64 in clean JSON as a string.
  const firstRaw = (await t.get("list_snapshot", { snapshot })).text;
  expect(firstRaw).toMatch(
    new RegExp(`^\\{"values":\\[\\{"_component":"","_table":"a","_ts":${snapshot},"_creationTime":`),
  );
  expect(values[0].k).toBe("1");
  expect(values.map((x) => x._id)).toContain(a1);
  // A single table, at the snapshot: a later insert is not in it.
  await t.call("m:put", { table: "b", n: 1 });
  expect((await t.get("list_snapshot", { snapshot, tableName: "b" })).body.values.length).toBe(2);
  expect((await listAll(t, { tableName: "b" })).values.map((x: any) => x._table)).toEqual(["b", "b", "b"]);
  // Changes after the snapshot: an insert, a patch, a delete — in commit order, deletes as `_deleted`.
  await t.call("m:put", { table: "b", n: 1, doc: { k: 2n } });
  await t.call("m:patch", { id: a1, doc: { k: 3n } });
  await t.call("m:del", { id: a1 });
  const d = await t.get("document_deltas", { cursor: snapshot, format: "encoded_json" });
  expect(d.body.hasMore).toBe(false);
  expect(d.body.values.map((x: any) => [x._table, x._deleted, x.k ?? null])).toEqual([
    ["b", false, null],
    ["b", false, { $integer: "AgAAAAAAAAA=" }],
    ["a", false, { $integer: "AwAAAAAAAAA=" }],
    ["a", true, null],
  ]);
  expect(Object.keys(d.body.values[3])).toEqual(["_component", "_table", "_ts", "_deleted", "_id"]);
  const cursor = /"cursor":(\d+)/.exec(d.text)![1]!;
  expect(BigInt(cursor)).toBeGreaterThan(BigInt(snapshot));
  expect((await t.get("document_deltas", { cursor })).body).toMatchObject({ values: [], hasMore: false });
});

test("pages: 1024 documents a list_snapshot page; document_deltas pages at 128 rows but never splits a commit", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1100 });
  const { pages } = await listAll(t);
  // Then table b's (empty) page: a page never spans two tables.
  expect(pages.map((p) => p.values.length)).toEqual([1024, 76, 0]);
  const start = (await t.get("list_snapshot")).text;
  const snapshot = /"snapshot":(\d+)/.exec(start)![1]!;
  // One commit of 200 rows: one page.
  await t.call("m:put", { table: "b", n: 200 });
  // Then 150 commits of one row each.
  for (let i = 0; i < 150; i++) await t.call("m:put", { table: "b", n: 1 });
  const p1 = await t.get("document_deltas", { cursor: snapshot });
  expect([p1.body.values.length, p1.body.hasMore]).toEqual([200, true]);
  const p2 = await t.get("document_deltas", { cursor: /"cursor":(\d+)/.exec(p1.text)![1]! });
  expect([p2.body.values.length, p2.body.hasMore]).toEqual([128, true]);
  const p3 = await t.get("document_deltas", { cursor: /"cursor":(\d+)/.exec(p2.text)![1]! });
  expect([p3.body.values.length, p3.body.hasMore]).toEqual([22, false]);
});

test("json_schemas and get_table_column_names from the shapes", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1, doc: { name: "x", age: 3n } });
  await t.call("m:put", { table: "a", n: 1, doc: { name: "y" } });
  const s = (await t.get("json_schemas")).body;
  expect(s.a).toEqual({
    type: "object",
    properties: {
      _creationTime: { type: "number" },
      _id: { $description: "Id(a)", type: "string" },
      age: { $description: "int64 represented as base10 string", type: "string" },
      name: { type: "string" },
    },
    additionalProperties: false,
    required: ["_creationTime", "_id", "name"],
    $schema: "http://json-schema.org/draft-07/schema#",
  });
  expect(s.b).toEqual({
    type: "object",
    properties: { _creationTime: { type: "number" }, _id: { $description: "Id(b)", type: "string" } },
    additionalProperties: false,
    required: ["_creationTime", "_id"],
    $schema: "http://json-schema.org/draft-07/schema#",
  });
  const delta = (await t.get("json_schemas", { deltaSchema: "true", format: "export_json", byComponent: "true" })).body;
  expect(Object.keys(delta[""].a.properties)).toEqual([
    "_creationTime",
    "_id",
    "age",
    "name",
    "_table",
    "_component",
    "_ts",
    "_deleted",
  ]);
  expect(delta[""].a.properties.age).toEqual({ $description: "int64", type: "number" });
  expect((await t.get("get_table_column_names")).body).toEqual({
    byComponent: {
      "": [
        { name: "a", columns: ["_creationTime", "_id", "age", "name"] },
        { name: "b", columns: ["_creationTime", "_id"] },
      ],
    },
  });
});

test("errors, access, and exact nanosecond timestamps over POST", async () => {
  const t = await setup();
  await t.call("m:put", { table: "a", n: 1 });
  expect((await t.get("test_streaming_export_connection")).text).toBe("null");
  expect((await t.get("test_streaming_export_connection", {}, READ_ONLY)).status).toBe(200);
  expect((await t.get("test_streaming_export_connection", {}, null)).status).toBe(403);
  expect((await t.get("document_deltas")).body).toEqual({
    code: "DocumentDeltasCursorRequired",
    message: "/api/document_deltas requires a cursor",
  });
  expect((await t.get("list_snapshot", { format: "xml" })).body).toEqual({
    code: "BadFormat",
    message: "format param must be one of [`json`]. Got xml",
  });
  // bunvex's names; Convex's are a BadFormat (DV-307).
  for (const format of ["json", "clean_json", "encoded_json", "export_json"])
    expect((await t.get("list_snapshot", { format })).status).toBe(200);
  for (const format of ["convex_encoded_json", "convex_json", "convex_clean_json"])
    expect((await t.get("list_snapshot", { format })).body).toEqual({
      code: "BadFormat",
      message: `format param must be one of [\`json\`]. Got ${format}`,
    });
  expect((await t.get("list_snapshot", { cursor: "nope" })).body.code).toBe("InvalidListSnapshotCursor");
  const future = (BigInt(Date.now()) * 1_000_000n + 10n ** 15n).toString();
  expect((await t.get("list_snapshot", { snapshot: future })).body).toEqual({
    code: "SnapshotTooNew",
    message: `Snapshot value ${future} is in the future.`,
  });
  const old = (BigInt(Date.now() - 6 * 24 * 3600 * 1000) * 1_000_000n).toString();
  expect((await t.get("list_snapshot", { snapshot: old })).body.code).toBe("SnapshotTooOld");
  // A cursor below the document retention window.
  const realRetention = t.engine.retention;
  (t.engine as { retention: unknown }).retention = { minDocumentTs: t.engine.committer.visibleTs };
  const expired = await t.get("document_deltas", { cursor: "1000" });
  (t.engine as { retention: unknown }).retention = realRetention;
  expect(expired.status).toBe(400);
  expect(expired.body.code).toBe("InvalidWindowToReadDocuments");
  expect(expired.body.message).toStartWith(
    "Trying to synchronize from timestamp 1001, which is older than the database’s retention window.",
  );
  // POST keeps a nanosecond snapshot exact (beyond 2^53).
  const snap = /"snapshot":(\d+)/.exec((await t.get("list_snapshot")).text)![1]!;
  const posted = await t.post("list_snapshot", `{"snapshot":${snap},"tableName":"a"}`);
  expect(posted.text).toContain(`"snapshot":${snap}`);
  // An exact selection: a column left out, `_id` kept.
  const sel = await t.post(
    "list_snapshot",
    JSON.stringify({
      selection: {
        _other: "excluded",
        "": { _other: "excluded", a: { _other: "included", _creationTime: "excluded" } },
      },
    }),
  );
  expect(Object.keys(JSON.parse(sel.text).values[0])).toEqual(["_component", "_table", "_ts", "_id"]);
});
