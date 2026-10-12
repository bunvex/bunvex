// `schema.tables` against the official package (STUDY-144): the same `defineSchema` on both, compared — the
// schema's own fields (`tables`, `strictTableNameTypes`, `schemaValidation`), `tables` as the record given (its
// keys, each a table definition whose `validator` is the one defined), `docValidator(name, schema.tables.x)`,
// `schema.doc` / `schema.id` and the error for a table the schema does not have. Validators are compared by
// their JSON.
import { expect, test } from "bun:test";
import * as bunvex from "@bunvex/core";
import { v as bv } from "@bunvex/values";
import * as convex from "convex/server";
import { v as cv } from "convex/values";

// biome-ignore lint/suspicious/noExplicitAny: one definition for both packages
type Any = any;

/** The same schema, built with one package's `defineSchema`, `defineTable` and `v`. */
function define(pkg: Any, v: Any, options?: { schemaValidation?: boolean }) {
  const tables = {
    users: pkg.defineTable({ name: v.string(), email: v.optional(v.string()) }).index("by_name", ["name"]),
    messages: pkg
      .defineTable({ author: v.id("users"), body: v.string() })
      .index("by_author", ["author"])
      .searchIndex("search_body", { searchField: "body", filterFields: ["author"] }),
    events: pkg.defineTable(
      v.union(v.object({ kind: v.literal("a") }), v.object({ kind: v.literal("b"), n: v.number() })),
    ),
    loose: pkg.defineTable(v.any()),
  };
  return { tables, schema: pkg.defineSchema(tables, options) };
}

const both = (options?: { schemaValidation?: boolean }) => ({
  convex: define(convex, cv, options),
  bunvex: define(bunvex, bv, options),
});

const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

test("the schema's own fields: tables, strictTableNameTypes (never set), schemaValidation", () => {
  for (const options of [undefined, { schemaValidation: false }]) {
    const s = both(options);
    expect(Object.keys(s.bunvex.schema)).toEqual(Object.keys(s.convex.schema));
    expect(s.bunvex.schema.schemaValidation).toBe(s.convex.schema.schemaValidation);
    expect(s.bunvex.schema.strictTableNameTypes).toBe(s.convex.schema.strictTableNameTypes);
  }
});

test("tables is the record given: its keys, each a table definition with its validator", () => {
  const s = both();
  expect(s.convex.schema.tables).toBe(s.convex.tables);
  expect(s.bunvex.schema.tables).toBe(s.bunvex.tables);
  expect(Object.keys(s.bunvex.schema.tables)).toEqual(Object.keys(s.convex.schema.tables));
  for (const name of Object.keys(s.convex.schema.tables)) {
    expect(s.bunvex.schema.tables[name]).toBeInstanceOf(bunvex.TableDefinition);
    expect(s.bunvex.schema.tables[name].validator.json).toEqual(s.convex.schema.tables[name].validator.json);
    // Convex's experimental list of a table's database indexes.
    expect(s.bunvex.schema.tables[name][" indexes"]()).toEqual(s.convex.schema.tables[name][" indexes"]());
  }
  const staged = (pkg: Any, v: Any) =>
    pkg
      .defineTable({ a: v.string(), b: v.string() })
      .index("by_a", ["a"])
      .index("by_b", { fields: ["b"], staged: true })
      .index("by_ab", { fields: ["a", "b"] })
      .index("by_a", ["b"]) // declared twice: listed twice (the push refuses it)
      [" indexes"]();
  expect(staged(bunvex, bv)).toEqual(staged(convex, cv));
});

test("docValidator(name, schema.tables.x), schema.doc and schema.id give the same validators", () => {
  const s = both();
  for (const name of Object.keys(s.convex.schema.tables)) {
    expect(bunvex.docValidator(name, s.bunvex.schema.tables[name]).json).toEqual(
      convex.docValidator(name, s.convex.schema.tables[name]).json,
    );
    expect(s.bunvex.schema.doc(name).json).toEqual(s.convex.schema.doc(name).json);
    expect(s.bunvex.schema.id(name).json).toEqual(s.convex.schema.id(name).json);
  }
  // A table's validator, reused as Convex's docs show: its fields in another validator.
  const fields = (schema: Any, v: Any) =>
    v.object({ ...schema.tables.messages.validator.fields, extra: v.boolean() }).json;
  expect(fields(s.bunvex.schema, bv)).toEqual(fields(s.convex.schema, cv));
});

test("an index added to a table after defineSchema is part of the schema: Convex exports `tables` when it pushes", () => {
  const s = both();
  s.convex.schema.tables.users.index("by_email", ["email"]);
  s.bunvex.schema.tables.users.index("by_email", ["email"]);
  const names = (tables: { tableName: string; indexes: { indexDescriptor: string }[] }[]) =>
    tables
      .find((t) => t.tableName === "users")!
      .indexes.map((i) => i.indexDescriptor)
      .sort();
  expect(names(bunvex.schemaToJson(s.bunvex.schema).tables)).toEqual(
    names(JSON.parse(s.convex.schema.export()).tables),
  );
  expect(names(bunvex.schemaToJson(s.bunvex.schema).tables)).toEqual(["by_email", "by_name"]);
});

test("a table the schema does not have: the same error", () => {
  const s = both();
  expect(message(() => s.bunvex.schema.doc("nope"))).toBe(message(() => s.convex.schema.doc("nope")));
  expect(message(() => s.bunvex.schema.id("nope"))).toBe(message(() => s.convex.schema.id("nope")));
  expect(s.bunvex.schema.tables.nope).toBe(s.convex.schema.tables.nope);
});
