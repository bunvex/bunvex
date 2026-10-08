// `_schemas` rows as Convex writes them (STUDY-134, DV-423): `state` an object tagged by `state` (a failed
// schema's error and `table_name` in it), and `schema` the text of Convex's `DatabaseSchemaJson` — compared with
// a row of a Convex deployment's database that pushed the same schema (convex-rows/_schemas.json).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable, type SchemaDefinition } from "../src/schema.ts";
import { schemaFromJson, schemaJsonText, schemaToJson } from "../src/schema-json.ts";
import { convexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const open = async () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-schemas-rows-"));
  dirs.push(d);
  const e = await new Engine(defineSchema({}), new SqlitePersistence(join(d, "db.sqlite"), { durable: true }), {
    storedSchema: true,
    indexBackfill: { chunkRate: null },
  }).init();
  engines.push(e);
  return e;
};
const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
};
const push = async (e: Engine, s: SchemaDefinition) => {
  const p = await e.startSchemaPush(s);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
  await e.commitSchemaPush(p.schemaId, async () => {});
  return p.schemaId;
};
const rows = (e: Engine) =>
  e.query((db) => db.asSystem(() => db.query(SCHEMAS_TABLE).collect())) as Promise<Record<string, unknown>[]>;

/** The schema of the app the Convex fixture pushed (scratch app `schema.ts`). */
const fixtureSchema = () =>
  defineSchema({
    things: defineTable({
      s: v.string(),
      n: v.number(),
      i: v.int64(),
      b: v.boolean(),
      z: v.null(),
      by: v.bytes(),
      arr: v.array(v.any()),
      obj: v.object({ a: v.object({ b: v.string() }), k: v.number() }),
      ref: v.optional(v.id("things")),
      file: v.optional(v.id("_storage")),
    })
      .index("by_s_n", ["s", "n"])
      .searchIndex("search_s", { searchField: "s", filterFields: ["b"] }),
  });

describe("an active schema's row", () => {
  test("has Convex's shape, and its schema text is Convex's byte for byte", async () => {
    const e = await open();
    const id = await push(e, fixtureSchema());
    const [row] = await rows(e);
    const convex = convexRows("_schemas")[0]!;
    expect(row!._id).toBe(id);
    expect(shapeDiff(stored(row), convex)).toEqual([]);
    expect(row!.state).toEqual({ state: "active" });
    expect(row!.schema).toBe(convex.schema as string);
  });

  test("pending, then overwritten by the next push; a restart reads the active one back", async () => {
    const e = await open();
    // A different schema first (an equal one would be the same pending schema, Convex's `submit_pending`).
    const first = await e.startSchemaPush(defineSchema({ other: defineTable(v.any()) }));
    expect((await rows(e)).map((r) => r.state)).toEqual([{ state: "pending" }]);
    await push(e, fixtureSchema());
    const states = new Map((await rows(e)).map((r) => [r._id, r.state]));
    expect(states.get(first.schemaId)).toEqual({ state: "overwritten" });
    expect([...states.values()]).toContainEqual({ state: "active" });
    // The engine's schema is the stored one, `_creationTime` suffix and all read back.
    expect(e.schema.tables.get("things")!.indexes).toEqual({ by_s_n: ["s", "n"] });
  });

  test("a failed schema: the error and the table in the state, as Convex's `Failed`", async () => {
    const e = await open();
    await push(e, defineSchema({ items: defineTable(v.any()) }));
    await e.mutation((db) => db.insert("items", { n: "text" }));
    const p = await e.startSchemaPush(defineSchema({ items: defineTable({ n: v.number() }) }));
    await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
    const status = await e.schemaPushStatus(p.schemaId);
    expect(status.type).toBe("failed");
    const row = (await rows(e)).find((r) => r._id === p.schemaId)!;
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "schema", "state"]);
    const state = row.state as { state: string; error: string; table_name: string | null };
    expect(Object.keys(state).sort()).toEqual(["error", "state", "table_name"]);
    expect(state.state).toBe("failed");
    expect(state.table_name).toBe("items");
    expect(status).toMatchObject({ error: state.error, tableName: "items" });
  });
});

