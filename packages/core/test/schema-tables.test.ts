// `schema.tables` as Convex's (STUDY-144): the record of table definitions `defineSchema` was given, while the engine
// reads the tables as it declares them (`declaredTables`). A schema the engine makes (a pushed schema read back from
// its JSON) has a `tables` record holding the same declarations. The shape against the official package is in
// packages/sync-e2e/test/schema-tables-oracle.test.ts.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { declaredTables, defineSchema, defineTable, TableDefinition } from "../src/schema.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

const tables = () => ({
  users: defineTable({ name: v.string(), age: v.number() })
    .index("by_name", ["name"])
    .index("by_staged", {
      fields: ["age"],
      staged: true,
    }),
  messages: defineTable({ author: v.id("users"), body: v.string(), embedding: v.array(v.float64()) })
    .searchIndex("search_body", { searchField: "body", filterFields: ["author", "author"] })
    .searchIndex("staged_search", { searchField: "body", staged: true })
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["author"] })
    .staged({
      author: v.id("users"),
      body: v.string(),
      embedding: v.array(v.float64()),
      extra: v.optional(v.string()),
    }),
  loose: defineTable(v.any()),
});

test("defineSchema keeps the record it was given; the engine's tables are declared from it", () => {
  const t = tables();
  const schema = defineSchema(t);
  expect(schema.tables).toBe(t);
  expect(Object.keys(schema)).toEqual(["tables", "strictTableNameTypes", "schemaValidation"]);
  expect(schema.tables.users.validator as unknown).toBe(t.users.document);
  const declared = declaredTables(schema);
  expect([...declared.keys()]).toEqual(["users", "messages", "loose"]);
  expect(declared.get("users")).toMatchObject({
    indexes: { by_name: ["name"], by_staged: ["age"] },
    staged: ["by_staged"],
  });
  expect(declared.get("messages")!.searchIndexes!.search_body!.filterFields).toEqual(["author"]);
  // Made once, on first use: the same map each time.
  expect(declaredTables(schema)).toBe(declared);
});

test("a schema read back from its JSON has table definitions declaring the same", () => {
  const schema = defineSchema(tables(), { schemaValidation: false });
  const back = schemaFromJson(schemaToJson(schema));
  expect(back.schemaValidation).toBe(false);
  expect(Object.keys(back.tables)).toEqual(["loose", "messages", "users"]);
  for (const t of Object.values(back.tables)) expect(t).toBeInstanceOf(TableDefinition);
  // Its `tables`, declared again as any schema's, give what the engine reads.
  expect(declaredTables({ tables: back.tables })).toEqual(declaredTables(back));
  expect(schemaToJson(defineSchema(back.tables, { schemaValidation: false }))).toEqual(schemaToJson(schema));
});

test("any object with a record of table definitions is declared on first use, with defineSchema's checks", () => {
  expect([...declaredTables({ tables: { a: defineTable({}) } }).keys()]).toEqual(["a"]);
  expect(() => declaredTables({ tables: { _a: defineTable({}) } })).toThrow(
    'Invalid table name "_a": names starting with "_" are reserved.',
  );
  expect(() => declaredTables({ tables: new Map() as never })).toThrow(
    "A schema's tables must be an object of table definitions (defineTable(...)).",
  );
});
