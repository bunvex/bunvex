// Full-text search indexes in the schema (STUDY-45 PR 1), as Convex's `searchIndex` and its push-time checks:
// filter fields as a set (at most 16), one search index per (searchField, filterFields), names unique across
// every kind and not reserved, field paths, 64 indexes per table; the schema JSON's `searchIndexes` /
// `stagedSearchIndexes`; the data model's types.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { DataModelFromSchemaDefinition } from "../src/data-model.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { schemaFromJson, schemaToJson } from "../src/schema-json.ts";

const messages = () => defineTable({ body: v.string(), channel: v.string(), author: v.string() });

test("searchIndex: declared, staged, filter fields as a set; the schema JSON round-trips", () => {
  const schema = defineSchema({
    messages: messages()
      .index("by_channel", ["channel"])
      .searchIndex("search_body", { searchField: "body", filterFields: ["channel", "author", "channel"] })
      .searchIndex("search_author", { searchField: "author", staged: true }),
  });
  const t = schema.tables.get("messages")!;
  expect(t.searchIndexes).toEqual({
    search_body: { searchField: "body", filterFields: ["channel", "author"] },
    search_author: { searchField: "author", filterFields: [] },
  });
  expect(t.stagedSearch).toEqual(["search_author"]);
  const json = schemaToJson(schema);
  expect(json.tables[0]).toMatchObject({
    searchIndexes: [{ indexDescriptor: "search_body", searchField: "body", filterFields: ["author", "channel"] }],
    stagedSearchIndexes: [{ indexDescriptor: "search_author", searchField: "author", filterFields: [] }],
  });
  expect(schemaToJson(schemaFromJson(json))).toEqual(json);
  // A table without search indexes has no such keys, as Convex's optional fields.
  expect("searchIndexes" in schemaToJson(defineSchema({ plain: defineTable({}) })).tables[0]!).toBe(false);
});

test("Convex's push-time checks and messages", () => {
  const define = (t: ReturnType<typeof messages>) => () => defineSchema({ messages: t });
  expect(
    define(
      messages().searchIndex("s", {
        searchField: "body",
        filterFields: Array.from({ length: 17 }, (_, i) => `f${i}`) as never,
      }),
    ),
  ).toThrow("Search indexes may have up to 16 filter fields.");
  expect(
    define(
      messages()
        .searchIndex("a", { searchField: "body", filterFields: ["channel"] })
        .searchIndex("b", { searchField: "body", filterFields: ["channel"] }),
    ),
  ).toThrow(
    'In table "messages" search index "a" and search index "b" have the same `searchField`. Search index fields must be unique within a table. You should combine the\n             indexes with the same `searchField` into one index containing all `filterField`s and then use different subsets of the `filterField`s at query time.',
  );
  // The same field with other filter fields is another index.
  expect(
    define(
      messages()
        .searchIndex("a", { searchField: "body", filterFields: ["channel"] })
        .searchIndex("b", { searchField: "body" }),
    ),
  ).not.toThrow();
  expect(define(messages().index("x", ["channel"]).searchIndex("x", { searchField: "body" }))).toThrow(
    'Table "messages" has two or more definitions of index "x".',
  );
  expect(define(messages().searchIndex("by_id", { searchField: "body" }))).toThrow(
    'In table "messages" cannot name an index "by_id" because the name is reserved.',
  );
  expect(define(messages().searchIndex("s", { searchField: "body.$x" }))).toThrow(
    'In index "s": Invalid index field: "body.$x"',
  );
  let many = messages();
  for (let i = 0; i < 65; i++)
    many = many.searchIndex(`s${i}`, { searchField: "body", filterFields: [`f${i}`] as never });
  expect(define(many)).toThrow('Table "messages" cannot have more than 64 indexes.');
});

test("the data model carries the search indexes' types", () => {
  const schema = defineSchema({
    messages: messages().searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  });
  type DM = DataModelFromSchemaDefinition<typeof schema>;
  const field: DM["messages"]["searchIndexes"]["search_body"]["searchField"] = "body";
  const filter: DM["messages"]["searchIndexes"]["search_body"]["filterFields"] = "channel";
  // @ts-expect-error: not a filter field of this index
  const wrong: DM["messages"]["searchIndexes"]["search_body"]["filterFields"] = "author";
  expect([field, filter, wrong as string]).toEqual(["body", "channel", "author"]);
});