describe("the schema text", () => {
  test("tables and indexes by name, every list present, an object's fields by name", () => {
    const s = defineSchema({
      zeta: defineTable({ b: v.string(), a: v.number() }).index("z_idx", ["b"]).index("a_idx", ["a"]),
      alpha: defineTable(v.any()).vectorIndex("vec", { vectorField: "e", dimensions: 2, filterFields: ["y", "x"] }),
    });
    const j = schemaToJson(s);
    expect(j.tables.map((t) => t.tableName)).toEqual(["alpha", "zeta"]);
    expect(j.tables[1]!.indexes.map((i) => i.indexDescriptor)).toEqual(["a_idx", "z_idx"]);
    expect(Object.keys(j.tables[0]!)).toEqual([
      "tableName",
      "indexes",
      "stagedDbIndexes",
      "searchIndexes",
      "stagedSearchIndexes",
      "vectorIndexes",
      "stagedVectorIndexes",
      "documentType",
      "stagedDocumentType",
    ]);
    expect(schemaJsonText(s)).toContain(
      '"vectorIndexes":[{"indexDescriptor":"vec","vectorField":"e","dimensions":2,"dimension":null,"filterFields":["x","y"]}]',
    );
    expect(schemaJsonText(s)).toContain(
      '"documentType":{"type":"object","value":{"a":{"fieldType":{"type":"number"},"optional":false},"b":{"fieldType":{"type":"string"},"optional":false}}}',
    );
    expect(schemaJsonText(s).endsWith('],"schemaValidation":true}')).toBe(true);
    expect(schemaToJson(schemaFromJson(JSON.parse(schemaJsonText(s))))).toEqual(j);
  });

  test("float literals as serde_json writes them; bigint literals as Convex's JSON", () => {
    const text = (value: number | bigint) =>
      schemaJsonText(defineSchema({ t: defineTable({ k: v.literal(value as number) }) }));
    expect(text(1)).toContain('"value":1.0}');
    expect(text(-2)).toContain('"value":-2.0}');
    expect(text(1.5)).toContain('"value":1.5}');
    expect(text(1e16)).toContain('"value":1e16}');
    expect(text(1e15)).toContain('"value":1000000000000000.0}');
    expect(text(0.00001)).toContain('"value":0.00001}');
    expect(text(1e-7)).toContain('"value":1e-7}');
    expect(text(2n)).toContain('"value":{"$integer":"AgAAAAAAAAA="}}');
  });

  test("a record field as Convex serializes it: its keys, then its values (never optional)", () => {
    const s = defineSchema({ t: defineTable({ m: v.record(v.string(), v.array(v.id("t"))) }) });
    expect(schemaJsonText(s)).toContain(
      '"m":{"fieldType":{"type":"record","keys":{"type":"string"},"values":{"fieldType":{"type":"array","value":{"type":"id","tableName":"t"}},"optional":false}},"optional":false}',
    );
    expect(schemaToJson(schemaFromJson(JSON.parse(schemaJsonText(s))))).toEqual(schemaToJson(s));
  });

  test("a table's top-level system fields are left out; a one-object union is that object", () => {
    const j = schemaToJson(
      defineSchema({
        t: defineTable(v.object({ _id: v.id("t"), a: v.string() })),
        u: defineTable(v.union(v.object({ k: v.string() }))),
        w: defineTable(v.union(v.object({ k: v.literal("a") }), v.object({ k: v.literal("b") }))),
      }),
    );
    expect(j.tables[0]!.documentType).toEqual({
      type: "object",
      value: { a: { fieldType: { type: "string" }, optional: false } },
    });
    expect(j.tables[1]!.documentType).toEqual({
      type: "object",
      value: { k: { fieldType: { type: "string" }, optional: false } },
    });
    expect(j.tables[2]!.documentType).toMatchObject({ type: "union" });
  });
});
