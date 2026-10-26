// Index definitions' types (STUDY-189 T5), with Convex's cases from its `server/schema.test.ts`: checked by `tsc`
// (`bun run typecheck`); each `Equal` must hold and each `@ts-expect-error` must be an error. A staged index is
// not in the table's type, and the fields an index names must be the document's paths or `_creationTime`.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { DataModelFromSchemaDefinition } from "../../src/data-model.ts";
import type { GenericDatabaseReader } from "../../src/database-types.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

test("staged database indexes are not in the type", () => {
  const schema = defineSchema({
    table: defineTable({ enabled: v.string(), enabled2: v.string(), enabled3: v.string(), staged: v.string() })
      .index("by_enabled", ["enabled"])
      .index("by_enabled2", { fields: ["enabled2"] })
      .index("by_enabled3", { fields: ["enabled3"], staged: false })
      .index("by_staged", { fields: ["staged"], staged: true }),
  });
  type DataModel = DataModelFromSchemaDefinition<typeof schema>;
  check<
    Equal<
      DataModel["table"]["indexes"],
      {
        by_enabled: ["enabled", "_creationTime"];
        by_enabled2: ["enabled2", "_creationTime"];
        by_enabled3: ["enabled3", "_creationTime"];
        by_id: ["_id"];
        by_creation_time: ["_creationTime"];
      }
    >
  >(true);
  // `withIndex` cannot name a staged index.
  const _query = (db: GenericDatabaseReader<DataModel>) => {
    db.query("table").withIndex("by_enabled");
    // @ts-expect-error a staged index
    db.query("table").withIndex("by_staged");
  };
  expect(schema.tables.table.stagedIndexes).toEqual(["by_staged"]);
});

test("staged search and vector indexes are not in the type", () => {
  const schema = defineSchema({
    table: defineTable({ enabled: v.string(), enabled2: v.string(), staged: v.string() })
      .searchIndex("by_enabled", { searchField: "enabled" })
      .searchIndex("by_enabled2", { searchField: "enabled2", staged: false })
      .searchIndex("by_staged", { searchField: "staged", staged: true })
      .vectorIndex("v_enabled", { vectorField: "enabled", dimensions: 1536 })
      .vectorIndex("v_enabled2", { vectorField: "enabled2", dimensions: 1536, staged: false })
      .vectorIndex("v_staged", { vectorField: "staged", dimensions: 1536, staged: true }),
  });
  type DataModel = DataModelFromSchemaDefinition<typeof schema>;
  check<
    Equal<
      DataModel["table"]["searchIndexes"],
      {
        by_enabled: { searchField: "enabled"; filterFields: never };
        by_enabled2: { searchField: "enabled2"; filterFields: never };
      }
    >
  >(true);
  check<
    Equal<
      DataModel["table"]["vectorIndexes"],
      {
        v_enabled: { vectorField: "enabled"; dimensions: number; filterFields: never };
        v_enabled2: { vectorField: "enabled2"; dimensions: number; filterFields: never };
      }
    >
  >(true);
});

test("a staged status not known at compile time is refused", () => {
  const staged = Math.random() < 0.5;
  defineSchema({
    // @ts-expect-error `staged: boolean`
    table: defineTable({ field: v.string() }).index("staged_database_index", { fields: ["field"], staged }),
  });
  defineSchema({
    table: defineTable({ field: v.string() }).searchIndex("staged_search_index", {
      searchField: "field",
      // @ts-expect-error `staged: boolean`
      staged,
    }),
  });
  defineSchema({
    table: defineTable({ field: v.array(v.float64()) }).vectorIndex("staged_vector_index", {
      vectorField: "field",
      dimensions: 42,
      // @ts-expect-error `staged: boolean`
      staged,
    }),
  });
});

test("an index names the document's fields", () => {
  const table = () =>
    defineTable({ a: v.string(), o: v.object({ b: v.number() }), e: v.array(v.float64()), u: v.optional(v.string()) });
  table()
    .index("by_a", ["a"])
    .index("by_a_creation", ["a", "_creationTime"])
    .index("by_nested", { fields: ["o.b"] })
    .index("by_optional", ["u"])
    .searchIndex("s", { searchField: "a", filterFields: ["o.b", "u"] })
    .vectorIndex("vi", { vectorField: "e", dimensions: 2, filterFields: ["a"] });

  // @ts-expect-error a field the document does not have
  table().index("x", ["nope"]);
  // @ts-expect-error a field the document does not have
  table().index("x", { fields: ["nope"] });
  // @ts-expect-error a field the document does not have, staged
  table().index("x", { fields: ["nope"], staged: true });
  // @ts-expect-error a field the document does not have, after one it has
  table().index("x", ["a", "nope"]);
  // @ts-expect-error a path into an object that it does not have
  table().index("x", ["o.c"]);
  // @ts-expect-error `_id` is not an index field
  table().index("x", ["_id"]);
  // @ts-expect-error a search field the document does not have
  table().searchIndex("x", { searchField: "nope" });
  // @ts-expect-error a filter field the document does not have
  table().searchIndex("x", { searchField: "a", filterFields: ["nope"] });
  // @ts-expect-error a vector field the document does not have
  table().vectorIndex("x", { vectorField: "nope", dimensions: 2 });
  // @ts-expect-error a filter field the document does not have
  table().vectorIndex("x", { vectorField: "e", dimensions: 2, filterFields: ["nope"] });
});

test("a union table's fields; any field on a v.any() table", () => {
  defineTable(
    v.union(v.object({ kind: v.literal("a"), x: v.string() }), v.object({ kind: v.literal("b"), y: v.number() })),
  )
    .index("by_kind", ["kind"])
    .index("by_x", ["x"])
    .index("by_y", ["y"]);
  defineTable(v.any())
    .index("by_anything", ["anything", "else.nested"])
    .searchIndex("s", { searchField: "body", filterFields: ["k"] })
    .vectorIndex("vi", { vectorField: "v", dimensions: 2 });
});
