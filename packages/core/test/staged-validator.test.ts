// `TableDefinition.staged(validator)` (STUDY-106): as Convex's, the next document validator is accepted,
// serialized and stored with the schema, and nothing checks documents against it: the validator given to
// `defineTable` stays the one enforced.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GenericValidator, v } from "@bunvex/values";
import { SCHEMAS_TABLE } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable, type SchemaDefinition, stagedDocumentError } from "../src/schema.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-staged-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
const open = async (path: string) => {
  const e = await new Engine(defineSchema({}), new SqlitePersistence(path, { durable: true }), {
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
/** Push a schema to the end: start, wait for its validation, commit. */
const push = async (e: Engine, s: SchemaDefinition) => {
  const p = await e.startSchemaPush(s);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type !== "inProgress");
  expect((await e.schemaPushStatus(p.schemaId)).type).toBe("complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
  return p.schemaId;
};
const schemaRows = (e: Engine) =>
  e.query((db) => db.asSystem(() => db.query(SCHEMAS_TABLE).collect())) as unknown as Promise<
    { _id: string; state: string; schema: string }[]
  >;

describe("defining it", () => {
  test("an object of fields is v.object of them; a validator is kept; it returns the table", () => {
    const t = defineTable({ a: v.string() });
    expect(t.staged({ a: v.array(v.string()) })).toBe(t);
    expect(t.stagedDocument!.json).toEqual(v.object({ a: v.array(v.string()) }).json);
    const u = v.union(v.object({ k: v.literal("x") }), v.object({ k: v.literal("y") }));
    expect(defineTable({ k: v.string() }).staged(u).stagedDocument).toBe(u);
    // The enforced validator is still `defineTable`'s.
    expect(t.validator.json).toEqual(v.object({ a: v.string() }).json);
  });

  test("a second call: Convex's error", () => {
    const t = defineTable({ a: v.string() }).staged({ a: v.number() });
    expect(() => t.staged({ a: v.boolean() })).toThrow(new Error("Table cannot have more than one staged validator."));
    // The first one stays.
    expect(t.stagedDocument!.json).toEqual(v.object({ a: v.number() }).json);
  });

  test("a staged validator whose JSON is not an object: Convex's export error, without the docs link", () => {
    const broken = { isValidator: true, kind: "object", json: "nope" } as unknown as GenericValidator;
    const t = defineTable({ a: v.string() }).staged(broken as never);
    expect(() => defineSchema({ t })).toThrow(
      new Error("Invalid staged validator: please make sure that the parameter of `.staged()` is valid"),
    );
  });

  test("at push, a staged validator a table could not have: Convex's top-level type error", () => {
    const of = (staged: GenericValidator) =>
      stagedDocumentError(defineSchema({ t: defineTable({ a: v.string() }).staged(staged as never) }));
    expect(of(v.object({ a: v.string() }))).toBeNull();
    expect(of(v.any())).toBeNull();
    expect(of(v.union(v.object({ a: v.string() }), v.object({ b: v.number() })))).toBeNull();
    expect(of(v.string())).toBe(
      "The document validator in a schema must be an object, a union of objects, or `v.any()`. Found v.string().",
    );
    // A union names its first member that is not an object.
    expect(of(v.union(v.object({ a: v.string() }), v.array(v.int64()), v.null()))).toBe(
      "The document validator in a schema must be an object, a union of objects, or `v.any()`. Found v.array(v.int64()).",
    );
    expect(stagedDocumentError(defineSchema({ t: defineTable({ a: v.string() }) }))).toBeNull();
  });
});

describe("the schema JSON", () => {
  test("stagedDocumentType: the validator's JSON, absent without one; it round-trips", () => {
    const s = defineSchema({
      staged: defineTable({ a: v.string() })
        .index("by_a", ["a"])
        .staged({ a: v.array(v.string()), b: v.optional(v.int64()) }),
      plain: defineTable({ a: v.string() }),
      anyStaged: defineTable(v.any()).staged(v.any()),
    });
    const j = schemaToJson(s);
    expect(j.tables[0]!.stagedDocumentType).toEqual({
      type: "object",
      value: {
        a: { fieldType: { type: "array", value: { type: "string" } }, optional: false },
        b: { fieldType: { type: "bigint" }, optional: true },
      },
    });
    expect("stagedDocumentType" in j.tables[1]!).toBe(false);
    expect(j.tables[2]!.stagedDocumentType).toEqual({ type: "any" });
    // The document type is still `defineTable`'s.
    expect(j.tables[0]!.documentType).toEqual(v.object({ a: v.string() }).json);
    const back = schemaFromJson(JSON.parse(JSON.stringify(j)));
    expect(schemaToJson(back)).toEqual(j);
    expect(back.tables.get("plain")!.stagedDocument).toBeUndefined();
  });
});

describe("pushing it", () => {
  test("only the staged validator changed: a different stored schema; the same schema again: the same", async () => {
    const e = await open(tmp());
    const base = () => defineTable({ n: v.number() }).index("by_n", ["n"]);
    const stored = async () => (await schemaRows(e)).find((r) => r.state === "active")!;
    await push(e, defineSchema({ items: base() }));
    const first = await stored();
    await push(e, defineSchema({ items: base() }));
    expect((await stored()).schema).toBe(first.schema);
    const second = await push(e, defineSchema({ items: base().staged({ n: v.string() }) }));
    const active = await stored();
    expect(active._id).toBe(second);
    expect(active.schema).not.toBe(first.schema);
    expect(JSON.parse(active.schema).tables[0].stagedDocumentType).toEqual(v.object({ n: v.string() }).json);
    // The staged validator changes again: the stored schema changes again.
    await push(e, defineSchema({ items: base().staged({ n: v.boolean() }) }));
    const third = (await schemaRows(e)).find((r) => r.state === "active")!;
    expect(third.schema).not.toBe(active.schema);
  });

  test("nothing checks documents against it: existing and new documents need only match the enforced validator", async () => {
    const path = tmp();
    const e = await open(path);
    await push(e, defineSchema({ items: defineTable({ n: v.number() }) }));
    await e.mutation((db) => db.insert("items", { n: 1 }));
    // The staged validator refuses every existing document; the push still completes.
    await push(e, defineSchema({ items: defineTable({ n: v.number() }).staged({ n: v.string() }) }));
    // Writes are checked against `defineTable`'s validator only.
    await e.mutation((db) => db.insert("items", { n: 2 }));
    await expect(e.mutation((db) => db.insert("items", { n: "two" }))).rejects.toThrow(/does not match the schema/);
    // A restart reads the staged validator back from the stored schema.
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    const again = await open(path);
    expect(again.schema.tables.get("items")!.stagedDocument!.json).toEqual(v.object({ n: v.string() }).json);
    await again.mutation((db) => db.insert("items", { n: 3 }));
  });
});
